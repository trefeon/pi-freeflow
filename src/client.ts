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
import type * as http from "node:http";
import {
 BASE_PORT_REPROBE_MS,
 DAEMON_CONTROL_TIMEOUT_MS,
 DAEMON_CONTROL_TIMEOUT_MS_ENV,
 DAEMON_HEARTBEAT_MS,
 DAEMON_HEARTBEAT_MS_ENV,
 DAEMON_READY_TIMEOUT_MS,
 DAEMON_SPAWN_ENV,
 DAEMON_WATCHDOG_MS,
 DAEMON_WATCHDOG_MS_ENV,
 HOST,
 LOG_FILE,
 NO_KILL_ENV,
 OPENCODE_VERSION_TTL_MS,
 PKG_VERSION,
 PORT,
 refreshOpenCodeUserAgent,
 ZEN_TRANSPORT_ENV,
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
import { tokenAuthHeaders } from "./token.ts";
import {
 daemonScriptPath,
 findExecutableOnPath,
 findSupportedNodeOnPath,
 isJsRuntimeExecutable,
 isUnderNodeModules,
 materializeDaemonSources,
 pruneStaleDaemonSrcDirs,
 readPackageJsonObject,
 resolveDaemonRuntime,
 resolvePackageDir,
 stageRuntimeDependencies,
 type DaemonRuntime,
} from "./client-staging.ts";
import {
 computeRecoveryBackoffMs,
 getBusySince,
 isBreakerHalted,
 isOlderDaemonVersion,
 isStuckBusy,
 recordRecoveryFailure,
 recordRecoverySuccess,
 resetBusySince,
 shouldRecoverOnHealth,
 trackBusyEdge,
 triggerRecovery,
 watchdogCheck,
 _getRecoveryStateForTest,
 _resetRecoveryForTest,
 type HealthForRecovery,
 type RecoveryDeps,
} from "./client-recovery.ts";

export {
 daemonScriptPath,
 findExecutableOnPath,
 findSupportedNodeOnPath,
 isJsRuntimeExecutable,
 isUnderNodeModules,
 materializeDaemonSources,
 pruneStaleDaemonSrcDirs,
 readPackageJsonObject,
 resolveDaemonRuntime,
 resolvePackageDir,
 stageRuntimeDependencies,
 type DaemonRuntime,
};

export {
 computeRecoveryBackoffMs,
 getBusySince,
 isBreakerHalted,
 isOlderDaemonVersion,
 isStuckBusy,
 recordRecoveryFailure,
 recordRecoverySuccess,
 resetBusySince,
 shouldRecoverOnHealth,
 trackBusyEdge,
 triggerRecovery,
 watchdogCheck,
 _getRecoveryStateForTest,
 _resetRecoveryForTest,
 type HealthForRecovery,
 type RecoveryDeps,
};

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
/** Last wall-clock attempt of a background UA refresh; storm-guard for heartbeat cadence. */
let lastUaRefreshAt = 0;
/** Test-injected fetch for the background UA refresh; null = global fetch. */
let uaRefreshFetch: typeof fetch | null = null;

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
  void watchdogCheck(port, recoveryDeps);
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

export async function stopHeartbeat(): Promise<void> {
 const port = heartbeatPort;
 const hadFallback = fallbackServer !== null;
 stopHeartbeatInternal();
 heartbeatPort = 0;
 if (fallbackServer) {
  try {
   fallbackServer.closeIdleConnections?.();
   fallbackServer.closeAllConnections?.();
   fallbackServer.close();
  } catch { }
  fallbackServer = null;
 }
 if (port && !hadFallback) {
  try {
   await controlCall(port, "/_client/detach", { id: CLIENT_ID });
  } catch { }
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

async function attachTo(port: number): Promise<boolean> {
 attachedPort = port;
 const result = await controlCall(port, "/_client/attach", { id: CLIENT_ID });
 if (result === "gone") {
  return false;
 }
 startHeartbeat(port);
 maybeRefreshOpenCodeUserAgent();
 return true;
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

const recoveryDeps: RecoveryDeps = {
 isEnsuring: () => ensuring,
 setEnsuring: (val: boolean) => {
  ensuring = val;
 },
 ensureInProcessFallback,
 stopHeartbeatInternal,
 resetHeartbeatPort: () => {
  heartbeatPort = 0;
 },
 attachTo: async (p: number) => { await attachTo(p); },
 killStaleDaemon: (p, v, w) => killStaleDaemon(p, v, w),
 ensureDaemon: () => ensureDaemon(),
 getDaemonHealth: (p: number) => getDaemonHealth(p),
};

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
  const currentBusy = trackBusyEdge(health.activeRequests, health.lastBytesAt ?? 0);
  if (!isStuckBusy(currentBusy, health.lastBytesAt ?? 0)) {
   logInfo(
    `Reusing existing pi-freeflow proxy daemon on http://${HOST}:${port} (${health.activeRequests} active request${health.activeRequests === 1 ? "" : "s"} — not interrupted)`,
   );
   return false;
  }
  logWarn(`busy daemon on :${port} stuck (busy 5min+, no forwarded bytes 60s+) — bypassing busy guard`);
  return true;
 }
 resetBusySince();
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
  const child = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(runtime.execPath) && daemonSpawner === spawn
   ? daemonSpawner(`"${runtime.execPath}" ${args.map((a) => `"${a}"`).join(" ")}`, [], {
    detached: true,
    stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
    windowsHide: true,
    shell: true,
    env: {
     ...process.env,
     [DAEMON_SPAWN_ENV]: "0",
    },
   })
   : daemonSpawner(runtime.execPath, args, {
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
  child.on("error", (err: Error) => {
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

/**
 * True when the running daemon's zenTransport snapshot disagrees with this
 * client's PI_FREEFLOW_ZEN_TRANSPORT env setting. A daemon started with
 * PI_FREEFLOW_ZEN_TRANSPORT=bun-sidecar reports mode "bun-sidecar" or
 * reason "bun-absent" / "bun-probe-failed" (never "transport-flag-off"),
 * so a missing/broken Bun binary does not trigger a respawn loop.
 */
export function isZenTransportEnvMismatch(
 daemonZenTransport: { mode: string; bunVersion: string | null; reason: string } | undefined,
 clientEnvValue = process.env[ZEN_TRANSPORT_ENV],
): boolean {
 if (!daemonZenTransport) return false;
 const clientWantsSidecar = clientEnvValue === "bun-sidecar";
 const daemonHadSidecarFlag =
  daemonZenTransport.mode === "bun-sidecar" ||
  daemonZenTransport.reason === "bun-absent" ||
  daemonZenTransport.reason === "bun-probe-failed";
 return clientWantsSidecar !== daemonHadSidecarFlag;
}

async function probeAndMaybeReplace(
 port: number,
 label: string,
 probeTimeoutMs = 150,
): Promise<number | null> {
 if (!(await isProxyAlive(port, probeTimeoutMs))) return null;
 const health = await getDaemonHealth(port);
 const ver = health ? health.version : null;
 if (ver !== null && ver !== PKG_VERSION) {
  logWarn(`detected proxy daemon version mismatch: running v${ver}, required v${PKG_VERSION} — auto-restarting`);
  await killStaleDaemon(port, ver, label);
  lastSpawnAt = 0;
  return null;
 }
 if (health !== null && isZenTransportEnvMismatch(health.zenTransport)) {
  logWarn(
   `detected proxy daemon zenTransport mismatch: running ${health.zenTransport?.mode ?? "node"} (${health.zenTransport?.reason ?? "unknown"}), client wants ${process.env[ZEN_TRANSPORT_ENV] === "bun-sidecar" ? "bun-sidecar" : "node"} — auto-restarting`,
  );
  if (await killStaleDaemon(port, ver ?? PKG_VERSION, label)) {
   lastSpawnAt = 0;
   return null;
  }
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
   if (await attachTo(primary)) return primary;
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
