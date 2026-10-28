/**
 * Configuration and path resolution for pi-freeflow
 */

import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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

// ── OpenCode client headers ─────────────────────────────────────────
// Live UA layer, grounded in reference/opencode:
// - packages/opencode/src/session/llm/request.ts sends `User-Agent: USER_AGENT`
//   on every opencode-provider request.
// - packages/opencode/src/installation/index.ts builds it as
//   `opencode/${InstallationVersion}` (plugin probes) or
//   `opencode/${InstallationChannel}/${InstallationVersion}/${client}` (CLI).
// - packages/core/src/installation/version.ts falls back to "local" when the
//   build-time OPENCODE_VERSION global is absent.
// Free-tier floor: opencodeHeaders() must never send below 1.17.0.
// OPENCODE_VERSION_FLOOR pins the minimum; OPENCODE_VERSION_FALLBACK is the
// last-known-good npm version used when the live lookup is stale/offline.
export const OPENCODE_VERSION_FLOOR = "1.17.0";
export const OPENCODE_VERSION_FALLBACK = "1.19.4";
/** Live npm lookup TTL: 6h — within one window the cached UA is reused. */
export const OPENCODE_VERSION_TTL_MS = 6 * 60 * 60 * 1_000;
/** Env override: exact `opencode/<version>` UA (or bare version) for tests/pins. */
export const OPENCODE_USER_AGENT_ENV = "PI_FREEFLOW_OPENCODE_USER_AGENT";
/** Owned UA probe cache file (sibling of the update-check cache). */
export const OPENCODE_VERSION_CACHE_ENV = "PI_FREEFLOW_OPENCODE_VERSION_CACHE";

export const OPENCODE_CLIENT = "cli";

function compareVersionParts(a: string, b: string): number {
 const pa = a.split(".").map((p) => Number.parseInt(p, 10));
 const pb = b.split(".").map((p) => Number.parseInt(p, 10));
 for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
  const na = pa[i] ?? 0;
  const nb = pb[i] ?? 0;
  if (na !== nb) return na < nb ? -1 : 1;
 }
 return 0;
}

/** True when `version` is a strict `major.minor.patch` at or above the floor. */
export function isSupportedOpenCodeVersion(version: unknown): boolean {
 if (typeof version !== "string") return false;
 if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
 return compareVersionParts(version, OPENCODE_VERSION_FLOOR) >= 0;
}

/** Normalize an override/registry version into an `opencode/<v>` UA, else null. */
export function toOpenCodeUserAgent(version: unknown): string | null {
 if (typeof version !== "string") return null;
 const v = version.trim();
 if (!v) return null;
 const bare = v.startsWith("opencode/") ? v.slice("opencode/".length) : v;
 if (!isSupportedOpenCodeVersion(bare)) return null;
 return `opencode/${bare}`;
}

function openCodeVersionCachePath(): string {
 const override = process.env[OPENCODE_VERSION_CACHE_ENV];
 if (typeof override === "string" && override.trim() !== "") return override;
 try {
  return path.join(path.dirname(resolveUpdateCachePath()), "pi-freeflow-opencode-version.json");
 } catch {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".opencode-version.json");
 }
}

interface OpenCodeVersionCache { version: string; checkedAt: number; }

function readOpenCodeVersionCache(): OpenCodeVersionCache | null {
 try {
  const raw = readFileSync(openCodeVersionCachePath(), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const { version, checkedAt } = parsed as Record<string, unknown>;
  if (!isSupportedOpenCodeVersion(version)) return null;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return null;
  return { version: version as string, checkedAt };
 } catch { return null; }
}

function writeOpenCodeVersionCache(version: string): void {
 try {
  const file = openCodeVersionCachePath();
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ version, checkedAt: Date.now() }), "utf8");
 } catch { }
}

let liveOpenCodeVersion: string | null = null;
/** Memoized disk read: path -> { version, fileCheckedAt } so opencodeHeaders() stays sync and cheap. */
let diskMemo: { path: string; version: string | null; readAt: number } | null = null;
const DISK_MEMO_TTL_MS = 60_000;

