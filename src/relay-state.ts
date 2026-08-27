/**
 * Persistent relay state manager and failover ordering for pi-freeflow
 *
 * Handles atomic state writes to ~/.pi/agent/pi-freeflow-relay-state.json.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RELAY_URL, RELAY_STATE_FILE } from "./config.ts";
import { logWarn } from "./logger.ts";
import type { ExtensionUIContext, KnownRelay, RelayMode, RelayState } from "./types.ts";
/**
 * Load persisted relay state from disk.
 */
export function loadRelayState(): RelayState {
	try {
		if (!fs.existsSync(RELAY_STATE_FILE)) {
			return { mode: "auto", enabled: true, url: DEFAULT_RELAY_URL, relays: [] };
		}
		const s = JSON.parse(fs.readFileSync(RELAY_STATE_FILE, "utf8"));
		const relays: KnownRelay[] = Array.isArray(s?.relays) ? s.relays : [];
		const mode: RelayMode =
			s?.mode === "on" || s?.mode === "off" || s?.mode === "auto"
				? s.mode
				: "auto";
		const enabled =
			mode === "on"
				? true
				: mode === "off"
					? false
					: s?.enabled !== false && relays.length > 0;
		return {
			mode,
			enabled,
			url: typeof s?.url === "string" ? s.url.trim() : (relays[0]?.url || DEFAULT_RELAY_URL),
			relays,
		};
	} catch {
		return { mode: "auto", enabled: true, url: DEFAULT_RELAY_URL, relays: [] };
	}
}

/** Block synchronously for ms without burning CPU. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, Date.now() + ms);
}

/**
 * Rename with bounded retry: Windows briefly locks the target when another
 * process holds the state file open, surfacing as EPERM/EACCES/EBUSY.
 * Three attempts with a fixed 50ms backoff; any other error fails immediately.
 */
function renameWithRetry(from: string, to: string): void {
	const retryable: Record<string, true> = { EPERM: true, EACCES: true, EBUSY: true };
	for (let attempt = 1; ; attempt++) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException | null)?.code;
			if (!code || !retryable[code] || attempt >= 3) {
				throw e;
			}
			sleepSync(50);
		}
	}
}

/**
 * Atomically save relay state to disk using a temporary file and rename.
 */
