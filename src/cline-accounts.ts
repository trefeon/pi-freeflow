/**
 * Per-user Cline API key pool for pi-freeflow.
 *
 * Cline serves its free models direct-only (never through the relay pool),
 * one bearer key per login slot. Keys live in a 0600 file beside the relay
 * state; a corrupt file reads back as an empty pool (never throws, never
 * logs secrets). Request failover walks the pool with per-slot cooldowns.
 */

import fs from "node:fs";
import path from "node:path";
import { RELAY_STATE_FILE } from "./config.ts";
import { logWarn } from "./logger.ts";

/** Env override for the pool file location (tests/CI sandbox). */
export const CLINE_POOL_FILE_ENV = "PI_FREEFLOW_CLINE_POOL_FILE";

/** Resolve the per-user pool file: beside the relay state file. */
export function resolveClinePoolPath(): string {
 const override = (process.env[CLINE_POOL_FILE_ENV] || "").trim();
 if (override) return override;
 return path.join(path.dirname(RELAY_STATE_FILE), "pi-freeflow-cline-pool.json");
}

export const CLINE_POOL_FILE = resolveClinePoolPath();

/** One saved login slot. The token is only ever sent as an explicit bearer header. */
export interface ClineAccount {
 slot: string;
 token: string;
 addedAt: string;
 lastOkAt?: number;
 /** WorkOS refresh token for device-login slots; absent on legacy key slots. */
 refreshToken?: string;
 /** Epoch-ms when `token` expires; absent means "no known expiry" (legacy slots). */
 expiresAt?: number;
 /** WorkOS account id, kept for display/diagnostics only. */
 accountId?: string;
 /** Login email, kept for display/diagnostics only. */
 email?: string;
}

export interface ClinePoolState {
 accounts: ClineAccount[];
 activeSlot?: string;
}

/**
 * Fresh tokens minted via the device-login refresh flow. DeviceAuth owns the
 * network call; this module only applies the result to the pool file.
 */
