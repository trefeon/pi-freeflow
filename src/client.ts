/**
 * Client-side daemon lifecycle for pi-freeflow.
 *
 * Every OMP/Pi session is a client. It attaches to the shared detached daemon
 * at 127.0.0.1:28180 (or spawns one if none is alive), registers a lease, and
 * renews it with a heartbeat while the session lives. When the session ends
 * the heartbeat stops; the daemon drops the lease after its TTL and retires
 * once no client holds a live lease for a grace window with nothing in flight
 * (request-idleness alone never retires it).
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as http from "node:http";
import {
 BASE_PORT_REPROBE_MS,
 BREAKER_FAILURES,
 BREAKER_HALT_MS,
 BREAKER_WINDOW_MS,
 BUSY_BYPASS_CONTINUOUS_MS,
 BUSY_BYPASS_QUIET_MS,
 DAEMON_CONTROL_TIMEOUT_MS,
 DAEMON_CONTROL_TIMEOUT_MS_ENV,
 DAEMON_HEARTBEAT_MS,
 DAEMON_HEARTBEAT_MS_ENV,
 DAEMON_READY_TIMEOUT_MS,
 DAEMON_RUNTIME_ENV,
 DAEMON_SPAWN_ENV,
 DAEMON_WATCHDOG_MS,
 DAEMON_WATCHDOG_MS_ENV,
 HOST,
 LOG_FILE,
 NO_KILL_ENV,
 OPENCODE_VERSION_TTL_MS,
 PKG_VERSION,
 PORT,
 RECOVERY_BACKOFF_BASE_MS,
 RECOVERY_BACKOFF_CAP_MS,
 refreshOpenCodeUserAgent,
 resolveDaemonSrcCacheDir,
} from "./config.ts";
import { logInfo, logWarn } from "./logger.ts";
import {
 getDaemonHealth,
 getDaemonVersion,
 isProxyAlive,
 isPortBound,
 killPortHolder,
 reprobeBasePortAlive,
 startProxy,
} from "./proxy.ts";
import { compareVersions } from "./update-core.ts";
import { isDaemonIdentityBody } from "./health.ts";
import type { DaemonHealthSnapshot } from "./health.ts";
import { tokenAuthHeaders } from "./token.ts";

const CLIENT_ID = randomUUID();

let attachedPort = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatPort = 0;
let ensuring = false;
/**
 * In-flight ensureDaemon() attempt. Every concurrent caller awaits this same
 * promise instead of guessing a port; ensureDaemon clears it on settle.
 */
let ensureInFlight: Promise<number> | null = null;
let fallbackServer: http.Server | null = null;
/** First tick (Date.now()) the daemon has looked continuously busy; 0 = idle. */
let busySince = 0;
/** Consecutive recovery attempts (backoff exponent n). Reset on healthy watchdog tick. */
let backoffAttempt = 0;
/** Timestamps of recent recovery failures (breaker window). */
let recoveryFailures: number[] = [];
/** Watchdog respawns halted until this time (breaker open). */
let breakerOpenUntil = 0;
/** Last wall-clock attempt of a background UA refresh; storm-guard for heartbeat cadence. */
let lastUaRefreshAt = 0;
/** Test-injected fetch for the background UA refresh; null = global fetch. */
let uaRefreshFetch: typeof fetch | null = null;

interface DaemonRuntime {
 execPath: string;
 args: string[];
 runtimeType: "bun" | "node";
}

/**
 * Detect whether an executable path is a JavaScript/TypeScript runtime (bun or node).
 * Rejects host binaries like omp, pi, electron, code, etc.
 */
export function isJsRuntimeExecutable(execPath: string): "bun" | "node" | null {
 if (!execPath || typeof execPath !== "string") return null;
 const checkName = (target: string): "bun" | "node" | null => {
  const base = path.basename(target.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/i, "");
  if (base === "bun" || base === "bunx") return "bun";
  if (base === "node" || base === "nodejs") return "node";
  return null;
 };

 const direct = checkName(execPath);
 if (direct) return direct;

 try {
  const real = fs.realpathSync(execPath);
  const realMatch = checkName(real);
  if (realMatch) return realMatch;
 } catch { }

 return null;
}

/**
 * Search directories in PATH for an executable matching name.
 * On Windows, tests extensions from PATHEXT (.exe, .cmd, .bat).
 * On POSIX, checks file existence and executable bit (X_OK).
 */
export function findExecutableOnPath(
 name: string,
 envPath: string = process.env.PATH || process.env.Path || "",
): string | null {
 if (!envPath || typeof envPath !== "string") return null;
 const dirs = envPath.split(path.delimiter).filter(Boolean);
 const hasExt = path.extname(name).length > 0;
 const extensions = process.platform === "win32"
  ? (hasExt ? [""] : (process.env.PATHEXT ? process.env.PATHEXT.split(";").filter(Boolean) : [".exe", ".cmd", ".bat"]))
  : [""];

 for (const dir of dirs) {
  for (const ext of extensions) {
   const candidate = ext ? path.join(dir, `${name}${ext}`) : path.join(dir, name);
   try {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) {
     if (process.platform !== "win32") {
      fs.accessSync(candidate, fs.constants.X_OK);
     }
     return candidate;
    }
   } catch { }
  }
 }
 return null;
}

