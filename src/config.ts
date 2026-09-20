/**
 * Configuration and path resolution for pi-freeflow
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
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
export const UPSTREAM_OPENCODE = "https://opencode.ai/zen";
export const KILO_CHAT_URL = "https://api.kilo.ai/api/gateway/chat/completions";
export const KILO_RESPONSES_URL = "https://api.kilo.ai/api/gateway/responses";
export const OPENCODE_API_URL = `${UPSTREAM_OPENCODE}/v1`;
// Cline serves chat completions only — responses-path requests are translated
// to chat upstream and back (see tool-translation.ts). Direct-only: Cline
// traffic never rides the relay pool and carries a per-user bearer token
// supplied at call time (never stored here).
export const CLINE_API_BASE = "https://api.cline.bot/api/v1";
export const CLINE_CHAT_URL = `${CLINE_API_BASE}/chat/completions`;

// ── Network & Server defaults ───────────────────────────────────────
export const DEFAULT_PORT = 28180;
export const LEGACY_PORT = 18080;
export const HOST = "127.0.0.1";

export function resolvePort(): number {
 const envPort = process.env.PI_FREEFLOW_PORT;
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
export const OPENCODE_VERSION_FALLBACK = "1.18.31";
/** Live npm lookup TTL: 6h — within one window the cached UA is reused. */
export const OPENCODE_VERSION_TTL_MS = 6 * 60 * 60 * 1_000;
/** Env override: exact `opencode/<version>` UA (or bare version) for tests/pins. */
export const OPENCODE_USER_AGENT_ENV = "PI_FREEFLOW_OPENCODE_USER_AGENT";
/** Owned UA probe cache file (sibling of the update-check cache). */
export const OPENCODE_VERSION_CACHE_ENV = "PI_FREEFLOW_OPENCODE_VERSION_CACHE";

export const OPENCODE_VERSION = OPENCODE_VERSION_FALLBACK;
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION}`;
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
 * Synchronous UA getter — offline-safe by construction. Precedence:
 * env override > in-process live version > fresh disk cache > pinned fallback.
 * Never throws, never touches the network (disk re-read at most once a minute).
 */
export function getOpenCodeUserAgent(): string {
 const override = toOpenCodeUserAgent(process.env[OPENCODE_USER_AGENT_ENV]);
 if (override) return override;
 if (liveOpenCodeVersion && isSupportedOpenCodeVersion(liveOpenCodeVersion)) {
  return `opencode/${liveOpenCodeVersion}`;
 }
 const disk = memoizedDiskVersion();
 if (disk) return `opencode/${disk}`;
 return OPENCODE_USER_AGENT;
}

/**
 * Refresh the live UA from `npm view opencode-ai version` (registry metadata,
 * same source the installer layer queries for the latest channel build).
 * Offline-safe: any failure keeps the pinned fallback and returns it.
 * A fetched version below the floor never replaces the fallback.
 */
export async function refreshOpenCodeUserAgent(fetchImpl: typeof fetch = fetch): Promise<string> {
 const override = toOpenCodeUserAgent(process.env[OPENCODE_USER_AGENT_ENV]);
 if (override) return override;
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
  return `opencode/${version}`;
 } catch { return getOpenCodeUserAgent(); }
}
// OpenCode project ID: 40-character sha1 hex hash
export const OPENCODE_PROJECT = createHash("sha1")
 .update("git-remote:github.com/anomalyco/opencode")
 .digest("hex");

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

export function createOpenCodeSessionId(): string {
 return `ses_${createOpenCodeId(true)}`;
}

export function createOpenCodeRequestId(): string {
 return `msg_${createOpenCodeId(false)}`;
}

export const OPENCODE_SESSION = createOpenCodeSessionId();

export function opencodeHeaders(): Record<string, string> {
 return {
  "User-Agent": getOpenCodeUserAgent(),
  "x-opencode-client": OPENCODE_CLIENT,
  "x-opencode-project": OPENCODE_PROJECT,
  "x-opencode-session": OPENCODE_SESSION,
  "x-opencode-request": createOpenCodeRequestId(),
 };
}

// ── Relay and Deployment constants ──────────────────────────────────
export const VERCEL_API = "https://api.vercel.com";

// ── Catalog & Logging constants ─────────────────────────────────────
export const CATALOG_CACHE_TTL_MS = 86_400_000; // 24 hours — delegate to host fetchDynamicModels
export const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB per file
export const LOG_MAX_FILES = 10; // 10 archived + current ≈ 110MB max (≈100MB per your request, rotated, not single 100MB blob)

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
 *  Unset → ~/.pi/agent. */
export const DATA_DIR_ENV = "PI_FREEFLOW_DATA_DIR";

function dataDirOverride(): string | null {
 const d = process.env[DATA_DIR_ENV];
 return typeof d === "string" && d.trim() !== "" ? d : null;
}

export function resolveRelayStatePath(): string {
 try {
  const override = dataDirOverride();
  if (override) return path.join(override, "pi-freeflow-relay-state.json");
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
  const override = dataDirOverride();
  if (override) return path.join(override, "pi-freeflow.log");
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
  const override = dataDirOverride();
  if (override) return path.join(override, "pi-freeflow-catalog-cache.json");
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
  const override = dataDirOverride();
  if (override) return path.join(override, "pi-freeflow-debug.json");
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
  const override = dataDirOverride();
  if (override) return path.join(override, "pi-freeflow-update.json");
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
  const override = dataDirOverride();
  if (override) return path.join(override, "pi-freeflow-onboarded");
  return path.join(homedir(), ".pi", "agent", "pi-freeflow-onboarded");
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
  const override = dataDirOverride();
  if (override) return path.join(override, "pi-freeflow-upstream-health.json");
  return path.join(homedir(), ".pi", "agent", "pi-freeflow-upstream-health.json");
 } catch {
  return path.join(
   path.dirname(fileURLToPath(import.meta.url)),
   "..",
   ".upstream-health.json",
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