export interface ClineRefreshResult {
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
export type ClineRefresher = (refreshToken: string) => Promise<ClineRefreshResult | null>;

/** Usable bearer for one slot, resolved via refresh when stale. */
export interface ValidSlotCredentials {
 slot: string;
 token: string;
}

/** Cooldowns after failures so a bad key stops absorbing traffic. */
const AUTH_COOLDOWN_MS = 10 * 60_000;
const RATE_COOLDOWN_MS = 90_000;
const SERVER_COOLDOWN_MS = 45_000;
const DEFAULT_COOLDOWN_MS = 30_000;

const slotCooldowns = new Map<string, number>();

/** Test-only: clear in-memory slot cooldowns. */
export function _resetClineCooldownsForTest(): void {
 slotCooldowns.clear();
}

/** Test-only: drop the loadPool mtime cache. */
export function _resetClinePoolCacheForTest(): void {
 cached = null;
 cachedMtime = -1;
}

function markSlotCooldown(slot: string, ms: number): void {
 slotCooldowns.set(slot, Date.now() + ms);
}

/** True when the slot is not cooling down. */
export function isClineSlotHealthy(slot: string): boolean {
 const until = slotCooldowns.get(slot);
 if (!until) return true;
 return Date.now() >= until;
}

/** Machine-classified outcome of one Cline chat attempt. */
export type ClineErrorKind = "ok" | "auth" | "rate-limit" | "exhausted" | "server" | "client";

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

function readPoolFile(): ClinePoolState {
 try {
  if (!fs.existsSync(CLINE_POOL_FILE)) return emptyPool();
  const raw = fs.readFileSync(CLINE_POOL_FILE, "utf8");
  let parsed: unknown;
  try {
   parsed = JSON.parse(raw);
  } catch {
   logWarn("cline pool file corrupt — starting with an empty pool", { path: CLINE_POOL_FILE });
   return emptyPool();
  }
  if (typeof parsed !== "object" || parsed === null) {
   logWarn("cline pool file unusable — starting with an empty pool", { path: CLINE_POOL_FILE });
   return emptyPool();
  }
  // Boundary-narrowed once: the on-disk blob is external input, so check
  // its shape here and read only validated fields below.
  const doc: Record<string, unknown> = parsed as Record<string, unknown>;
  if (!Array.isArray(doc.accounts)) {
   logWarn("cline pool file unusable — starting with an empty pool", { path: CLINE_POOL_FILE });
   return emptyPool();
  }
  const accounts: ClineAccount[] = [];
  for (const entry of doc.accounts as unknown[]) {
   if (typeof entry !== "object" || entry === null) continue;
   const rec: Record<string, unknown> = entry as Record<string, unknown>;
   const slot = typeof rec.slot === "string" ? rec.slot.trim() : "";
   const token = typeof rec.token === "string" ? rec.token : "";
   if (!slot || !token.startsWith("workos:")) continue;
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
   accounts.push({
    slot,
    token,
    addedAt: typeof rec.addedAt === "string" ? rec.addedAt : new Date().toISOString(),
    ...(typeof rec.lastOkAt === "number" ? { lastOkAt: rec.lastOkAt } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
   });
  }
  const activeRaw: unknown = doc.activeSlot;
  const activeSlot = typeof activeRaw === "string" && accounts.some((a) => a.slot === activeRaw.trim())
   ? activeRaw.trim()
   : undefined;
  return activeSlot ? { accounts, activeSlot } : { accounts };
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
 const m = diskMtime();
 if (cached && m === cachedMtime) return cached;
 cached = readPoolFile();
 cachedMtime = diskMtime();
 return cached;
}

/** Atomically persist the pool with owner-only permissions. Never logs secrets. */
export function savePool(pool: ClinePoolState): void {
 try {
  const dir = path.dirname(CLINE_POOL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${CLINE_POOL_FILE}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pool, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
   fs.chmodSync(tmp, 0o600);
  } catch { }
  fs.renameSync(tmp, CLINE_POOL_FILE);
  cached = pool;
  cachedMtime = diskMtime();
 } catch (e) {
  logWarn("could not persist cline pool", { slots: pool.accounts.length });
  void e;
 }
}

/** Last-4 display for a token; the full value is never shown or logged. */
export function redactedToken(token: string): string {
 const tail = (token || "").slice(-4) || "????";
 return `…${tail}`;
}

/**
 * Save (or replace) one login slot. The token must carry the `workos:` prefix.
 * Throws on bad input — the message never echoes the token.
 * Extras carry the device-login grant (refresh token, expiry, identity);
 * legacy key slots keep calling with two args and load untouched.
 */
export function addAccount(
 slot: string,
 token: string,
 extras?: { refreshToken?: string; expiresAt?: number; accountId?: string; email?: string },
): ClinePoolState {
 const cleanSlot = (slot || "").trim();
 if (!cleanSlot) throw new Error("Cline slot name cannot be empty");
 if (cleanSlot.length > 64) throw new Error("Cline slot name is too long (max 64 characters)");
 if (!token.startsWith("workos:")) throw new Error("Cline token must start with workos:");
 const pool = loadPool();
 const existing = pool.accounts.find((a) => a.slot === cleanSlot);
 if (existing) {
  existing.token = token;
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
 slotCooldowns.delete(cleanSlot);
 savePool(pool);
 return pool;
}

/** Skew so a token expiring mid-flight counts as stale before it breaks a call. */
export const CLINE_REFRESH_SKEW_MS = 60_000;

/**
 * True when the slot carries a known expiry that has passed (or passes within
 * the skew window). Slots without `expiresAt` — every legacy key slot — are
 * never stale: they load and serve exactly as before.
 */
export function isClineTokenStale(account: ClineAccount, skewMs = CLINE_REFRESH_SKEW_MS): boolean {
 if (typeof account.expiresAt !== "number" || !Number.isFinite(account.expiresAt)) return false;
 return Date.now() + skewMs >= account.expiresAt;
}

/**
 * Refresh outcome for one slot: fresh tokens applied and persisted (`true`),
 * dead grant with nothing to keep (`false`), or a transient fault where the
 * caller should fall back to the stale bearer (`null`).
 */
async function refreshAccountInPlace(
 pool: ClinePoolState,
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
 if (!fresh || typeof fresh.token !== "string" || !fresh.token.startsWith("workos:")) {
  logWarn("cline slot refresh rejected — grant is dead", { slot: account.slot });
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
 savePool(pool);
 return true;
}

/**
 * Resolve a usable bearer for one slot. Fresh slots and legacy slots without
 * a known expiry return immediately; stale slots with a refresh grant try one
 * refresh and persist it. Resolves null when the slot is unknown or its grant
 * is dead (invalid_grant) — the caller should prompt for a fresh login.
 */
export async function getValidSlotCredentials(
 slot: string,
 opts?: { refreshImpl?: ClineRefresher; skewMs?: number },
): Promise<ValidSlotCredentials | null> {
 const cleanSlot = (slot || "").trim();
 if (!cleanSlot) return null;
 const pool = loadPool();
 const account = pool.accounts.find((a) => a.slot === cleanSlot);
 if (!account) return null;
 if (!isClineTokenStale(account, opts?.skewMs)) return { slot: account.slot, token: account.token };
 if (!account.refreshToken || !opts?.refreshImpl) return { slot: account.slot, token: account.token };
 const outcome = await refreshAccountInPlace(pool, account, opts.refreshImpl);
 if (outcome === true) return { slot: account.slot, token: account.token };
 if (outcome === false) return null;
 return { slot: account.slot, token: account.token };
}

/** Drop one login slot. Returns false when the slot was not saved. */
export function removeAccount(slot: string): boolean {
 const cleanSlot = (slot || "").trim();
 const pool = loadPool();
 const idx = pool.accounts.findIndex((a) => a.slot === cleanSlot);
 if (idx < 0) return false;
 pool.accounts.splice(idx, 1);
 if (pool.activeSlot === cleanSlot) pool.activeSlot = pool.accounts[0]?.slot;
 slotCooldowns.delete(cleanSlot);
 savePool(pool);
 return true;
}

export interface ClineRollOpts {
 /** Serialized chat-completions body, reused verbatim on every attempt. */
 body: string;
 /** Chat completions endpoint (proxy passes its configured URL explicitly). */
 chatUrl: string;
 /** Restrict the roll to these slots; default is the whole pool. */
 slots?: string[];
 fetchImpl?: typeof fetch;
 reqId?: string;
 /**
  * Device-login refresher. When present, a stale slot refreshes once before
  * its attempt, and a 401/403 refreshes once before the slot cools out.
  * Absent: every slot serves its stored bearer exactly as before.
  */
 refreshImpl?: ClineRefresher;
}

export interface ClineRollResult {
 res: Response;
 /** Slot that served the response; null when no account was tried. */
 slot: string | null;
 /** True when every account cooled out (or the pool is empty). */
 exhausted: boolean;
 kind: ClineErrorKind;
}

function exhaustedResponse(reason: string): Response {
 return new Response(
  JSON.stringify({ error: { message: reason, code: "cline_pool_exhausted" } }),
  { status: 429, headers: { "content-type": "application/json" } },
 );
}

/**
 * POST one chat body to the Cline endpoint, rolling across saved slots with
 * per-slot cooldowns. Each attempt sends its slot bearer explicitly; raw
 * tokens never leave this module. Response bodies are never consumed here —
 * the caller owns the returned Response.
 */
export async function rollChat(opts: ClineRollOpts): Promise<ClineRollResult> {
 const fetchImpl = opts.fetchImpl ?? fetch;
 const pool = loadPool();
 const wanted = opts.slots?.map((s) => s.trim()).filter(Boolean);
 let candidates = wanted?.length
  ? pool.accounts.filter((a) => wanted.includes(a.slot))
  : [...pool.accounts];
 if (pool.activeSlot) {
  const at = candidates.findIndex((a) => a.slot === pool.activeSlot);
  if (at > 0) candidates = [candidates[at], ...candidates.slice(0, at), ...candidates.slice(at + 1)];
 }
 candidates = candidates.filter((a) => isClineSlotHealthy(a.slot));
 if (candidates.length === 0) {
  const reason = pool.accounts.length === 0
   ? "No Cline accounts saved — add one with /freeflow cline login"
   : "All Cline accounts are cooling down — try again shortly";
  logWarn("cline pool exhausted", { slots: pool.accounts.length });
  return { res: exhaustedResponse(reason), slot: null, exhausted: true, kind: "exhausted" };
 }
 for (const account of candidates) {
  // Stale device-login bearer: one refresh before the attempt. A dead grant
  // cools the slot out immediately; a transient fault keeps the stale token.
  let refreshedThisSlot = false;
  if (opts.refreshImpl && account.refreshToken && isClineTokenStale(account)) {
   const outcome = await refreshAccountInPlace(pool, account, opts.refreshImpl);
   if (outcome === false) {
    markSlotCooldown(account.slot, AUTH_COOLDOWN_MS);
    logWarn("cline slot refresh rejected — cooling slot", { slot: account.slot });
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
      authorization: `Bearer ${token}`,
     },
     body: opts.body,
    });
   } catch (e) {
    markSlotCooldown(account.slot, DEFAULT_COOLDOWN_MS);
    logWarn("cline slot fetch error — cooling slot", { slot: account.slot });
    void e;
    return null;
   }
  };
  const succeed = (res: Response, kind: ClineErrorKind): ClineRollResult => {
   if (kind === "ok") {
    account.lastOkAt = Date.now();
    pool.activeSlot = account.slot;
    savePool(pool);
   }
   return { res, slot: account.slot, exhausted: false, kind };
  };
  const cool = (kind: ClineErrorKind, status: number): void => {
   markSlotCooldown(
    account.slot,
    kind === "auth" ? AUTH_COOLDOWN_MS : kind === "rate-limit" ? RATE_COOLDOWN_MS : SERVER_COOLDOWN_MS,
   );
   logWarn("cline slot failed — rolling to next slot", { slot: account.slot, status });
  };
  let res = await attempt(account.token);
  if (!res) continue;
  let kind = mapClineError(res.status);
  if (kind === "ok" || kind === "client") return succeed(res, kind);
  // Auth failure on a refreshable slot that has not refreshed yet: one
  // refresh, then exactly one retry with the fresh bearer.
  if (kind === "auth" && !refreshedThisSlot && opts.refreshImpl && account.refreshToken) {
   try {
    await res.body?.cancel();
   } catch { }
   const outcome = await refreshAccountInPlace(pool, account, opts.refreshImpl);
   if (outcome === true) {
    refreshedThisSlot = true;
    res = await attempt(account.token);
    if (!res) continue;
    kind = mapClineError(res.status);
    if (kind === "ok" || kind === "client") return succeed(res, kind);
   } else if (outcome === false) {
    try {
     await res.body?.cancel();
    } catch { }
    cool(kind, res.status);
    continue;
   }
   // Transient refresh fault: fall through and cool the slot on the
   // original auth result below.
  }
  cool(kind, res.status);
  try {
   await res.body?.cancel();
  } catch { }
 }
 logWarn("cline pool exhausted after roll", { slots: candidates.length });
 return {
  res: exhaustedResponse("All Cline accounts failed or are cooling down — try again shortly"),
  slot: null,
  exhausted: true,
  kind: "exhausted",
 };
}
