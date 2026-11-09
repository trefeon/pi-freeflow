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
export const CLINE_POOL_LOCK_FILE = `${CLINE_POOL_FILE}.lock`;
const CLINE_LOCK_STALE_MS = 30_000;

export function tryAcquireClineLock(depth = 0): boolean {
 if (depth >= 3) return false;
 try {
  fs.writeFileSync(CLINE_POOL_LOCK_FILE, String(process.pid), { flag: "wx" });
  return true;
 } catch (e) {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code !== "EEXIST") {
   return false;
  }
  let stale = false;
  try {
   stale = Date.now() - fs.statSync(CLINE_POOL_LOCK_FILE).mtimeMs > CLINE_LOCK_STALE_MS;
  } catch {
   return tryAcquireClineLock(depth + 1);
  }
  if (!stale) {
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
   return tryAcquireClineLock(depth + 1);
  }
  try {
   fs.rmSync(CLINE_POOL_LOCK_FILE, { force: true });
  } catch {
   return false;
  }
  return tryAcquireClineLock(depth + 1);
 }
}

export function releaseClineLock(): void {
 try { fs.rmSync(CLINE_POOL_LOCK_FILE, { force: true }); } catch { }
}

export function withClineLock<T>(fn: () => T): T {
 const locked = tryAcquireClineLock();
 if (!locked) {
  logWarn("cline pool lock held — proceeding without lock", {
   lock: CLINE_POOL_LOCK_FILE,
  });
 }
 try {
  return fn();
 } finally {
  if (locked) {
   releaseClineLock();
  }
 }
}
/** One saved login slot. The token is only ever sent as an explicit bearer header. */
export interface ClineAccount {
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

/** One slot's serve counters. See `ClinePoolState.usage`. */
export interface ClineSlotUsage {
 served: number;
 lastAt: number;
 lastModel: string;
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

let cached: ClinePoolState | null = null;
let cachedMtime = -1;

/** Test-only: drop the loadPool mtime cache. */
export function _resetClinePoolCacheForTest(): void {
 cached = null;
 cachedMtime = -1;
}

export function emptyPool(): ClinePoolState {
 return { accounts: [] };
}

/**
 * Deep clone a pool snapshot so callers can never alias the cache: mutating a
 * loaded pool must not corrupt the next load, and mutating the argument after
 * savePool must not rewrite what was cached.
 */
export function clonePool(pool: ClinePoolState): ClinePoolState {
 return {
  accounts: pool.accounts.map((a) => ({ ...a })),
  ...(pool.activeSlot !== undefined ? { activeSlot: pool.activeSlot } : {}),
  ...(pool.limits
   ? { limits: Object.fromEntries(Object.entries(pool.limits).map(([slot, models]) => [slot, { ...models }])) }
   : {}),
  ...(pool.usage
   ? { usage: Object.fromEntries(Object.entries(pool.usage).map(([slot, row]) => [slot, { ...row }])) }
   : {}),
 };
}

/**
 * Read the optional `limits` map out of a pool document, dropping anything
 * malformed and every entry whose reset has already passed. Returns undefined
 * when nothing usable is left, so a pool that never saw a cap keeps its old
 * shape on disk.
 */
export function parseLimits(raw: unknown, now: number): Record<string, Record<string, number>> | undefined {
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
export function parseUsage(raw: unknown): Record<string, ClineSlotUsage> | undefined {
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
export function parsePoolDoc(raw: string): ClinePoolState | null {
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
  const token = typeof rec.token === "string" ? rec.token.trim() : "";
  if (!slot || (!token.startsWith("workos:") && !isWorkosJwt(token) && !token.startsWith("clp_"))) {
   logWarn("cline pool entry rejected", { slot: slot || "(unnamed)" });
   continue;
  }
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
export function recoverPoolFromBackup(description: string): ClinePoolState | null {
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

export function readPoolFile(): ClinePoolState {
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
 if (cached && before === cachedMtime) return clonePool(cached);
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
 cached = clonePool(loaded);
 cachedMtime = stamp;
 return clonePool(cached);
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
export function keepLargestBackup(raw: string): void {
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
  writeFileAtomic(CLINE_POOL_BACKUP_FILE, raw, { mode: 0o600 });
 } catch { }
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
export function forgetAccountInBackup(removed: ClineAccount): void {
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
  writeFileAtomic(CLINE_POOL_BACKUP_FILE, JSON.stringify(doc, null, 2), { mode: 0o600 });
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
  cached = clonePool(pool);
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
export function patchAccountOnDisk(slot: string, patch: Partial<ClineAccount>): void {
 withClineLock(() => {
  const live = readPoolFile();
  const target = live.accounts.find((a) => a.slot === slot);
  if (!target) return;
  Object.assign(target, patch);
  savePool(live);
 });
}

/** Record which slot served a turn, without clobbering concurrent edits. */
export function markActiveSlotOnDisk(slot: string): void {
 withClineLock(() => {
  const live = readPoolFile();
  if (!live.accounts.some((a) => a.slot === slot)) return;
  live.activeSlot = slot;
  savePool(live);
 });
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
 withClineLock(() => {
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
 });
}

/** The reset still in force for one slot+requested model, or null when free. */
export function activeLimitFor(pool: ClinePoolState, slot: string, model: string, now: number): number | null {
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
export function recordLimitOnDisk(slot: string, model: string, resetAt: number): void {
 withClineLock(() => {
  if (!model) return;
  const live = readPoolFile();
  if (!live.accounts.some((a) => a.slot === slot)) return;
  const known = live.limits?.[slot]?.[model];
  if (typeof known === "number" && known >= resetAt) return;
  const limits = live.limits ?? {};
  limits[slot] = { ...(limits[slot] ?? {}), [model]: resetAt };
  live.limits = limits;
  savePool(live);
 });
}

/** Drop one slot+model limit once that slot serves the model again. */
export function clearLimitOnDisk(slot: string, model: string): void {
 withClineLock(() => {
  if (!model) return;
  const live = readPoolFile();
  const limits = live.limits;
  const forSlot = limits?.[slot];
  if (!limits || !forSlot || typeof forSlot[model] !== "number") return;
  delete forSlot[model];
  if (Object.keys(forSlot).length === 0) delete limits[slot];
  if (Object.keys(limits).length === 0) delete live.limits;
  savePool(live);
 });
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
export function sameClineAccount(account: ClineAccount, identity: { token?: string; accountId?: string; email?: string }): boolean {
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
 return withClineLock(() => {
  const cleanSlot = (slot || "").trim();
  if (!cleanSlot) throw new Error("Cline slot name cannot be empty");
  if (cleanSlot.length > 64) throw new Error("Cline slot name is too long (max 64 characters)");
  const cleanToken = (token || "").trim();
  if (!cleanToken.startsWith("workos:") && !isWorkosJwt(cleanToken) && !cleanToken.startsWith("clp_")) throw new Error("Cline token must be a workos: login grant or a clp_ API key");
  const pool = loadPool();
  const existing = pool.accounts.find((a) => a.slot === cleanSlot);
  const duplicate = findClineAccountSlot(pool, { token: cleanToken, accountId: extras?.accountId, email: extras?.email }, cleanSlot);
  if (duplicate) {
   const who = extras?.email?.trim() || existing?.email?.trim() || "this account";
   throw new Error(`That Cline account (${who}) is already saved as [${duplicate}] — log in with a different account, or use /freeflow cline logout ${duplicate} first`);
  }
  if (existing) {
   existing.token = cleanToken;
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
    token: cleanToken,
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
  if (!savePool(pool)) {
   let landed = false;
   try {
    landed = loadPool().accounts.some((a) => a.slot === cleanSlot && a.token === cleanToken);
   } catch {
    landed = false;
   }
   if (!landed) {
    throw new Error(
     `Cline login [${cleanSlot}] could not be saved to ${CLINE_POOL_FILE} — check that the directory is writable and log in again`,
    );
   }
  }
  return clonePool(pool);
 });
}

/** Drop one login slot. Returns false when the slot was not saved. */
export function removeAccount(slot: string): boolean {
 return withClineLock(() => {
  const cleanSlot = (slot || "").trim();
  const pool = loadPool();
  const idx = pool.accounts.findIndex((a) => a.slot === cleanSlot);
  if (idx < 0) return false;
  const [removed] = pool.accounts.splice(idx, 1);
  if (pool.usage?.[cleanSlot] !== undefined) {
   delete pool.usage[cleanSlot];
   if (Object.keys(pool.usage).length === 0) delete pool.usage;
  }
  if (pool.limits?.[cleanSlot] !== undefined) {
   delete pool.limits[cleanSlot];
   if (Object.keys(pool.limits).length === 0) delete pool.limits;
  }
  if (pool.activeSlot === cleanSlot) pool.activeSlot = pool.accounts[0]?.slot;
  savePool(pool);
  forgetAccountInBackup(removed);
  return true;
 });
}
