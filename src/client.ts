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
	DAEMON_SPAWN_ENV,
	DAEMON_WATCHDOG_MS,
	DAEMON_WATCHDOG_MS_ENV,
	HOST,
	LEGACY_PORT,
	NO_KILL_ENV,
	PKG_VERSION,
	PORT,
	RECOVERY_BACKOFF_BASE_MS,
	RECOVERY_BACKOFF_CAP_MS,
} from "./config.ts";
import { logInfo, logWarn } from "./logger.ts";
import {
	getDaemonHealth,
	getDaemonVersion,
	isProxyAlive,
	killPortHolder,
	reprobeBasePortAlive,
	startProxy,
} from "./proxy.ts";
import { compareVersions } from "./update-checker.ts";

const CLIENT_ID = randomUUID();

let attachedPort = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatPort = 0;
let ensuring = false;
let fallbackServer: http.Server | null = null;
/** First tick (Date.now()) the daemon has looked continuously busy; 0 = idle. */
let busySince = 0;
/** Consecutive recovery attempts (backoff exponent n). Reset on healthy watchdog tick. */
let backoffAttempt = 0;
/** Timestamps of recent recovery failures (breaker window). */
let recoveryFailures: number[] = [];
/** Watchdog respawns halted until this time (breaker open). */
let breakerOpenUntil = 0;

function isBunRuntime(): boolean {
	return typeof (process.versions as unknown as Record<string, string>).bun === "string";
}

function daemonScriptPath(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.ts");
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
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(getControlTimeoutMs()),
		});
		if (!res.ok) return "legacy";
		try {
			const data: unknown = await res.json();
			if (data && typeof data === "object" && "ok" in data && data.ok === false) return "unknown";
		} catch {}
		return "ok";
	} catch {
		return "gone";
	}
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
	} catch {}
	const wms = getWatchdogMs();
	watchdogTimer = setInterval(() => {
		void watchdogCheck(port);
	}, wms);
	try {
		watchdogTimer.unref();
	} catch {}
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
		} catch {}
		fallbackServer = null;
	}
}

async function beatOnce(port: number): Promise<void> {
	if (ensuring) return;
	const result = await controlCall(port, "/_client/heartbeat", { id: CLIENT_ID });
	if (result === "gone") {
		void ensureDaemon();
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

export type HealthForRecovery = {
	version: string | null;
	activeRequests?: number | undefined;
	sseDegraded?: boolean | undefined;
	lastBytesAt?: number | undefined;
} | null;

/**
 * Watchdog decision matrix (pure, testable). Recover when the daemon is gone,
 * serves a stale version, or reports a degraded failed-SSE window. Missing
 * sseDegraded (pre-window daemon) never triggers on its own.
 */
export function shouldRecoverOnHealth(health: HealthForRecovery): boolean {
	if (health === null) return true;
	if (health.version !== null && health.version !== PKG_VERSION) return true;
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
	} catch {}
	await ensureDaemon();
}

/**
 * 5s watchdog tick: polls /_health for version + failed-SSE rate and drives
 * stopHeartbeat → busy-ruled kill → ensureDaemon when the daemon is stale or
 * degraded. Healthy ticks reset backoff/breaker and track the busy edge.
 */
export async function watchdogCheck(port: number): Promise<void> {
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
	void triggerRecovery(port, health === null ? "daemon gone" : health.version !== PKG_VERSION ? `stale v${health.version}` : "failed-SSE degraded");
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
	for (let i = 0; i < 10; i++) {
		await new Promise<void>((r) => setTimeout(r, 200));
		if (!(await isProxyAlive(port))) return true;
	}
	logInfo(
		`Reusing existing pi-freeflow proxy daemon on http://${HOST}:${port} (stale kill did not free port)`,
	);
	return false;
}

let lastSpawnAt = 0;
const SPAWN_THROTTLE_MS = 2_000;

function spawnDaemonProcess(): void {
	const now = Date.now();
	if (now - lastSpawnAt < SPAWN_THROTTLE_MS) {
		logWarn("daemon spawn throttled — recent spawn still pending");
		return;
	}
	lastSpawnAt = now;
	const script = daemonScriptPath();
	const args = isBunRuntime() ? [script] : ["--experimental-strip-types", script];
	try {
		const child = spawn(process.execPath, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
		child.on("error", (err) => {
			logWarn("daemon spawn failed", { error: String(err) });
		});
	} catch (e) {
		logWarn("daemon spawn failed", { error: String(e) });
	}
}

async function waitForReady(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isProxyAlive(port)) return true;
		await new Promise<void>((r) => setTimeout(r, 200));
	}
	return false;
}

async function probeAndMaybeReplace(
	port: number,
	label: string,
): Promise<number | null> {
	if (!(await isProxyAlive(port))) return null;
	const ver = await getDaemonVersion(port);
	if (ver !== null && ver !== PKG_VERSION) {
		if (await killStaleDaemon(port, ver, label)) {
			return null;
		}
		if (await isProxyAlive(port)) return port;
		return null;
	}
	return port;
}

/**
 * Ensure a proxy daemon is running and attach this client to it.
 * Returns the port the caller should use for its ProviderConfig.
 */
export async function ensureDaemon(): Promise<number> {
	if (ensuring) return attachedPort || PORT;
	ensuring = true;
	try {
		const primary = await probeAndMaybeReplace(PORT, "proxy daemon");
		if (primary !== null) {
			await attachTo(primary);
			return primary;
		}

		if (PORT !== LEGACY_PORT) {
			const legacy = await probeAndMaybeReplace(LEGACY_PORT, "legacy proxy daemon");
			if (legacy !== null) {
				await attachTo(legacy);
				return legacy;
			}
		}

		if (isSpawnEnabled()) {
			// Cross-process race guard: a sibling session may be spawning right
			// now (singleflight is per-process). Jitter + re-probe converts most
			// cold-start races into attach instead of N detached spawns.
			await new Promise<void>((r) => setTimeout(r, 100 + Math.random() * 200));
			if (await isProxyAlive(PORT)) {
				await attachTo(PORT);
				return PORT;
			}
			spawnDaemonProcess();
			const ready = await waitForReady(PORT, DAEMON_READY_TIMEOUT_MS);
			if (ready) {
				const ver = await getDaemonVersion(PORT);
				if (ver !== null && ver !== PKG_VERSION) {
				if (await killStaleDaemon(PORT, ver, "proxy daemon")) {
					lastSpawnAt = 0; // kill-confirmed retry bypasses the spawn throttle
					spawnDaemonProcess();
						const retryReady = await waitForReady(PORT, DAEMON_READY_TIMEOUT_MS);
						if (retryReady) {
							await attachTo(PORT);
							return PORT;
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
				logWarn("daemon spawn did not become ready — is the port blocked?");
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
					} catch {}
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
	} finally {
		ensuring = false;
	}
}

export function getClientPort(): number {
	return attachedPort || PORT;
}

export function getClientId(): string {
	return CLIENT_ID;
}

export function hasFallbackServer(): boolean {
	return fallbackServer !== null;
}

/** Test seam: true when client heartbeat timer is active. */
export function isHeartbeatActive(): boolean {
	return heartbeatTimer !== null;
}

export function _resetClientForTest(): void {
	stopHeartbeatInternal();
	heartbeatPort = 0;
	attachedPort = 0;
	ensuring = false;
	lastSpawnAt = 0;
	_resetRecoveryForTest();
	if (fallbackServer) {
		try {
			fallbackServer.close();
		} catch {}
		fallbackServer = null;
	}
}