/**
 * Resolve the executable and arguments needed to run src/daemon.ts.
 *
 * Priority order:
 * 1. Explicit override via opts.overrideExecPath or PI_FREEFLOW_DAEMON_RUNTIME env var.
 * 2. Current process.execPath (if and only if it is actually a node or bun executable).
 * 3. Search PATH for `bun` (preferred: native TypeScript support with zero flags).
 * 4. Search PATH for `node` (Node.js >= 22.6 with --experimental-strip-types).
 *
 * Returns null if no valid runtime is found (e.g. running as a standalone `omp` binary
 * without bun or node on PATH). The caller MUST fall back to an in-process proxy rather
 * than spawning an arbitrary binary (which would cause recursive agent fork-bombs).
 */
export function resolveDaemonRuntime(opts?: {
 overrideExecPath?: string;
 scriptPath?: string;
 envPath?: string;
 currentExecPath?: string;
}): DaemonRuntime | null {
 const script = opts?.scriptPath ?? daemonScriptPath();
 const envExec = opts?.overrideExecPath ?? (typeof process.env[DAEMON_RUNTIME_ENV] === "string" ? process.env[DAEMON_RUNTIME_ENV]?.trim() : undefined);

 // 1. Explicit override
 if (envExec) {
  const type = isJsRuntimeExecutable(envExec) ?? "node";
  const args = type === "bun" ? [script] : ["--experimental-strip-types", script];
  return { execPath: envExec, args, runtimeType: type };
 }

 // 2. Check current process.execPath
 const currentExec = opts?.currentExecPath ?? process.execPath;
 const currentType = isJsRuntimeExecutable(currentExec);
 if (currentType !== null) {
  const args = currentType === "bun" ? [script] : ["--experimental-strip-types", script];
  return { execPath: currentExec, args, runtimeType: currentType };
 }

 // 3. Current executable is not a JS runtime (e.g. omp, pi, electron).
 // Search PATH for bun first, then node.
 const pathVal = opts?.envPath ?? process.env.PATH ?? process.env.Path ?? "";

 const bunOnPath = findExecutableOnPath("bun", pathVal);
 if (bunOnPath) {
  return { execPath: bunOnPath, args: [script], runtimeType: "bun" };
 }

 const nodeOnPath = findExecutableOnPath("node", pathVal);
 if (nodeOnPath) {
  return {
   execPath: nodeOnPath,
   args: ["--experimental-strip-types", script],
   runtimeType: "node",
  };
 }

 return null;
}

function daemonScriptPath(): string {
 const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts");
 return process.platform === "win32" ? p.replace(/\\/g, "/") : p;
}

function getHeartbeatMs(): number {
 const raw = process.env[DAEMON_HEARTBEAT_MS_ENV];
 if (raw) {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
 }
 return DAEMON_HEARTBEAT_MS;
}

/** Per-OS loopback control-call timeout (Windows 3s, Linux 1.5s) unless overridden by env. */
export function getControlTimeoutMs(): number {
 const raw = process.env[DAEMON_CONTROL_TIMEOUT_MS_ENV];
 if (raw) {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
 }
 return DAEMON_CONTROL_TIMEOUT_MS;
}

function getWatchdogMs(): number {
 const raw = process.env[DAEMON_WATCHDOG_MS_ENV];
 if (raw) {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
 }
 return DAEMON_WATCHDOG_MS;
}

function isSpawnEnabled(): boolean {
 return process.env[DAEMON_SPAWN_ENV] !== "0";
}

type ControlResult = "ok" | "unknown" | "legacy" | "gone";

async function controlCall(
 port: number,
 endpoint: string,
 payload: Record<string, string>,
): Promise<ControlResult> {
 try {
  const res = await fetch(`http://${HOST}:${port}${endpoint}`, {
   method: "POST",
   headers: { "content-type": "application/json", ...tokenAuthHeaders() },
   body: JSON.stringify(payload),
   signal: AbortSignal.timeout(getControlTimeoutMs()),
  });
  if (!res.ok) return "legacy";
  try {
   const data: unknown = await res.json();
   if (data && typeof data === "object" && "ok" in data && data.ok === false) return "unknown";
  } catch { }
  return "ok";
 } catch {
  return "gone";
 }
}

/**
 * Fire-and-forget background refresh of the OpenCode User-Agent.
 * Called once at attach/startup and re-armed on the heartbeat cadence.
 * Never on the request hot path, never awaited, failures silent: the pinned
 * fallback keeps serving traffic offline and the 6h disk TTL keeps the live
 * version fresh. The in-process last-attempt timestamp (set synchronously
 * before firing) stops overlapping heartbeats from stampeding npm while a
 * fetch is still in flight.
 */
export function maybeRefreshOpenCodeUserAgent(): void {
 const now = Date.now();
 if (now - lastUaRefreshAt < OPENCODE_VERSION_TTL_MS) return;
 lastUaRefreshAt = now;
 try {
  void Promise.resolve(refreshOpenCodeUserAgent(uaRefreshFetch ?? fetch)).catch(() => { });
 } catch { }
}

/** Test seam: inject the fetch used by the background UA refresh. */
export function _setUaRefreshFetchForTest(fetchImpl: typeof fetch | null): void {
 uaRefreshFetch = fetchImpl;
}

/** Test seam: reset the UA refresh storm-guard (and injected fetch). */
export function _resetUaRefreshForTest(): void {
 lastUaRefreshAt = 0;
 uaRefreshFetch = null;
}

