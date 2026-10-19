/**
 * Per-user Cline API key pool for pi-freeflow.
 *
 * Cline serves its free models direct-only (never through the relay pool),
 * one bearer key per login slot. Keys live in a 0600 file beside the relay
 * state; a corrupt file reads back as an empty pool (never throws, never
 * logs secrets). Request failover walks the pool in order, trying every slot
 * fresh on every request. A slot whose grant Cline rejected outright is parked
 * for a cooldown, never dropped: the credential stays in the pool and a fresh
 * login into that slot clears the pause at once.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { RELAY_STATE_FILE } from "./config.ts";
import { logWarn } from "./logger.ts";
import type { FetchImpl } from "./cline-device-auth.ts";
import { isWorkosJwt } from "./cline-device-auth.ts";

/** Env override for the pool file location (tests/CI sandbox). */
const CLINE_POOL_FILE_ENV = "PI_FREEFLOW_CLINE_POOL_FILE";

/** Resolve the per-user pool file: beside the relay state file. */
function resolveClinePoolPath(): string {
 const override = (process.env[CLINE_POOL_FILE_ENV] || "").trim();
 if (override) return override;
 return path.join(path.dirname(RELAY_STATE_FILE), "pi-freeflow-cline-pool.json");
}

export const CLINE_POOL_FILE = resolveClinePoolPath();

/**
 * Recovery copy of the pool, read only when the main file is missing or
 * unreadable. Mirrors the relay-state `.bak` convention, with one deliberate
 * difference: an empty pool is a legitimate state here (`/freeflow cline
 * logout` of the last login must stick), so a valid empty main file is never
 * overridden from the backup.
 */
export const CLINE_POOL_BACKUP_FILE = `${CLINE_POOL_FILE}.bak`;

/** One saved login slot. The token is only ever sent as an explicit bearer header. */
interface ClineAccount {
 slot: string;
 token: string;
 addedAt: string;
 /** WorkOS refresh token for device-login slots; absent on legacy key slots. */
 refreshToken?: string;
 /** Epoch-ms when `token` expires; absent means "no known expiry" (legacy slots). */
 expiresAt?: number;
 /** WorkOS account id, shown when choosing which login to remove. */
 accountId?: string;
 /** Login email, shown when choosing which login to remove. */
 email?: string;
 /**
  * Epoch ms until which Cline has rejected this slot's grant outright: the
  * roll skips the slot until then rather than paying a doomed refresh every
  * turn. The credential itself is never dropped — past the stamp the slot is
  * tried again, and saving a fresh login into the slot clears it at once.
  */
 deadUntil?: number;
}

export interface ClinePoolState {
 accounts: ClineAccount[];
 activeSlot?: string;
 /**
  * Daily free-limit resets per slot per *requested* model id (epoch ms):
  * `limits[slot][modelId] = resetAt`. Cline reports its own model name in the
  * 429 body, which never matches the id we asked for, so the requested id is
  * the only key a later request can look up. Expired entries are dropped on
  * read. Optional: pools written before this existed load unchanged.
  */
 limits?: Record<string, Record<string, number>>;
 /**
  * Per-slot serve counters: `usage[slot] = { served, lastAt, lastModel }`.
  * Bumped every time the slot serves a turn (`served` counts up, `lastAt`
  * is epoch ms, `lastModel` the requested model id). Counters only — no
  * token, email, or other identity ever lives here; callers map
  * slot→identity at display time. Optional: pools written before this
  * existed load unchanged.
  */
 usage?: Record<string, ClineSlotUsage>;
}

/** One slot's serve counters. See `ClinePoolState.usage`. */
interface ClineSlotUsage {
 served: number;
 lastAt: number;
 lastModel: string;
}

/**
 * Fresh tokens minted via the device-login refresh flow. DeviceAuth owns the
 * network call; this module only applies the result to the pool file.
 */
interface ClineRefreshResult {
 token: string;
 refreshToken?: string;
 expiresAt?: number;
 accountId?: string;
 email?: string;
}

/**
 * Refresh one slot. Resolves to the fresh tokens, or null when the grant is
 * dead (invalid_grant — the slot must be logged in again). May throw on
 * transient network faults; callers treat a throw as "keep the stale token".
 */
type ClineRefresher = (refreshToken: string) => Promise<ClineRefreshResult | null>;

/** Test-only: drop the loadPool mtime cache. */
export function _resetClinePoolCacheForTest(): void {
 cached = null;
 cachedMtime = -1;
}

/** Version this proxy reports as its Cline client build. */
const CLINE_CLIENT_VERSION = "3.5.54";

/**
 * Client headers the Cline API expects. Measured live (2026-09-21): the
 * `cline-free/*` models answer 403 "only available via Cline product surfaces"
 * with a bare bearer, and 200 with this set; every non-prefixed catalog model
 * (e.g. z-ai/glm-5.3-flash) answers 200 either way. Header names and shape
 * mirror reference/cline providers/request-headers.ts
 * (DEFAULT_CLINE_REQUEST_HEADERS) — no credential is derived from them.
 *
 * `X-CLIENT-TYPE` is the Cline desktop app's identity, and it gates the
 * `cline-free/*` id space (measured live 2026-09-22: that prefix answers 403
 * "only available via Cline product surfaces" with a bare bearer, and 200 with
 * this set; every non-prefixed id answers 200 either way). The header is kept
 * because one catalog id still depends on it — after the 2026-10-13 prune,
 * `cline-free/muse-spark-1.3-contributor` is the last prefixed model in the
 * catalog. It also decided the free-model feed at the time: five entries for
 * `cline-sdk` / `cline-cli` / the `VSCode Extension` label against six for
 * `cline-desktop`, the extra one being `cline-free/kimi-k3`. That sixth model
 * is retired upstream and no longer requested. Version and User-Agent stay
 * as-is: the feed served the desktop list with them unchanged.
 */
