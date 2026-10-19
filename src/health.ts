/**
 * Health endpoints for pi-freeflow proxy
 * - GET /health  — unauthenticated identity probe (ok/service/port/version)
 * - GET /_health — rich relay/lease snapshot; token-gated by src/proxy.ts
 */

import type * as http from "node:http";
import { ALL_MODELS } from "./models.ts";
import { getActiveRelayState, getRelayHealth, isRelayHealthy } from "./relay-state.ts";
import { getLastActivityAt, getLeaseCount, getLeaseSnapshot } from "./lease.ts";
import { PKG_VERSION, PORT } from "./config.ts";
import { getLastForwardedByteAt, getMidStreamFaultStats, getSseStats } from "./stream-pipe.ts";

interface HealthRelayInfo {
	url: string;
	label?: string;
	healthy: boolean;
	cooldownUntil: number;
	consecutiveFailures: number;
}

interface HealthData {
	port: number;
	active: string;
	mode: string;
	enabled: boolean;
	relays: HealthRelayInfo[];
	catalog: number;
	version: string;
	/** In-flight proxied requests right now (stale-daemon replacement guard). */
	activeRequests: number;
	/** Clients holding a live lease (detached-daemon GC). */
	clients: number;
	/** clientId -> lastSeenAt for every live lease. */
	leases: Record<string, number>;
	/** Last time any request was proxied (request-touch for legacy clients). */
	lastActivityAt: number;
	/** Failed-SSE rolling window: failures in the last 20 streams. */
	sseFailed: number;
	/** Streams recorded in the current rolling window (max 20). */
	sseTotal: number;
	/** Failure rate over the window (0 when empty). */
	sseRate: number;
	/** True when the window holds enough samples and the rate exceeds 50%. */
	sseDegraded: boolean;
	/** Last time any stream byte was forwarded (busy-bypass quiet check), 0 when no stream yet. */
	lastBytesAt: number;
	/** Mid-stream turns the upstream model itself failed (model fault, never a relay fault). */
	midStreamModelFaults: number;
	/** Mid-stream turns cut by the relay/transport (relay fault, rotated away from). */
	midStreamRelayTruncations: number;
}

/**
 * Wire subset of HealthData fetched from a running daemon over loopback.
 * Single source of truth for the recovery-decision shape (client.ts
 * HealthForRecovery) and the fetch shape (proxy.ts getDaemonHealth): each
 * field's type follows HealthData, so a rename there breaks here at compile
 * time instead of silently desyncing a hand-duplicated copy.
 * Fields stay optional — older daemons predate them — and version is nullable
 * for unversioned responses. The key list must match what getDaemonHealth parses.
 */
export type DaemonHealthSnapshot = {
	[K in "activeRequests" | "sseRate" | "sseDegraded" | "lastBytesAt"]?: HealthData[K] | undefined;
} & {
	version: string | null;
} | null;

/**
 * Collect current health snapshot.
 * @param portOverride - actual listening port (defaults to config PORT)
 * @param activeRequests - in-flight proxied requests (defaults to 0 for callers that do not track)
 */
export function getHealthData(portOverride?: number, activeRequests = 0): HealthData {
	const state = getActiveRelayState();
	const relays: HealthRelayInfo[] = (state.relays || []).map((r) => {
		const h = getRelayHealth(r.url);
		const healthy = isRelayHealthy(r.url);
		return {
			url: r.url,
			label: r.label,
			healthy,
			cooldownUntil: h?.cooldownUntil ?? 0,
			consecutiveFailures: h?.consecutiveFailures ?? 0,
		};
	});
	const sse = getSseStats();
	const midStreamFaults = getMidStreamFaultStats();
	return {
		port: portOverride ?? PORT,
		active: state.url || "",
		mode: (state.mode as string) ?? "auto",
		enabled: Boolean(state.enabled),
		relays,
		catalog: ALL_MODELS.length,
		version: PKG_VERSION,
		activeRequests,
		clients: getLeaseCount(),
		leases: getLeaseSnapshot(),
		lastActivityAt: getLastActivityAt(),
		sseFailed: sse.failures,
		sseTotal: sse.total,
		sseRate: sse.rate,
		sseDegraded: sse.degraded,
		lastBytesAt: getLastForwardedByteAt(),
		midStreamModelFaults: midStreamFaults.modelFaults,
		midStreamRelayTruncations: midStreamFaults.relayTruncations,
	};
}

/**
 * Identity of a pi-freeflow daemon bound to `port`, as answered by the
 * unauthenticated GET /health probe. `port` is the value read from the
 * listening socket, so a stranger squatting the loopback port cannot pass by
 * answering arbitrary JSON.
 *
 * Legacy daemons (pre-token releases) answered /health with the rich health
 * snapshot: a numeric self-reported port plus a version string. Accepting that
 * shape keeps upgrade paths working — the client recognises the old daemon,
 * sees the version mismatch and replaces it — while `{}` or a foreign service
 * still fails.
 */
export function isDaemonIdentityBody(port: number, body: unknown): boolean {
	if (!body || typeof body !== "object" || Array.isArray(body)) return false;
	if (!("port" in body) || typeof body.port !== "number" || body.port !== port) return false;
	if ("service" in body) return body.service === "pi-freeflow" && "ok" in body && body.ok === true;
	return "version" in body && typeof body.version === "string" && body.version !== "";
}

/**
 * Check whether an IP address is a loopback address (127.0.0.1, ::1, localhost).
 */
export function isLoopbackIP(ip: string): boolean {
	if (!ip) return false;
	const withoutZone = ip.split("%")[0];
	const clean = withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
	return clean === "127.0.0.1" || clean === "::1" || clean === "localhost";
}

/**
 * Handle loopback health requests.
 * Returns true if request was a health endpoint (handled, response already sent).
 * Returns false if not a health path (caller should continue).
 *
 * Two shapes:
 * - `GET /health` is the unauthenticated identity probe: exactly
 *   `{ok, service, port, version}`, used by attach/dark-holder checks to
 *   recognise our daemon before a token is available.
 * - `GET /_health` is the rich relay/lease/session snapshot. The proxy
 *   enforces the installation token on every `/_*` route before dispatching
 *   here, so this handler does not repeat the auth check.
 */
export function handleHealthRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	portOverride?: number,
	activeRequests = 0,
): boolean {
	if (req.method !== "GET") return false;

	let reqPathname: string | null = null;
	try {
		reqPathname = new URL(req.url ?? "/", `http://127.0.0.1`).pathname;
	} catch {
		return false;
	}
	if (reqPathname === null) return false;
	if (reqPathname !== "/_health" && reqPathname !== "/health") return false;

	const clientIP = req.socket.remoteAddress ?? "";
	if (!isLoopbackIP(clientIP)) {
		res.writeHead(403, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "loopback only" }));
		return true;
	}

	const body =
		reqPathname === "/health"
			? JSON.stringify({
				ok: true,
				service: "pi-freeflow",
				port: portOverride ?? PORT,
				version: PKG_VERSION,
			})
			: JSON.stringify(getHealthData(portOverride, activeRequests), null, 2);
	res.writeHead(200, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	res.end(body);
	return true;
}