function memoizedDiskVersion(): string | null {
 const file = openCodeVersionCachePath();
 const now = Date.now();
 if (diskMemo && diskMemo.path === file && now - diskMemo.readAt < DISK_MEMO_TTL_MS) return diskMemo.version;
 const cached = readOpenCodeVersionCache();
 const version = cached && now - cached.checkedAt < OPENCODE_VERSION_TTL_MS ? cached.version : null;
 diskMemo = { path: file, version, readAt: now };
 return version;
}

/** Test-only: reset the in-process live version (cache file untouched). */
export function _resetLiveOpenCodeVersionForTest(): void { liveOpenCodeVersion = null; diskMemo = null; }

/**
 * Current OpenCode version for the wire UA — the single precedence chain:
 * env override > in-process live version > fresh disk cache > pinned fallback.
 * Never throws, never touches the network (disk re-read at most once a minute).
 */
function currentOpenCodeVersion(): string {
 const override = toOpenCodeUserAgent(process.env[OPENCODE_USER_AGENT_ENV]);
 if (override) return override.slice("opencode/".length);
 if (liveOpenCodeVersion && isSupportedOpenCodeVersion(liveOpenCodeVersion)) return liveOpenCodeVersion;
 const disk = memoizedDiskVersion();
 if (disk) return disk;
 return OPENCODE_VERSION_FALLBACK;
}

/**
 * Synchronous UA getter — the single User-Agent implementation every lane
 * sends (offline-safe by construction). Always the verbatim CLI full shape.
 */
export function getOpenCodeUserAgent(): string {
 return buildOpenCodeUserAgent(currentOpenCodeVersion());
}

/**
 * Refresh the live UA from `npm view opencode-ai version` (registry metadata,
 * same source the installer layer queries for the latest channel build).
 * Offline-safe: any failure keeps the pinned fallback and returns it.
 * A fetched version below the floor never replaces the fallback.
 */
