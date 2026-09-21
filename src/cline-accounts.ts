/**
 * Per-user Cline API key pool for pi-freeflow.
 *
 * Cline serves its free models direct-only (never through the relay pool),
 * one bearer key per login slot. Keys live in a 0600 file beside the relay
 * state; a corrupt file reads back as an empty pool (never throws, never
 * logs secrets). Request failover walks the pool in order, trying every slot
 * fresh on every request — no slot is ever locked out.
 */

import fs from "node:fs";
import path from "node:path";
import { RELAY_STATE_FILE } from "./config.ts";
import { logWarn } from "./logger.ts";
import type { FetchImpl } from "./cline-device-auth.ts";
import { isWorkosJwt } from "./cline-device-auth.ts";

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
 /** WorkOS refresh token for device-login slots; absent on legacy key slots. */
 refreshToken?: string;
 /** Epoch-ms when `token` expires; absent means "no known expiry" (legacy slots). */
 expiresAt?: number;
 /** WorkOS account id, shown when choosing which login to remove. */
 accountId?: string;
 /** Login email, shown when choosing which login to remove. */
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

/** Test-only: drop the loadPool mtime cache. */
export function _resetClinePoolCacheForTest(): void {
 cached = null;
 cachedMtime = -1;
}

/** Version this proxy reports as its Cline client build. */
export const CLINE_CLIENT_VERSION = "3.5.54";

/**
 * Client headers the Cline API expects. Measured live (2026-09-21): the
 * `cline-free/*` models answer 403 "only available via Cline product surfaces"
 * with a bare bearer, and 200 with this set; every non-prefixed catalog model
 * (e.g. z-ai/glm-5.3-flash) answers 200 either way. Header names and shape
 * mirror reference/cline providers/request-headers.ts
 * (DEFAULT_CLINE_REQUEST_HEADERS) — no credential is derived from them.
 */
export const CLINE_CLIENT_HEADERS: Record<string, string> = {
 "HTTP-Referer": "https://cline.bot",
 "X-Title": "Cline",
 "X-IS-MULTIROOT": "false",
 "X-CLIENT-TYPE": "cline-sdk",
 "X-CLIENT-VERSION": CLINE_CLIENT_VERSION,
 "User-Agent": `Cline/${CLINE_CLIENT_VERSION}`,
};

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
   accounts.push({
    slot,
    token,
    addedAt: typeof rec.addedAt === "string" ? rec.addedAt : new Date().toISOString(),
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
 pool.accounts.splice(idx, 1);
 if (pool.activeSlot === cleanSlot) pool.activeSlot = pool.accounts[0]?.slot;
 savePool(pool);
 return true;
}

export interface ClineRollOpts {
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

export interface ClineRollResult {
 res: Response;
 /** Slot that served the response; null when no account was tried. */
 slot: string | null;
 /** True when every account failed (or the pool is empty). */
 exhausted: boolean;
 kind: ClineErrorKind;
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
 let candidates = [...pool.accounts];
 if (pool.activeSlot) {
  const at = candidates.findIndex((a) => a.slot === pool.activeSlot);
  if (at > 0) candidates = [candidates[at], ...candidates.slice(0, at), ...candidates.slice(at + 1)];
 }
 if (candidates.length === 0) {
  const reason = "No Cline logins saved — add one with /freeflow cline login";
  logWarn("cline pool empty", { slots: pool.accounts.length });
  return { res: exhaustedResponse(reason, 401), slot: null, exhausted: true, kind: "exhausted" };
 }
 let lastRes: Response | null = null;
 let lastSlot: string | null = null;
 let lastKind: ClineErrorKind = "exhausted";
 for (const account of candidates) {
  // Stale device-login bearer: one refresh before the attempt. A dead grant
  // skips the slot for this turn; a transient fault keeps the stale token.
  let refreshedThisSlot = false;
  if (opts.refreshImpl && account.refreshToken && isClineTokenStale(account)) {
   const outcome = await refreshAccountInPlace(account, opts.refreshImpl);
   if (outcome === false) {
    logWarn("cline slot refresh rejected — skipping slot this turn", { slot: account.slot });
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
   if (kind === "ok") markActiveSlotOnDisk(account.slot);
   if (lastRes && lastRes !== res) {
    try { await lastRes.body?.cancel(); } catch { }
   }
   lastRes = null;
   return { res, slot: account.slot, exhausted: false, kind };
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
    logWarn("cline slot refresh rejected — trying next slot", { slot: account.slot });
    continue;
   }
   // Transient refresh fault: the original response is still intact, so it is
   // stashed below and can be surfaced to the caller.
  }
  logWarn("cline slot failed — trying next slot", { slot: account.slot, status: res.status });
  await stashFailure(res, kind);
 }
 if (lastRes) {
  logWarn("cline pool exhausted after roll — returning last upstream failure", { slots: candidates.length });
  return { res: lastRes, slot: lastSlot, exhausted: true, kind: lastKind };
 }
 // Every slot was skipped before producing a response: its saved login was
 // rejected, or the network call threw. Nothing is rate-limited here, so say
 // what actually happened instead of implying the user should wait.
 logWarn("cline pool exhausted with no upstream response", { slots: candidates.length });
 return {
  res: exhaustedResponse("Every saved Cline login failed to reach Cline — sign in again with /freeflow cline login", 502),
  slot: null,
  exhausted: true,
  kind: "exhausted",
 };
}
