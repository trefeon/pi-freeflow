/**
 * Upstream degradation health for pi-freeflow.
 *
 * Tracks OpenCode Zen free-tier gating (HTTP 403 FreeTierError: the free
 * tier can only be used from within OpenCode) in a small persisted state
 * machine. While gated, fresh Zen sessions fail over to a healthy Kilo
 * model on the same wire API (chat and responses both); proven sessions
 * keep their upstream and a periodic canary probes for recovery.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAliveCatalog } from "./catalog.ts";
import { resolveUpstreamHealthPath } from "./config.ts";
import { log } from "./logger.ts";
import { getStatusUi } from "./relay-state.ts";

export type UpstreamName = "zen" | "kilo";

export interface UpstreamHealthSnapshot {
 gated: boolean;
 consecutiveFreeTier403: number;
 firstGatedAt: number;
 lastTransitionAt: number;
 lastCanaryAt: number;
}

export const GATE_ENTER_AFTER = 2;
export const FALLBACK_KILO_MODEL = "stepfun/step-3.7-flash:free";

export type ZenRoute = "passthrough" | "failover" | "canary";

/** Free-tier gate marker: the free tier only works from inside OpenCode. */
const GATE_CODE_MARKER = "FreeTierError";
const GATE_MESSAGE_MARKER = "only be used from within OpenCode";

/** User-visible hint attached to fast-failed 403 gate bodies. */
const FREE_TIER_HINT =
 "OpenCode's free tier is only available inside OpenCode right now, " +
 "so a new session can't start here. Try again later or continue with a fallback model.";

const GATE_ENTER_MESSAGE =
 "OpenCode's free tier is only available inside OpenCode right now — " +
 "new sessions here will use a fallback model until it recovers.";
const GATE_CLEAR_MESSAGE =
 "OpenCode's free tier is available again — new sessions here are using it.";

/** Established session keys live a day; the table is capped and pruned on save. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_SESSION_KEYS = 1_000;
/** Non-transition saves are throttled; gate flips and canaries always persist. */
const SAVE_THROTTLE_MS = 1_000;
/** While gated, at most one unproven canary per window probes for recovery. */
const CANARY_INTERVAL_MS = 5 * 60 * 1_000;
/** Gate flip notifications are throttled per direction. */
const GATE_NOTIFY_THROTTLE_MS = 60_000;
/** Fast-fail hint notifications have their own slower throttle. */
const HINT_NOTIFY_THROTTLE_MS = 10 * 60 * 1_000;

interface GateState {
 gated: boolean;
 consecutiveFreeTier403: number;
 firstGatedAt: number;
 lastTransitionAt: number;
 lastCanaryAt: number;
}

function cleanGate(): GateState {
 return {
  gated: false,
  consecutiveFreeTier403: 0,
  firstGatedAt: 0,
  lastTransitionAt: 0,
  lastCanaryAt: 0,
 };
}

const gates = new Map<UpstreamName, GateState>();
const sessions = new Map<string, number>();
/**
 * Gate-rejection memory: fingerprints of sessions Zen just refused with a
 * free-tier gate 403. A retried or resumed session that matches is failed
 * over immediately instead of replaying the refusal — this is what heals
 * resumed conversations (multi-turn replays, stale keys) without touching
 * working traffic. Memory-only (a daemon restart costs one 403 re-prime)
 * and dropped wholesale when the gate clears.
 */
const rejected = new Map<string, number>();
const REJECTED_TTL_MS = 60 * 60 * 1_000;
const MAX_REJECTED = 1_000;
let loaded = false;
let lastSaveAt = 0;
let lastGateNotifyAt = 0;
let lastGateNotifyKey = "";
let lastHintNotifyAt = 0;

function gateOf(upstream: UpstreamName): GateState {
 let g = gates.get(upstream);
 if (!g) {
  g = cleanGate();
  gates.set(upstream, g);
 }
 return g;
}

function isEstablished(key: string): boolean {
 const expiresAt = sessions.get(key);
 if (expiresAt === undefined) return false;
 if (expiresAt <= Date.now()) {
  sessions.delete(key);
  return false;
 }
 return true;
}

