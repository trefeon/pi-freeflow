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
import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logWarn } from "./logger.ts";

const PACKAGE_NAME = "pi-freeflow";
const RELEASE_OWNER = "trefeon";
/** Repo that hosts the release assets; also the package name, so the two stay in step. */
const RELEASE_REPO = "pi-freeflow";
export const RELEASES_PAGE_URL = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
const RELEASE_TAG_MARKER = "/releases/tag/";
const VERSION_PROBE_TIMEOUT_MS = 5_000;

/**
 * Download URL of the tarball asset attached to the v<version> GitHub release.
 *
 * The asset is fetched to a local file before installing: npm 12 refuses
 * remote and git specifiers by default (`allow-remote`/`allow-git` = none),
 * while a local tarball installs everywhere without extra flags.
 */
export function releaseTarballUrl(version: string): string {
 return `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/download/v${version}/${PACKAGE_NAME}-${version}.tgz`;
}

const TARBALL_TIMEOUT_MS = 60_000;
/** Sanity ceiling for the asset; the real tarball is a few hundred KB. */
const TARBALL_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Fetch the release tarball to a temp file and return its path, or null.
 *
 * The local path is what every install step takes, so installation never
 * depends on the npm registry or on a manager accepting a remote specifier.
 */
export async function downloadReleaseTarball(version: string): Promise<string | null> {
 const url = releaseTarballUrl(version);
 try {
  const res = await fetch(url, {
   redirect: "follow",
   signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS),
  });
  if (!res.ok) {
   logWarn(`release tarball download failed: HTTP ${res.status} ${url}`);
   return null;
  }
  const declared = Number(res.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > TARBALL_MAX_BYTES) {
   logWarn(`release tarball is larger than expected (${declared} bytes) — refusing`);
   return null;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > TARBALL_MAX_BYTES) {
   logWarn(`release tarball has an unexpected size (${bytes.length} bytes) — refusing`);
   return null;
  }
  const file = path.join(os.tmpdir(), `${PACKAGE_NAME}-${version}.tgz`);
  await writeFile(file, bytes);
  return file;
 } catch (e) {
  logWarn(`release tarball download failed: ${(e as Error).message}`);
  return null;
 }
}

/** Remove a downloaded tarball; best-effort, the temp file is harmless. */
export async function removeReleaseTarball(file: string): Promise<void> {
 try {
  await unlink(file);
 } catch {
  // already gone
 }
}

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

/**
 * First line of every /freeflow status banner and /freeflow version reply.
 * Null local (unreadable package.json) falls back to "unknown" instead of
 * throwing or printing an empty version.
 */
export function formatVersionLine(local: string | null): string {
 return `pi-freeflow v${local ?? "unknown"}`;
}

/**
 * Version reply body: the version line plus a cached-latest verdict.
 * Offline by design — `latest` must come from getCachedUpdate(), never a
 * live fetch, so this stays pure and synchronous.
 */
export function formatVersionDetail(local: string | null, latest: string | null): string {
 const line = formatVersionLine(local);
 if (latest && local && compareVersions(latest, local) > 0) {
  return `${line}\nUpdate available: ${local} -> ${latest} — run /freeflow update`;
 }
 if (local && latest) {
  return `${line}\nUp to date (v${local})`;
 }
 return line;
}

/** Version named by a `…/releases/tag/v1.2.3` reference, or null. */
function versionFromReleaseReference(text: string): string | null {
 const index = text.lastIndexOf(RELEASE_TAG_MARKER);
 if (index === -1) return null;
 const raw = (text.slice(index + RELEASE_TAG_MARKER.length).split(/[\s"'?#<>]/, 1)[0] ?? "").trim();
 const version = raw.startsWith("v") ? raw.slice(1) : raw;
 return SEMVER_PATTERN.test(version) ? version : null;
}

/**
 * Latest published version, read from the GitHub releases channel.
 *
 * `releases/latest` answers with a redirect to the newest tag, so the version
 * is already in the response URL: no API request, and none of the
 * unauthenticated API rate limit. The page body is a second reading of the
 * same fact for proxies that drop or rewrite the redirect — it links to the
 * same `/releases/tag/v…` path.
 */
export async function fetchLatestVersion(): Promise<string | null> {
 try {
  const res = await fetch(RELEASES_PAGE_URL, {
   redirect: "follow",
   signal: AbortSignal.timeout(VERSION_PROBE_TIMEOUT_MS),
   headers: { Accept: "text/html" },
  });
  if (!res.ok) return null;
  const fromRedirect = versionFromReleaseReference(res.url);
  if (fromRedirect !== null) return fromRedirect;
  try {
   const fromPage = versionFromReleaseReference(await res.text());
   if (fromPage !== null) return fromPage;
  } catch {
   // Body unreadable (aborted or non-text): the redirect already had its turn.
   return null;
  }
  logWarn("releases page did not name a version");
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
   const text = String(d);
   for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (s) opts.onOutput?.(s);
   }
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