export function saveRelayState(s: RelayState): void {
	try {
		const dir = path.dirname(RELAY_STATE_FILE);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const tmpPath = `${RELAY_STATE_FILE}.${randomUUID()}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(s, null, 2), "utf8");
		renameWithRetry(tmpPath, RELAY_STATE_FILE);
	} catch (e) {
		logWarn("Could not persist relay state", { error: String(e) });
	}
}

/**
 * Deduplicate and add or update a relay URL in the known relay list.
 */
export function ensureRelay(
	s: RelayState,
	url: string,
	label?: string,
): KnownRelay {
	const cleanUrl = (url || "").trim();
	if (!cleanUrl) {
		throw new Error("Relay URL cannot be empty");
	}
	const cleanLabel = (label || "").trim() || undefined;
	const existing = s.relays.find((r) => r.url === cleanUrl);
	if (existing) {
		if (cleanLabel && cleanLabel !== "manual") {
			existing.label = cleanLabel;
		}
		return existing;
	}
	const newRelay: KnownRelay = {
		url: cleanUrl,
		label: cleanLabel && cleanLabel !== "manual" ? cleanLabel : undefined,
		addedAt: new Date().toISOString(),
	};
	s.relays.push(newRelay);
	return newRelay;
}

/**
 * Set or update short name / label for a relay by URL, index, or existing label.
 */
export function setRelayLabel(
	s: RelayState,
	identifier: string | number,
	label: string,
): KnownRelay | null {
	const relay = findRelay(s, identifier);
	if (!relay) return null;
	const cleanLabel = (label || "").trim();
	relay.label = cleanLabel || undefined;
	return relay;
}

/**
 * Find a relay in state by 1-based index, short name / label, or URL.
 */
export function findRelay(
	s: RelayState,
	identifier: string | number,
): KnownRelay | undefined {
	if (typeof identifier === "number") {
		const idx = identifier - 1;
		return s.relays[idx];
	}
	const str = String(identifier || "").trim();
	if (!str) return undefined;

	// 1-based index (e.g. "1", "2")
	if (/^\d+$/.test(str)) {
		const num = Number.parseInt(str, 10);
		if (num >= 1 && num <= s.relays.length) {
			return s.relays[num - 1];
		}
	}

	// Exact URL match
	const exactUrl = s.relays.find((r) => r.url === str);
	if (exactUrl) return exactUrl;

	// Case-insensitive label match
	const byLabel = s.relays.find(
		(r) => r.label && r.label.toLowerCase() === str.toLowerCase(),
	);
	if (byLabel) return byLabel;

	// Partial URL match
	return s.relays.find((r) => r.url.toLowerCase().includes(str.toLowerCase()));
}

/**
 * Remove a relay URL from the known relay list.
 */
export function removeRelay(s: RelayState, url: string): void {
	s.relays = s.relays.filter((r) => r.url !== url);
}

/**
 * Resolve relay state with defaults.
 */
export function resolveRelayState(): RelayState {
	const s = loadRelayState();
	// Seed the relay list from defaults when state lacks entries.
	if (!s.relays.length) {
		if (DEFAULT_RELAY_URL) {
			ensureRelay(s, DEFAULT_RELAY_URL, "Default");
		}
		if (s.url && s.url !== DEFAULT_RELAY_URL) {
			ensureRelay(s, s.url, "previous");
		}
	}
	if (!s.url) {
		s.url = DEFAULT_RELAY_URL;
	}
	return s;
}

let activeRelayState: RelayState = resolveRelayState();
let activeStatusUi: ExtensionUIContext | null = null;
let isFreeFlowModelActive = true;

export interface RelayHealth {
	consecutiveFailures: number;
	lastFailureTime: number;
	cooldownUntil: number;
	lastStatus?: number;
	lastError?: string;
}

const relayHealthMap = new Map<string, RelayHealth>();
let last429Warn = 0;

/**
 * Mark a relay as healthy and active on successful response.
 */
export function markRelaySuccess(url: string): void {
	if (!url) return;
	relayHealthMap.delete(url.trim());
}

/**
 * Mark a relay as degraded with temporary cooldown on failure/429/timeout/socket error.
 */
export function markRelayFailure(url: string, status?: number, error?: string): void {
	if (!url) return;
	const clean = url.trim();
	const prev = relayHealthMap.get(clean) || {
		consecutiveFailures: 0,
		lastFailureTime: 0,
		cooldownUntil: 0,
	};
	const consecutive = prev.consecutiveFailures + 1;
	const now = Date.now();
	let cooldownMs = 30_000; // 30s default for socket/network/502/503

	if (status === 429) {
		cooldownMs = 90_000;
		if (now - last429Warn > 10 * 60 * 1000) {
			logWarn("relay 429 burst >5/min, consider adding egress", { relay: clean });
			last429Warn = now;
		}
	} else if (status === 504) {
		cooldownMs = 60_000;
	} else if (status && status >= 500) {
		cooldownMs = 45_000;
	}

	// Escalate with consecutive failures so chronic offenders back off up to
	// 4x their base cooldown instead of re-hammering at a fixed interval.
	const multiplier = Math.min(4, consecutive);
	relayHealthMap.set(clean, {
		consecutiveFailures: consecutive,
		lastFailureTime: now,
		cooldownUntil: now + cooldownMs * multiplier,
		lastStatus: status,
		lastError: error,
	});
}

/**
 * Check if a relay is currently healthy (not in active cooldown).
 */
export function isRelayHealthy(url: string): boolean {
	if (!url) return true;
	const clean = url.trim();
	const health = relayHealthMap.get(clean);
	if (!health) return true;
	return Date.now() >= health.cooldownUntil;
}

/**
 * Get current health snapshot for a relay.
 */
export function getRelayHealth(url: string): RelayHealth | undefined {
	return relayHealthMap.get(url.trim());
}

/**
 * Reset all in-memory relay health records.
 */
export function resetAllRelayHealth(): void {
	relayHealthMap.clear();
	last429Warn = 0;
}
/** Test-only: reset 429 warn throttle */
export function _reset429WarnForTest(): void { last429Warn = 0; }
/**
 * Mtime of the on-disk state file at the moment we last read or wrote it.
 * session's master daemon, while never clobbering this process's own
 * unpersisted runtime overrides between external writes.
 */
let lastKnownStateMtimeMs = -1;

function currentDiskStateMtimeMs(): number {
	try {
		return fs.statSync(RELAY_STATE_FILE).mtimeMs;
	} catch {
		return -1;
	}
}

lastKnownStateMtimeMs = currentDiskStateMtimeMs();

/**
 * Get active in-memory relay state
 */
export function getActiveRelayState(): RelayState {
	const currentMtime = currentDiskStateMtimeMs();
	if (currentMtime > 0 && currentMtime > lastKnownStateMtimeMs) {
		activeRelayState = resolveRelayState();
		lastKnownStateMtimeMs = currentMtime;
	}
	return activeRelayState;
}

/**
 * Set active in-memory relay state and persist to disk
 */
export function setActiveRelayState(s: RelayState, persist = true): void {
	activeRelayState = s;
	if (persist) {
		saveRelayState(s);
	}
	lastKnownStateMtimeMs = currentDiskStateMtimeMs();
}

/**
 * Register the Pi extension UI context for status line updates
 */
export function setStatusUi(ui: ExtensionUIContext | null): void {
	activeStatusUi = ui;
}

export function setFreeFlowModelActive(active: boolean): void {
	isFreeFlowModelActive = active;
	if (!active && activeStatusUi?.setStatus) {
		activeStatusUi.setStatus("freeflow", undefined);
	}
}
/**
 * Get the current Pi extension UI context
 */
export function getStatusUi(): ExtensionUIContext | null {
	return activeStatusUi;
}

/**
 * Generate a short, human-readable label for a relay URL.
 * Prefers user-configured label/short name; falls back to clean domain/subdomain.
 */
export function shortRelayLabel(url: string, relays?: KnownRelay[]): string {
	const pool = relays || activeRelayState.relays;
	try {
		const hit = pool.find((r) => r.url === url);
		if (hit?.label?.trim() && hit.label.trim() !== "manual") {
			return hit.label.trim();
		}
		const u = new URL(url);
		const host = u.host;
		// IP address (e.g. 192.168.1.5:8080 or 10.0.0.1)
		if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(host)) {
			return host;
		}
		const parts = host.split(".");
		if (parts.length >= 3) {
			// E.g. "my-relay" from "my-relay.workers.dev" or "my-app.vercel.app"
			return parts[0];
		}
		return parts[0] || host;
	} catch {
		return url.slice(0, 18);
	}
}

/**
 * Get ordered candidate URLs for relay execution starting with the sticky active URL.
 * Reloads from disk only when another process changed the state file (mtime moved),
 * so cross-session relay-pool updates propagate to workers while this process's own
 * unpersisted runtime overrides survive between external writes.
 */
export function getOrderedRelayUrls(): string[] {
	const mtime = currentDiskStateMtimeMs();
	if (mtime !== lastKnownStateMtimeMs) {
		activeRelayState = loadRelayState();
		lastKnownStateMtimeMs = mtime;
	}

	if (activeRelayState.relays && activeRelayState.relays.length > 0) {
		const active = (activeRelayState.url || "").trim();
		let activeIdx = activeRelayState.relays.findIndex((r) => r.url === active);
		if (activeIdx < 0) {
			activeIdx = 0;
		}
		// Sticky primary until error — keep active relay as primary for all requests,
		// only rolling to next healthy on 429/5xx or cooldown. Avoids per-request
		// rotation that sprays load; successive requests reuse same egress IP.
		const totalRelays = activeRelayState.relays.length;
		const startIdx = activeIdx;
		const rawOrdered: string[] = [];
		for (let i = 0; i < totalRelays; i++) {
			const r = activeRelayState.relays[(startIdx + i) % totalRelays];
			if (r?.url?.trim()) {
				rawOrdered.push(r.url.trim());
			}
		}

		// Partition into healthy candidates first, degraded/cooling candidates at the tail
		const healthy = rawOrdered.filter((u) => isRelayHealthy(u));
		const cooling = rawOrdered.filter((u) => !isRelayHealthy(u));
		const ordered = [...healthy, ...cooling];

		return ordered;
	}
	return [];
}

/**
 * Update the extension UI status widget with current active relay info
 */
export function updateRelayStatusUi(targetUrl?: string): void {
	if (!activeStatusUi?.setStatus) {
		return;
	}
	// Do not update status bar if the user switched to another provider (e.g. Gemini/Claude)
	if (!isFreeFlowModelActive) {
		activeStatusUi.setStatus("freeflow", undefined);
		return;
	}
	if (getActiveRelayState().hideWidget) {
		activeStatusUi.setStatus("freeflow", undefined);
		return;
	}
	const state = getActiveRelayState();
	if (!state.enabled || !state.relays || state.relays.length === 0) {
		activeStatusUi.setStatus("freeflow", undefined);
		return;
	}
	const currentUrl = targetUrl || state.url || state.relays[0]?.url || "";
	const label = shortRelayLabel(currentUrl);
	const total = state.relays.length || 1;
	const pos = Math.max(1, state.relays.findIndex((r) => r.url === currentUrl) + 1);
	const modeLabel = state.mode === "on" ? "ON" : "AUTO (ON)";
	activeStatusUi.setStatus("freeflow", `relay: ${modeLabel} | ${label} ${pos}/${total}`);
}
