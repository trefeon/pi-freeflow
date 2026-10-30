/**
 * Opt-in Bun transport for the Zen direct leg (transport-gating follow-up).
 *
 * Default OFF: unless PI_FREEFLOW_ZEN_TRANSPORT is exactly "bun-sidecar" the
 * status resolves to node mode without spawning anything, so the default wire
 * path is byte-identical to today. When enabled, the daemon routes the Zen
 * direct leg through src/zen-sidecar.ts (Bun.fetch native stack) and degrades
 * to the Node fetch direct leg on any spawn/exit/timeout failure — served as
 * direct (servedIssuer null), never marked on the relay pool, never priming
 * the machine-wide gate beyond the existing direct-only 403 rule.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { ZEN_TRANSPORT_ENV } from "./config.ts";

export type ZenTransportMode = "node" | "bun-sidecar";

export interface ZenTransportStatus {
 mode: ZenTransportMode;
 bunVersion: string | null;
 bunPath: string | null;
 reason: string;
}

/** Minimum Bun that the sidecar bridge trusts (>= 1.1 fetch/stdio surface). */
export const ZEN_BUN_VERSION_FLOOR = "1.1.0";
/** Memo TTL for the bun probe: at most one spawn per minute on the request path. */
export const ZEN_BUN_PROBE_TTL_MS = 60_000;
/** Bun --version spawn budget (request path must never stall on a hung binary). */
export const ZEN_BUN_PROBE_TIMEOUT_MS = 2_000;

/** spawnSync-compatible injector, mirroring config.ts OpenCodeSpawnSync. */
export interface ZenSpawnSyncResult {
 status: number | null;
 stdout?: unknown;
 stderr?: unknown;
 error?: unknown;
}
export type ZenSpawnSync = (
 command: string,
 args: readonly string[],
 options: { encoding: "utf8"; timeout: number; windowsHide: boolean; shell?: boolean },
) => ZenSpawnSyncResult;

function defaultZenSpawn(
 command: string,
 args: readonly string[],
 options: { encoding: "utf8"; timeout: number; windowsHide: boolean; shell?: boolean },
): ZenSpawnSyncResult {
 // Single-string form under a Windows shell resolves *.cmd shims the same
 // way client.ts findExecutableOnPath does; direct exec elsewhere. Quote the
 // command so a bun installed under a path with spaces still resolves.
 if (process.platform === "win32") {
  const commandLine = `"${command}" ${args.map((arg) => `"${arg}"`).join(" ")}`;
  return spawnSync(commandLine, {
   encoding: options.encoding,
   timeout: options.timeout,
   windowsHide: options.windowsHide,
   shell: true,
  }) as unknown as ZenSpawnSyncResult;
 }
 return spawnSync(command, [...args], options) as unknown as ZenSpawnSyncResult;
}

function compareBunParts(a: string, b: string): number {
 const pa = a.split(".").map((p) => Number.parseInt(p, 10));
 const pb = b.split(".").map((p) => Number.parseInt(p, 10));
 for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
  const na = pa[i] ?? 0;
  const nb = pb[i] ?? 0;
  if (na !== nb) return na < nb ? -1 : 1;
 }
 return 0;
}

/** Parse `bun --version` output into a bare semver at or above the floor, else null. */
export function parseBunVersion(output: unknown): string | null {
 if (typeof output !== "string") return null;
 const match = output.match(/(\d+\.\d+\.\d+)/);
 if (!match) return null;
 const version: string | undefined = match[1];
 if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) return null;
 if (compareBunParts(version, ZEN_BUN_VERSION_FLOOR) < 0) return null;
 return version;
}

let bunMemo: { key: string; version: string | null; probedAt: number } | null = null;
let transportMemo: { key: string; at: number; status: ZenTransportStatus } | null = null;

/** Test-only: reset the in-process bun probe and transport-resolution memos. */
export function _resetZenTransportForTest(): void {
 bunMemo = null;
 transportMemo = null;
}

/**
 * Probe the `bun` binary (`--version`). Offline-safe: any failure keeps null.
 * Results (including misses) are memoized ~60s; pass spawnImpl to stub in tests.
 */