const CLINE_CLIENT_HEADERS: Record<string, string> = {
 "HTTP-Referer": "https://cline.bot",
 "X-Title": "Cline",
 "X-IS-MULTIROOT": "false",
 "X-CLIENT-TYPE": "cline-desktop",
 "X-CLIENT-VERSION": CLINE_CLIENT_VERSION,
 "User-Agent": `Cline/${CLINE_CLIENT_VERSION}`,
};

/**
 * Free-limit report carried by a Cline 429 body, e.g.
 * {"error":{"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit
 * reached on model meta/muse-spark-1.3-contributor. Try again in 20h 4m"}}.
 *
 * `modelId` is the name Cline spells in its own body, which is a different
 * namespace from the id this proxy requests (measured live 2026-10-13: we ask
 * for `cline-free/muse-spark-1.3-contributor`, Cline answers about
 * `meta/muse-spark-1.3-contributor`). The limit cache is therefore keyed by the
 * requested id; `modelId` is diagnostics only.
 */
interface ClineFreeLimit {
 /** Model name as the upstream body spells it. */
 modelId?: string;
 /** Epoch ms the cap lifts; absent when the body stated no delay. */
 resetAt?: number;
}

const CLINE_FREE_LIMIT_MARKER = /free limit reached on model/i;

/**
 * Delay stated as `try again in <N>h <N>m`, `<N>m`, or a bare `<N>` (hours).
 * Returns null when the body states no delay this parser understands.
 */
function parseResetDelayMs(text: string): number | null {
 const hoursMinutes = text.match(/try again in\s+([0-9]+)\s*h(?:ours?|rs?)?(?:\s*([0-9]+)\s*m(?:in(?:utes?)?)?)?/i);
 if (hoursMinutes) {
  const hours = Number(hoursMinutes[1]);
  const minutes = hoursMinutes[2] ? Number(hoursMinutes[2]) : 0;
  return (hours * 60 + minutes) * 60_000;
 }
 const minutesOnly = text.match(/try again in\s+([0-9]+)\s*m(?:in(?:utes?)?)?/i);
 if (minutesOnly) return Number(minutesOnly[1]) * 60_000;
 const bareHours = text.match(/try again in\s+([0-9]+)(?![0-9a-z])/i);
 return bareHours ? Number(bareHours[1]) * 3600_000 : null;
}

/**
 * Parse an upstream 429 body for the daily free-limit marker. Returns null for
 * anything else, so a plain edge 429 keeps its existing behavior.
 */
export function parseClineFreeLimit(raw: string, now = Date.now()): ClineFreeLimit | null {
 if (typeof raw !== "string" || !CLINE_FREE_LIMIT_MARKER.test(raw)) return null;
 const named = raw.match(/free limit reached on model\s+(\S+)/i);
 // The model name ends the sentence, so a trailing "." belongs to the prose.
 const modelId = named ? named[1].replace(/[.,;:]+$/, "") : "";
 const delay = parseResetDelayMs(raw);
 return {
  ...(modelId ? { modelId } : {}),
  ...(delay !== null ? { resetAt: now + delay } : {}),
 };
}

/** Machine-classified outcome of one Cline chat attempt. */
type ClineErrorKind = "ok" | "auth" | "rate-limit" | "exhausted" | "server" | "client";

export function mapClineError(status: number): ClineErrorKind {
 if (status >= 200 && status < 300) return "ok";
 if (status === 401 || status === 403) return "auth";
 if (status === 429) return "rate-limit";
 if (status === 402) return "exhausted";
 if (status >= 500) return "server";
 return "client";
}

function emptyPool(): ClinePoolState {
 return { accounts: [] };
}

/**
 * Read the optional `limits` map out of a pool document, dropping anything
 * malformed and every entry whose reset has already passed. Returns undefined
 * when nothing usable is left, so a pool that never saw a cap keeps its old
 * shape on disk.
 */
function parseLimits(raw: unknown, now: number): Record<string, Record<string, number>> | undefined {
 if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
 const limits: Record<string, Record<string, number>> = {};
 for (const [slot, modelsRaw] of Object.entries(raw as Record<string, unknown>)) {
  if (!slot.trim()) continue;
  if (typeof modelsRaw !== "object" || modelsRaw === null || Array.isArray(modelsRaw)) continue;
  const models: Record<string, number> = {};
  for (const [model, resetRaw] of Object.entries(modelsRaw as Record<string, unknown>)) {
   if (!model.trim()) continue;
   if (typeof resetRaw !== "number" || !Number.isFinite(resetRaw) || resetRaw <= now) continue;
   models[model] = resetRaw;
  }
  if (Object.keys(models).length > 0) limits[slot.trim()] = models;
 }
 return Object.keys(limits).length > 0 ? limits : undefined;
}

/**
 * Read the optional `usage` map out of a pool document, dropping anything
 * malformed. Returns undefined when nothing usable is left, so a pool that
 * never served a turn keeps its old shape on disk.
 */
