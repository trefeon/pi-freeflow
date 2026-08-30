/**
 * Persistent relay state manager and failover ordering for pi-freeflow
 *
 * Handles atomic state writes to ~/.pi/agent/pi-freeflow-relay-state.json.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RELAY_STATE_FILE } from "./config.ts";
import { ALLOW_UNSAFE_RELAY_ENV } from "./config.ts";
import { logWarn } from "./logger.ts";
import type { ExtensionUIContext, KnownRelay, RelayMode, RelayState } from "./types.ts";

/**
 * Reject relay hostnames the deployed worker templates also refuse: loopback,
 * RFC1918, CGNAT, link-local, ULA, and *.local/*.internal names. Mirrors the
 * isPrivateHostname discipline embedded in the Vercel/Cloudflare/Deno templates.
 */
function isPrivateRelayHostname(hostname: string): boolean {
	let host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
	if (host.length > 1 && host.endsWith(".")) host = host.slice(0, -1);
	if (!host) return true;
	if (
		host === "localhost" ||
		host === "0.0.0.0" ||
		host === "127.0.0.1" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal")
	) {
		return true;
	}
	// IPv6 loopback / unspecified / any ::-prefixed form
	if (host.startsWith("::")) return true;
	const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 192 && b === 168) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
		return false;
	}
	if (host.includes(":")) {
		if (host.startsWith("fc") || host.startsWith("fd")) return true; // ULA fc00::/7
		if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
		return false;
	}
	return false;
}

/**
 * Validate a relay URL the way the deployed worker templates validate their
 * x-relay-target: https-only (unless ALLOW_UNSAFE_RELAY_ENV=1), no embedded
 * credentials, public hostname only, default port only.
 *
 * Returns { ok: true, url } or { ok: false, reason } — never throws.
 */
export function validateRelayUrl(
	raw: string,
): { ok: true; url: URL } | { ok: false; reason: string } {
	const unsafe = process.env[ALLOW_UNSAFE_RELAY_ENV] === "1";
	const trimmed = (raw || "").trim();
	if (!trimmed) return { ok: false, reason: "Relay URL cannot be empty" };
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, reason: "invalid URL" };
	}
	if (!unsafe) {
		if (url.protocol !== "https:") {
			return { ok: false, reason: "only https relay URLs are allowed" };
		}
	} else if (url.protocol !== "https:" && url.protocol !== "http:") {
		return { ok: false, reason: "only http/https relay URLs are allowed" };
	}
	if (url.username || url.password) {
		return { ok: false, reason: "credentials are not allowed in relay URLs" };
	}
	if (!unsafe) {
		if (isPrivateRelayHostname(url.hostname)) {
			return { ok: false, reason: "private/loopback relay hosts are not allowed" };
		}
		if (url.port && url.port !== "443") {
			return { ok: false, reason: "non-default relay ports are not allowed" };
		}
	}
	return { ok: true, url };
}
/**
 * Parse a relay-state JSON blob into a usable state.
 * Returns null when the blob is corrupt or has an empty relay pool —
 * either makes the state unusable for routing.
 */
function parseRelayState(raw: string): RelayState | null {
	try {
		const s = JSON.parse(raw);
		const relays: KnownRelay[] = Array.isArray(s?.relays) ? s.relays : [];
		if (relays.length === 0) {
			return null;
		}
		const mode: RelayMode =
			s?.mode === "on" || s?.mode === "off" || s?.mode === "auto"
				? s.mode
				: "auto";
		return {
			mode,
			enabled:
				mode === "on"
					? true
					: mode === "off"
						? false
						: s?.enabled !== false && relays.length > 0,
			url: typeof s?.url === "string" ? s.url.trim() : (relays[0]?.url || ""),
			relays,
		};
	} catch {
		return null;
	}
}

/**
 * Remove leftover `<state>.<uuid>.tmp` files from crashed or failed saves.
 * Only files older than an hour are removed, so an in-flight save by a
 * sibling process is never disturbed.
 */