export async function refreshOpenCodeUserAgent(fetchImpl: typeof fetch = fetch): Promise<string> {
 const override = toOpenCodeUserAgent(process.env[OPENCODE_USER_AGENT_ENV]);
 if (override) return getOpenCodeUserAgent();
 try {
  const res = await fetchImpl("https://registry.npmjs.org/opencode-ai/latest", {
   signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return getOpenCodeUserAgent();
  const body: unknown = await res.json();
  const version = (body as Record<string, unknown>)?.version;
  if (!isSupportedOpenCodeVersion(version)) return getOpenCodeUserAgent();
  liveOpenCodeVersion = version as string;
  writeOpenCodeVersionCache(version as string);
  diskMemo = null;
  return getOpenCodeUserAgent();
 } catch { return getOpenCodeUserAgent(); }
}
/** Live version already fetched in-process, else the pinned fallback. No network, no side effect. */
export function getLiveOpenCodeVersion(): string { return liveOpenCodeVersion ?? OPENCODE_VERSION_FALLBACK; }

/**
 * Build the OpenCode User-Agent string: always the verbatim CLI full shape
 * (`opencode/<version> ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`).
 * The legacy bare and channel shapes are gone with the A/B profiles.
 */
export function buildOpenCodeUserAgent(version: string): string {
 return `opencode/${version} ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`;
}

const STABLE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const STABLE_SESSION_CAP = 1000;
const stableSessionCache = new Map<string, string>();
const TIME48_MASK = (1n << 48n) - 1n;

/**
 * Stable per-conversation session id. A valid `ses_*` key passes through
 * verbatim; "" allocates a fresh random id; anything else maps deterministically
 * via sha256("pi-freeflow\\0" + key): 48-bit time field from the digest with the
 * descending counter pinned at 1, plus 14 base62 chars from later digest bytes.
 * Results are memoized in an LRU (cap 1000, hit moves to back); `now` is accepted
 * for signature compatibility and ignored so the same key always maps the same.
 */
export function stableOpenCodeSessionId(key: string, now = Date.now()): string {
 void now;
 if (STABLE_SESSION_RE.test(key)) return key;
 if (key === "") return createOpenCodeSessionId();
 const hit = stableSessionCache.get(key);
 if (hit !== undefined) {
  stableSessionCache.delete(key);
  stableSessionCache.set(key, hit);
  return hit;
 }
 const digest = createHash("sha256").update(`pi-freeflow\0${key}`).digest();
 const time48 = (BigInt(digest[0]!) << 40n) | (BigInt(digest[1]!) << 32n) | (BigInt(digest[2]!) << 24n) | (BigInt(digest[3]!) << 16n) | (BigInt(digest[4]!) << 8n) | BigInt(digest[5]!);
 const time = ((~(time48 * 0x1000n + 1n)) & TIME48_MASK).toString(16).padStart(12, "0");
 let rand = "";
 for (let i = 0; i < 14; i++) rand += ID_CHARS[digest[(6 + i) % digest.length]! % 62];
 const id = `ses_${time}${rand}`;
 stableSessionCache.set(key, id);
 if (stableSessionCache.size > STABLE_SESSION_CAP) {
  const oldest = stableSessionCache.keys().next();
  if (!oldest.done) stableSessionCache.delete(oldest.value);
 }
 return id;
}

/** Test-only: clear the stable session memo. */
export function _resetStableSessionCacheForTest(): void { stableSessionCache.clear(); }

/** Test-only: current stable session memo size (proves the LRU cap). */
export function _stableSessionCacheSizeForTest(): number { return stableSessionCache.size; }

/** Test-only: whether a key is currently memoized (proves LRU eviction). */
export function _stableSessionHasKeyForTest(key: string): boolean { return stableSessionCache.has(key); }
/** The literal `global` project the CLI sends outside a repo. */
export const OPENCODE_PROJECT_GLOBAL = "global";
/** sha1 hex digest of a working directory (what the CLI sends as the project). */
export function openCodeProjectForCwd(cwd: string): string {
 return createHash("sha1").update(cwd).digest("hex");
}

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let idTimestamp = 0;
let idCounter = 0;

/**
 * Generate a 26-character OpenCode-compatible identifier.
 * Matches packages/schema/src/identifier.ts in anomalyco/opencode:
 * 12 hex characters encoding inverted (descending) or direct (ascending)
 * timestamp (BigInt(timestamp) * 0x1000n + counter, ~ when descending),
 * followed by 14 random base62 characters.
 */
export function createOpenCodeId(descending: boolean, timestamp = Date.now()): string {
 if (timestamp !== idTimestamp) {
  idTimestamp = timestamp;
  idCounter = 0;
 }
 idCounter++;

 const current = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
 const value = descending ? ~current : current;
 const time = Array.from({ length: 6 }, (_, index) =>
  Number((value >> BigInt(40 - 8 * index)) & 0xffn)
   .toString(16)
   .padStart(2, "0"),
 ).join("");
 const bytes = randomBytes(14);
 return time + Array.from(bytes, (byte) => ID_CHARS[byte % 62]).join("");
}

// Upstream v1.19.4 refactored `SessionID.create` to compose the prefix itself
// (`schema.make("ses_" + descending())` in packages/schema/src/session-id.ts).
// The identifier generator is unchanged, so this call is still byte-for-byte
// equivalent: `ses_` + 12 hex timestamp chars + 14 base62 random chars.
export function createOpenCodeSessionId(): string {
 return `ses_${createOpenCodeId(true)}`;
}

export function createOpenCodeRequestId(): string {
 return `msg_${createOpenCodeId(false)}`;
}

/**
 * Live project header: the CLI sends `global` outside a repo and the sha1 of
 * the working directory inside one. Without a cwd to hash, `global` is the
 * truthful value — never the fixed pin above.
 */
export function resolveOpenCodeProjectLive(cwd?: string): string {
 if (typeof cwd === "string" && cwd.length > 0) return openCodeProjectForCwd(cwd);
 return OPENCODE_PROJECT_GLOBAL;
}

/**
 * Live-truth OpenCode headers (v1 1.19.4 MITM, SG): full UA, Bearer public,
 * client cli, per-conversation ses_* session, fresh msg_* request id per
 * prepare, and the cwd-derived project. Affinity headers are NEVER sent on
 * the opencode lane (upstream treats them as a non-OpenCode signal); they
 * are gated to non-opencode lanes only (see sanitizeHeaders callers).
 *
 * @param sessionKey conversation-scoped key reused within a run
 *   (stableOpenCodeSessionId maps it deterministically; a valid ses_* passes
 *   through verbatim). Omitted/empty allocates a fresh id for this call.
 * @param cwd working directory for the project header; omitted → `global`.
 */
export function opencodeHeaders(sessionKey?: string, cwd?: string): Record<string, string> {
 const sessionId =
  typeof sessionKey === "string" && sessionKey.length > 0
   ? stableOpenCodeSessionId(sessionKey)
   : createOpenCodeSessionId();
 return {
  Authorization: "Bearer public",
  "User-Agent": getOpenCodeUserAgent(),
  "x-opencode-client": OPENCODE_CLIENT,
  "x-opencode-project": resolveOpenCodeProjectLive(cwd),
  "x-opencode-session": sessionId,
  "x-opencode-session-id": sessionId,
  "x-opencode-request": createOpenCodeRequestId(),
 };
}

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

/** Env override that re-roots ALL pi-freeflow data files (tests/CI sandbox).
 *  Unset → pi's agent dir (PI_CODING_AGENT_DIR, else ~/.pi/agent). */
export const DATA_DIR_ENV = "PI_FREEFLOW_DATA_DIR";

/** Env var pi itself uses to re-root its config dir: pi names it
 *  `<APP_NAME>_CODING_AGENT_DIR` (stock pi → PI_CODING_AGENT_DIR, else
 *  ~/.pi/agent). Freeflow data files follow it so CI/containers only need to
 *  relocate one root instead of granting write access to a hardcoded home
 *  path; when another host (e.g. the omp plugin loader) does not set it, the
 *  ~/.pi/agent default keeps the shared daemon/log location. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Expand a leading ~ the way pi expands its own agent-dir value. */
function expandHome(value: string): string {
 if (value === "~") return homedir();
 if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2));
 return value;
}