function startHeartbeat(port: number): void {
 stopHeartbeatInternal();
 heartbeatPort = port;
 const ms = getHeartbeatMs();
 heartbeatTimer = setInterval(() => {
  void beatOnce(port);
 }, ms);
 try {
  heartbeatTimer.unref();
 } catch { }
 const wms = getWatchdogMs();
 watchdogTimer = setInterval(() => {
  void watchdogCheck(port);
 }, wms);
 try {
  watchdogTimer.unref();
 } catch { }
}

function stopHeartbeatInternal(): void {
 if (heartbeatTimer !== null) {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
 }
 if (watchdogTimer !== null) {
  clearInterval(watchdogTimer);
  watchdogTimer = null;
 }
}

export function stopHeartbeat(): void {
 const port = heartbeatPort;
 stopHeartbeatInternal();
 heartbeatPort = 0;
 if (port) {
  void controlCall(port, "/_client/detach", { id: CLIENT_ID });
 }
 if (fallbackServer) {
  try {
   fallbackServer.close();
  } catch { }
  fallbackServer = null;
 }
}

async function beatOnce(port: number): Promise<void> {
 maybeRefreshOpenCodeUserAgent();
 if (ensuring) return;
 const result = await controlCall(port, "/_client/heartbeat", { id: CLIENT_ID });
 if (result === "gone") {
  void ensureDaemon().catch((e) => logWarn("heartbeat respawn failed", { error: String(e) }));
 } else if (result === "unknown") {
  // Daemon restarted since attach: re-register our lease.
  await attachTo(port);
 }
}

async function attachTo(port: number): Promise<void> {
 attachedPort = port;
 const result = await controlCall(port, "/_client/attach", { id: CLIENT_ID });
 if (result === "gone") {
  return;
 }
 startHeartbeat(port);
 maybeRefreshOpenCodeUserAgent();
}

/**
 * Respawn backoff: min(2s * 2^n, 60s) + jitter. n is the consecutive-failure
 * count; pass jitterMs = 0 in tests for a deterministic base.
 */
export function computeRecoveryBackoffMs(attempt: number, jitterMs = Math.random() * 500): number {
 const n = Math.max(0, Math.floor(attempt));
 const base = Math.min(RECOVERY_BACKOFF_BASE_MS * 2 ** n, RECOVERY_BACKOFF_CAP_MS);
 return base + Math.max(0, jitterMs);
}

/**
 * Stuck-busy check (pure, testable): a busy daemon may only be replaced after
 * 5min of continuous busy AND zero forwarded stream bytes for 60s+. Anything
 * else must be left untouched mid-request.
 */
export function isStuckBusy(busySinceMs: number, lastBytesAt: number, now = Date.now()): boolean {
 if (!busySinceMs) return false;
 if (now - busySinceMs < BUSY_BYPASS_CONTINUOUS_MS) return false;
 if (lastBytesAt && now - lastBytesAt < BUSY_BYPASS_QUIET_MS) return false;
 return true;
}

/** Track the busy/idle edge from a health snapshot; returns the updated busySince. */
export function trackBusyEdge(activeRequests: number, lastBytesAt: number, now = Date.now()): number {
 if (activeRequests > 0) {
  if (!busySince) busySince = now;
 } else {
  busySince = 0;
 }
 return busySince;
}

/** True while the breaker halt is in effect (respawns paused, fallback serves). */
export function isBreakerHalted(now = Date.now()): boolean {
 return now < breakerOpenUntil;
}

/** Record a recovery failure; opens the breaker after 5 straight failures in 5min. */
export function recordRecoveryFailure(now = Date.now()): boolean {
 recoveryFailures.push(now);
 recoveryFailures = recoveryFailures.filter((t) => now - t <= BREAKER_WINDOW_MS);
 backoffAttempt += 1;
 if (recoveryFailures.length >= BREAKER_FAILURES) {
  breakerOpenUntil = now + BREAKER_HALT_MS;
  logWarn("recovery breaker open — 5 straight failures in 5min, halting respawn for 10min (in-process fallback meanwhile)");
  return true;
 }
 return false;
}

/** Record a healthy watchdog tick: clears the straight-failure run and backoff. */
export function recordRecoverySuccess(): void {
 recoveryFailures = [];
 backoffAttempt = 0;
 breakerOpenUntil = 0;
}

/** Test seam: snapshot of the recovery counters. */
export function _getRecoveryStateForTest(): {
 backoffAttempt: number;
 failures: number[];
 breakerOpenUntil: number;
 busySince: number;
} {
 return { backoffAttempt, failures: [...recoveryFailures], breakerOpenUntil, busySince };
}

/** Test seam: reset recovery counters without touching timers. */
export function _resetRecoveryForTest(): void {
 backoffAttempt = 0;
 recoveryFailures = [];
 breakerOpenUntil = 0;
 busySince = 0;
}

/** Recovery-decision shape; canonical definition lives in health.ts. */
export type HealthForRecovery = DaemonHealthSnapshot;

/**
 * Older-version guard: only a daemon strictly older than this build is worth
 * recovering. shouldReplaceDaemon deliberately leaves a NEWER daemon running,
 * so recovering from one could never succeed (watchdog → recover → refused →
 * reattach → watchdog, until the breaker parks into the in-process fallback).
 * Null/undefined version (pre-version daemon) is not older on its own.
 */