function ensureLoaded(): void {
 if (loaded) return;
 loaded = true;
 let raw: string;
 try {
  raw = fs.readFileSync(resolveUpstreamHealthPath(), "utf8");
 } catch {
  return;
 }
 try {
  const data = JSON.parse(raw) as {
   sessions?: Record<string, number>;
   gates?: Record<string, Partial<GateState>>;
  };
  const now = Date.now();
  if (data.sessions && typeof data.sessions === "object") {
   for (const [k, v] of Object.entries(data.sessions)) {
    if (typeof k === "string" && k.length > 0 && typeof v === "number" && v > now) {
     sessions.set(k, v);
    }
   }
  }
  for (const name of ["zen", "kilo"] as UpstreamName[]) {
   const stored = data.gates?.[name];
   if (stored && typeof stored === "object") {
    gates.set(name, {
     gated: stored.gated === true,
     consecutiveFreeTier403:
      typeof stored.consecutiveFreeTier403 === "number" &&
       Number.isFinite(stored.consecutiveFreeTier403)
       ? Math.max(0, Math.floor(stored.consecutiveFreeTier403))
       : 0,
     firstGatedAt: typeof stored.firstGatedAt === "number" ? stored.firstGatedAt : 0,
     lastTransitionAt:
      typeof stored.lastTransitionAt === "number" ? stored.lastTransitionAt : 0,
     lastCanaryAt: typeof stored.lastCanaryAt === "number" ? stored.lastCanaryAt : 0,
    });
   }
  }
 } catch {
  gates.clear();
  sessions.clear();
 }
}

function persist(force: boolean): void {
 const now = Date.now();
 if (!force && now - lastSaveAt < SAVE_THROTTLE_MS) return;
 for (const [k, v] of sessions) {
  if (v <= now) sessions.delete(k);
 }
 while (sessions.size > MAX_SESSION_KEYS) {
  const oldest = sessions.keys().next();
  if (oldest.done) break;
  sessions.delete(oldest.value);
 }
 try {
  const file = resolveUpstreamHealthPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(
   {
    version: 1,
    sessions: Object.fromEntries(sessions),
    gates: {
     zen: gates.get("zen") ?? cleanGate(),
     kilo: gates.get("kilo") ?? cleanGate(),
    },
   },
   null,
   2,
  );
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  try {
   fs.renameSync(tmp, file);
  } catch {
   try {
    fs.rmSync(tmp, { force: true });
   } catch { }
   fs.writeFileSync(file, body, "utf8");
  }
  lastSaveAt = Date.now();
 } catch (e) {
  log("warn", "Could not persist upstream health", { error: String(e) });
 }
}

export function notifyGateTransition(upstream: UpstreamName, gated?: boolean): void {
 ensureLoaded();
 const isGated = typeof gated === "boolean" ? gated : gateOf(upstream).gated;
 const ui = getStatusUi();
 if (!ui?.notify) return;
 const now = Date.now();
 const key = `${upstream}:${isGated ? "gated" : "open"}`;
 if (key === lastGateNotifyKey && now - lastGateNotifyAt < GATE_NOTIFY_THROTTLE_MS) {
  return;
 }
 lastGateNotifyKey = key;
 lastGateNotifyAt = now;
 try {
  ui.notify(isGated ? GATE_ENTER_MESSAGE : GATE_CLEAR_MESSAGE, isGated ? "warning" : "info");
 } catch { }
}

/** True when a status/body pair is the free-tier gate (fresh sessions refused). */
export function isFreeTierGate(status: number, bodyText: unknown): boolean {
 if (status !== 403 || typeof bodyText !== "string") return false;
 return (
  bodyText.includes(GATE_CODE_MARKER) && bodyText.includes(GATE_MESSAGE_MARKER)
 );
}