function dataDirOverride(): string | null {
 const d = process.env[DATA_DIR_ENV];
 return typeof d === "string" && d.trim() !== "" ? expandHome(d) : null;
}

function defaultAgentDir(): string {
 const d = process.env[AGENT_DIR_ENV];
 if (typeof d === "string" && d.trim() !== "") return expandHome(d);
 return path.join(homedir(), ".pi", "agent");
}

function dataFilePath(name: string): string {
 const override = dataDirOverride();
 if (override) return path.join(override, name);
 return path.join(defaultAgentDir(), name);
}

/**
 * Per-installation proxy token file (src/token.ts reads/creates it at 0600).
 * Sits with the other data files so a sandboxed data dir relocates it too.
 */
export function resolveTokenPath(): string {
 try {
  return dataFilePath("token");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".pi-freeflow-token",
  );
 }
}

export function resolveRelayStatePath(): string {
 try {
  return dataFilePath("pi-freeflow-relay-state.json");
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
  return dataFilePath("pi-freeflow.log");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   "pi-freeflow.log",
  );
 }
}

/**
 * Root directory for staged daemon sources — copies taken outside
 * node_modules because Node's type stripping refuses files under a
 * node_modules path (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, issue #52).
 * Version subdirectories live inside it.
 */
export function resolveDaemonSrcCacheDir(): string {
 try {
  return dataFilePath("pi-freeflow-daemon-src");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".pi-freeflow-daemon-src",
  );
 }
}

export function resolveCatalogCachePath(): string {
 try {
  return dataFilePath("pi-freeflow-catalog-cache.json");
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
  return dataFilePath("pi-freeflow-debug.json");
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
  return dataFilePath("pi-freeflow-update.json");
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
  return dataFilePath("pi-freeflow-onboarded");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".onboarded",
  );
 }
}

export function resolveUpstreamHealthPath(): string {
 try {
  return dataFilePath("pi-freeflow-upstream-health.json");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".upstream-health.json",
  );
 }
}

/** JSONL audit of tool-call turns that failed or needed repair (src/toolcall-audit.ts). */
export function resolveToolcallAuditPath(): string {
 try {
  return dataFilePath("toolcall-audit.jsonl");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".toolcall-audit.jsonl",
  );
 }
}