function cleanupStaleTmpFiles(): void {
	try {
		const dir = path.dirname(RELAY_STATE_FILE);
		const prefix = `${path.basename(RELAY_STATE_FILE)}.`;
		const cutoff = Date.now() - 60 * 60 * 1000;
		for (const entry of fs.readdirSync(dir)) {
			if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) {
				continue;
			}
			const full = path.join(dir, entry);
			try {
				if (fs.statSync(full).mtimeMs < cutoff) {
					fs.rmSync(full, { force: true });
				}
			} catch {}
		}
	} catch {}
}

/**
 * Recover relay state from the .bak file and heal the main file so the
 * recovery is sticky. Returns null when no usable backup exists.
 */
function recoverFromBackup(description: string): RelayState | null {
	try {
		const bak = parseRelayState(fs.readFileSync(`${RELAY_STATE_FILE}.bak`, "utf8"));
		if (bak) {
			logWarn(`relay state ${description} — recovered from .bak`, { relays: bak.relays.length });
			saveRelayState(bak); // heal the main file so recovery is sticky
			return bak;
		}
	} catch {}
	return null;
}

/**
 * Load persisted relay state from disk.
 * Falls back to .bak when the main file is corrupt OR empty — an empty save
 * over real relays leaves exactly a valid-but-empty main, and the backup is
 * the only surviving copy (see tmp 50-byte litter wipe). A successful
 * recovery is written back to the main file so it is not re-done on every
 * load.
 */
export function loadRelayState(): RelayState {
	try {
		cleanupStaleTmpFiles();
		if (!fs.existsSync(RELAY_STATE_FILE)) {
			// Main file missing (deleted outright, never healed after a wipe):
			// heal from .bak when the backup still holds relays — losing the
			// pool to a missing main is just as bad as a corrupt one.
			const healed = recoverFromBackup("main state file missing");
			if (healed) {
				return healed;
			}
			return { mode: "auto", enabled: true, url: "", relays: [] };
		}
		const main = parseRelayState(fs.readFileSync(RELAY_STATE_FILE, "utf8"));
		if (main) {
			return main;
		}
		// Try backup before giving up — user data loss is worse than stale data
		const bak = recoverFromBackup("unusable");
		if (bak) {
			return bak;
		}
		logWarn("relay state file unusable and no valid backup — starting fresh", {
			path: RELAY_STATE_FILE,
		});
		return { mode: "auto", enabled: true, url: "", relays: [] };
	} catch {
		return { mode: "auto", enabled: true, url: "", relays: [] };
	}
}

/**
 * Atomically save relay state to disk using a temporary file and rename.
 * Backs up the current non-empty state to .bak before overwriting so a
 * corrupt or empty save can always be recovered by loadRelayState.
 */
