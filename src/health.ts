/**
 * Health endpoint for pi-freeflow proxy
 * Loopback-only GET /_health (and alias /health) returning relay health snapshot.
 */

import type * as http from "node:http";
import { ALL_MODELS } from "./models.ts";
import { getActiveRelayState, getRelayHealth, isRelayHealthy } from "./relay-state.ts";
import { PORT } from "./config.ts";

export interface HealthRelayInfo {
	url: string;
	label?: string;
	healthy: boolean;
	cooldownUntil: number;
	consecutiveFailures: number;
}

export interface HealthData {
	port: number;
	active: string;
	mode: string;
	enabled: boolean;
	relays: HealthRelayInfo[];
	catalog: number;
}

/**
 * Collect current health snapshot.
 * @param portOverride - actual listening port (defaults to config PORT)
 */
export function getHealthData(portOverride?: number): HealthData {
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
	return {
		port: portOverride ?? PORT,
		active: state.url || "",
		mode: (state.mode as string) ?? "auto",
		enabled: Boolean(state.enabled),
		relays,
		catalog: ALL_MODELS.length,
	};
}

function isLoopbackIP(ip: string): boolean {
	if (!ip) return false;
	const clean = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
	return clean === "127.0.0.1" || clean === "::1" || clean === "localhost";
}

function getClientIPFromReq(req: http.IncomingMessage): string {
	const addr = (req.socket as unknown as { remoteAddress?: string })?.remoteAddress;
	if (!addr) return "unknown";
	return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

/**
 * Handle loopback health requests.
 * Returns true if request was a health endpoint (handled, response already sent).
 * Returns false if not a health path (caller should continue).
 */
export function handleHealthRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	portOverride?: number,
): boolean {
	let pathname: string | null = null;
	try {
		pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
	} catch {
		return false;
	}

	const isHealthPath =
		pathname === "/_health" || pathname === "/health" || pathname.endsWith("/health");
	if (req.method !== "GET" || !isHealthPath) {
		return false;
	}

	const clientIP = getClientIPFromReq(req);
	if (!isLoopbackIP(clientIP)) {
		const body = JSON.stringify({ error: "forbidden" });
		res.writeHead(403, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
		res.end(body);
		return true;
	}

	const data = getHealthData(portOverride);
	const body = JSON.stringify(data);
	res.writeHead(200, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
	return true;
}