export function probeBunVersion(opts: {
 execPath?: string;
 timeoutMs?: number;
 spawnImpl?: ZenSpawnSync;
} = {}): string | null {
 const execPath = opts.execPath ?? "bun";
 const timeoutMs = opts.timeoutMs ?? ZEN_BUN_PROBE_TIMEOUT_MS;
 const now = Date.now();
 if (bunMemo && bunMemo.key === execPath && now - bunMemo.probedAt < ZEN_BUN_PROBE_TTL_MS) {
  return bunMemo.version;
 }
 let version: string | null = null;
 try {
  const impl = opts.spawnImpl ?? defaultZenSpawn;
  const res = impl(execPath, ["--version"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  if (res && res.error === undefined && res.status === 0) {
   const text = [res.stdout, res.stderr].filter((part): part is string => typeof part === "string").join("\n");
   version = parseBunVersion(text);
  }
 } catch { version = null; }
 bunMemo = { key: execPath, version, probedAt: now };
 return version;
}

/**
 * Search PATH for `bun`, mirroring client.ts findExecutableOnPath (PATHEXT on
 * Windows, executable bit on POSIX). Local copy keeps this module free of
 * src/ imports (no proxy/client cycle risk).
 */
export function findBunOnPath(envPath?: string): string | null {
 const raw = envPath ?? process.env.PATH ?? process.env.Path ?? "";
 if (!raw || typeof raw !== "string") return null;
 const extensions = process.platform === "win32"
  ? (process.env.PATHEXT ? process.env.PATHEXT.split(";").filter(Boolean) : [".exe", ".cmd", ".bat"])
  : [""];
 for (const dir of raw.split(path.delimiter).filter(Boolean)) {
  for (const ext of extensions) {
   const candidate = ext ? path.join(dir, `bun${ext}`) : path.join(dir, "bun");
   try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) continue;
    if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
   } catch { }
  }
 }
 return null;
}

/**
 * Resolve the Zen transport. Anything but an exact "bun-sidecar" flag value
 * (including unset) returns node mode without spawning — the default path.
 * Pass bunPath explicitly (null = absent) or envPath to avoid touching the
 * real PATH in tests. Successful resolutions are memoized for the probe TTL so
 * the request path does not rescan PATH on every request.
 */
export function resolveZenTransport(opts: {
 spawnImpl?: ZenSpawnSync;
 bunPath?: string | null;
 envPath?: string;
} = {}): ZenTransportStatus {
 const raw = process.env[ZEN_TRANSPORT_ENV];
 if (opts.spawnImpl === undefined && opts.bunPath === undefined && opts.envPath === undefined && raw !== "bun-sidecar") {
  return {
   mode: "node",
   bunVersion: null,
   bunPath: null,
   reason: raw === undefined || raw === "" ? "transport-flag-off" : `unknown-transport-${raw}`,
  };
 }
 const envPath = opts.envPath ?? process.env.PATH ?? process.env.Path ?? "";
 const memoKey = `${raw ?? ""}|${opts.bunPath === undefined ? "<auto>" : String(opts.bunPath)}|${envPath}`;
 const now = Date.now();
 // Injected spawns are test seams: never memoize them, so a stub's result
 // cannot leak into the next case.
 const canMemo = opts.spawnImpl === undefined;
 if (canMemo && transportMemo !== null && transportMemo.key === memoKey && now - transportMemo.at < ZEN_BUN_PROBE_TTL_MS) {
  return transportMemo.status;
 }
 const remember = (status: ZenTransportStatus): ZenTransportStatus => {
  if (canMemo) transportMemo = { key: memoKey, at: now, status };
  return status;
 };
 if (raw !== "bun-sidecar") {
  return remember({
   mode: "node",
   bunVersion: null,
   bunPath: null,
   reason: raw === undefined || raw === "" ? "transport-flag-off" : `unknown-transport-${raw}`,
  });
 }
 const bunPath = opts.bunPath !== undefined ? opts.bunPath : findBunOnPath(opts.envPath);
 if (bunPath === null || bunPath === undefined) {
  return remember({ mode: "node", bunVersion: null, bunPath: null, reason: "bun-absent" });
 }
 const version = probeBunVersion({ execPath: bunPath, spawnImpl: opts.spawnImpl });
 if (version === null) {
  return remember({ mode: "node", bunVersion: null, bunPath, reason: "bun-probe-failed" });
 }
 return remember({ mode: "bun-sidecar", bunVersion: version, bunPath, reason: "bun-sidecar" });
}