export function saveRelayState(s: RelayState): void {
	try {
		const dir = path.dirname(RELAY_STATE_FILE);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// Backup current file before overwrite for recovery
		try {
			if (fs.existsSync(RELAY_STATE_FILE)) {
				const cur = fs.readFileSync(RELAY_STATE_FILE, "utf8");
				// Only backup non-empty states
				const parsed = JSON.parse(cur);
				if (Array.isArray(parsed?.relays) && parsed.relays.length > 0) {
					fs.writeFileSync(`${RELAY_STATE_FILE}.bak`, cur, "utf8");
				}
			}
		} catch {}
		const tmpPath = `${RELAY_STATE_FILE}.${randomUUID()}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(s, null, 2), "utf8");
		renameWithRetry(tmpPath, RELAY_STATE_FILE);
	} catch (e) {
		logWarn("Could not persist relay state", { error: String(e) });
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
	const check = validateRelayUrl(cleanUrl);
	if (!check.ok) {
		throw new Error(`Relay URL rejected: ${check.reason}`);
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
 * Find a relay in state by 1-based index (numeric 0 also maps to the first relay),
 * short name / label, or URL.
 */
export function findRelay(
	s: RelayState,
	identifier: string | number,
): KnownRelay | undefined {
	if (typeof identifier === "number") {
		const idx = identifier === 0 ? 0 : identifier - 1;
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
 * Resolve relay state with defaults. The default relay URL is empty in this
 * build (fresh installs start in direct mode), so the former seeding branch
 * was dead code and is removed; loadRelayState already returns usable state.
 */
export function resolveRelayState(): RelayState {
	return loadRelayState();
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
	/** most recent successful response latency in ms */
	lastLatencyMs?: number;
	/** total successful responses recorded while keeping the health record */
	successCount?: number;
	/** total failures recorded since the health record was created */
	failureCount?: number;
	/** timestamp of the most recent HTTP 429 (if any) */
	last429At?: number;
}

const relayHealthMap = new Map<string, RelayHealth>();
let last429Warn = 0;
// Sliding 60-second window of HTTP 429 events used by markRelayFailure to
// keep the "burst >5/min" warning honest (see markRelayFailure).
const RELAY_429_BURST_WINDOW_MS = 60_000;
const RELAY_429_BURST_THRESHOLD = 5;
const recent429Timestamps: number[] = [];

/**
 * Mark a relay as healthy and active on successful response.
 * With a finite latencyMs the health record is kept (failures reset, latency
 * recorded); without one the record is deleted entirely.
 */
export function markRelaySuccess(url: string, latencyMs?: number): void {
	if (!url) return;
	const clean = url.trim();
	if (typeof latencyMs === "number" && Number.isFinite(latencyMs)) {
		const prev = relayHealthMap.get(clean);
		const record: RelayHealth = prev
			? { ...prev, consecutiveFailures: 0, lastFailureTime: 0, cooldownUntil: 0, lastLatencyMs: Math.round(latencyMs), successCount: (prev?.successCount ?? 0) + 1 }
			: { consecutiveFailures: 0, lastFailureTime: 0, cooldownUntil: 0, lastLatencyMs: Math.round(latencyMs) };
		relayHealthMap.set(clean, record);
		return;
	}
	relayHealthMap.delete(clean);
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
		// 60-second sliding window: record the event, then warn only when the
		// observed rate crosses >5/min (transition into a burst episode).
		// One warning per episode beats both spamming (old 10-min cooldown
		// re-warned on every boundary during a long burst) and blindness (a
		// fresh burst inside the cooldown stayed silent).
		const cutoff = now - RELAY_429_BURST_WINDOW_MS;
		while (recent429Timestamps.length > 0 && recent429Timestamps[0] <= cutoff) {
			recent429Timestamps.shift();
		}
		const beforeBurst = recent429Timestamps.length;
		recent429Timestamps.push(now);
		if (beforeBurst <= RELAY_429_BURST_THRESHOLD && recent429Timestamps.length > RELAY_429_BURST_THRESHOLD) {
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
		...prev,
		consecutiveFailures: consecutive,
		lastFailureTime: now,
		cooldownUntil: now + cooldownMs * multiplier,
		lastStatus: status,
		lastError: error,
		failureCount: (prev.failureCount ?? 0) + 1,
		last429At: status === 429 ? now : prev.last429At || undefined,
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
	recent429Timestamps.length = 0;
	last429Warn = 0;
}
/** Test-only: reset 429 warn throttle */
export function _reset429WarnForTest(): void {
	recent429Timestamps.length = 0;
	last429Warn = 0;
}
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
	if (currentMtime !== lastKnownStateMtimeMs) {
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

// ── CAS state mutation ──────────────────────────────────────────────
// Command handlers mutate relay state through a compare-and-swap discipline
// (withRelayState) instead of editing a stale in-memory snapshot: the
// operation is re-applied to the freshest on-disk state at write time, so
// concurrent sessions cannot silently clobber each other's edits.

const RELAY_STATE_LOCK_FILE = `${RELAY_STATE_FILE}.lock`;
const LOCK_WAIT_MAX_MS = 2_000;
const LOCK_RETRY_START_MS = 25;
const LOCK_RETRY_MAX_MS = 200;
/** A lock older than this is presumed abandoned (crashed holder) and taken over. */
const LOCK_STALE_MS = 30_000;

function tryAcquireRelayLock(): boolean {
	try {
		fs.writeFileSync(RELAY_STATE_LOCK_FILE, String(process.pid), { flag: "wx" });
		return true;
	} catch (e) {
		const code = (e as NodeJS.ErrnoException | null)?.code;
		if (code !== "EEXIST") {
			// Lock cannot be created for an unrelated reason (permissions etc.) —
			// proceed unlocked; the atomic tmp+rename save already prevents torn files.
			return false;
		}
		// Held or stale: take over locks older than LOCK_STALE_MS so a crashed
		// process cannot wedge the state file forever.
		try {
			const age = Date.now() - fs.statSync(RELAY_STATE_LOCK_FILE).mtimeMs;
			if (age > LOCK_STALE_MS) {
				fs.rmSync(RELAY_STATE_LOCK_FILE, { force: true });
				return tryAcquireRelayLock();
			}
		} catch {
			return tryAcquireRelayLock(); // lock vanished between stat and here
		}
		return false;
	}
}

/**
 * Apply a mutation to relay state with a compare-and-swap discipline.
 * Locks the state file (bounded retry, ~2s), loads the freshest on-disk state,
 * runs the updater against it, persists atomically, and releases the lock.
 * On lock timeout the write proceeds unlocked — the atomic tmp+rename save
 * already prevents torn files; the lock only serializes write intent.
 * Returns the state that was actually persisted (also becomes the in-memory
 * active state).
 */
export function withRelayState(updater: (s: RelayState) => RelayState): RelayState {
	const deadline = Date.now() + LOCK_WAIT_MAX_MS;
	let locked = tryAcquireRelayLock();
	let delay = LOCK_RETRY_START_MS;
	while (!locked && Date.now() < deadline) {
		sleepSync(delay);
		locked = tryAcquireRelayLock();
		delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
	}
	if (!locked) {
		logWarn("relay state lock held — proceeding without lock after timeout", {
			lock: RELAY_STATE_LOCK_FILE,
		});
	}
	try {
		const next = updater(loadRelayState());
		saveRelayState(next);
		setActiveRelayState(next, false);
		return next;
	} finally {
		if (locked) {
			try { fs.rmSync(RELAY_STATE_LOCK_FILE, { force: true }); } catch {}
		}
	}
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
 * Shared status-widget label: the active relay line shown in the host status
 * bar. Returns null when the widget should be cleared (hidden, direct mode,
 * or an empty pool with no explicit OFF mode).
 */
export function formatRelayStatusLabel(state: RelayState, targetUrl?: string): string | null {
	if (!state || state.hideWidget) {
		return null;
	}
	if (!state.enabled || !state.relays || state.relays.length === 0) {
		return state.mode === "off" ? "relay: OFF (direct)" : null;
	}
	const currentUrl = targetUrl || state.url || state.relays[0]?.url || "";
	const label = shortRelayLabel(currentUrl, state.relays);
	const total = state.relays.length || 1;
	const pos = Math.max(1, state.relays.findIndex((r) => r.url === currentUrl) + 1);
	const modeLabel = state.mode === "on" ? "ON" : "AUTO (ON)";
	return `relay: ${modeLabel} | ${label} ${pos}/${total}`;
}

/**
 * Shared relay-picker item text ("[1] [label] → url" with an active marker).
 */
export function formatRelayPickerItem(r: KnownRelay, idx: number, activeUrl?: string): string {
	const isActive = typeof activeUrl === "string" && r.url === activeUrl;
	const lbl = r.label ? `[${r.label}] ` : `[${shortRelayLabel(r.url)}] `;
	return `${isActive ? "★ " : ""}[${idx + 1}] ${lbl}→ ${r.url}`;
}

/**
 * Shared /freeflow flash notification text for the current relay mode/pool state.
 */
export function formatRelayFlash(state: RelayState): string {
	const activeLabel = shortRelayLabel(state.url, state.relays);
	const activeIdx = Math.max(
		1,
		state.relays.findIndex((r) => r.url === state.url) + 1,
	);
	const total = state.relays.length || 1;
	const modeStr = (state.mode || "auto").toUpperCase();
	return `Relay mode: ${modeStr} (${state.enabled ? "ON" : "OFF"})${state.enabled ? ` → ${activeLabel} (${activeIdx}/${total})` : " (direct)"} | saved=${state.relays.length} (auto-fallback rolling)`;
}

export function updateRelayStatusUi(targetUrl?: string): void {
	if (!activeStatusUi?.setStatus) {
		return;
	}
	// Do not update status bar if the user switched to another provider (e.g. Gemini/Claude)
	if (!isFreeFlowModelActive) {
		activeStatusUi.setStatus("freeflow", undefined);
		return;
	}
	const label = formatRelayStatusLabel(getActiveRelayState(), targetUrl);
	activeStatusUi.setStatus("freeflow", label ?? undefined);
}
