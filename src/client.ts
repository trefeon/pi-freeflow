/**
 * Client-side daemon lifecycle for pi-freeflow.
 *
 * Every OMP/Pi session is a client. It attaches to the shared detached daemon
 * at 127.0.0.1:28180 (or spawns one if none is alive), registers a lease, and
 * renews it with a heartbeat while the session lives. When the session ends
 * the heartbeat stops; the daemon drops the lease after its TTL and retires
 * once no client holds a live lease and no request has been proxied recently.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as http from "node:http";
import {
	DAEMON_HEARTBEAT_MS,
	DAEMON_HEARTBEAT_MS_ENV,
	DAEMON_READY_TIMEOUT_MS,
	DAEMON_SPAWN_ENV,
	HOST,
	LEGACY_PORT,
	NO_KILL_ENV,
	PKG_VERSION,
	PORT,
} from "./config.ts";
import { logInfo, logWarn } from "./logger.ts";
import {
	getDaemonHealth,
	getDaemonVersion,
	isProxyAlive,
	killPortHolder,
	startProxy,
} from "./proxy.ts";
import { compareVersions } from "./update-checker.ts";

const CLIENT_ID = randomUUID();

let attachedPort = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatPort = 0;
let ensuring = false;
let fallbackServer: http.Server | null = null;

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

function isSpawnEnabled(): boolean {
	return process.env[DAEMON_SPAWN_ENV] !== "0";
}

type ControlResult = "ok" | "legacy" | "gone";

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
			signal: AbortSignal.timeout(1500),
		});
		return res.ok ? "ok" : "legacy";
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
}

function stopHeartbeatInternal(): void {
	if (heartbeatTimer !== null) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
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
		logInfo(
			`Reusing existing pi-freeflow proxy daemon on http://${HOST}:${port} (${health.activeRequests} active request${health.activeRequests === 1 ? "" : "s"} — not interrupted)`,
		);
		return false;
	}
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
			spawnDaemonProcess();
			const ready = await waitForReady(PORT, DAEMON_READY_TIMEOUT_MS);
			if (ready) {
				const ver = await getDaemonVersion(PORT);
				if (ver !== null && ver !== PKG_VERSION) {
					if (await killStaleDaemon(PORT, ver, "proxy daemon")) {
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
			return PORT;
		}

		try {
			const r = await startProxy();
			if (r.server) fallbackServer = r.server;
			const port = r.port;
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

export function _resetClientForTest(): void {
	stopHeartbeatInternal();
	heartbeatPort = 0;
	attachedPort = 0;
	ensuring = false;
	lastSpawnAt = 0;
	if (fallbackServer) {
		try {
			fallbackServer.close();
		} catch {}
		fallbackServer = null;
	}
}