/** Absolute path of the staged sidecar script (sits beside this module). */
export function resolveZenSidecarScript(): string {
 return path.join(path.dirname(fileURLToPath(import.meta.url)), "zen-sidecar.ts");
}

/** Kill the sidecar tree: taskkill /T on Windows, SIGKILL on POSIX. */
function killZenSidecarTree(child: ChildProcess): void {
 const pid = child.pid;
 if (pid !== undefined && process.platform === "win32") {
  try {
   spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch { }
 }
 try {
  child.kill("SIGKILL");
 } catch { }
 try {
  child.kill();
 } catch { }
}

/** Statuses whose Response must not carry a body (undici rejects one). */
function isNullBodyStatus(status: number): boolean {
 return status === 204 || status === 205 || status === 304;
}

/**
 * Run one Zen direct-leg request through the sidecar child and return its
 * response. Rejects on spawn failure, exit-before-headers, bad header frame,
 * or header timeout (caller degrades to the Node fetch direct leg). Once
 * headers arrive the body streams; mid-body crashes surface as stream errors
 * for the existing truncation/refire path, and client abort kills the child.
 */
export function fetchZenDirectViaSidecar(
 url: string,
 init: { method: string; headers: Record<string, string>; body: Buffer; headerTimeoutMs: number },
 opts: { runtimePath: string; runtimeArgs?: string[]; scriptPath: string; signal?: AbortSignal; spawnImpl?: typeof spawn },
): Promise<Response> {
 const { promise, resolve, reject } = Promise.withResolvers<Response>();
 let headersDone = false;
 let rejected = false;
 let finished = false;
 let stream: Readable | null = null;
 let stderrText = "";
 let child: ChildProcess | null = null;
 let exitState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
 let stdoutEnded = false;
 const spawnFn = opts.spawnImpl ?? spawn;
 try {
  child = spawnFn(opts.runtimePath, [...(opts.runtimeArgs ?? []), opts.scriptPath], {
   stdio: ["pipe", "pipe", "pipe"],
   windowsHide: true,
   detached: false,
  });
 } catch (e) {
  reject(e instanceof Error ? e : new Error(String(e)));
  return promise;
 }
 const proc = child;
 const stderrDetail = (): string => {
  const text = stderrText.trim();
  return text.length > 0 ? `: ${text.slice(-1000)}` : "";
 };
 const errorWithDetail = (base: Error): Error => {
  const detail = stderrDetail();
  if (detail.length === 0 || base.message.includes(detail)) return base;
  return new Error(`${base.message}${detail}`);
 };
 const fail = (err: unknown): void => {
  try { killZenSidecarTree(proc); } catch { }
  const base = err instanceof Error ? err : new Error(String(err));
  if (!headersDone) {
   if (rejected) return;
   rejected = true;
   finished = true;
   clearTimeout(timer);
   opts.signal?.removeEventListener("abort", onAbort);
   reject(errorWithDetail(base));
   return;
  }
  // After headers: surface as a stream error, never a clean EOF.
  finished = true;
  opts.signal?.removeEventListener("abort", onAbort);
  try { stream?.destroy(base); } catch { }
 };
 const headerTimeoutMs = init.headerTimeoutMs > 0 ? init.headerTimeoutMs : 300_000;
 const timeoutError = (): Error => {
  const err = new Error(`zen sidecar header timeout (${headerTimeoutMs}ms)`) as Error & { code?: string };
  err.name = "AbortError";
  err.code = "FF_INTERNAL_ABORT";
  return err;
 };
 const onAbort = (): void => fail(opts.signal?.reason ?? new Error("zen sidecar aborted"));
 const timer = setTimeout(() => fail(timeoutError()), headerTimeoutMs);
 if (opts.signal?.aborted) {
  fail(opts.signal.reason ?? new Error("zen sidecar aborted"));
  return promise;
 }
 opts.signal?.addEventListener("abort", onAbort, { once: true });
 proc.on("error", (e) => fail(e));
 const stdout = proc.stdout;
 const stdin = proc.stdin;
 const stderr = proc.stderr;
 if (!stdout || !stdin) {
  fail(new Error("zen sidecar stdio unavailable"));
  return promise;
 }
 stderr?.on("data", (c: Buffer) => {
  if (stderrText.length < 4096) stderrText += c.toString("utf8");
 });
 stderr?.on("error", () => { });
 const finishStream = (): void => {
  if (finished || stream === null || !stdoutEnded || exitState === null) return;
  finished = true;
  opts.signal?.removeEventListener("abort", onAbort);
  if (exitState.code === 0) {
   stream.push(null);
   return;
  }
  stream.destroy(new Error(`zen sidecar exited (${String(exitState.code ?? exitState.signal)}) mid-body${stderrDetail()}`));
 };
 proc.on("exit", (code, signal) => {
  exitState = { code, signal };
  if (!headersDone) {
   fail(new Error(`zen sidecar exited (${String(code ?? signal)}) before headers`));
   return;
  }
  finishStream();
 });
 let buf = Buffer.alloc(0);
 let frameConsumed = false;
 const onStdoutData = (chunk: Buffer): void => {
  if (frameConsumed) return;
  buf = Buffer.concat([buf, chunk]);
  const nl = buf.indexOf(0x0a);
  if (nl < 0) return;
  frameConsumed = true;
  let parsed: { status?: unknown; headers?: unknown };
  try {
   parsed = JSON.parse(buf.subarray(0, nl).toString("utf8")) as { status?: unknown; headers?: unknown };
  } catch {
   fail(new Error("zen sidecar bad header frame"));
   return;
  }
  if (typeof parsed.status !== "number" || !Number.isInteger(parsed.status) || parsed.status < 200 || parsed.status > 599) {
   fail(new Error("zen sidecar bad status"));
   return;
  }
  const status = parsed.status;
  const rest = buf.subarray(nl + 1);
  buf = Buffer.alloc(0);
  headersDone = true;
  clearTimeout(timer);
  stdout.off("data", onStdoutData);
  const nullBody = isNullBodyStatus(status);
  stream = new Readable({
   read() {
    // Backpressure: only resume the child pipe when the consumer wants more.
    if (!stdoutEnded) stdout.resume();
   },
  });
  const pushBody = (c: Buffer): void => {
   if (nullBody || stream === null) return;
   if (!stream.push(c)) stdout.pause();
  };
  stdout.on("data", (c: Buffer) => pushBody(c));
  stdout.on("end", () => {
   stdoutEnded = true;
   finishStream();
  });
  if (rest.length > 0) pushBody(rest);
  const rawHeaders = parsed.headers !== null && typeof parsed.headers === "object"
   ? parsed.headers as Record<string, string>
   : {};
  const headers = nullBody
   ? Object.fromEntries(Object.entries(rawHeaders).filter(([key]) => {
    const lower = key.toLowerCase();
    return lower !== "content-length" && lower !== "transfer-encoding";
   }))
   : rawHeaders;
  try {
   resolve(nullBody
    ? new Response(null, { status, headers })
    : new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers }));
  } catch (e) {
   fail(e);
  }
 };
 stdout.on("data", onStdoutData);
 stdout.on("error", (e: Error) => {
  if (headersDone) {
   finished = true;
   try { stream?.destroy(e); } catch { }
   return;
  }
  fail(e);
 });
 const frame = JSON.stringify({
  url,
  method: init.method,
  headers: init.headers,
  bodyB64: init.body.length > 0 ? init.body.toString("base64") : "",
  headerTimeoutMs,
 });
 stdin.on("error", () => { });
 stdin.end(frame, "utf8");
 return promise;
}