function isOlderDaemonVersion(version: string | null | undefined): boolean {
 return version != null && compareVersions(version, PKG_VERSION) < 0;
}

/**
 * Watchdog decision matrix (pure, testable). Recover when the daemon is gone,
 * serves an older version, or reports a degraded failed-SSE window. Missing
 * sseDegraded (pre-window daemon) never triggers on its own.
 */
export function shouldRecoverOnHealth(health: HealthForRecovery): boolean {
 if (health === null) return true;
 if (isOlderDaemonVersion(health.version)) return true;
 if (health.sseDegraded === true) return true;
 return false;
}

async function ensureInProcessFallback(): Promise<number> {
 try {
  const r = await startProxy();
  if (r.server) fallbackServer = r.server;
  await attachTo(r.port);
  return r.port;
 } catch (e) {
  logWarn("in-process fallback bind failed", { error: String(e) });
  return PORT;
 }
}

async function triggerRecovery(port: number, why: string): Promise<void> {
 if (ensuring) return;
 ensuring = true;
 try {
  const now = Date.now();
  if (isBreakerHalted(now)) {
   logWarn(`recovery breaker halted — serving in-process fallback meanwhile (${why})`);
   void ensureInProcessFallback();
   return;
  }
  const opened = recordRecoveryFailure(now);
  if (opened) {
   void ensureInProcessFallback();
   return;
  }
  const delay = computeRecoveryBackoffMs(backoffAttempt - 1);
  logWarn(`watchdog recovery (${why}) — backing off ${Math.round(delay)}ms before respawn`);
  stopHeartbeatInternal();
  heartbeatPort = 0;
  await new Promise<void>((r) => setTimeout(r, delay));
  try {
   const health = await getDaemonHealth(port);
   if (health && (health.activeRequests ?? 0) > 0) {
    trackBusyEdge(health.activeRequests ?? 0, health.lastBytesAt ?? 0, Date.now());
    if (!isStuckBusy(busySince, health.lastBytesAt ?? 0, Date.now())) {
     logInfo(`watchdog recovery deferred — daemon busy (${health.activeRequests} active, waiting for 5min-stuck + 60s-quiet)`);
     await attachTo(port);
     return;
    }
   }
   const ver = health?.version ?? PKG_VERSION;
   await killStaleDaemon(port, ver, "proxy daemon");
  } catch (e) {
   logWarn("watchdog pre-respawn probe failed", { error: String(e) });
  }
  // Release before delegating: ensureDaemon owns the flag from here (it
  // early-returns while ensuring is true). The handoff is synchronous up
  // to ensureDaemon's own ensuring=true, so no tick slips between.
  ensuring = false;
  await ensureDaemon();
 } finally {
  ensuring = false;
 }
}

/**
 * 5s watchdog tick: polls /_health for version + failed-SSE rate and drives
 * stopHeartbeat → busy-ruled kill → ensureDaemon when the daemon is stale or
 * degraded. Healthy ticks reset backoff/breaker and track the busy edge.
 */
async function watchdogCheck(port: number): Promise<void> {
 if (ensuring) return;
 if (isBreakerHalted()) return;
 let health: Awaited<ReturnType<typeof getDaemonHealth>>;
 try {
  health = await getDaemonHealth(port);
 } catch {
  return;
 }
 if (health === null) {
  await new Promise<void>((r) => setTimeout(r, 200));
  try {
   health = await getDaemonHealth(port);
  } catch {
   return;
  }
 }
 if (health && (health.activeRequests ?? 0) > 0) {
  trackBusyEdge(health.activeRequests ?? 0, health.lastBytesAt ?? 0);
 } else {
  trackBusyEdge(0, 0);
 }
 if (!shouldRecoverOnHealth(health)) {
  recordRecoverySuccess();
  return;
 }
 if (health && (health.activeRequests ?? 0) > 0 && !isStuckBusy(busySince, health.lastBytesAt ?? 0)) return;
 void triggerRecovery(port, health === null ? "daemon gone" : isOlderDaemonVersion(health.version) ? `stale v${health.version}` : "failed-SSE degraded").catch((e) => logWarn("watchdog recovery failed", { error: String(e) }));
}

async function shouldReplaceDaemon(port: number, remoteVer: string): Promise<boolean> {
 if (NO_KILL_ENV && process.env[NO_KILL_ENV] === "1") {
  logInfo(
   `Reusing existing pi-freeflow proxy daemon on http://${HOST}:${port} (replacement disabled by env)`,
  );
  return false;
 }
 if (compareVersions(remoteVer, PKG_VERSION) > 0) {
  logInfo(
   `Reusing existing pi-freeflow proxy daemon on http://${HOST}:${port} (newer daemon v${remoteVer} left running)`,
  );
  return false;
 }
 const health = await getDaemonHealth(port);
 if (health === null || health.activeRequests === undefined) {
  logInfo(
   `Reusing existing pi-freeflow proxy daemon on http://${HOST}:${port} (cannot verify usage — leaving the running daemon untouched)`,
  );
  return false;
 }
 if (health.activeRequests > 0) {
  trackBusyEdge(health.activeRequests, health.lastBytesAt ?? 0);
  if (!isStuckBusy(busySince, health.lastBytesAt ?? 0)) {
   logInfo(
    `Reusing existing pi-freeflow proxy daemon on http://${HOST}:${port} (${health.activeRequests} active request${health.activeRequests === 1 ? "" : "s"} — not interrupted)`,
   );
   return false;
  }
  logWarn(`busy daemon on :${port} stuck (busy 5min+, no forwarded bytes 60s+) — bypassing busy guard`);
  return true;
 }
 busySince = 0;
 return true;
}

