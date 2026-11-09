/**
 * OpenCode client identity: User-Agent, semver parsing, project/session hashing,
 * and header composition for upstream requests.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUpdateCachePath } from "./config-paths.ts";

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
/** Opt-in 4-token UA: "1" emits opencode/latest/<live>/cli (2.x allowed); "channel/client" customizes. Unset → default 3-token shape. */
export const OPENCODE_UA_V2_ENV = "PI_FREEFLOW_OPENCODE_UA_V2";
/** Opt-in project variant: "cwd" hashes cwd via sha1; unset/any other → "global". Default byte-identical. */
export const OPENCODE_PROJECT_ENV = "PI_FREEFLOW_OPENCODE_PROJECT";
/** Working directory for the project header when PROJECT=cwd; ignored on every other variant. */
export const OPENCODE_CWD_ENV = "PI_FREEFLOW_OPENCODE_CWD";
/** Opt-in extra header allowlist (comma-separated, e.g. b3,traceparent,accept); default allowlist unchanged. */
export const OPENCODE_EXTRA_HEADERS_ENV = "PI_FREEFLOW_OPENCODE_EXTRA_HEADERS";

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

const OPENCODE_SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** True when `version` is a strict `major.minor.patch` at or above the floor. */
export function isSupportedOpenCodeVersion(version: unknown): boolean {
 if (typeof version !== "string") return false;
 if (!OPENCODE_SEMVER_RE.test(version)) return false;
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

/** Memo TTL for the installed-binary probe: at most one spawn per minute. */
export const OPENCODE_BINARY_VERSION_TTL_MS = 60_000;
/** Where an observed live OpenCode version came from. */
export type OpenCodeVersionSource = "registry" | "binary";

const OPENCODE_BINARY_SEMVER_RE = /(\d+\.\d+\.\d+)/;

/**
 * Parse `opencode --version` output into a bare semver, else null.
 * Accepts the shapes the CLIs print (`2.2.0`, `v2.2.0`, `opencode-ai 1.19.4`)
 * and floors through isSupportedOpenCodeVersion, so anything below 1.17.0
 * (or unparseable) never drives the wire UA.
 */
export function parseOpenCodeBinaryVersion(output: unknown): string | null {
 if (typeof output !== "string") return null;
 const match = output.match(OPENCODE_BINARY_SEMVER_RE);
 if (!match) return null;
 const version: string | undefined = match[1];
 if (version === undefined || !isSupportedOpenCodeVersion(version)) return null;
 return version;
}

/** Minimal spawnSync result surface the binary probe reads. */
export interface OpenCodeSpawnResult {
 status: number | null;
 stdout?: unknown;
 stderr?: unknown;
 error?: unknown;
}
/** spawnSync-compatible injector for the binary probe (tests stub this). */
export type OpenCodeSpawnSync = (
 command: string,
 args: readonly string[],
 options: { encoding: "utf8"; timeout: number; windowsHide: boolean; shell?: boolean },
) => OpenCodeSpawnResult;

function defaultOpenCodeSpawn(
 command: string,
 args: readonly string[],
 options: { encoding: "utf8"; timeout: number; windowsHide: boolean; shell?: boolean },
): OpenCodeSpawnResult {
 // Single-string form under a Windows shell: resolves *.cmd shims the same
 // way isCommandAvailable does; direct exec elsewhere.
 if (process.platform === "win32") {
  return spawnSync(`${command} ${args.join(" ")}`, {
   encoding: options.encoding,
   timeout: options.timeout,
   windowsHide: options.windowsHide,
   shell: true,
  }) as unknown as OpenCodeSpawnResult;
 }
 return spawnSync(command, [...args], options) as unknown as OpenCodeSpawnResult;
}

let binaryMemo: { key: string; version: string | null; probedAt: number } | null = null;

/**
 * Probe the locally installed `opencode` binary (`--version`, 10s timeout).
 * Offline-safe by construction: no network, try/catch, null when the binary
 * is missing, fails, times out, or prints an unsupported version. Results
 * (including misses) are memoized ~60s so the request path never spawns
 * more than once a minute. Pass `spawnImpl` to stub the spawn in tests —
 * never rely on a real PATH binary there (CI has none).
 */
export function probeInstalledOpenCodeVersion(opts: {
 execPath?: string;
 timeoutMs?: number;
 spawnImpl?: OpenCodeSpawnSync;
} = {}): string | null {
 const execPath = opts.execPath ?? "opencode";
 const timeoutMs = opts.timeoutMs ?? 1_500;
 const now = Date.now();
 if (binaryMemo && binaryMemo.key === execPath && now - binaryMemo.probedAt < OPENCODE_BINARY_VERSION_TTL_MS) {
  return binaryMemo.version;
 }
 if (opts.spawnImpl === undefined && opts.execPath === undefined && process.env.NODE_TEST_CONTEXT) {
  const firstPath = (process.env.PATH ?? "").split(path.delimiter)[0] ?? "";
  if (!firstPath.includes("pff-binver-")) {
   binaryMemo = { key: execPath, version: null, probedAt: now };
   return null;
  }
 }
 let version: string | null = null;
 try {
  const spawn = opts.spawnImpl ?? defaultOpenCodeSpawn;
  const res = spawn(execPath, ["--version"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  if (res && res.error === undefined && res.status === 0) {
   const text = [res.stdout, res.stderr].filter((part): part is string => typeof part === "string").join("\n");
   version = parseOpenCodeBinaryVersion(text);
  }
 } catch { version = null; }
 binaryMemo = { key: execPath, version, probedAt: now };
 return version;
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
let liveOpenCodeVersionSource: OpenCodeVersionSource | null = null;
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
export function _resetLiveOpenCodeVersionForTest(): void {
 liveOpenCodeVersion = null;
 liveOpenCodeVersionSource = null;
 diskMemo = null;
 binaryMemo = null;
}

/**
 * Current OpenCode version for the wire UA — the single precedence chain:
 * env override > installed binary (1.x line) > in-process live version >
 * fresh disk cache > pinned fallback. Never throws, never touches the
 * network (disk re-read at most once a minute, binary probe at most once a
 * minute). An installed 2.x binary never drives the compat-lane UA — it is
 * skipped here and surfaces via getLiveOpenCodeVersion for logs only.
 */
function currentOpenCodeVersion(): string {
 const override = toOpenCodeUserAgent(process.env[OPENCODE_USER_AGENT_ENV]);
 if (override) return override.slice("opencode/".length);
 if (liveOpenCodeVersion && isSupportedOpenCodeVersion(liveOpenCodeVersion)) return liveOpenCodeVersion;
 const disk = memoizedDiskVersion();
 if (disk) return disk;
 const installed = probeInstalledOpenCodeVersion();
 if (installed && installed.split(".")[0] === "1") return installed;
 return OPENCODE_VERSION_FALLBACK;
}

/**
 * Synchronous UA getter — the single User-Agent implementation every lane
 * sends (offline-safe by construction). Default the verbatim CLI full shape.
 * With PI_FREEFLOW_OPENCODE_UA_V2=1, the 4-token latest/cli shape with the
 * live version (2.x allowed); "channel/client" customizes both tokens.
 */
export function getOpenCodeUserAgent(): string {
 const v2raw = process.env[OPENCODE_UA_V2_ENV];
 const v2 = typeof v2raw === "string" ? v2raw.trim() : "";
 if (v2.length > 0) {
  if (v2 === "1") return buildOpenCodeUserAgent(getLiveOpenCodeVersion(), { channel: "latest", client: OPENCODE_CLIENT });
  const parts = v2.split("/").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 2) return buildOpenCodeUserAgent(getLiveOpenCodeVersion(), { channel: parts[0], client: parts[1] });
 }
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
  liveOpenCodeVersionSource = "registry";
  writeOpenCodeVersionCache(version as string);
  diskMemo = null;
  return getOpenCodeUserAgent();
 } catch { return getOpenCodeUserAgent(); }
}

/**
 * Live version already fetched in-process, else the installed binary, else
 * the pinned fallback. The installed 2.x line surfaces here (and in logs)
 * while the compat-lane UA keeps the 1.x line — major-2 never auto-switches
 * the wire shape. No network; the binary probe is memoized ~60s.
 */
export function getLiveOpenCodeVersion(): string {
 if (liveOpenCodeVersion) return liveOpenCodeVersion;
 return probeInstalledOpenCodeVersion() ?? OPENCODE_VERSION_FALLBACK;
}

/**
 * Where the live version came from: `registry` when refresh populated it,
 * `binary` when it reflects the installed binary, null on the pure fallback.
 */
export function getOpenCodeVersionSource(): OpenCodeVersionSource | null {
 if (liveOpenCodeVersion) return liveOpenCodeVersionSource;
 if (probeInstalledOpenCodeVersion() !== null) return "binary";
 return null;
}

/**
 * Build the OpenCode User-Agent string: default the verbatim CLI full shape
 * (`opencode/<version> ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`).
 * With both channel+client, the 4-token CLI shape
 * (`opencode/<channel>/<version>/<client> ai-sdk/... runtime/...`).
 * The legacy bare shape is gone with the A/B profiles.
 */
export function buildOpenCodeUserAgent(version: string, opts?: { channel?: string; client?: string }): string {
 if (typeof opts?.channel === "string" && opts.channel.length > 0 && typeof opts?.client === "string" && opts.client.length > 0) {
  return `opencode/${opts.channel}/${version}/${opts.client} ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`;
 }
 return `opencode/${version} ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`;
}

const STABLE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{13,14}$/;
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
 * Live project header: legacy cwd hash preserved, env only overrides. Unset
 * PI_FREEFLOW_OPENCODE_PROJECT keeps today's behavior (cwd → sha1, else
 * `global`), so the wire default (no cwd threaded) stays `global` and
 * existing callers/tests are unchanged. "global" forces global even with a
 * cwd; "cwd" hashes the param or PI_FREEFLOW_OPENCODE_CWD (else global).
 */
export function resolveOpenCodeProjectLive(cwd?: string): string {
 const variant = process.env[OPENCODE_PROJECT_ENV];
 if (variant === "cwd") {
  const effective = typeof cwd === "string" && cwd.length > 0 ? cwd : process.env[OPENCODE_CWD_ENV];
  if (typeof effective === "string" && effective.length > 0) return openCodeProjectForCwd(effective);
  return OPENCODE_PROJECT_GLOBAL;
 }
 if (variant === "global") return OPENCODE_PROJECT_GLOBAL;
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
 * @param cwd working directory for the project header; omitted → `global`
 *   unless PI_FREEFLOW_OPENCODE_PROJECT=cwd supplies one through
 *   PI_FREEFLOW_OPENCODE_CWD.
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
