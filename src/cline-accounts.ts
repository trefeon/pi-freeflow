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
}

export interface ClinePoolState {
 accounts: ClineAccount[];
 activeSlot?: string;
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
   accounts.push({
    slot,
    token,
    addedAt: typeof rec.addedAt === "string" ? rec.addedAt : new Date().toISOString(),
    ...(typeof rec.lastOkAt === "number" ? { lastOkAt: rec.lastOkAt } : {}),
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
 */
export function addAccount(slot: string, token: string): ClinePoolState {
 const cleanSlot = (slot || "").trim();
 if (!cleanSlot) throw new Error("Cline slot name cannot be empty");
 if (cleanSlot.length > 64) throw new Error("Cline slot name is too long (max 64 characters)");
 if (!token.startsWith("workos:")) throw new Error("Cline token must start with workos:");
 const pool = loadPool();
 const existing = pool.accounts.find((a) => a.slot === cleanSlot);
 if (existing) {
  existing.token = token;
 } else {
  pool.accounts.push({ slot: cleanSlot, token, addedAt: new Date().toISOString() });
 }
 if (!pool.activeSlot) pool.activeSlot = cleanSlot;
 slotCooldowns.delete(cleanSlot);
 savePool(pool);
 return pool;
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
  const token = account.token;
  let res: Response;
  try {
   res = await fetchImpl(opts.chatUrl, {
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
   continue;
  }
  const kind = mapClineError(res.status);
  if (kind === "ok" || kind === "client") {
   if (kind === "ok") {
    account.lastOkAt = Date.now();
    pool.activeSlot = account.slot;
    savePool(pool);
   }
   return { res, slot: account.slot, exhausted: false, kind };
  }
  markSlotCooldown(
   account.slot,
   kind === "auth" ? AUTH_COOLDOWN_MS : kind === "rate-limit" ? RATE_COOLDOWN_MS : SERVER_COOLDOWN_MS,
  );
  try {
   await res.body?.cancel();
  } catch { }
  logWarn("cline slot failed — rolling to next slot", { slot: account.slot, status: res.status });
 }
 logWarn("cline pool exhausted after roll", { slots: candidates.length });
 return {
  res: exhaustedResponse("All Cline accounts failed or are cooling down — try again shortly"),
  slot: null,
  exhausted: true,
  kind: "exhausted",
 };
}
