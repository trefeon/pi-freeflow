/**
 * Cline chat roll across pooled accounts, limit inspection, and failover mechanics.
 */

import type { FetchImpl } from "./cline-device-auth.ts";
import { isWorkosJwt } from "./cline-device-auth.ts";
import { logWarn } from "./logger.ts";
import { CLINE_CLIENT_HEADERS } from "./cline-accounts.ts";
import {
 activeLimitFor,
 clearLimitOnDisk,
 loadPool,
 markActiveSlotOnDisk,
 patchAccountOnDisk,
 recordClineUsageOnDisk,
 recordLimitOnDisk,
 type ClineAccount,
} from "./cline-pool.ts";

export const CLINE_MODEL_PREFIX = "cline/";

/**
 * Maps a catalog Cline model ID to the exact wire model ID expected by Cline API.
 */
export function clineUpstreamModelId(id: string): string {
 const trimmed = id.trim();
 if (trimmed === "cline/nemotron-3.5-super-vl") {
  return "nvidia/nemotron-3.5-super-vl:free";
 }
 if (trimmed.startsWith(CLINE_MODEL_PREFIX)) {
  return trimmed.slice(CLINE_MODEL_PREFIX.length);
 }
 if (trimmed.startsWith("cline-free/")) {
  return trimmed.slice("cline-free/".length);
 }
 return trimmed;
}

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
export interface ClineFreeLimit {
 /** Model name as the upstream body spells it. */
 modelId?: string;
 /** Epoch ms the cap lifts; absent when the body stated no delay. */
 resetAt?: number;
}

