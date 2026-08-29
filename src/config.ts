/**
 * Configuration and path resolution for pi-freeflow
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { Upstream } from "./types.ts";

// Package version — stale-daemon detection in the shared-port reuse path.
let PKG_VERSION = "0.0.0";
try {
	const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
	const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
	if (raw && typeof raw === "object" && "version" in raw) {
		const v = raw.version;
		if (typeof v === "string" && v) PKG_VERSION = v;
	}
} catch {}
export { PKG_VERSION };

// ── Upstream endpoints ──────────────────────────────────────────────
export const UPSTREAM_OPENCODE = "https://opencode.ai/zen";
export const KILO_CHAT_URL = "https://api.kilo.ai/api/gateway/chat/completions";
export const OPENCODE_API_URL = `${UPSTREAM_OPENCODE}/v1`;

// ── Network & Server defaults ───────────────────────────────────────
export const DEFAULT_PORT = 28180;
export const LEGACY_PORT = 18080;
export const HOST = "127.0.0.1";

export function resolvePort(): number {
	const envPort = process.env.FREEFLOW_PORT;
	if (envPort) {
		const parsed = Number(envPort);
		if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
			return parsed;
		}
	}
	return DEFAULT_PORT;
}

export const PORT = resolvePort();

// ── OpenCode client headers ─────────────────────────────────────────
export const OPENCODE_USER_AGENT = "opencode/latest/1.14.50/cli";
export const OPENCODE_CLIENT = "cli";
export const OPENCODE_PROJECT = "default";
export const OPENCODE_SESSION = randomUUID();

export function opencodeHeaders(): Record<string, string> {
	return {
		"User-Agent": OPENCODE_USER_AGENT,
		"x-opencode-client": OPENCODE_CLIENT,
		"x-opencode-project": OPENCODE_PROJECT,
		"x-opencode-session": OPENCODE_SESSION,
		"x-opencode-request": randomUUID(),
	};
}

// ── Relay and Deployment constants ──────────────────────────────────
export const VERCEL_API = "https://api.vercel.com";

// ── Catalog & Logging constants ─────────────────────────────────────
export const CATALOG_CACHE_TTL_MS = 86_400_000; // 24 hours — delegate to host fetchDynamicModels
export const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB per file
export const LOG_MAX_FILES = 10; // 10 archived + current ≈ 110MB max (≈100MB per your request, rotated, not single 100MB blob)

// ── Rate Limit Maxima ───────────────────────────────────────────────
export const RATE_LIMIT_MAX: Record<Upstream, number> = {
	opencode: 200, // public free quota: requests per UTC day per IP
	kilo: 200, // documented gateway quota: requests per 1-hour window per IP
};

// ── Whitelists & Security ───────────────────────────────────────────
export const ALLOWED_PATH_PATTERN = /^\/v1\/[a-zA-Z0-9/_.,\-?&=]*$/;
export const PATH_TRAVERSAL_PATTERN = /\.\./;
export const ALLOWED_METHODS = new Set(["GET", "POST", "OPTIONS", "HEAD"]);

export const STRIP_HEADERS = new Set([
	"authorization",
	"host",
	"content-length",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"x-real-ip",
	"x-client-ip",
	"x-originate-ip",
	"cookie",
	"set-cookie",
	"proxy-connection",
	"proxy-authorization",
]);

// ── File Path Resolvers ─────────────────────────────────────────────

export function resolveRelayStatePath(): string {
	try {
		return path.join(homedir(), ".pi", "agent", "pi-freeflow-relay-state.json");
	} catch {
		return path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			".relay-state.json",
		);
	}
}

export function resolveLogFilePath(): string {
	try {
		return path.join(homedir(), ".pi", "agent", "pi-freeflow.log");
	} catch {
		return path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			"pi-freeflow.log",
		);
	}
}

export function resolveCatalogCachePath(): string {
	try {
		return path.join(
			homedir(),
			".pi",
			"agent",
			"pi-freeflow-catalog-cache.json",
		);
	} catch {
		return path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			".catalog-cache.json",
		);
	}
}

export function resolveDebugStatePath(): string {
	try {
		return path.join(homedir(), ".pi", "agent", "pi-freeflow-debug.json");
	} catch {
		return path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			".debug-state.json",
		);
	}
}

export function resolveUpdateCachePath(): string {
	try {
		return path.join(homedir(), ".pi", "agent", "pi-freeflow-update.json");
	} catch {
		return path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			".update-cache.json",
		);
	}
}

export function resolveOnboardedFlagPath(): string {
	try {
		return path.join(homedir(), ".pi", "agent", "pi-freeflow-onboarded");
	} catch {
		return path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			".onboarded",
		);
	}
}

export const RELAY_STATE_FILE = resolveRelayStatePath();
export const LOG_FILE = resolveLogFilePath();
export const CATALOG_CACHE_FILE = resolveCatalogCachePath();
export const DEBUG_STATE_FILE = resolveDebugStatePath();
export const UPDATE_CACHE_FILE = resolveUpdateCachePath();
export const ONBOARDED_FLAG_FILE = resolveOnboardedFlagPath();
export const UPDATE_CHECK_TTL_MS = 86_400_000;
// ── Security & Relay Validation ─────────────────────────────────────
/** Opt-out for tests/dev: when set to "1", relay URLs on http:// and private hosts are allowed. */
export const ALLOW_UNSAFE_RELAY_ENV = "PI_FREEFLOW_ALLOW_UNSAFE_RELAY";
/** Max request body the proxy buffers before responding 413. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Default timeout for upstream headers while proxying a request. */
export const UPSTREAM_HEADER_TIMEOUT_MS = 300_000;
/** Timeout for refreshing the catalog (host fetchDynamicModels). */
export const CATALOG_REFRESH_TIMEOUT_MS = 10_000;
/** Timeout for probing a relay with a light /v1/models request. */
export const PROBE_TIMEOUT_MS = 5_000;