async function killStaleDaemon(
 port: number,
 remoteVer: string,
 what: string,
): Promise<boolean> {
 if (!(await shouldReplaceDaemon(port, remoteVer))) return false;
 logWarn(`stale ${what} v${remoteVer} on :${port} (need v${PKG_VERSION}) — replacing`, {
  remoteVer,
  expected: PKG_VERSION,
 });
 await killPortHolder(port);
 for (let i = 0; i < 15; i++) {
  await new Promise<void>((r) => setTimeout(r, 100));
  if (!(await isProxyAlive(port))) {
   lastSpawnAt = 0;
   return true;
  }
 }
 logInfo(
  `Reusing existing pi-freeflow proxy daemon on http://${HOST}:${port} (stale kill did not free port)`,
 );
 return false;
}
/**
 * Open the shared log file for the detached daemon's stdout/stderr so a
 * native abort or crash leaves its reason on disk instead of vanishing into
 * stdio "ignore". Returns the fd, or null when the file is unavailable
 * (the spawn then falls back to ignore).
 */
function openDaemonLogFd(): number | null {
 try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  return fs.openSync(LOG_FILE, "a");
 } catch {
  return null;
 }
}

type DarkHolderProbe = {
 /** True when GET /health identifies a pi-freeflow daemon on the port. */
 alive: boolean;
 /** True when a TCP connection to the port succeeds (something holds it). */
 bound: boolean;
 /**
  * True when GET /health answers in OUR daemon's identity shape (service +
  * the bound port). A stranger squatting the loopback port can answer `{}` or
  * arbitrary JSON: that is not a daemon of ours, whatever it claims.
  */
 healthOurs: boolean;
};

/**
 * True when a /health response body carries OUR daemon's identity: the
 * pi-freeflow service marker plus the port it is bound to (src/health.ts
 * builds both from the listening socket). Anything else is a stranger on the
 * loopback port — attaching to it would route the user's prompts into a
 * process we do not own, so it must never be read as a daemon.
 */
export function isOurDaemonHealthBody(port: number, body: unknown): boolean {
 return isDaemonIdentityBody(port, body);
}

/**
 * Probe whatever holds `port` for the three facts the reclaim decision needs.
 * Ordered cheap-to-expensive and short-circuiting exactly like the inline
 * sequence it replaces: an identity-answering daemon is live, a refused port
 * is free, and only a bound-but-silent holder is asked again with a longer
 * budget (a slow daemon still counts as ours).
 */
export async function probeDarkHolder(port: number): Promise<DarkHolderProbe> {
 if (await isProxyAlive(port)) return { alive: true, bound: true, healthOurs: true };
 if (!(await isPortBound(port))) return { alive: false, bound: false, healthOurs: false };
 return { alive: false, bound: true, healthOurs: await probeOurHealth(port) };
}

/**
 * Fetch GET /health and keep the verdict only when the body is OUR daemon's
 * identity shape. Same request as proxy.isProxyAlive but with the longer
 * daemon budget, so a slow-but-ours daemon is not mistaken for a stranger.
 */