function parseUsage(raw: unknown): Record<string, ClineSlotUsage> | undefined {
 if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
 const usage: Record<string, ClineSlotUsage> = {};
 for (const [slot, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
  if (!slot.trim()) continue;
  if (typeof entryRaw !== "object" || entryRaw === null || Array.isArray(entryRaw)) continue;
  const entry: Record<string, unknown> = entryRaw as Record<string, unknown>;
  const served = entry.served;
  const lastAt = entry.lastAt;
  const lastModel = entry.lastModel;
  if (typeof served !== "number" || !Number.isFinite(served) || served < 0) continue;
  if (typeof lastAt !== "number" || !Number.isFinite(lastAt) || lastAt <= 0) continue;
  if (typeof lastModel !== "string") continue;
  usage[slot.trim()] = { served: Math.floor(served), lastAt, lastModel };
 }
 return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Parse a pool document. Returns null when the blob is unusable (bad JSON,
 * wrong shape) so callers can fall back to the backup copy. A valid document
 * with zero accounts is NOT null: that is a real empty pool.
 */
function parsePoolDoc(raw: string): ClinePoolState | null {
 let parsed: unknown;
 try {
  parsed = JSON.parse(raw);
 } catch {
  logWarn("cline pool file corrupt", { path: CLINE_POOL_FILE });
  return null;
 }
 if (typeof parsed !== "object" || parsed === null) {
  logWarn("cline pool file unusable", { path: CLINE_POOL_FILE });
  return null;
 }
 // Boundary-narrowed once: the on-disk blob is external input, so check
 // its shape here and read only validated fields below.
 const doc: Record<string, unknown> = parsed as Record<string, unknown>;
 if (!Array.isArray(doc.accounts)) {
  logWarn("cline pool file unusable", { path: CLINE_POOL_FILE });
  return null;
 }
 const accounts: ClineAccount[] = [];
 // One clock for the whole document: a quarantine stamp and a cap reset are
 // both compared against the same instant.
 const now = Date.now();
 for (const entry of doc.accounts as unknown[]) {
  if (typeof entry !== "object" || entry === null) continue;
  const rec: Record<string, unknown> = entry as Record<string, unknown>;
  const slot = typeof rec.slot === "string" ? rec.slot.trim() : "";
  const token = typeof rec.token === "string" ? rec.token : "";
  if (!slot || (!token.startsWith("workos:") && !isWorkosJwt(token) && !token.startsWith("clp_"))) continue;
  const refreshRaw: unknown = rec.refreshToken;
  const refreshToken = typeof refreshRaw === "string" && refreshRaw.length > 0 ? refreshRaw : undefined;
  const expiresRaw: unknown = rec.expiresAt;
  const expiresAt = typeof expiresRaw === "number" && Number.isFinite(expiresRaw) && expiresRaw > 0
   ? expiresRaw
   : undefined;
  const accountIdRaw: unknown = rec.accountId;
  const accountId = typeof accountIdRaw === "string" && accountIdRaw.trim() ? accountIdRaw.trim() : undefined;
  const emailRaw: unknown = rec.email;
  const email = typeof emailRaw === "string" && emailRaw.trim() ? emailRaw.trim() : undefined;
  // An elapsed quarantine is dropped on read, so a slot Cline rejected last
  // week is a normal candidate again and the field never lingers in the file.
  const deadRaw: unknown = rec.deadUntil;
  const deadUntil = typeof deadRaw === "number" && Number.isFinite(deadRaw) && deadRaw > now ? deadRaw : undefined;
  accounts.push({
   slot,
   token,
   addedAt: typeof rec.addedAt === "string" ? rec.addedAt : new Date().toISOString(),
   ...(refreshToken ? { refreshToken } : {}),
   ...(expiresAt !== undefined ? { expiresAt } : {}),
   ...(accountId ? { accountId } : {}),
   ...(email ? { email } : {}),
   ...(deadUntil !== undefined ? { deadUntil } : {}),
  });
 }
 const activeRaw: unknown = doc.activeSlot;
 const activeSlot = typeof activeRaw === "string" && accounts.some((a) => a.slot === activeRaw.trim())
  ? activeRaw.trim()
  : undefined;
 const limits = parseLimits(doc.limits, now);
 const usage = parseUsage(doc.usage);
 const state: ClinePoolState = { accounts };
 if (activeSlot) state.activeSlot = activeSlot;
 if (limits) state.limits = limits;
 if (usage) state.usage = usage;
 return state;
}

/**
 * Recover the pool from the backup copy and heal the main file so the recovery
 * sticks. Returns null when no usable backup exists. Only ever called for a
 * missing or unusable main file — never to override a valid empty pool.
 */
function recoverPoolFromBackup(description: string): ClinePoolState | null {
 try {
  const parsed = parsePoolDoc(fs.readFileSync(CLINE_POOL_BACKUP_FILE, "utf8"));
  if (parsed && parsed.accounts.length > 0) {
   logWarn(`cline pool ${description} — recovered from backup`, { slots: parsed.accounts.length, path: CLINE_POOL_BACKUP_FILE });
   savePool(parsed);
   return parsed;
  }
 } catch { }
 return null;
}

function readPoolFile(): ClinePoolState {
 try {
  if (!fs.existsSync(CLINE_POOL_FILE)) {
   return recoverPoolFromBackup("main file missing") ?? emptyPool();
  }
  const parsed = parsePoolDoc(fs.readFileSync(CLINE_POOL_FILE, "utf8"));
  if (parsed) return parsed;
  return recoverPoolFromBackup("file unusable") ?? emptyPool();
 } catch {
  return emptyPool();
 }
}

let cached: ClinePoolState | null = null;
let cachedMtime = -1;

function diskMtime(): number {
 try {
  return fs.statSync(CLINE_POOL_FILE).mtimeMs;
 } catch {
  return -1;
 }
}

/**
 * Load the pool, re-reading from disk only when another process changed the
 * file (mtime moved). Never throws; corrupt reads come back empty.
 */
export function loadPool(): ClinePoolState {
 const before = diskMtime();
 if (cached && before === cachedMtime) return cached;
 let loaded = readPoolFile();
 let stamp = diskMtime();
 // The read is only trustworthy when the file did not move across it. Reading
 // first and stamping afterwards latches pre-read content under the post-write
 // mtime, which hides the change until the next write. Re-read once; the mtime
 // observed after that read is the one the returned pool is cached under.
 if (stamp !== before) {
  loaded = readPoolFile();
  stamp = diskMtime();
 }
 cached = loaded;
 cachedMtime = stamp;
 return cached;
}

/**
 * Keep the largest pool ever seen as the recovery copy.
 *
 * Largest-wins rather than last-write-wins, deliberately. The backup is read
 * only when the main file is missing or unreadable, and two failure modes had
 * to be covered at once:
 *   - an existing richer pool being overwritten (compare the file being
 *     replaced, before the write), and
 *   - growth being lost because the backup always lagged one write (compare
 *     the pool just written, after the write).
 * Ties do not replace, so a run of equally-sized destructive writes cannot
 * evict a good copy — which is how a real pool was lost: two good logins were
 * replaced by fixtures, and the second fixture write replaced the backup too.
 */
function keepLargestBackup(raw: string): void {
 try {
  const count = accountCountIn(raw);
  if (count <= 0) return;
  let backupCount = -1;
  try {
   backupCount = accountCountIn(fs.readFileSync(CLINE_POOL_BACKUP_FILE, "utf8"));
  } catch {
   backupCount = -1;
  }
  if (count <= backupCount) return;
  fs.writeFileSync(CLINE_POOL_BACKUP_FILE, raw, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(CLINE_POOL_BACKUP_FILE, 0o600); } catch { }
 } catch { }
}

/** How many accounts a raw pool blob holds; -1 when it is unreadable. */
function accountCountIn(raw: string): number {
 try {
  const doc = JSON.parse(raw) as { accounts?: unknown };
  return Array.isArray(doc.accounts) ? doc.accounts.length : -1;
 } catch {
  return -1;
 }
}

/**
 * Scrub one explicitly removed login out of the recovery copy.
 *
 * Largest-wins keeps that copy rich, which is what saves a real pool from an
 * accidental smaller write — but it also means a logout's token (and its
 * refresh grant) can sit in `<pool>.bak` and sign the user back in if the main
 * file is ever lost. A removal is an explicit instruction, so the removed
 * identity is dropped from the copy too — matched by slot or by bearer, since
 * a legacy pool can hold one account under two slots. Every other account
 * stays available for recovery.
 */
function forgetAccountInBackup(removed: ClineAccount): void {
 try {
  if (!fs.existsSync(CLINE_POOL_BACKUP_FILE)) return;
  const parsed: unknown = JSON.parse(fs.readFileSync(CLINE_POOL_BACKUP_FILE, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const doc: Record<string, unknown> = parsed as Record<string, unknown>;
  if (!Array.isArray(doc.accounts)) return;
  const kept = (doc.accounts as unknown[]).filter((entry) => {
   if (typeof entry !== "object" || entry === null) return true;
   const rec: Record<string, unknown> = entry as Record<string, unknown>;
   if (typeof rec.slot === "string" && rec.slot.trim() === removed.slot) return false;
   return !(typeof rec.token === "string" && rec.token.length > 0 && rec.token === removed.token);
  });
  if (kept.length === doc.accounts.length) return;
  doc.accounts = kept;
  fs.writeFileSync(CLINE_POOL_BACKUP_FILE, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(CLINE_POOL_BACKUP_FILE, 0o600); } catch { }
 } catch { }
}

/**
 * Atomically persist the pool with owner-only permissions (temp file + rename,
 * see src/atomic-write.ts). Never logs secrets.
 *
 * Returns false when the pool did not reach the disk, so a caller that tells
 * the user "saved" can tell the truth instead. The bytes are read back after
 * the rename: a rename that reported success is not proof that the next read
 * sees the new pool — a read-only target is the live failure mode.
 */
export function savePool(pool: ClinePoolState): boolean {
 try {
  const dir = path.dirname(CLINE_POOL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // The pool being replaced is the only copy of itself: secure it first.
  try {
   if (fs.existsSync(CLINE_POOL_FILE)) keepLargestBackup(fs.readFileSync(CLINE_POOL_FILE, "utf8"));
  } catch { }
  const serialized = JSON.stringify(pool, null, 2);
  writeFileAtomic(CLINE_POOL_FILE, serialized, { mode: 0o600 });
  if (fs.readFileSync(CLINE_POOL_FILE, "utf8") !== serialized) {
   throw new Error(`pool write did not land at ${CLINE_POOL_FILE}`);
  }
  // Compare the pool just written too, so growth is never the copy that lags.
  keepLargestBackup(serialized);
  cached = pool;
  cachedMtime = diskMtime();
  return true;
 } catch (e) {
  logWarn("could not persist cline pool", { slots: pool.accounts.length, reason: e instanceof Error ? e.message : String(e) });
  // The in-memory snapshot must not outlive the write that failed: with the
  // cache dropped, the next load re-reads the disk and sees what actually
  // landed instead of the pool this process hoped to write.
  cached = null;
  cachedMtime = -1;
  return false;
 }
}

/** Last-4 display for a token; the full value is never shown or logged. */
export function redactedToken(token: string): string {
 const tail = (token || "").slice(-4) || "????";
 return `…${tail}`;
}

/**
 * Persist a patch to one slot against the file as it is on disk right now.
 * A request holds its pool snapshot across network round trips, and the host
 * process writes the same file for login/logout, so writing the snapshot back
 * would revert a login added or removed while the request was in flight. A
 * slot that no longer exists is left alone rather than resurrected.
 */
function patchAccountOnDisk(slot: string, patch: Partial<ClineAccount>): void {
 const live = readPoolFile();
 const target = live.accounts.find((a) => a.slot === slot);
 if (!target) return;
 Object.assign(target, patch);
 savePool(live);
}

/** Record which slot served a turn, without clobbering concurrent edits. */
function markActiveSlotOnDisk(slot: string): void {
 const live = readPoolFile();
 if (!live.accounts.some((a) => a.slot === slot)) return;
 live.activeSlot = slot;
 savePool(live);
}

/**
 * Bump one slot's serve counters against the file as it is on disk right
 * now: a request holds its pool snapshot across round trips, and the host
 * process writes the same file for login/logout, so writing the snapshot
 * back would revert a login added or removed while the request was in
 * flight. A slot that no longer exists is left alone rather than
 * resurrected. The row carries counters only — never token or identity.
 */
export function recordClineUsageOnDisk(slot: string, modelId: string): void {
 const cleanSlot = (slot || "").trim();
 if (!cleanSlot) return;
 const live = readPoolFile();
 if (!live.accounts.some((a) => a.slot === cleanSlot)) return;
 const prev = live.usage?.[cleanSlot];
 const served = typeof prev?.served === "number" && Number.isFinite(prev.served) && prev.served >= 0
  ? Math.floor(prev.served) + 1
  : 1;
 live.usage = {
  ...(live.usage ?? {}),
  [cleanSlot]: { served, lastAt: Date.now(), lastModel: (modelId || "").trim() },
 };
 savePool(live);
}

/** The reset still in force for one slot+requested model, or null when free. */
function activeLimitFor(pool: ClinePoolState, slot: string, model: string, now: number): number | null {
 if (!model) return null;
 const at = pool.limits?.[slot]?.[model];
 return typeof at === "number" && Number.isFinite(at) && at > now ? at : null;
}

/**
 * Persist one free-limit observation against the file as it is on disk right
 * now: a request holds its pool snapshot across round trips, and the host
 * process writes the same file for login/logout, so writing the snapshot back
 * would revert a login added or removed while the request was in flight.
 */
function recordLimitOnDisk(slot: string, model: string, resetAt: number): void {
 if (!model) return;
 const live = readPoolFile();
 if (!live.accounts.some((a) => a.slot === slot)) return;
 const known = live.limits?.[slot]?.[model];
 // Keep the later of the two: a fresh report must not shorten a window that is
 // already known, and repeating the same reset writes nothing.
 if (typeof known === "number" && known >= resetAt) return;
 const limits = live.limits ?? {};
 limits[slot] = { ...(limits[slot] ?? {}), [model]: resetAt };
 live.limits = limits;
 savePool(live);
}

/** Drop one slot+model limit once that slot serves the model again. */
function clearLimitOnDisk(slot: string, model: string): void {
 if (!model) return;
 const live = readPoolFile();
 const limits = live.limits;
 const forSlot = limits?.[slot];
 if (!limits || !forSlot || typeof forSlot[model] !== "number") return;
 delete forSlot[model];
 if (Object.keys(forSlot).length === 0) delete limits[slot];
 if (Object.keys(limits).length === 0) delete live.limits;
 savePool(live);
}

/**
 * Identity of a Cline login. Two slots holding the same account share one free
 * quota, so rotating between them buys nothing — callers use this to detect
 * that instead of saving a duplicate.
 *
 * accountId (WorkOS user id) is authoritative; email is the readable fallback.
 * When neither side carries an identity — a legacy `clp_` key slot has none —
 * only an identical bearer proves the same account.
 */
function sameClineAccount(account: ClineAccount, identity: { token?: string; accountId?: string; email?: string }): boolean {
 const idA = account.accountId?.trim();
 const idB = identity.accountId?.trim();
 if (idA && idB) return idA === idB;
 const mailA = account.email?.trim().toLowerCase();
 const mailB = identity.email?.trim().toLowerCase();
 if (mailA && mailB) return mailA === mailB;
 const token = identity.token;
 return typeof token === "string" && token.length > 0 && account.token === token;
}

/**
 * The other slot already holding this account, or null when it is new.
 * `exceptSlot` skips the slot being written, so re-logging into an existing
 * slot is never treated as a duplicate.
 */
export function findClineAccountSlot(
 pool: ClinePoolState,
 identity: { token?: string; accountId?: string; email?: string },
 exceptSlot?: string,
): string | null {
 const hit = pool.accounts.find(
  (a) => a.slot !== exceptSlot && sameClineAccount(a, identity),
 );
 return hit ? hit.slot : null;
}

/**
 * Save (or replace) one login slot. The token must carry the `workos:` prefix.
 * Throws on bad input — the message never echoes the token.
 * Extras carry the device-login grant (refresh token, expiry, identity);
 * legacy key slots keep calling with two args and load untouched.
 * Refuses an account that another slot already holds.
 */
export function addAccount(
 slot: string,
 token: string,
 extras?: { refreshToken?: string; expiresAt?: number; accountId?: string; email?: string },
): ClinePoolState {
 const cleanSlot = (slot || "").trim();
 if (!cleanSlot) throw new Error("Cline slot name cannot be empty");
 if (cleanSlot.length > 64) throw new Error("Cline slot name is too long (max 64 characters)");
 if (!token.startsWith("workos:") && !isWorkosJwt(token) && !token.startsWith("clp_")) throw new Error("Cline token must be a workos: login grant or a clp_ API key");
 const pool = loadPool();
 const existing = pool.accounts.find((a) => a.slot === cleanSlot);
 const duplicate = findClineAccountSlot(pool, { token, accountId: extras?.accountId, email: extras?.email }, cleanSlot);
 if (duplicate) {
  const who = extras?.email?.trim() || existing?.email?.trim() || "this account";
  throw new Error(`That Cline account (${who}) is already saved as [${duplicate}] — log in with a different account, or use /freeflow cline logout ${duplicate} first`);
 }
 if (existing) {
  existing.token = token;
  // A fresh login is proof the grant works again: a quarantine recorded
  // against the credential it replaces must never outlive it.
  delete existing.deadUntil;
  if (extras?.refreshToken) existing.refreshToken = extras.refreshToken;
  if (extras?.expiresAt !== undefined) {
   if (Number.isFinite(extras.expiresAt) && extras.expiresAt > 0) existing.expiresAt = extras.expiresAt;
   else delete existing.expiresAt;
  }
  if (extras?.accountId !== undefined) {
   if (extras.accountId.trim()) existing.accountId = extras.accountId.trim();
   else delete existing.accountId;
  }
  if (extras?.email !== undefined) {
   if (extras.email.trim()) existing.email = extras.email.trim();
   else delete existing.email;
  }
 } else {
  pool.accounts.push({
   slot: cleanSlot,
   token,
   addedAt: new Date().toISOString(),
   ...(extras?.refreshToken ? { refreshToken: extras.refreshToken } : {}),
   ...(extras?.expiresAt !== undefined && Number.isFinite(extras.expiresAt) && extras.expiresAt > 0
    ? { expiresAt: extras.expiresAt }
    : {}),
   ...(extras?.accountId?.trim() ? { accountId: extras.accountId.trim() } : {}),
   ...(extras?.email?.trim() ? { email: extras.email.trim() } : {}),
  });
 }
 if (!pool.activeSlot) pool.activeSlot = cleanSlot;
 // A save that never reached the disk must not report success: the caller
 // prints "ready to use" on the strength of this return, and the login would
 // vanish on the next read. The write helper already logged the cause.
 if (!savePool(pool)) {
  // Re-read the way the relay deploy path does before blaming the write.
  let landed = false;
  try {
   landed = loadPool().accounts.some((a) => a.slot === cleanSlot && a.token === token);
  } catch {
   landed = false;
  }
  if (!landed) {
   throw new Error(
    `Cline login [${cleanSlot}] could not be saved to ${CLINE_POOL_FILE} — check that the directory is writable and log in again`,
   );
  }
 }
 return pool;
}

/** Skew so a token expiring mid-flight counts as stale before it breaks a call. */
const CLINE_REFRESH_SKEW_MS = 60_000;

/**
 * How long a slot stays parked after Cline rejects its grant outright. Long
 * enough that a live session cannot re-pay the refresh round trip on every
 * turn, short enough that the slot comes back on its own: the pause never
 * blocks a slot whose credential a fresh login replaced.
 */
export const CLINE_DEAD_GRANT_COOLDOWN_MS = 15 * 60_000;

/**
 * True when the slot carries a known expiry that has passed (or passes within
 * the skew window). Slots without `expiresAt` — every legacy key slot — are
 * never stale: they load and serve exactly as before.
 */
function isClineTokenStale(account: ClineAccount, skewMs = CLINE_REFRESH_SKEW_MS): boolean {
 if (typeof account.expiresAt !== "number" || !Number.isFinite(account.expiresAt)) return false;
 return Date.now() + skewMs >= account.expiresAt;
}

/**
 * Refresh outcome for one slot: fresh tokens applied and persisted (`true`),
 * dead grant with nothing to keep (`false`), or a transient fault where the
 * caller should fall back to the stale bearer (`null`).
 */
async function refreshAccountInPlace(
 account: ClineAccount,
 refreshImpl: ClineRefresher,
): Promise<boolean | null> {
 const current = account.refreshToken;
 if (!current) return null;
 let fresh: ClineRefreshResult | null;
 try {
  fresh = await refreshImpl(current);
 } catch (e) {
  logWarn("cline slot refresh failed — keeping stale bearer", { slot: account.slot });
  void e;
  return null;
 }
 if (!fresh || typeof fresh.token !== "string" || (!fresh.token.startsWith("workos:") && !isWorkosJwt(fresh.token) && !fresh.token.startsWith("clp_"))) {
  // Cline rejected the grant outright: park the slot on disk so the next
  // turns skip it instead of re-paying a refresh that cannot succeed. The
  // credential stays in the pool — a fresh login into the slot clears this —
  // and the cooldown ends the pause on its own.
  account.deadUntil = Date.now() + CLINE_DEAD_GRANT_COOLDOWN_MS;
  logWarn("cline slot refresh rejected — quarantining slot", {
   slot: account.slot,
   forMs: CLINE_DEAD_GRANT_COOLDOWN_MS,
  });
  patchAccountOnDisk(account.slot, { deadUntil: account.deadUntil });
  return false;
 }
 account.token = fresh.token;
 if (fresh.refreshToken) account.refreshToken = fresh.refreshToken;
 if (typeof fresh.expiresAt === "number" && Number.isFinite(fresh.expiresAt) && fresh.expiresAt > 0) {
  account.expiresAt = fresh.expiresAt;
 } else {
  delete account.expiresAt;
 }
 if (fresh.accountId?.trim()) account.accountId = fresh.accountId.trim();
 if (fresh.email?.trim()) account.email = fresh.email.trim();
 // Persist only the refreshed fields: the snapshot this request holds may
 // predate a login added or removed in the host process.
 patchAccountOnDisk(account.slot, {
  token: account.token,
  ...(account.refreshToken ? { refreshToken: account.refreshToken } : {}),
  expiresAt: account.expiresAt,
  ...(account.accountId ? { accountId: account.accountId } : {}),
  ...(account.email ? { email: account.email } : {}),
 });
 return true;
}

/** Drop one login slot. Returns false when the slot was not saved. */
export function removeAccount(slot: string): boolean {
 const cleanSlot = (slot || "").trim();
 const pool = loadPool();
 const idx = pool.accounts.findIndex((a) => a.slot === cleanSlot);
 if (idx < 0) return false;
 const [removed] = pool.accounts.splice(idx, 1);
 if (pool.usage?.[cleanSlot] !== undefined) {
  delete pool.usage[cleanSlot];
  if (Object.keys(pool.usage).length === 0) delete pool.usage;
 }
 // A cap belongs to the login that hit it: keeping it would outlive the slot
 // it names and key a later login of the same name into a stale window.
 if (pool.limits?.[cleanSlot] !== undefined) {
  delete pool.limits[cleanSlot];
  if (Object.keys(pool.limits).length === 0) delete pool.limits;
 }
 if (pool.activeSlot === cleanSlot) pool.activeSlot = pool.accounts[0]?.slot;
 savePool(pool);
 // A logout is explicit: the removed grant must not survive in the recovery
 // copy, or losing the main file would sign that account back in.
 forgetAccountInBackup(removed);
 return true;
}

/**
 * The model id this request asks Cline for — the key every recorded limit is
 * looked up under. Empty when the body carries no usable model, which
 * disables limit bookkeeping for the roll rather than guessing a key.
 */
function requestedModelId(body: string): string {
 try {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const model = (parsed as Record<string, unknown>).model;
  return typeof model === "string" ? model.trim() : "";
 } catch {
  return "";
 }
}

/**
 * Read a free-limit report off a 429 body through a clone: the response handed
 * back to the caller must stay readable, so its body is never consumed here.
 */
async function freeLimitFrom(res: Response, now: number): Promise<ClineFreeLimit | null> {
 try {
  return parseClineFreeLimit(await res.clone().text(), now);
 } catch {
  return null;
 }
}

interface ClineRollOpts {
 /** Serialized chat-completions body, reused verbatim on every attempt. */
 body: string;
 /** Chat completions endpoint (proxy passes its configured URL explicitly). */
 chatUrl: string;
 fetchImpl?: FetchImpl;
 /**
  * Device-login refresher. When present, a stale slot refreshes once before
  * its attempt, and a 401/403 refreshes once before the slot is skipped.
  * Absent: every slot serves its stored bearer exactly as before.
  */
 refreshImpl?: ClineRefresher;
}

interface ClineRollResult {
 res: Response;
 /** Slot that served the response; null when no account was tried. */
 slot: string | null;
 /** True when every account failed (or the pool is empty). */
 exhausted: boolean;
 kind: ClineErrorKind;
 /**
  * Saved logins this roll had to work with (the candidate count). On an
  * exhausted result every one of them was tried, so a caller may name this
  * number when telling the user how many logins are capped. It is never an
  * upstream-attempt count: one login that refreshes and retries is still one.
  * A slot already parked after a rejected grant is not counted — it was not a
  * candidate on this roll.
  */
 logins: number;
 /**
  * True when the roll tried at least one login and every login it tried
  * answered the free-limit 429 for the requested model — nothing else was
  * tried and nothing succeeded. A login skipped for a dead grant keeps this
  * false, as does any other failure mixed into the roll.
  */
 limitOnly: boolean;
 /** Earliest reset among the free-limit 429s seen (epoch ms); null when none was stated. */
 earliestResetAt: number | null;
 /** Model name as Cline spelled it in its own body, when a free limit was reported. */
 limitModelId?: string;
}

/**
 * Synthetic body for the two states that never reached Cline: nothing is
 * saved to sign in with, or no saved login could reach Cline. Neither is a
 * rate limit, so it must not answer 429 — that status makes hosts back off
 * and hide the actionable message behind a "rate limited" notice.
 */
function exhaustedResponse(reason: string, status: number): Response {
 return new Response(
  JSON.stringify({ error: { message: reason, code: "cline_pool_exhausted" } }),
  { status, headers: { "content-type": "application/json" } },
 );
}

/**
 * POST one chat body to the Cline endpoint, rolling across every saved slot.
 * Each attempt sends its slot bearer explicitly; raw tokens never leave this
 * module. Superseded failure bodies are cancelled here; the response handed
 * back to the caller is left untouched so the caller can read it.
 */
export async function rollChat(opts: ClineRollOpts): Promise<ClineRollResult> {
 const fetchImpl = opts.fetchImpl ?? fetch;
 const pool = loadPool();
 const now = Date.now();
 const requestedModel = requestedModelId(opts.body);
 // A slot Cline rejected outright is parked for a cooldown: retrying its dead
 // grant on every turn re-pays a refresh that cannot succeed. The credential
 // stays in the pool and the stamp expires, so this is a pause, not a
 // removal — pool order and size are untouched.
 const quarantinedSlots = new Set(
  pool.accounts
   .filter((a) => typeof a.deadUntil === "number" && Number.isFinite(a.deadUntil) && a.deadUntil > now)
   .map((a) => a.slot),
 );
 let candidates = pool.accounts.filter((a) => !quarantinedSlots.has(a.slot));
 if (pool.activeSlot) {
  const at = candidates.findIndex((a) => a.slot === pool.activeSlot);
  if (at > 0) candidates = [candidates[at], ...candidates.slice(0, at), ...candidates.slice(at + 1)];
 }
 if (requestedModel) {
  // A slot recorded on this model's daily cap almost always answers 429 again:
  // it is tried last so a healthy login serves the turn without paying the
  // extra round trip. It stays in the list — a cap can lift before its
  // recorded reset, and only a real attempt can discover that.
  const open: ClineAccount[] = [];
  const capped: ClineAccount[] = [];
  for (const account of candidates) {
   (activeLimitFor(pool, account.slot, requestedModel, now) === null ? open : capped).push(account);
  }
  candidates = [...open, ...capped];
 }
 if (candidates.length === 0) {
  if (quarantinedSlots.size > 0) {
   // Logins are saved but Cline rejected every one of them: telling the user
   // nothing is saved would point at the wrong problem.
   logWarn("cline pool fully quarantined — every saved grant was rejected", {
    slots: pool.accounts.length,
    quarantined: quarantinedSlots.size,
   });
   return {
    res: exhaustedResponse("Every saved Cline login was rejected by Cline — sign in again with /freeflow cline login", 502),
    slot: null,
    exhausted: true,
    kind: "exhausted",
    logins: 0,
    limitOnly: false,
    earliestResetAt: null,
   };
  }
  const reason = "No Cline logins saved — add one with /freeflow cline login";
  logWarn("cline pool empty", { slots: pool.accounts.length });
  return { res: exhaustedResponse(reason, 401), slot: null, exhausted: true, kind: "exhausted", logins: 0, limitOnly: false, earliestResetAt: null };
 }
 let lastRes: Response | null = null;
 let lastSlot: string | null = null;
 let lastKind: ClineErrorKind = "exhausted";
 // Slots whose grant Cline rejected during this roll: they are now parked on
 // disk, so the exhausted answer can say "rejected" instead of "unreachable".
 let rejectedThisRoll = 0;
 // Distinct logins that answered the cap, so one login refreshing and retrying
 // through the 401 path still counts once.
 const cappedSlots = new Set<string>();
 let earliestResetAt: number | null = null;
 let limitModelId: string | undefined;
 for (const account of candidates) {
  // Stale device-login bearer: one refresh before the attempt. A dead grant
  // parks the slot (see refreshAccountInPlace); a transient fault keeps the
  // stale token.
  let refreshedThisSlot = false;
  if (opts.refreshImpl && account.refreshToken && isClineTokenStale(account)) {
   const outcome = await refreshAccountInPlace(account, opts.refreshImpl);
   if (outcome === false) {
    rejectedThisRoll += 1;
    continue;
   }
   refreshedThisSlot = outcome === true;
  }
  const attempt = async (token: string): Promise<Response | null> => {
   try {
    return await fetchImpl(opts.chatUrl, {
     method: "POST",
     headers: {
      "content-type": "application/json",
      ...CLINE_CLIENT_HEADERS,
      authorization: `Bearer ${token}`,
     },
     body: opts.body,
    });
   } catch (e) {
    logWarn("cline slot fetch error — trying next slot", { slot: account.slot });
    void e;
    return null;
   }
  };
  const succeed = async (res: Response, kind: ClineErrorKind): Promise<ClineRollResult> => {
   if (kind === "ok") {
    markActiveSlotOnDisk(account.slot);
    // This slot just served the model, so whatever cap it was on has lifted.
    // Reads the file as it is on disk and writes only when an entry exists.
    clearLimitOnDisk(account.slot, requestedModel);
    // Counters only — no token or identity ever lands in the usage row.
    recordClineUsageOnDisk(account.slot, requestedModel);
   }
   if (lastRes && lastRes !== res) {
    try { await lastRes.body?.cancel(); } catch { }
   }
   lastRes = null;
   return {
    res,
    slot: account.slot,
    exhausted: false,
    kind,
    logins: candidates.length,
    limitOnly: false,
    earliestResetAt,
    ...(limitModelId ? { limitModelId } : {}),
   };
  };
  const stashFailure = async (res: Response, kind: ClineErrorKind): Promise<void> => {
   if (lastRes && lastRes !== res) {
    try { await lastRes.body?.cancel(); } catch { }
   }
   lastRes = res;
   lastSlot = account.slot;
   lastKind = kind;
  };
  let res = await attempt(account.token);
  if (!res) continue;
  let kind = mapClineError(res.status);
  if (kind === "ok" || kind === "client") return await succeed(res, kind);
  // Auth failure on a refreshable slot that has not refreshed yet: one
  // refresh, then exactly one retry with the fresh bearer.
  if (kind === "auth" && !refreshedThisSlot && opts.refreshImpl && account.refreshToken) {
   const outcome = await refreshAccountInPlace(account, opts.refreshImpl);
   if (outcome === true) {
    try {
     await res.body?.cancel();
    } catch { }
    refreshedThisSlot = true;
    res = await attempt(account.token);
    if (!res) continue;
    kind = mapClineError(res.status);
    if (kind === "ok" || kind === "client") return await succeed(res, kind);
   } else if (outcome === false) {
    try {
     await res.body?.cancel();
    } catch { }
    rejectedThisRoll += 1;
    continue;
   }
   // Transient refresh fault: the original response is still intact, so it is
   // stashed below and can be surfaced to the caller.
  }
  // A 429 carrying the free-limit marker means this login is out of free use
  // for the requested model until the stated reset: remember it, so the next
  // turn tries the other logins first.
  if (res.status === 429) {
   const limit = await freeLimitFrom(res, now);
   if (limit) {
    cappedSlots.add(account.slot);
    if (limit.modelId) limitModelId = limit.modelId;
    if (typeof limit.resetAt === "number") {
     if (earliestResetAt === null || limit.resetAt < earliestResetAt) earliestResetAt = limit.resetAt;
     recordLimitOnDisk(account.slot, requestedModel, limit.resetAt);
    }
    logWarn("cline slot is on this model's daily free cap", {
     slot: account.slot,
     model: requestedModel || limit.modelId || "unknown",
     resetInMs: typeof limit.resetAt === "number" ? limit.resetAt - now : null,
    });
   }
  }
  logWarn("cline slot failed — trying next slot", { slot: account.slot, status: res.status });
  await stashFailure(res, kind);
 }
 if (lastRes) {
  // Only every saved login answering the cap counts as a limit-only roll: a
  // login that never got through is a login problem, not a capped one.
  const limitOnly = cappedSlots.size > 0 && candidates.every((a) => cappedSlots.has(a.slot));
  logWarn("cline pool exhausted after roll — returning last upstream failure", {
   slots: candidates.length,
   cappedSlots: cappedSlots.size,
   limitOnly,
   ...(limitModelId ? { limitModel: limitModelId } : {}),
  });
  return {
   res: lastRes,
   slot: lastSlot,
   exhausted: true,
   kind: lastKind,
   logins: candidates.length,
   limitOnly,
   earliestResetAt,
   ...(limitModelId ? { limitModelId } : {}),
  };
 }
 // Every slot was skipped before producing a response: its saved login was
 // rejected, or the network call threw. Nothing is rate-limited here, so say
 // what actually happened instead of implying the user should wait.
 logWarn("cline pool exhausted with no upstream response", { slots: candidates.length, rejected: rejectedThisRoll });
 return {
  res: exhaustedResponse(
   rejectedThisRoll >= candidates.length
    ? "Every saved Cline login was rejected by Cline — sign in again with /freeflow cline login"
    : "Every saved Cline login failed to reach Cline — sign in again with /freeflow cline login",
   502,
  ),
  slot: null,
  exhausted: true,
  kind: "exhausted",
  logins: candidates.length,
  limitOnly: false,
  earliestResetAt,
  ...(limitModelId ? { limitModelId } : {}),
 };
}