/** Stable conversation key carried by request bodies, if the caller sent one. */
export function sessionKeyOf(parsedBody: unknown): string | null {
 if (typeof parsedBody !== "object" || parsedBody === null) return null;
 const key = (parsedBody as Record<string, unknown>).prompt_cache_key;
 return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * Fingerprint of one request for gate-rejection memory: the stable session
 * key when the caller sent one, else a hash of model + path + conversation
 * content (chat messages or responses input). Keyless chat replays hash by
 * content, so a resumed conversation matches its own refused attempt.
 */
export function rejectionFingerprint(parsedBody: unknown, pathname: string): string | null {
 if (typeof parsedBody !== "object" || parsedBody === null) return null;
 const key = sessionKeyOf(parsedBody);
 if (key) return `k:${key}`;
 const rec = parsedBody as Record<string, unknown>;
 const content = Array.isArray(rec.messages) ? rec.messages : rec.input;
 if (content === undefined) return null;
 const model = typeof rec.model === "string" ? rec.model : "?";
 return (
  "h:" +
  createHash("sha256")
   .update(`${model}|${String(pathname)}|${JSON.stringify(content)}`, "utf8")
   .digest("hex")
 );
}

function pruneRejected(now: number): void {
 for (const [fp, expiresAt] of rejected) {
  if (expiresAt <= now) rejected.delete(fp);
 }
 while (rejected.size > MAX_REJECTED) {
  const oldest = rejected.keys().next();
  if (oldest.done) break;
  rejected.delete(oldest.value);
 }
}

/**
 * Remember a session Zen just refused, so its retry fails over instead of
 * replaying the refusal. Only free-tier gate verdicts prime — anything else
 * passes through untouched.
 */
export function rememberGateRejection(
 parsedBody: unknown,
 pathname: string,
 status: number,
 bodyText: unknown,
): void {
 if (!isFreeTierGate(status, bodyText)) return;
 const fp = rejectionFingerprint(parsedBody, pathname);
 if (!fp) return;
 const now = Date.now();
 pruneRejected(now);
 rejected.set(fp, now + REJECTED_TTL_MS);
}

/** True when this session already ate a gate 403 and its retry should fail over. */
export function wasGateRejected(parsedBody: unknown, pathname: string): boolean {
 const fp = rejectionFingerprint(parsedBody, pathname);
 if (!fp) return false;
 const expiresAt = rejected.get(fp);
 if (expiresAt === undefined) return false;
 if (expiresAt <= Date.now()) {
  rejected.delete(fp);
  return false;
 }
 return true;
}

/**
 * True for sessions with no proven history: responses bodies whose key was
 * never established, chat bodies with at most one message and no known key.
 * Fails open (false) for missing bodies.
 */
export function isUnprovenSession(parsedBody: unknown, pathname: string): boolean {
 if (typeof parsedBody !== "object" || parsedBody === null) return false;
 ensureLoaded();
 const key = sessionKeyOf(parsedBody);
 if (key && isEstablished(key)) return false;
 if (String(pathname ?? "").includes("responses")) return true;
 const messages = (parsedBody as { messages?: unknown }).messages;
 if (Array.isArray(messages) && messages.length > 1) return false;
 return true;
}

/**
 * Session routing while degraded: proven sessions and ungated traffic pass
 * through; gated fresh sessions get one canary per window, else failover.
 */
export function decideZenRoute(parsedBody: unknown, pathname: string): ZenRoute {
 ensureLoaded();
 if (!gateOf("zen").gated) return "passthrough";
 if (!isUnprovenSession(parsedBody, pathname)) return "passthrough";
 const g = gateOf("zen");
 const now = Date.now();
 if (!g.lastCanaryAt || now - g.lastCanaryAt >= CANARY_INTERVAL_MS) {
  g.lastCanaryAt = now;
  persist(true);
  return "canary";
 }
 return "failover";
}

/** First healthy Kilo model id, else the built-in Kilo fallback. */
export function pickFailoverModel(): string {
 try {
  const hit = getAliveCatalog().find(
   (m) => (m as { source?: string }).source === "kilo" && typeof m.id === "string" && m.id.length > 0,
  );
  if (hit) return hit.id;
 } catch { }
 return FALLBACK_KILO_MODEL;
}

/**
 * Record a successful upstream turn. Plain successes only establish the
 * session key and never clear the gate; a canary success clears it.
 */
export function recordUpstreamSuccess(
 upstream: UpstreamName,
 opts?: { sessionKey?: string | null; canary?: boolean },
): void {
 ensureLoaded();
 const now = Date.now();
 let dirty = false;
 if (typeof opts?.sessionKey === "string" && opts.sessionKey.length > 0) {
  sessions.delete(opts.sessionKey);
  sessions.set(opts.sessionKey, now + SESSION_TTL_MS);
  dirty = true;
 }
 const g = gateOf(upstream);
 if (opts?.canary === true) {
  g.lastCanaryAt = now;
  // A canary success proves Zen serves fresh sessions again, so remembered
  // refusals are stale whether or not the gate flag was set.
  if (rejected.size > 0) {
   rejected.clear();
   dirty = true;
  }
  if (g.gated) {
   g.gated = false;
   g.consecutiveFreeTier403 = 0;
   g.firstGatedAt = 0;
   g.lastTransitionAt = now;
   log("info", "upstream recovered for new sessions", { upstream });
   persist(true);
   notifyGateTransition(upstream, false);
   return;
  }
  dirty = true;
 } else if (!g.gated && g.consecutiveFreeTier403 !== 0) {
  g.consecutiveFreeTier403 = 0;
  dirty = true;
 }
 if (dirty) persist(false);
}

/** Record a failed upstream turn; consecutive gate 403s flip the gate. */
export function recordUpstreamFailure(
 upstream: UpstreamName,
 status: number,
 bodyText: unknown,
): void {
 ensureLoaded();
 if (!isFreeTierGate(status, bodyText)) {
  const g = gateOf(upstream);
  if (g.consecutiveFreeTier403 !== 0) {
   g.consecutiveFreeTier403 = 0;
   persist(false);
  }
  return;
 }
 const g = gateOf(upstream);
 g.consecutiveFreeTier403 += 1;
 if (!g.gated && g.consecutiveFreeTier403 >= GATE_ENTER_AFTER) {
  const now = Date.now();
  g.gated = true;
  if (!g.firstGatedAt) g.firstGatedAt = now;
  g.lastTransitionAt = now;
  log("warn", "upstream gating new sessions, failing over to fallback", { upstream });
  persist(true);
  notifyGateTransition(upstream, true);
  return;
 }
 persist(false);
}

/** Whether the upstream is currently gated for fresh sessions. */
export function isUpstreamGated(upstream: UpstreamName): boolean {
 ensureLoaded();
 return gateOf(upstream).gated;
}

/** Copy of the current per-upstream health snapshot. */
export function getUpstreamHealth(upstream: UpstreamName): UpstreamHealthSnapshot {
 ensureLoaded();
 return { ...gateOf(upstream) };
}

/**
 * Attach an actionable hint to fast-failed 403 gate bodies. Any other
 * status or body passes through byte-identical. Hint notifications are
 * throttled to one per 10 minutes.
 */
export function withFreeTierHint(status: number, data: string): string {
 if (!isFreeTierGate(status, data)) return data;
 let parsed: unknown;
 try {
  parsed = JSON.parse(data);
 } catch {
  return data;
 }
 if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  return data;
 }
 const json = JSON.stringify({
  ...(parsed as Record<string, unknown>),
  hint: FREE_TIER_HINT,
 });
 try {
  const ui = getStatusUi();
  const now = Date.now();
  if (ui?.notify && now - lastHintNotifyAt >= HINT_NOTIFY_THROTTLE_MS) {
   lastHintNotifyAt = now;
   ui.notify(FREE_TIER_HINT, "warning");
  }
 } catch { }
 return json;
}
/** Reset the degradation gate for an upstream (e.g. after client fingerprint fix or manual recovery). */
export function resetUpstreamGate(upstream: UpstreamName): void {
 ensureLoaded();
 const g = gateOf(upstream);
 g.gated = false;
 g.consecutiveFreeTier403 = 0;
 g.firstGatedAt = 0;
 g.lastTransitionAt = Date.now();
 rejected.clear();
 persist(true);
}


/** Test-only: drop all in-memory health and remove the persisted file. */
export function _resetUpstreamHealthForTest(): void {
 gates.clear();
 sessions.clear();
 rejected.clear();
 loaded = false;
 lastSaveAt = 0;
 lastGateNotifyAt = 0;
 lastGateNotifyKey = "";
 try {
  fs.rmSync(resolveUpstreamHealthPath(), { force: true });
 } catch { }
}

/** Test-only: reset the hint notification throttle. */
export function _resetFreeTierHintForTest(): void {
 lastHintNotifyAt = 0;
}