const CLINE_FREE_LIMIT_MARKER = /(?:free limit reached on model|Daily limit reached for)/i;
const CLINE_RATE_LIMIT_RESET_RE = /X-RateLimit-Reset[\\"\s:]+([0-9.]+)/i;
const CLINE_RESET_HOURS_MINUTES_RE = /try again in\s+([0-9]+)\s*h(?:ours?|rs?)?(?:\s*([0-9]+)\s*m(?:in(?:utes?)?)?)?/i;
const CLINE_RESET_MINUTES_ONLY_RE = /try again in\s+([0-9]+)\s*m(?:in(?:utes?)?)?/i;
const CLINE_RESET_BARE_HOURS_RE = /try again in\s+([0-9]+)(?![0-9a-z])/i;
const CLINE_FREE_LIMIT_NAMED_RE = /(?:free limit reached on model|Daily limit reached for)\s+([^\\"\s,;]+)/i;
const CLINE_TRAILING_PUNCT_RE = /[.,;:]+$/;

/**
 * Extract epoch reset from X-RateLimit-Reset if present in headers or metadata.
 * Converts epoch seconds (<1e11) to ms.
 */
export function parseXRateLimitReset(text: string): number | null {
 const m = text.match(CLINE_RATE_LIMIT_RESET_RE);
 if (!m) return null;
 const val = Number(m[1]);
 if (!Number.isFinite(val) || val <= 0) return null;
 return val < 1e11 ? Math.round(val * 1000) : Math.round(val);
}

/**
 * Delay stated as `try again in <N>h <N>m`, `<N>m`, or a bare `<N>` (hours).
 * Returns null when the body states no delay this parser understands.
 */
export function parseResetDelayMs(text: string): number | null {
 const hoursMinutes = text.match(CLINE_RESET_HOURS_MINUTES_RE);
 if (hoursMinutes) {
  const hours = Number(hoursMinutes[1]);
  const minutes = hoursMinutes[2] ? Number(hoursMinutes[2]) : 0;
  return (hours * 60 + minutes) * 60_000;
 }
 const minutesOnly = text.match(CLINE_RESET_MINUTES_ONLY_RE);
 if (minutesOnly) return Number(minutesOnly[1]) * 60_000;
 const bareHours = text.match(CLINE_RESET_BARE_HOURS_RE);
 return bareHours ? Number(bareHours[1]) * 3600_000 : null;
}

/**
 * Parse an upstream 429 body for the daily free-limit marker. Returns null for
 * anything else, so a plain edge 429 keeps its existing behavior.
 */
export function parseClineFreeLimit(raw: string, now = Date.now()): ClineFreeLimit | null {
 if (typeof raw !== "string" || !CLINE_FREE_LIMIT_MARKER.test(raw)) return null;
 const named = raw.match(CLINE_FREE_LIMIT_NAMED_RE);
 // The model name ends the sentence, so a trailing "." belongs to the prose.
 const modelId = named ? named[1].replace(CLINE_TRAILING_PUNCT_RE, "") : "";
 const epochReset = parseXRateLimitReset(raw);
 const delay = epochReset !== null ? null : parseResetDelayMs(raw);
 const resetAt = epochReset !== null ? epochReset : delay !== null ? now + delay : undefined;
 return {
  ...(modelId ? { modelId } : {}),
  ...(resetAt !== undefined ? { resetAt } : {}),
 };
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

/**
 * The model id this request asks Cline for — the key every recorded limit is
 * looked up under. Empty when the body carries no usable model, which
 * disables limit bookkeeping for the roll rather than guessing a key.
 */
export function requestedModelId(body: string): string {
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
 * For OpenRouter-backed Cline models, Cline sometimes answers HTTP 200
 * `text/event-stream` where the first event is an in-stream 429 error
 * (e.g. `stream_initialization_failed` with status 429 / daily limit reached).
 * Peek the first chunk: if it is an in-stream 429 error, convert it to a 429
 * Response so rollChat rolls to the next slot; otherwise, reconstruct the
 * stream with the peeked chunk re-enqueued.
 */
async function peekStreamForInStreamError(res: Response): Promise<{ res: Response; inStreamError: boolean; errorText: string }> {
 const contentType = res.headers.get("content-type") || "";
 if (!contentType.includes("text/event-stream") || !res.body) {
  return { res, inStreamError: false, errorText: "" };
 }
 try {
  const reader = res.body.getReader();
  const { done, value } = await reader.read();
  if (done || !value || value.byteLength === 0) {
   return {
    res: new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers }),
    inStreamError: false,
    errorText: "",
   };
  }
  const text = new TextDecoder().decode(value);
  // Strict: only an in-stream initialization failure carrying a 429 signal
  // converts. A 200 whose first chunk merely mentions "error" or "429" (model
  // content, tool output) must pass through untouched.
  const hasInitFailed = text.includes("stream_initialization_failed");
  const has429Signal = (
   /status[^0-9]{0,12}429/i.test(text) ||
   /"code"\s*:\s*429/.test(text) ||
   /Rate limit exceeded/i.test(text) ||
   /Daily limit reached/i.test(text) ||
   /free limit reached/i.test(text) ||
   /Daily free limit/i.test(text)
  );
  const isInStream429 = hasInitFailed && has429Signal;

  if (isInStream429) {
   try { await reader.cancel(); } catch { }
   const errRes = new Response(text, {
    status: 429,
    headers: { "content-type": "application/json" },
   });
   return { res: errRes, inStreamError: true, errorText: text };
  }

  const reconstructed = new ReadableStream<Uint8Array>({
   start(controller) {
    controller.enqueue(value);
   },
   async pull(controller) {
    try {
     const { done: nextDone, value: nextValue } = await reader.read();
     if (nextDone) {
      controller.close();
     } else if (nextValue) {
      controller.enqueue(nextValue);
     }
    } catch (err) {
     controller.error(err);
    }
   },
   cancel(reason) {
    return reader.cancel(reason);
   },
  });

  return {
   res: new Response(reconstructed, { status: res.status, statusText: res.statusText, headers: res.headers }),
   inStreamError: false,
   errorText: "",
  };
 } catch {
  return { res, inStreamError: false, errorText: "" };
 }
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
export function isClineTokenStale(account: ClineAccount, skewMs = CLINE_REFRESH_SKEW_MS): boolean {
 if (typeof account.expiresAt !== "number" || !Number.isFinite(account.expiresAt)) return false;
 return Date.now() + skewMs >= account.expiresAt;
}

const refreshInFlight = new Map<string, Promise<boolean | null>>();

/**
 * Refresh outcome for one slot: fresh tokens applied and persisted (`true`),
 * dead grant with nothing to keep (`false`), or a transient fault where the
 * caller should fall back to the stale bearer (`null`).
 */
export async function refreshAccountInPlace(
 account: ClineAccount,
 refreshImpl: ClineRefresher,
): Promise<boolean | null> {
 const current = account.refreshToken;
 if (!current) return null;
 if (refreshInFlight.has(account.slot)) {
  const result = await refreshInFlight.get(account.slot)!;
  const pool = loadPool();
  const refreshed = pool.accounts.find((a) => a.slot === account.slot);
  if (refreshed) {
   account.token = refreshed.token;
   if (refreshed.refreshToken) account.refreshToken = refreshed.refreshToken;
   if (typeof refreshed.expiresAt === "number") {
    account.expiresAt = refreshed.expiresAt;
   } else {
    delete account.expiresAt;
   }
   if (refreshed.accountId) account.accountId = refreshed.accountId;
   if (refreshed.email) account.email = refreshed.email;
   if (refreshed.deadUntil) account.deadUntil = refreshed.deadUntil;
  }
  return result;
 }
 const promise = (async (): Promise<boolean | null> => {
  let fresh: ClineRefreshResult | null;
  try {
   fresh = await refreshImpl(current);
  } catch (e) {
   logWarn("cline slot refresh failed — keeping stale bearer", { slot: account.slot });
   void e;
   return null;
  }
  const freshToken = fresh !== null && typeof fresh.token === "string" ? fresh.token.trim() : "";
  if (fresh === null || !freshToken || (!freshToken.startsWith("workos:") && !isWorkosJwt(freshToken) && !freshToken.startsWith("clp_"))) {
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
  account.token = freshToken;
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
 })();
 refreshInFlight.set(account.slot, promise);
 try {
  return await promise;
 } finally {
  refreshInFlight.delete(account.slot);
 }
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
  let inStreamLimitText: string | null = null;
  if (res.status === 200 && res.headers.get("content-type")?.includes("text/event-stream")) {
   const peek = await peekStreamForInStreamError(res);
   res = peek.res;
   if (peek.inStreamError) {
    inStreamLimitText = peek.errorText;
   }
  }
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
    if (res.status === 200 && res.headers.get("content-type")?.includes("text/event-stream")) {
     const peek = await peekStreamForInStreamError(res);
     res = peek.res;
     if (peek.inStreamError) inStreamLimitText = peek.errorText;
    }
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
   const limit = inStreamLimitText ? parseClineFreeLimit(inStreamLimitText, now) : await freeLimitFrom(res, now);
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
