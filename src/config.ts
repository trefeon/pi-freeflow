/**
 * Configuration and path resolution for pi-freeflow
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Package version — stale-daemon detection in the shared-port reuse path.
let PKG_VERSION = "0.0.0";
try {
 const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
 const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
 if (raw && typeof raw === "object" && "version" in raw) {
  const v = raw.version;
  if (typeof v === "string" && v) PKG_VERSION = v;
 }
} catch { }
export { PKG_VERSION };

// ── Upstream endpoints ──────────────────────────────────────────────
export const UPSTREAM_OPENCODE = "https://opencode.ai/inference";
export const KILO_CHAT_URL = "https://api.kilo.ai/api/gateway/chat/completions";
export const KILO_RESPONSES_URL = "https://api.kilo.ai/api/gateway/responses";
export const OPENCODE_API_URL = `${UPSTREAM_OPENCODE}/v1`;
/**
 * OpenAI-compat Zen lane — the DEFAULT lane for chat completions.
 * Live truth (v1 1.19.4 MITM, SG): the official CLI addresses the free tier
 * here (`POST https://opencode.ai/inference/openai/v1/chat/completions`),
 * not on the plain /v1 chat path. Same gateway, same Bearer public
 * credential, but the path carries the extra `/openai` segment and the body
 * carries `stream_options: { include_usage: true }`.
 * The plain `/inference/v1/chat/completions` path stays as the fallback when
 * the compat lane answers 404/405. Relay probes address the compat lane via
 * OPENCODE_OPENAI_COMPAT_PATH (the x-relay-path the workers forward as
 * target + path).
 */
export const OPENCODE_OPENAI_COMPAT_URL = `${UPSTREAM_OPENCODE}/openai/v1/chat/completions`;
export const OPENCODE_OPENAI_COMPAT_PATH = "/inference/openai/v1/chat/completions";

/**
 * Origin (scheme + host) of the OpenCode gateway. UPSTREAM_OPENCODE above is
 * the origin plus the `/inference` base path; joining a `/inference/...`
 * upstream path onto it would double the base (`/inference/inference/...`),
 * so callers that already hold an upstream-rooted path join it here instead.
 */
export const OPENCODE_ORIGIN = "https://opencode.ai";

/**
 * Default-lane upstream path for a request path. Chat completions ride
 * the openai-compat lane (live CLI truth); every other path (responses,
 * messages, models) keeps its plain mapping. The plain chat path stays as
 * the fallback when the compat lane answers 404/405.
 *
 * Accepts EITHER form because production `validatePath` resolves the local
 * `/v1/...` path against the `/inference` base, so `target.pathname` already
 * arrives upstream-rooted (`/inference/v1/chat/completions`): a leading
 * `/inference` base is normalized off before mapping, and an already-compat
 * or unknown path passes through untouched instead of being sliced blindly.
 * Idempotent: feeding its own output back returns it unchanged.
 */
export function zenUpstreamPathFor(localOrUpstreamPathname: string): string {
 const local = localOrUpstreamPathname.startsWith("/inference/")
  ? localOrUpstreamPathname.slice("/inference".length)
  : localOrUpstreamPathname;
 if (local === "/v1/chat/completions") return OPENCODE_OPENAI_COMPAT_PATH;
 if (local.startsWith("/v1/")) return `/inference${local}`;
 return localOrUpstreamPathname;
}

/** Full upstream URL for a local request path on the default Zen lane. */
export function zenUpstreamUrlFor(localPathname: string): string {
 return `${OPENCODE_ORIGIN}${zenUpstreamPathFor(localPathname)}`;
}
// Cline serves chat completions only — responses-path requests are translated
// to chat upstream and back (see tool-translation.ts). Direct-only: Cline
// traffic never rides the relay pool and carries a per-user bearer token
// supplied at call time (never stored here).
export const CLINE_API_BASE = "https://api.cline.bot/api/v1";
export const CLINE_CHAT_URL = `${CLINE_API_BASE}/chat/completions`;
// OVHcloud AI Endpoints serves OpenAI-compatible chat completions with no
// credential at all (probed keyless 2026-10-13: no Authorization header,
// 200). Direct-only: OVH has no Zen-style per-IP gate to route around, so
// it never rides the relay pool and is deliberately absent from the deployed
// relay allowlist (src/deploy.ts), which keeps the relay surface at exactly
// two upstreams. Chat-only: OVH's responses endpoint rejects every array
// input shape with 422 "input: data did not match any variant of untagged
// enum ResponseInput" and accepts only a bare string (probed 2026-10-13), so
// a responses-path caller is translated to chat upstream and back.
export const OVH_API_BASE = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1";
export const OVH_CHAT_URL = `${OVH_API_BASE}/chat/completions`;

// ── Network & Server defaults ───────────────────────────────────────
export const DEFAULT_PORT = 28180;
export const HOST = "127.0.0.1";

export function resolvePort(): number {
 const envPort = process.env.PI_FREEFLOW_PORT;
 if (envPort) {
  const parsed = Number(envPort);
  // Integers only: 28180.5 is finite and in range but net.Server.listen
  // rejects it with an uncatchable ERR_SOCKET_BAD_PORT.
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
   return parsed;
  }
 }
 return DEFAULT_PORT;
}

export const PORT = resolvePort();

// ── Relay and Deployment constants ──────────────────────────────────
export const VERCEL_API = "https://api.vercel.com";

// ── Catalog & Logging constants ─────────────────────────────────────
export const CATALOG_CACHE_TTL_MS = 86_400_000; // 24 hours — delegate to host fetchDynamicModels
export const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB per file
export const LOG_MAX_FILES = 10; // 10 archived + current ≈ 110MB cap (rotated, never a single 100MB blob)

// ── Whitelists & Security ───────────────────────────────────────────
export const ALLOWED_PATH_PATTERN = /^\/v1\/[a-zA-Z0-9/_.,\-?&= %]*$/;
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

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Default timeout for upstream headers while proxying a request. */
export const UPSTREAM_HEADER_TIMEOUT_MS = 300_000;

// ── Zen transport (opt-in Bun sidecar) ─────────────────────────────────
// PI_FREEFLOW_ZEN_TRANSPORT selects the TLS stack that originates the Zen
// direct-leg connection. Unset (or anything but "bun-sidecar") keeps the
// Node fetch path, byte-identical to today. Set exactly "bun-sidecar" to
// route the Zen direct leg through src/zen-sidecar.ts (Bun.fetch native
// stack) with automatic degrade to Node fetch when bun is absent, too old,
// or the sidecar fails. Zen relay legs are skipped while the sidecar is
// active (a relay would re-originate the connection and forfeit the
// sidecar's fingerprint); non-Zen lanes never use the sidecar.
export const ZEN_TRANSPORT_ENV = "PI_FREEFLOW_ZEN_TRANSPORT";
/** Timeout for refreshing the catalog (host fetchDynamicModels). */
export const CATALOG_REFRESH_TIMEOUT_MS = 10_000;
/** Timeout for probing a relay with a light /v1/models request. */
export const PROBE_TIMEOUT_MS = 5_000;

// ── Re-exports from split modules for complete backward compatibility ─
export * from "./config-paths.ts";
export * from "./opencode-identity.ts";