export function resolveSessionPinPath(): string {
 try {
  return dataFilePath("pi-freeflow-session-pins.json");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".session-pins.json",
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
/** Opt-out for the stale-daemon replace: when "1", a version-mismatched daemon is never killed. */
export const NO_KILL_ENV = ALLOW_UNSAFE_RELAY_ENV.replace("_ALLOW_UNSAFE_RELAY", "_NO_KILL");
/** When "0", the extension never spawns a detached proxy daemon (tests/CI). */
export const DAEMON_SPAWN_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_SPAWN");
/** Explicit runtime executable path for daemon.ts (overrides process.execPath and PATH search). */
export const DAEMON_RUNTIME_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_RUNTIME");
/** Lease TTL for attached clients (ms); expired leases are dropped by the daemon GC. */
export const DAEMON_TTL_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_TTL_MS");
/** Client heartbeat interval (ms) — must stay well under the lease TTL. */
export const DAEMON_HEARTBEAT_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_HEARTBEAT_MS");
/** Daemon GC sweep interval (ms). */
export const DAEMON_GC_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_GC_MS");
/** Zero-lease persistence window before a lease-less daemon exits (ms). */
export const DAEMON_GRACE_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_GRACE_MS");
/** Max time a client waits for a freshly spawned daemon to answer /_health (ms). */
export const DAEMON_READY_TIMEOUT_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_READY_TIMEOUT_MS");
/** Timeout for a single loopback control call (attach/heartbeat/detach) (ms). */
export const DAEMON_CONTROL_TIMEOUT_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_CONTROL_TIMEOUT_MS");
/** Client watchdog tick: how often /_health is polled for version + failed-SSE rate (ms). */
export const DAEMON_WATCHDOG_MS_ENV = DATA_DIR_ENV.replace("_DATA_DIR", "_DAEMON_WATCHDOG_MS");

function envMs(name: string, fallback: number): number {
 const raw = process.env[name];
 if (raw) {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
 }
 return fallback;
}

const IS_WINDOWS_HOST = process.platform === "win32";
export const DAEMON_SPAWN_ENABLED = process.env[DAEMON_SPAWN_ENV] !== "0";
export const DAEMON_TTL_MS = envMs(DAEMON_TTL_MS_ENV, 30_000);
export const DAEMON_HEARTBEAT_MS = envMs(DAEMON_HEARTBEAT_MS_ENV, IS_WINDOWS_HOST ? 8_000 : 10_000);
export const DAEMON_GC_MS = envMs(DAEMON_GC_MS_ENV, 5_000);
export const DAEMON_GRACE_MS = envMs(DAEMON_GRACE_MS_ENV, IS_WINDOWS_HOST ? 15_000 : 10_000);
export const DAEMON_READY_TIMEOUT_MS = envMs(DAEMON_READY_TIMEOUT_MS_ENV, 5_000);
export const DAEMON_CONTROL_TIMEOUT_MS = envMs(DAEMON_CONTROL_TIMEOUT_MS_ENV, IS_WINDOWS_HOST ? 3_000 : 1_500);
export const DAEMON_WATCHDOG_MS = envMs(DAEMON_WATCHDOG_MS_ENV, 5_000);
/** Failed-SSE rolling window (streams) and the failure rate that marks a daemon degraded. */
export const WATCHDOG_SSE_WINDOW = 20;
export const WATCHDOG_SSE_FAIL_RATE = 0.5;
/** Minimum samples before the failed-SSE rate can trigger recovery (avoids single-sample flapping). */
export const WATCHDOG_SSE_MIN_SAMPLES = 5;
/** Respawn backoff: min(2s * 2^n, 60s) + jitter. */
export const RECOVERY_BACKOFF_BASE_MS = 2_000;
export const RECOVERY_BACKOFF_CAP_MS = 60_000;
/** Breaker: 5 straight failures inside 5min halts respawn for 10min (in-process fallback meanwhile). */
export const BREAKER_FAILURES = 5;
export const BREAKER_WINDOW_MS = 5 * 60_000;
export const BREAKER_HALT_MS = 10 * 60_000;
/** Busy bypass: a busy daemon is replaced only after 5min continuous busy with zero forwarded bytes for 60s+. */
export const BUSY_BYPASS_CONTINUOUS_MS = 5 * 60_000;
export const BUSY_BYPASS_QUIET_MS = 60_000;
/** Re-probe of the base port before accepting a walked port (ms). */
export const BASE_PORT_REPROBE_MS = 3_000;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Default timeout for upstream headers while proxying a request. */
export const UPSTREAM_HEADER_TIMEOUT_MS = 300_000;
/** Timeout for refreshing the catalog (host fetchDynamicModels). */
export const CATALOG_REFRESH_TIMEOUT_MS = 10_000;
/** Timeout for probing a relay with a light /v1/models request. */
export const PROBE_TIMEOUT_MS = 5_000;
