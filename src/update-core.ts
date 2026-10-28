/**
 * Update primitives shared by the background checker, the auto-updater and the
 * `/freeflow update` command surface.
 *
 * This is a LEAF module on purpose. src/update-checker.ts (background check)
 * and src/updater.ts (auto-update install) both need the version facts and the
 * step runner; having either import the other made the pair a value-level
 * cycle. Nothing here imports update-checker.ts, updater.ts, proxy.ts or
 * client.ts, so both sides can depend on it in one direction only.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logWarn } from "./logger.ts";

const REGISTRY_URL = "https://registry.npmjs.org/pi-freeflow/latest";

/** Strict semver shape: major.minor.patch with optional -prerelease or +build suffix. */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/;

/**
 * Simple semver compare: split on '.' and compare numeric segments.
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 *
 * Prerelease aware: a `-prerelease` version sorts below its own core release
 * (`1.4.2-beta` < `1.4.2`), and two prereleases compare identifier by
 * identifier (numeric < alphanumeric, shorter prefix < longer). Build
 * metadata (`+build`) never orders. Inputs with no numeric core at all
 * ("" or "invalid") are uncomparable and compare equal (0), never throw.
 */
export function compareVersions(a: string, b: string): number {
 try {
  const pa = parseComparableVersion(a);
  const pb = parseComparableVersion(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
   const da = pa.core[i] ?? 0;
   const db = pb.core[i] ?? 0;
   if (da !== db) return da - db;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePrereleaseIds(pa.pre, pb.pre);
 } catch {
  return 0;
 }
}

function parseComparableVersion(v: string): { core: number[]; pre: (number | string)[] | null } | null {
 const withoutBuild = v.split("+", 1)[0] ?? "";
 const [corePart = "", ...preParts] = withoutBuild.split("-");
 const coreRaw = corePart.split(".");
 if (coreRaw.length === 0 || coreRaw.some((s) => s === "" || !/^\d+$/.test(s))) return null;
 const pre = preParts.length > 0 ? preParts.join("-").split(".").filter((s) => s !== "") : null;
 return {
  core: coreRaw.map(Number),
  pre: pre === null || pre.length === 0 ? null : pre.map((s) => (/^\d+$/.test(s) ? Number(s) : s)),
 };
}

function comparePrereleaseIds(a: (number | string)[], b: (number | string)[]): number {
 const len = Math.max(a.length, b.length);
 for (let i = 0; i < len; i++) {
  const x = a[i];
  const y = b[i];
  if (x === undefined) return -1;
  if (y === undefined) return 1;
  if (typeof x === "number" && typeof y === "number") {
   if (x !== y) return x - y;
  } else if (typeof x === "number") {
   return -1;
  } else if (typeof y === "number") {
   return 1;
  } else if (x !== y) {
   return x < y ? -1 : 1;
  }
 }
 return 0;
}

/**
 * Read the local package version from package.json.
 * Shared by the background update check and the /freeflow update|status commands.
 * Returns null when the version cannot be read (missing/unparseable
 * package.json) so callers skip the comparison instead of ordering "0.0.0"
 * against the registry.
 */
export function getLocalVersion(): string | null {
 try {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(thisDir, "..", "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
   return pkg.version.trim();
  }
  return null;
 } catch {
  return null;
 }
}

export async function fetchLatestVersion(): Promise<string | null> {
 try {
  const res = await fetch(REGISTRY_URL, {
   signal: AbortSignal.timeout(3000),
   headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { version?: string };
  const v = json?.version;
  if (typeof v === "string" && v.trim().length > 0) {
   const version = v.trim();
   if (SEMVER_PATTERN.test(version)) return version;
   logWarn(`registry returned invalid latest version: ${version}`);
   return null;
  }
  return null;
 } catch {
  return null;
 }
}

interface UpdateStepOptions {
 /** Hard ceiling for the whole step; the process tree is killed when it fires. */
 timeoutMs?: number;
 /** One progress line from the child's stdout/stderr (trimmed, non-empty). */
 onOutput?: (line: string) => void;
 /** Timeout or spawn failure — never a non-zero exit, which is a normal outcome. */
 onWarning?: (message: string) => void;
}

const DEFAULT_STEP_TIMEOUT_MS = 120_000;

/**
 * Kill the child AND its descendants.
 *
 * The install steps run under a shell on Windows, so `child.kill()` reaps only
 * cmd.exe and leaves the installer tree running. taskkill /T takes the tree;
 * on POSIX the child leads its own process group (detached), so a negative-pid
 * signal reaches every descendant.
 */
function killProcessTree(child: ChildProcess): void {
 const pid = child.pid;
 if (!pid) return;
 if (process.platform === "win32") {
  try {
   spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
    stdio: "ignore",
    windowsHide: true,
   }).unref();
  } catch {
   // taskkill unavailable: fall through to the direct kill below.
  }
  try {
   child.kill();
  } catch {
   // already gone
  }
  return;
 }
 try {
  // Negative pid = the child's process group (spawned detached).
  process.kill(-pid, "SIGKILL");
 } catch {
  // No group (detached failed): kill the direct child only.
 }
 try {
  child.kill("SIGKILL");
 } catch {
  // already gone
 }
}

/**
 * Run one update step asynchronously and resolve with its exit code.
 *
 * Asynchronous on purpose: an install can take minutes, and the auto-update
 * runs from extension activation, so a blocking spawn would freeze the host
 * TUI. Output is streamed to `onOutput` as it arrives.
 *
 * A child killed by a signal (SIGKILL/SIGTERM, e.g. an external kill or the
 * timeout path) is a FAILURE: `close` reports code null, never 0, so a killed
 * install cannot be mistaken for a successful one.
 */
export function runUpdateStep(
 cmd: string,
 args: string[],
 opts: UpdateStepOptions = {},
): Promise<number> {
 const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
 const { promise, resolve } = Promise.withResolvers<number>();
 let settled = false;
 const settle = (code: number): void => {
  if (settled) return;
  settled = true;
  resolve(code);
 };
 let timer: NodeJS.Timeout | null = null;
 const clear = (): void => {
  if (timer) {
   clearTimeout(timer);
   timer = null;
  }
 };
 try {
  const child = spawn(cmd, args, {
   shell: process.platform === "win32",
   stdio: "pipe",
   windowsHide: true,
   // POSIX: own process group so the timeout can kill the whole tree.
   detached: process.platform !== "win32",
  });
  timer = setTimeout(() => {
   opts.onWarning?.(`spawn ${cmd} timed out after ${timeoutMs}ms — killed`);
   killProcessTree(child);
   settle(1);
  }, timeoutMs);
  try {
   timer.unref?.();
  } catch {
   // unref is best-effort
  }
  const emit = (d: Buffer): void => {
   const s = String(d).trim();
   if (s) opts.onOutput?.(s);
  };
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);
  child.on("error", (err: Error) => {
   clear();
   opts.onWarning?.(`spawn ${cmd} failed: ${err.message}`);
   settle(1);
  });
  child.on("close", (code: number | null) => {
   clear();
   // null = terminated by a signal: that install did not succeed.
   settle(code ?? 1);
  });
 } catch (e) {
  clear();
  opts.onWarning?.(`spawn ${cmd} failed: ${(e as Error).message}`);
  settle(1);
 }
 return promise;
}