async function probeOurHealth(port: number): Promise<boolean> {
 if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
 try {
  const res = await fetch(`http://${HOST}:${port}/health`, {
   signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) return false;
  return isDaemonIdentityBody(port, await res.json());
 } catch {
  return false;
 }
}

/**
 * Pure decision: reclaim a base port that is actually held (TCP connect
 * succeeds) yet does not answer GET /health in OUR identity shape. A live
 * daemon — stale, busy, even mid-stream — always answers it from its event
 * loop, so a dark holder cannot be serving traffic and replacing it cannot
 * interrupt a real stream. A FREE port is not a dark holder: treating it as
 * one cost a blind ~2s kill-and-poll on every cold start (issue #52). A holder
 * answering /health with anything but our identity (a stranger's `{}`) is
 * dark: it is not a daemon of ours, so it is reclaimed rather than attached to.
 */
export function shouldReclaimDarkHolder(probe: DarkHolderProbe): boolean {
 if (probe.alive) return false;
 if (!probe.bound) return false;
 if (probe.healthOurs) return false;
 return true;
}

/**
 * Dislodge a dark holder from the base port so a fresh daemon can bind it.
 * Returns true when a healthy proxy answers afterwards (attach to it); false
 * when the caller should spawn fresh (the port is free — nothing to reclaim).
 * Honors the no-kill env opt-out; a live holder is never touched here — the
 * stale-replace path owns versioned daemons.
 */
async function reclaimDarkHolder(port: number): Promise<boolean> {
 const probe = await probeDarkHolder(port);
 if (probe.alive) return true;
 if (!probe.bound) return false; // port is free — spawn fresh
 if (!shouldReclaimDarkHolder(probe)) return true;
 if (NO_KILL_ENV && process.env[NO_KILL_ENV] === "1") {
  logInfo(
   `proxy on :${port} answers neither our health nor models — leaving it alone (replacement disabled by env)`,
  );
  return false;
 }
 logWarn(`proxy on :${port} holds the port but answers nothing of ours — replacing dark holder`);
 await killPortHolder(port);
 for (let i = 0; i < 10; i++) {
  await new Promise<void>((r) => setTimeout(r, 200));
  if (await isProxyAlive(port)) return true;
 }
 if (await isPortBound(port)) {
  logWarn(`port :${port} is still held by a process we could not (and must not) kill — starting the in-process proxy instead`);
 }
 return false;
}

function mentionsLoopback(text: string): boolean {
 return text.includes("127.0.0.1") || text.includes("::1") || text.includes("localhost");
}

/**
 * True when a fetch failure is a refused loopback connection — the local
 * proxy is gone, not the upstream. Walks the undici cause chain, so both
 * bare { code: "ECONNREFUSED" } errors and "fetch failed" wrappers classify.
 */
export function isLoopbackRefused(err: unknown): boolean {
 let refused = false;
 let loopback = false;
 const seen = new Set<unknown>();
 const stack: unknown[] = [err];
 while (stack.length > 0) {
  const cur = stack.pop();
  if (typeof cur === "string") {
   if (mentionsLoopback(cur)) loopback = true;
   continue;
  }
  if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
  seen.add(cur);
  const rec = cur as Record<string, unknown>;
  if (rec.code === "ECONNREFUSED") refused = true;
  if (typeof rec.message === "string" && mentionsLoopback(rec.message)) loopback = true;
  if (typeof rec.host === "string" && mentionsLoopback(rec.host)) loopback = true;
  if (typeof rec.address === "string" && mentionsLoopback(rec.address)) loopback = true;
  if (rec.cause !== undefined) stack.push(rec.cause);
 }
 return refused && loopback;
}

/**
 * Explicit proxy-down message: names the loopback port and the recovery
 * action. Used wherever a refused loopback would otherwise surface as a
 * per-model connect failure.
 */
export function proxyDownMessage(port: number): string {
 return (
  `pi-freeflow proxy is down on 127.0.0.1:${port} (connection refused) — ` +
  `model requests cannot reach the local proxy until it is back. ` +
  `Start a new session or run /freeflow to respawn it.`
 );
}

type ProxyReadiness = { ok: true; port: number } | { ok: false; port: number; reason: string };

/**
 * Health probe before requests: when the loopback answers, no respawn runs.
 * When it refuses, one bounded respawn retry runs, then an explicit
 * proxy-down result — never a silent per-model connect failure.
 * The respawn seam defaults to the full daemon ensure; tests inject a fake.
 */
export async function ensureProxyReady(
 port: number,
 respawn: () => Promise<number> = ensureDaemon,
): Promise<ProxyReadiness> {
 if (await isProxyAlive(port)) return { ok: true, port };
 let next = port;
 try {
  next = await respawn();
 } catch (e) {
  logWarn("proxy respawn failed", { error: String(e) });
 }
 if (await isProxyAlive(next)) return { ok: true, port: next };
 if (next !== port && (await isProxyAlive(port))) return { ok: true, port };
 return { ok: false, port, reason: proxyDownMessage(port) };
}

/** True when any path segment of `filePath` is `node_modules`. Node refuses to
 * strip types for files under such a path (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
 * so a Node-spawned daemon must run from a staged copy elsewhere. */
function isUnderNodeModules(filePath: string): boolean {
 return filePath.split(/[\\/]/).includes("node_modules");
}

function readPackageJsonObject(dir: string): Record<string, unknown> | null {
 try {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
 } catch {
  return null;
 }
}

/** Resolve a dependency's package directory the way Node would: walk up the
 *  node_modules chain from the importing package's root. */
function resolvePackageDir(name: string, fromDir: string): string | null {
 let dir = fromDir;
 for (; ;) {
  const pkgJson = path.join(dir, "node_modules", name, "package.json");
  if (fs.existsSync(pkgJson)) return path.dirname(pkgJson);
  const parent = path.dirname(dir);
  if (parent === dir) return null;
  dir = parent;
 }
}

/** Link (or copy, when linking is unavailable) each runtime dependency beside
 *  the staged sources so bare imports such as `undici` still resolve. */
function stageRuntimeDependencies(pkgRoot: string, pkgJson: Record<string, unknown>, stagedDir: string): void {
 const deps = pkgJson.dependencies;
 if (!deps || typeof deps !== "object") return;
 const nodeModulesDir = path.join(stagedDir, "node_modules");
 for (const name of Object.keys(deps as Record<string, unknown>)) {
  const target = resolvePackageDir(name, pkgRoot);
  if (target === null) {
   logWarn("daemon dependency not found for staging", { dependency: name });
   continue;
  }
  try {
   fs.mkdirSync(nodeModulesDir, { recursive: true });
   // Junction on Windows (no elevated privileges needed); dir symlink elsewhere.
   fs.symlinkSync(target, path.join(nodeModulesDir, name), process.platform === "win32" ? "junction" : "dir");
  } catch {
   try {
    fs.cpSync(target, path.join(nodeModulesDir, name), { recursive: true, dereference: true });
   } catch (e) {
    logWarn("daemon dependency staging failed", { dependency: name, error: String(e) });
   }
  }
 }
}

/** Best-effort prune of staged daemon sources from earlier versions (1 day TTL). */
function pruneStaleDaemonSrcDirs(root: string, currentVersion: string): void {
 try {
  const now = Date.now();
  for (const entry of fs.readdirSync(root)) {
   if (entry === currentVersion) continue;
   const full = path.join(root, entry);
   try {
    if (now - fs.statSync(full).mtimeMs > 24 * 60 * 60 * 1000) {
     fs.rmSync(full, { recursive: true, force: true });
    }
   } catch { }
  }
 } catch { }
}

/**
 * Materialize the daemon's sources outside node_modules so a Node runtime can
 * execute `src/daemon.ts` (Node refuses type stripping for any file under a
 * node_modules path, and this package ships TypeScript sources). Copies
 * `src/` + `package.json` into a per-version cache directory, stages the
 * runtime dependencies beside them, and returns the staged daemon entry.
 * Returns the input path unchanged when the script is already outside
 * node_modules (dev checkouts) or the package root is unreadable.
 */
export function materializeDaemonSources(scriptPath: string, cacheDir?: string): string {
 if (!isUnderNodeModules(scriptPath)) return scriptPath;
 const pkgRoot = path.dirname(path.dirname(scriptPath));
 const pkgJson = readPackageJsonObject(pkgRoot);
 const version = pkgJson !== null && typeof pkgJson.version === "string" ? pkgJson.version : "";
 if (pkgJson === null || !version) return scriptPath;

 const root = cacheDir ?? resolveDaemonSrcCacheDir();
 const finalDir = path.join(root, version);
 const finalEntry = path.join(finalDir, "src", "daemon.ts");
 if (fs.existsSync(finalEntry) && fs.existsSync(path.join(finalDir, "package.json"))) {
  pruneStaleDaemonSrcDirs(root, version);
  return finalEntry;
 }

 const tmpDir = `${finalDir}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
 try {
  fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  fs.cpSync(path.join(pkgRoot, "src"), path.join(tmpDir, "src"), { recursive: true });
  fs.copyFileSync(path.join(pkgRoot, "package.json"), path.join(tmpDir, "package.json"));
  stageRuntimeDependencies(pkgRoot, pkgJson, tmpDir);
  try {
   fs.renameSync(tmpDir, finalDir);
   logInfo(`staged proxy daemon sources outside node_modules at ${finalDir}`);
  } catch (e) {
   // A concurrent starter won the rename (or the dir appeared meanwhile):
   // its copy is byte-identical for the same version, so reuse it.
   try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
   } catch { }
   if (!fs.existsSync(finalEntry)) {
    logWarn("daemon source staging failed", { error: String(e), dir: finalDir });
    return scriptPath;
   }
  }
 } catch (e) {
  try {
   fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { }
  logWarn("daemon source staging failed — spawning from the installed path", { error: String(e), dir: tmpDir });
  return scriptPath;
 }
 pruneStaleDaemonSrcDirs(root, version);
 return finalEntry;
}

interface DaemonChild {
 pid?: number;
 exitCode: number | null;
 signalCode: string | null;
 unref(): void;
 on(event: "error", listener: (err: Error) => void): unknown;
}

type DaemonSpawner = (
 command: string,
 args: string[],
 options: Parameters<typeof spawn>[2],
) => DaemonChild;

let daemonSpawner: DaemonSpawner = spawn;
/** Children that failed to launch (spawn error) — the ready-wait treats them as exited. */
const failedDaemonSpawns = new WeakSet<DaemonChild>();

/** Test seam: replace the child spawner used for detached daemon starts. */
export function _setDaemonSpawnForTest(spawner: DaemonSpawner | null): void {
 daemonSpawner = spawner ?? spawn;
}

/** True once a spawned daemon child has exited (exit code or signal). */
export function hasChildExited(child: Pick<DaemonChild, "exitCode" | "signalCode">): boolean {
 return child.exitCode !== null || child.signalCode !== null;
}

let lastSpawnAt = 0;
const SPAWN_THROTTLE_MS = 2_000;

function spawnDaemonProcess(): DaemonChild | null {
 const now = Date.now();
 if (now - lastSpawnAt < SPAWN_THROTTLE_MS) {
  logWarn("daemon spawn throttled — recent spawn still pending");
  return null;
 }
 const runtime = resolveDaemonRuntime();
 if (!runtime) {
  logWarn(
   `cannot spawn detached proxy daemon: no node or bun runtime found (process.execPath "${process.execPath}" is not a JS runtime) — falling back to in-process proxy`,
  );
  return null;
 }
 // Node refuses to strip types for files under node_modules, so stage the
 // sources elsewhere before spawning with a Node runtime (issue #52).
 const scriptArg = runtime.args[runtime.args.length - 1] ?? "";
 const stagedScript = runtime.runtimeType === "node" ? materializeDaemonSources(scriptArg) : scriptArg;
 const args = stagedScript === scriptArg ? runtime.args : [...runtime.args.slice(0, -1), stagedScript];
 lastSpawnAt = now;
 const logFd = openDaemonLogFd();
 try {
  const child = daemonSpawner(runtime.execPath, args, {
   detached: true,
   stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
   windowsHide: true,
   env: {
    ...process.env,
    [DAEMON_SPAWN_ENV]: "0",
   },
  });
  child.unref();
  logInfo(
   `spawned proxy daemon process (pid ${child.pid ?? "unknown"}) using ${runtime.runtimeType} (${runtime.execPath}) for :${PORT}${stagedScript === scriptArg ? "" : " [staged sources]"}`,
  );
  child.on("error", (err) => {
   failedDaemonSpawns.add(child);
   logWarn("daemon spawn failed", { error: String(err), execPath: runtime.execPath });
  });
  return child;
 } catch (e) {
  logWarn("daemon spawn failed", { error: String(e), execPath: runtime.execPath });
  return null;
 } finally {
  if (logFd !== null) {
   try {
    fs.closeSync(logFd);
   } catch { }
  }
 }
}

export async function waitForReady(
 port: number,
 timeoutMs: number,
 child?: DaemonChild | null,
): Promise<boolean> {
 const deadline = Date.now() + timeoutMs;
 while (Date.now() < deadline) {
  if (await isProxyAlive(port, 150)) return true;
  if (child && (hasChildExited(child) || failedDaemonSpawns.has(child))) {
   logWarn("daemon child exited before becoming ready", {
    port,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
   });
   return false;
  }
  await new Promise<void>((r) => setTimeout(r, 80));
 }
 return false;
}

async function probeAndMaybeReplace(
 port: number,
 label: string,
 probeTimeoutMs = 150,
): Promise<number | null> {
 if (!(await isProxyAlive(port, probeTimeoutMs))) return null;
 const ver = await getDaemonVersion(port);
 if (ver !== null && ver !== PKG_VERSION) {
  logWarn(`detected proxy daemon version mismatch: running v${ver}, required v${PKG_VERSION} — auto-restarting`);
  await killStaleDaemon(port, ver, label);
  lastSpawnAt = 0;
  return null;
 }
 return port;
}

/**
 * Ensure a proxy daemon is running and attach this client to it.
 * Returns the port the caller should use for its ProviderConfig.
 */
export async function ensureDaemon(): Promise<number> {
 if (ensureInFlight) return ensureInFlight;
 if (ensuring) return attachedPort || PORT;
 ensuring = true;
 const attempt = ensureDaemonAttempt();
 ensureInFlight = attempt;
 try {
  return await attempt;
 } finally {
  if (ensureInFlight === attempt) ensureInFlight = null;
  ensuring = false;
 }
}

/**
 * One ensure/attach attempt: probe → attach → spawn → dark-holder reclaim →
 * in-process fallback. Split out of ensureDaemon so concurrent callers share
 * the same promise instead of reading a half-settled port. Keeps `ensuring`
 * latched for the whole attempt so the heartbeat/watchdog/recovery ticks stay
 * out of the way (they early-return on it).
 */
async function ensureDaemonAttempt(): Promise<number> {
  const primary = await probeAndMaybeReplace(PORT, "proxy daemon");
  if (primary !== null) {
   await attachTo(primary);
   return primary;
  }


  if (isSpawnEnabled()) {
   const child = spawnDaemonProcess();
   if (child) {
    const ready = await waitForReady(PORT, DAEMON_READY_TIMEOUT_MS, child);
    if (ready) {
     const ver = await getDaemonVersion(PORT);
     if (ver !== null && ver !== PKG_VERSION) {
      if (await killStaleDaemon(PORT, ver, "proxy daemon")) {
       lastSpawnAt = 0; // kill-confirmed retry bypasses the spawn throttle
       const retryChild = spawnDaemonProcess();
       if (retryChild) {
        const retryReady = await waitForReady(PORT, DAEMON_READY_TIMEOUT_MS, retryChild);
        if (retryReady) {
         await attachTo(PORT);
         return PORT;
        }
       }
      } else if (await isProxyAlive(PORT)) {
       await attachTo(PORT);
       return PORT;
      }
     } else {
      await attachTo(PORT);
      return PORT;
     }
    } else {
     // The spawn never answered: the child exited before binding (e.g. Node
     // refusing type stripping under a node_modules path) or a dark holder
     // owns the base port (bind fails, probes fail).
     if (await reclaimDarkHolder(PORT)) {
      await attachTo(PORT);
      return PORT;
     }
     logWarn("daemon spawn did not become ready — child exited or the port is blocked");
    }
   }
   // Fall through to the in-process fallback below — never hand the caller
   // a port we did not attach to (no lease, no heartbeat).
  }

  try {
   const r = await startProxy();
   if (r.server) fallbackServer = r.server;
   let port = r.port;
   if (port !== PORT && r.server) {
    // Walked-port guard: the base port may have freed during the
    // 3s bind race. Re-probe :28180 before settling on port+1 so
    // parallel startups converge instead of stranding followers.
    if (await reprobeBasePortAlive(PORT, BASE_PORT_REPROBE_MS)) {
     try {
      r.server.close();
     } catch { }
     if (fallbackServer === r.server) fallbackServer = null;
     logInfo(`base port ${PORT} freed during walk — re-attaching to :${PORT} instead of :${port}`);
     await attachTo(PORT);
     return PORT;
    }
   }
   await attachTo(port);
   return port;
  } catch (e) {
   logWarn("in-process fallback bind failed", { error: String(e) });
   return PORT;
  }
}

export function getClientPort(): number {
 return attachedPort || PORT;
}

export function hasFallbackServer(): boolean {
 return fallbackServer !== null;
}

export function _resetClientForTest(): void {
 stopHeartbeatInternal();
 heartbeatPort = 0;
 attachedPort = 0;
 ensuring = false;
 ensureInFlight = null;
 lastSpawnAt = 0;
 daemonSpawner = spawn;
 _resetUaRefreshForTest();
 _resetRecoveryForTest();
 if (fallbackServer) {
  try {
   fallbackServer.close();
  } catch { }
  fallbackServer = null;
 }
}
