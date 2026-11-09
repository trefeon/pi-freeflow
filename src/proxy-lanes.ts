/**
 * Non-Zen proxy routing lanes (Cline, OVH, Kilo) and lane classification helpers.
 */

import type * as http from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import {
 CLINE_CHAT_URL,
 KILO_CHAT_URL,
 KILO_RESPONSES_URL,
 OVH_CHAT_URL,
 UPSTREAM_HEADER_TIMEOUT_MS,
} from "./config.ts";

import { log } from "./logger.ts";
import {
 getModelUpstream,
 isClineModel,
 isOvhModel,
 KILO_MODEL_IDS,
 MODEL_MAP,
 ovhUpstreamModelId,
 resolveCanonicalModelId,
} from "./models.ts";
import { isFreeCatalogId } from "./catalog.ts";
import { ClineAuthError, refreshClineToken, toApiKey } from "./cline-device-auth.ts";
import {
 clineUpstreamModelId,
 keepClineTokensAlive,
 refreshClineVersion,
 rollChat,
} from "./cline-accounts.ts";
import { fetchWithSystemCA } from "./system-ca-fetch.ts";
import type { ZenTransportMode } from "./zen-transport.ts";
import { pipeUpstreamStream } from "./stream-pipe.ts";
import type { ToolcallRecorder, ToolcallWire } from "./toolcall-audit.ts";
import {
 buildFindGlobRestore,
 chatBodyFromResponsesBody,
 chatResponsesJsonFromChatCompletion,
 chatResponsesSseFromChatCompletion,
 translateToolsForPath,
} from "./tool-translation.ts";
import { buildArgRepairSchemas } from "./tool-args.ts";
import {
 convertSseToJson,
 looksLikeSse,
 repairJsonToolArguments,
 sseToChatCompletionJson,
} from "./opencode-fingerprint.ts";
import { relayFetch } from "./relay.ts";
import { getActiveRelayState } from "./relay-state.ts";
import {
 attachHintForDisplay,
 decideZenRoute,
 isFreeUsageShapeError,
 isUnprovenSession,
 isUpstreamGated,
 isZenFailoverEnabled,
 pickFailoverModel,
 recordUpstreamSuccess,
 wasGateRejected,
} from "./upstream-health.ts";

/**
 * Natural-429 hint throttle: the deploy guidance hint is attached to upstream
 * 429 passthroughs at most once per 10 minutes per process so repeated
 * rate-limit responses don't spam clients.
 */
let last429HintAt = 0;
export function shouldShow429Hint(): boolean {
 const now = Date.now();
 if (now - last429HintAt < 10 * 60 * 1000) return false;
 last429HintAt = now;
 return true;
}
/** Test-only: reset 429 hint throttle */
export function _reset429HintForTest(): void { last429HintAt = 0; }

/** Deploy guidance attached to a natural upstream 429 once the throttle allows. */
export const RATE_LIMIT_HINT =
 "Shared free-tier IP quota reached. Add your own relay egress: /freeflow deploy (Cloudflare recommended, 100k req/day free)";

/**
 * Attach the deploy hint to a natural upstream 429 JSON body. Anything else —
 * non-429 statuses, non-JSON bodies — passes through untouched without
 * consuming the throttle slot.
 */
export function withRateLimitHint(status: number, data: string): string {
 if (status !== 429) return data;
 // Shape 429 (FreeUsageLimitError without quota burn) is our fingerprint's
 // fault, not the pool's: the deploy hint would mislead, so it stays off.
 if (isFreeUsageShapeError(status, data)) return data;
 try {
  const parsed: unknown = JSON.parse(data);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && shouldShow429Hint()) {
   return JSON.stringify(attachHintForDisplay(parsed as Record<string, unknown>, RATE_LIMIT_HINT));
  }
 } catch { }
 return data;
}

/** Cline marker errors: each status carries account-actionable guidance. */
const CLINE_RATE_LIMIT_HINT =
 "Cline free-use limit reached for this login. Wait for the reset or switch models.";
const CLINE_FORBIDDEN_HINT =
 "Cline refused this request. Check the Cline login and retry.";
const CLINE_AUTH_HINT =
 "Cline login expired or missing. Reconnect the Cline login and retry.";
const CLINE_MODEL_HINT =
 "Cline has no such model. Refresh the model list and retry.";

const CLINE_REFRESH_INVALID_TOKEN_RE = /^Invalid token response|^Token response did not include a refresh token/;

/**
 * What the roll knows about a free-limit exhaustion, for the 429 hint: how many
 * saved logins answered the cap and the nearest reset any of them stated.
 */
export interface ClineLimitHint {
 logins: number;
 /** Epoch ms, or null when no login's body stated a reset. */
 resetAt: number | null;
}

/** Coarse reset delay ("20h 4m", "35m") — the hint names what the body stated. */
function formatResetDelay(resetAt: number): string {
 const minutes = Math.max(1, Math.round((resetAt - Date.now()) / 60_000));
 const hours = Math.floor(minutes / 60);
 const rest = minutes % 60;
 if (hours === 0) return `${rest}m`;
 return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Every saved login is out of free use for this model: say what helps next. */
function clineAllLimitedHint(limit: ClineLimitHint): string {
 const reset = limit.resetAt === null ? "" : ` Nearest reset in about ${formatResetDelay(limit.resetAt)}.`;
 return `Cline's daily free limit is used up on all ${limit.logins} saved logins.${reset} Switch models, or add another login with /freeflow cline login.`;
}

/**
 * Attach the matching hint to a Cline marker error JSON body (free-limit
 * 429, 403, 401, model 404). Anything else — other statuses, non-JSON
 * bodies — passes through untouched.
 *
 * `limit` is present only when the roll tried every saved login and every one
 * of them answered the daily free cap; then "for this login" would be wrong and
 * hide that another login is the way out.
 */
export function mapClineError(status: number, data: string, limit?: ClineLimitHint): string {
 // Synthetic pool-exhausted bodies already tell the user exactly what to do
 // (sign in again) — a rate-limit hint would mislead.
 if (data.includes("cline_pool_exhausted")) return data;
 const hint = status === 429
  ? (limit ? clineAllLimitedHint(limit) : CLINE_RATE_LIMIT_HINT)
  : status === 403
   ? CLINE_FORBIDDEN_HINT
   : status === 401
    ? CLINE_AUTH_HINT
    : status === 404
     ? CLINE_MODEL_HINT
     : null;
 if (hint === null) return data;
 try {
  const parsed: unknown = JSON.parse(data);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
   // Hosts render error.message and ignore the sibling hint field, so the
   // guidance must live in the visible message too (hint kept for compat).
   return JSON.stringify(attachHintForDisplay(parsed as Record<string, unknown>, hint));
  }
 } catch { }
 return data;
}

/**
 * Device-login refresher for the Cline pool: one refresh per stale slot per
 * turn. A grant Cline rejects outright (HTTP 4xx, or a 200 without usable
 * tokens) is dead — it resolves null so the pool stops trying that slot until
 * the user logs in again. Anything else (network fault, upstream 5xx) throws,
 * which keeps the stale bearer for this turn.
 */
async function clineRefreshImpl(refreshToken: string): Promise<{ token: string; refreshToken?: string; expiresAt?: number } | null> {
 try {
  const creds = await refreshClineToken(undefined, refreshToken);
  return { token: toApiKey(creds.access), refreshToken: creds.refresh, expiresAt: creds.expires };
 } catch (e) {
  if (e instanceof ClineAuthError && typeof e.status === "number" && e.status >= 400 && e.status < 500) {
   log("warn", "cline refresh grant rejected — slot needs a fresh login", { status: e.status });
   return null;
  }
  if (e instanceof Error && CLINE_REFRESH_INVALID_TOKEN_RE.test(e.message)) {
   log("warn", "cline refresh returned no usable tokens — slot needs a fresh login", { reason: e.message });
   return null;
  }
  throw e;
 }
}

let clineKeepAliveTimer: NodeJS.Timeout | null = null;
const CLINE_KEEP_ALIVE_INTERVAL_MS = 15 * 60 * 1000;

export function startClineKeepAlive(): void {
 if (clineKeepAliveTimer !== null) return;
 void keepClineTokensAlive().catch(() => {});
 void refreshClineVersion().catch(() => {});
 clineKeepAliveTimer = setInterval(() => {
  void keepClineTokensAlive().catch(() => {});
  void refreshClineVersion().catch(() => {});
 }, CLINE_KEEP_ALIVE_INTERVAL_MS);
 clineKeepAliveTimer.unref?.();
}

export function stopClineKeepAlive(): void {
 if (clineKeepAliveTimer !== null) {
  clearInterval(clineKeepAliveTimer);
  clineKeepAliveTimer = null;
 }
}

/**
 * Bound on the caller tool names the audit summary carries (the recorder
 * applies the same caps itself; bounding here keeps a hostile body from
 * building a large array first).
 */
const AUDIT_MAX_DECLARED = 32;
const AUDIT_MAX_NAME = 64;

/**
 * Caller-declared tool names from a request body, in all three wire shapes:
 * chat `{type:"function",function:{name}}`, responses `{type:"function",name}`
 * and messages `{name}`. Names only — the audit never records schemas.
 */
export function declaredToolNames(body: Record<string, unknown>): string[] {
 const names: string[] = [];
 const tools = body.tools;
 if (!Array.isArray(tools)) return names;
 for (const raw of tools) {
  if (names.length >= AUDIT_MAX_DECLARED) break;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
  const rec = raw as Record<string, unknown>;
  const fn = rec.function;
  const fnRec = fn !== null && typeof fn === "object" && !Array.isArray(fn)
   ? (fn as Record<string, unknown>)
   : null;
  const rawName = typeof fnRec?.name === "string" ? fnRec.name : rec.name;
  if (typeof rawName !== "string" || rawName === "") continue;
  const name = rawName.length > AUDIT_MAX_NAME ? rawName.slice(0, AUDIT_MAX_NAME) : rawName;
  if (!names.includes(name)) names.push(name);
 }
 return names;
}

/** Audit wire of a request path: the body shape upstream is asked for. */
export function auditWireFor(pathname: string): ToolcallWire {
 if (pathname.endsWith("/responses")) return "responses";
 if (pathname.endsWith("/messages")) return "messages";
 return "chat";
}

/**
 * Classify an already-assembled chat completion for the audit (non-stream
 * path). Never throws: the audit is best-effort and must stay off the request
 * path. A body without `choices` records a tool-less turn, which is exactly
 * what the caller received.
 */
export function auditChatCompletion(audit: ToolcallRecorder | undefined, completion: unknown): void {
 if (audit === undefined || !audit.active) return;
 try {
  const parsed = completion !== null && typeof completion === "object" && !Array.isArray(completion)
   ? (completion as Record<string, unknown>)
   : {};
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const first = choices.length > 0 && choices[0] !== null && typeof choices[0] === "object" && !Array.isArray(choices[0])
   ? (choices[0] as Record<string, unknown>)
   : undefined;
  const message = first !== undefined && first.message !== null && typeof first.message === "object" && !Array.isArray(first.message)
   ? (first.message as Record<string, unknown>)
   : {};
  const finishReason = typeof first?.finish_reason === "string" ? (first.finish_reason as string) : null;
  audit.finishFromChat(message, finishReason);
 } catch {
  // Unreadable body: nothing to record.
 }
}

/** `auditChatCompletion` over serialized JSON (the aggregated non-stream body). */
export function auditChatBody(audit: ToolcallRecorder | undefined, json: string): void {
 if (audit === undefined || !audit.active) return;
 try {
  auditChatCompletion(audit, JSON.parse(json));
 } catch {
  // Not JSON: nothing to record.
 }
}

/**
 * Classify a non-stream turn of a Responses/Anthropic wire: the recorder reads
 * the raw SSE text itself. A body that carried no SSE frames is left
 * unrecorded rather than guessed as a tool-less turn — the recorder has no
 * reader for a plain object of those wires.
 */
export function auditSseBody(audit: ToolcallRecorder | undefined, text: string): void {
 if (audit === undefined || !audit.active) return;
 if (!text.includes("data:")) return;
 try {
  audit.observe(text);
  audit.finish();
 } catch {
  // Best-effort by contract.
 }
}

/**
 * Non-stream final classification: a chat-wire body parses directly; the
 * responses/messages wires are classified from the raw upstream SSE text.
 */
export function auditFinalBody(
 audit: ToolcallRecorder | undefined,
 pathname: string,
 rawUpstream: string,
 served: string,
): void {
 if (auditWireFor(pathname) === "chat") auditChatBody(audit, served);
 else auditSseBody(audit, rawUpstream);
}

export function upstreamTimeoutError(): Error & { code: string } {
 const err = new Error(`upstream header timeout (${UPSTREAM_HEADER_TIMEOUT_MS}ms)`) as Error & { code: string };
 err.name = "AbortError";
 err.code = "FF_INTERNAL_ABORT";
 return err;
}

export interface HandleClineRequestOptions {
 parsedBody: Record<string, unknown>;
 pathname: string;
 req: http.IncomingMessage;
 res: http.ServerResponse;
 reqId: string;
 clientRequestedStream: boolean;
 audit?: ToolcallRecorder;
}

/**
 * Serve a Cline-model request direct (never relay pool, no opencode
 * fingerprint). Cline serves chat completions only: responses-path bodies
 * translate to chat upstream and the chat answer translates back, re-emitted
 * as SSE when the caller streamed. Upstream always streams; callers that
 * asked for plain JSON get the aggregated object.
 */
export async function handleClineRequest(opts: HandleClineRequestOptions): Promise<void> {
 const { parsedBody, pathname, req, res, reqId, clientRequestedStream, audit } = opts;
 const responsesRequest = pathname.endsWith("/responses");
 const model = typeof parsedBody.model === "string" ? parsedBody.model : "unknown";
 let chatBody: Record<string, unknown>;
 if (responsesRequest) {
  chatBody = chatBodyFromResponsesBody(parsedBody);
 } else {
  chatBody = { ...parsedBody };
  if (Array.isArray(chatBody.tools)) chatBody.tools = translateToolsForPath(chatBody.tools, "/v1/chat/completions");
  delete chatBody.prompt_cache_key;
 }
 chatBody.model = clineUpstreamModelId(model);
 // Cline bypasses the fingerprint, but its arguments still malform the same
 // way: capture the caller's own schemas before translation for repair.
 const argSchemas = buildArgRepairSchemas(Array.isArray(parsedBody.tools) ? parsedBody.tools : []);
 // Translation renames the caller's `find` to `glob` upstream and folds any
 // name the upstream shape forbids; without this map the answer returns under
 // a name Pi never registered.
 const findGlob = buildFindGlobRestore(Array.isArray(parsedBody.tools) ? parsedBody.tools : []);
 chatBody.stream = true;
 let upstreamRes: Response;
 let limitHint: ClineLimitHint | undefined;
 // Client-gone abort: a roll left running after the caller's socket died
 // leaves its upstream body paused forever and the handler never finishes.
 // `res.writableEnded` is false for a destroyed socket, so the roll carries
 // our signal (injected through the roll's fetch) and the resolved body is
 // cancelled at the check below.
 const clineController = new AbortController();
 const abortClineOnClientGone = (): void => {
  if (!res.writableEnded) clineController.abort();
 };
 res.once("close", abortClineOnClientGone);
 req.once("error", abortClineOnClientGone);
 try {
  const result = await rollChat({
   body: JSON.stringify(chatBody),
   chatUrl: CLINE_CHAT_URL,
   refreshImpl: clineRefreshImpl,
   fetchImpl: (url, init) => fetchWithSystemCA(url, { ...init, signal: clineController.signal }),
  });
  upstreamRes = result.res;
  // The roll returns the last upstream failure when the pool is exhausted,
  // so "served by" must only log on an actual success.
  if (upstreamRes.ok && typeof result.slot === "string" && result.slot.length > 0) {
   log("debug", `cline served by slot ${result.slot}`, { model }, reqId);
  }
  // Every saved login answered the daily free cap: name that instead of
  // blaming "this login", which hides that another login or another model works.
  if (result.limitOnly && result.logins > 1) {
   limitHint = { logins: result.logins, resetAt: result.earliestResetAt };
  }
 } catch (e) {
  log("error", "cline pool error", { error: String(e), model }, reqId);
  if (!res.headersSent) {
   res.writeHead(502, { "content-type": "application/json" });
   res.end(JSON.stringify({ error: "upstream error" }));
  }
  return;
 } finally {
  res.off("close", abortClineOnClientGone);
  req.off("error", abortClineOnClientGone);
 }
 if (res.destroyed || res.writableEnded) {
  try { await upstreamRes.body?.cancel(); } catch { }
  return;
 }
 if (!upstreamRes.ok) {
  log("warn", `cline upstream ${upstreamRes.status} for model ${model}`, { status: upstreamRes.status, model }, reqId);
  // A tools request rejected upstream (e.g. a tool-schema 400) is the verdict
  // the host will see; record it so the audit names the cause.
  audit?.attemptFailure({ attempt: 0, status: upstreamRes.status, reason: "final-upstream-status" });
  const raw = await upstreamRes.text().catch(() => null);
  if (raw === null) {
   log("error", "cline upstream body unreadable", { status: upstreamRes.status, model }, reqId);
   if (!res.headersSent) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream error" }));
   } else if (!res.writableEnded) {
    res.end();
   }
   return;
  }
  const data = mapClineError(upstreamRes.status, raw, limitHint);
  if (!res.headersSent) {
   res.writeHead(upstreamRes.status, { "content-type": upstreamRes.headers.get("content-type") || "application/json" });
   res.end(data);
  } else if (!res.writableEnded) {
   res.end();
  }
  return;
 }
 if (!responsesRequest && clientRequestedStream && upstreamRes.body) {
  res.writeHead(upstreamRes.status, {
   "content-type": upstreamRes.headers.get("content-type") || "text/event-stream",
   "cache-control": "no-cache, no-transform",
   connection: "keep-alive",
   "x-accel-buffering": "no",
  });
  pipeUpstreamStream(
   Readable.fromWeb(upstreamRes.body as unknown as WebReadableStream),
   res,
   req,
   reqId,
   "direct",
   findGlob.renamedFindToGlob || findGlob.renamed !== undefined || argSchemas.size > 0
    ? { callerHadTools: true, argSchemas, findGlob, pathname: "/v1/chat/completions" }
    : undefined,
   { upstreamContentType: upstreamRes.headers.get("content-type"), audit: audit?.active ? audit : undefined },
  );
  return;
 }
 const sseText = await upstreamRes.text().catch(() => null);
 if (sseText === null) {
  log("error", "cline upstream stream unreadable", { status: upstreamRes.status, model }, reqId);
  if (!res.headersSent) {
   res.writeHead(502, { "content-type": "application/json" });
   res.end(JSON.stringify({ error: "upstream error" }));
  } else if (!res.writableEnded) {
   res.end();
  }
  return;
 }
 if (!responsesRequest) {
 const data = convertSseToJson(sseText, pathname, true, undefined, findGlob, undefined, argSchemas);
  auditChatBody(audit, data);
  if (!res.headersSent) {
   res.writeHead(upstreamRes.status, { "content-type": "application/json" });
   res.end(data);
  } else if (!res.writableEnded) {
   res.end();
  }
  return;
 }
 const chat = sseToChatCompletionJson(sseText, true, undefined, findGlob, undefined, argSchemas);
 // Classify the chat object before it is mapped: finishFromChat reads the
 // assistant message the model actually produced.
 auditChatCompletion(audit, chat);
 const resp = chatResponsesJsonFromChatCompletion(chat, model);
 if (clientRequestedStream) {
  if (!res.headersSent) {
   res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
   });
   res.end(chatResponsesSseFromChatCompletion(resp));
  } else if (!res.writableEnded) {
   res.end();
  }
  return;
 }
 if (!res.headersSent) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(resp));
 } else if (!res.writableEnded) {
  res.end();
 }
}

// ── OVH lane quirks ───────────────────────────────────────────────────
// Two catalog models have upstream-side quirks this lane must absorb. Both
// checks key off the canonical catalog id, never the wire id: the wire id has
// already lost its `ovh-free/` prefix, and a short alias (`qwen3.8-27b`,
// `mistral-small-3.2`) must resolve to the same model.

/** Qwen3.8-27B on OVH: `reasoning_effort` starves the model into an empty turn. */
const OVH_NO_EFFORT_MODEL = "ovh-free/Qwen3.8-27B" as const;
/** Mistral Small 3.2 on OVH: replayed tool-call ids must be 9 alphanumerics. */
const OVH_STRICT_TOOL_CALL_ID_MODEL = "ovh-free/Mistral-Small-3.2-24B-Instruct-2506" as const;
const OVH_TOOL_CALL_ID_RE = /^[A-Za-z0-9]{9}$/;

/**
 * Rewrite the non-conforming tool-call ids in a chat body's messages.
 *
 * Upstream validates every replayed id against "a-z, A-Z, 0-9, length 9" and
 * drops the whole turn otherwise: a 400 `Tool call id was ll_loop_1 but must be
 * a-z, A-Z, 0-9, with a length of 9` for a non-streamed call, and the same
 * rejection as a silent `data: [DONE]`-only 200 when streaming (measured
 * 2026-10-22). Upstream mints conforming ids itself (observed `hCCedplH4`), so
 * only host-supplied history needs fixing. Replacements are deterministic
 * (`t` + 8-character zero-padded base36 of the request-local sequence) and the
 * same map is applied to the matching `role:"tool"` message, so the pair a host
 * replays next turn stays equal. Conforming ids pass through untouched.
 */
export function normalizeOvhToolCallIds(messages: unknown): void {
 if (!Array.isArray(messages)) return;
 const taken = new Set<string>();
 const broken: string[] = [];
 const note = (id: unknown): void => {
  if (typeof id !== "string" || id.length === 0) return;
  if (OVH_TOOL_CALL_ID_RE.test(id)) taken.add(id);
  else if (!broken.includes(id)) broken.push(id);
 };
 for (const message of messages) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
  const rec = message as Record<string, unknown>;
  if (Array.isArray(rec.tool_calls)) {
   for (const call of rec.tool_calls) {
    if (call !== null && typeof call === "object" && !Array.isArray(call)) note((call as Record<string, unknown>).id);
   }
  }
  if (rec.role === "tool") note(rec.tool_call_id);
 }
 if (broken.length === 0) return;
 const remap = new Map<string, string>();
 let seq = 0;
 for (const id of broken) {
  let next = `t${seq.toString(36).padStart(8, "0")}`;
  while (taken.has(next)) {
   seq += 1;
   next = `t${seq.toString(36).padStart(8, "0")}`;
  }
  seq += 1;
  taken.add(next);
  remap.set(id, next);
 }
 for (const message of messages) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
  const rec = message as Record<string, unknown>;
  if (Array.isArray(rec.tool_calls)) {
   for (const call of rec.tool_calls) {
    if (call === null || typeof call !== "object" || Array.isArray(call)) continue;
    const callRec = call as Record<string, unknown>;
    const next = remap.get(callRec.id as string);
    if (next !== undefined) callRec.id = next;
   }
  }
  if (rec.role === "tool") {
   const next = remap.get(rec.tool_call_id as string);
   if (next !== undefined) rec.tool_call_id = next;
  }
 }
}

/**
 * True when an aggregated chat answer carries neither assistant text nor a
 * tool call — the exact shape OVH produces when it starves a request (Qwen
 * with a `reasoning_effort` field, Mistral with a malformed replayed tool-call
 * id) and closes the stream after a bare `data: [DONE]`. Aggregating that
 * yields `content: null, finish_reason: "stop"`, which the host reads as a
 * finished empty turn; the lane must surface it instead of fabricating it.
 */
export function ovhAnswerIsEmpty(chat: Record<string, unknown>): boolean {
 const choices = Array.isArray(chat.choices) ? chat.choices : [];
 const first = choices.length > 0 && choices[0] !== null && typeof choices[0] === "object" && !Array.isArray(choices[0])
  ? choices[0] as Record<string, unknown>
  : undefined;
 const message = first !== undefined && first.message !== null && typeof first.message === "object" && !Array.isArray(first.message)
  ? first.message as Record<string, unknown>
  : undefined;
 if (message === undefined) return true;
 if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
 const content = message.content;
 if (typeof content === "string") return content.length === 0;
 if (Array.isArray(content)) return content.length === 0;
 return true;
}

/** `ovhAnswerIsEmpty` over the JSON text `convertSseToJson` serialized. */
export function ovhAggregateIsEmpty(data: string): boolean {
 let parsed: unknown;
 try {
  parsed = JSON.parse(data);
 } catch {
  return false;
 }
 if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
 return ovhAnswerIsEmpty(parsed as Record<string, unknown>);
}

/**
 * Answer an empty upstream stream as an error. Never emit the aggregated
 * `chatcmpl-freeflow` shell for it: that is a fabricated 200 completion with
 * `content: null` and `finish_reason: "stop"`, the very thing that hid these
 * upstream failures from the host.
 */
export function respondOvhEmptyStream(res: http.ServerResponse, reqId: string, model: string): void {
 log("warn", `ovh upstream returned an empty stream for model ${model}`, { model }, reqId);
 if (!res.headersSent) {
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "upstream error", detail: "upstream returned an empty stream" }));
 } else if (!res.writableEnded) {
  res.end();
 }
}

export interface HandleOvhRequestOptions {
 parsedBody: Record<string, unknown>;
 pathname: string;
 req: http.IncomingMessage;
 res: http.ServerResponse;
 reqId: string;
 clientRequestedStream: boolean;
 audit?: ToolcallRecorder;
}

/**
 * Serve an OVH-model request direct (never relay pool, no opencode
 * fingerprint). Chat-only upstream: OVH's responses endpoint rejects every
 * array `input` shape with 422 "input: data did not match any variant of
 * untagged enum ResponseInput" and accepts only a bare string (probed
 * 2026-10-13), so a responses-path body translates to chat upstream and the
 * chat answer translates back — the same shape mapping the Cline lane uses.
 * Keyless: no Authorization header, because OVH answers anonymous callers.
 * Upstream always streams; callers that asked for plain JSON get the
 * aggregated object, and a streamed responses caller gets SSE re-emitted
 * from the mapped Responses object.
 */
export async function handleOvhRequest(opts: HandleOvhRequestOptions): Promise<void> {
 const { parsedBody, pathname, req, res, reqId, clientRequestedStream, audit } = opts;
 const responsesRequest = pathname.endsWith("/responses");
 const requestedModel = typeof parsedBody.model === "string" ? parsedBody.model : "unknown";
 let chatBody: Record<string, unknown>;
 if (responsesRequest) {
  chatBody = chatBodyFromResponsesBody(parsedBody);
 } else {
  chatBody = { ...parsedBody };
  if (Array.isArray(chatBody.tools)) chatBody.tools = translateToolsForPath(chatBody.tools, "/v1/chat/completions");
  delete chatBody.prompt_cache_key;
 }
 // OVH knows only the bare id. Canonicalise before stripping: a short alias
 // (`llama-3.3-70b`) must resolve to `ovh-free/Meta-Llama-3_3-70B-Instruct`
 // first, or it reaches OVH unrecognised and answers 404 model_not_found.
 chatBody.model = ovhUpstreamModelId(requestedModel);
 // Lane quirks, keyed by canonical catalog id so an alias resolves to the same
 // model (the wire id above has already lost its `ovh-free/` prefix).
 const canonicalModelId = resolveCanonicalModelId(requestedModel);
 // OVH's OpenAI-compatible surface rejects Qwen chat-template controls
 // (`400 feature 'extra arguments: {"chat_template_kwargs":…}' is not
 // currently supported`). The host classifies this loopback proxy as a local
 // OpenAI-compatible backend, treats `Qwen3.x` models as template-dialect
 // Qwen and injects them; the lane has no such feature. Strip defensively so
 // no host version can leak them upstream.
 delete chatBody.chat_template_kwargs;
 delete chatBody.enable_thinking;
 delete chatBody.preserve_thinking;
 // OVH's OpenAI-compatible surface rejects Responses-native caps (`400 feature
 // 'extra arguments: {"max_output_tokens":…}' is not currently supported`)
 // when a responses-path request was translated via chatBodyFromResponsesBody.
 // Strip defensively so the cap is not passed as an unknown extra argument.
 delete chatBody.max_output_tokens;
 const modelDef = MODEL_MAP.get(canonicalModelId) ?? MODEL_MAP.get(requestedModel);
 if (canonicalModelId === OVH_NO_EFFORT_MODEL || (modelDef && !modelDef.reasoning)) {
  // Qwen3.8-27B on OVH starves when reasoning_effort is present.
  // Non-reasoning OVH models (Llama 3.3, Mistral Small) return HTTP 400
  // "feature 'reasoning_effort for this model' is not currently supported".
  delete chatBody.reasoning_effort;
 }
 if (canonicalModelId === OVH_STRICT_TOOL_CALL_ID_MODEL) {
  // Quirk documented on normalizeOvhToolCallIds: a host-supplied history id
  // that is not 9 alphanumerics kills the turn upstream (400 non-streamed,
  // silent `[DONE]`-only 200 streamed).
  normalizeOvhToolCallIds(chatBody.messages);
 }
 // Bypassing the fingerprint does not exempt OVH from malformed tool
 // arguments: capture the caller's own schemas before translation for repair.
 const argSchemas = buildArgRepairSchemas(Array.isArray(parsedBody.tools) ? parsedBody.tools : []);
 // Translation renames the caller's `find` to `glob` upstream and folds any
 // name the upstream shape forbids; without this map the answer returns under
 // a name Pi never registered.
 const findGlob = buildFindGlobRestore(Array.isArray(parsedBody.tools) ? parsedBody.tools : []);
 chatBody.stream = true;
 // Header-wait timeout + client-disconnect abort, cleared once headers arrive
 // so a long stream is not killed at the timeout ceiling.
 const controller = new AbortController();
 const timeoutId = setTimeout(
  () => controller.abort(upstreamTimeoutError()),
  UPSTREAM_HEADER_TIMEOUT_MS,
 );
 const abortOnClientGone = (): void => {
  if (!res.writableEnded) controller.abort();
 };
 res.once("close", abortOnClientGone);
 req.once("error", abortOnClientGone);
 let upstreamRes: Response;
 let servedRelay: string | null = null;
 try {
  const relayState = getActiveRelayState();
  const relayPoolOn =
   relayState.mode !== "off" &&
   relayState.enabled !== false &&
   Boolean(relayState.url || (relayState.relays && relayState.relays.length > 0));

  if (relayPoolOn) {
   upstreamRes = await relayFetch(
    OVH_CHAT_URL,
    {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify(chatBody),
     signal: controller.signal,
    },
    reqId,
    {
     roundRobin: true,
     onServed: (url) => { servedRelay = url; },
    },
    (failure) => audit?.attemptFailure({ attempt: failure.attempt, status: failure.status, reason: failure.reason }),
   );
  } else {
   upstreamRes = await fetch(OVH_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatBody),
    signal: controller.signal,
   });
  }
 } catch (e) {
  log("error", "ovh upstream fetch failed", { error: String(e), model: requestedModel }, reqId);
  if (!res.headersSent) {
   res.writeHead(502, { "content-type": "application/json" });
   res.end(JSON.stringify({ error: "upstream error" }));
  } else if (!res.writableEnded) {
   res.end();
  }
  return;
 } finally {
  clearTimeout(timeoutId);
  res.off("close", abortOnClientGone);
  req.off("error", abortOnClientGone);
 }
 if (res.writableEnded) {
  try { await upstreamRes.body?.cancel(); } catch { }
  return;
 }
 if (!upstreamRes.ok) {
  log("warn", `ovh upstream ${upstreamRes.status} for model ${requestedModel}`, { status: upstreamRes.status, model: requestedModel }, reqId);
  audit?.attemptFailure({ attempt: 0, status: upstreamRes.status, reason: "final-upstream-status" });
  const raw = await upstreamRes.text().catch(() => null);
  if (raw === null) {
   log("error", "ovh upstream body unreadable", { status: upstreamRes.status, model: requestedModel }, reqId);
   if (!res.headersSent) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream error" }));
   } else if (!res.writableEnded) {
    res.end();
   }
   return;
  }
  if (!res.headersSent) {
   res.writeHead(upstreamRes.status, { "content-type": upstreamRes.headers.get("content-type") || "application/json" });
   res.end(raw);
  } else if (!res.writableEnded) {
   res.end();
  }
  return;
 }
 if (!responsesRequest && clientRequestedStream && upstreamRes.body) {
  res.writeHead(upstreamRes.status, {
   "content-type": upstreamRes.headers.get("content-type") || "text/event-stream",
   "cache-control": "no-cache, no-transform",
   connection: "keep-alive",
   "x-accel-buffering": "no",
  });
  // Fetched via relay pool or direct fallback.
  pipeUpstreamStream(
   Readable.fromWeb(upstreamRes.body as unknown as WebReadableStream),
   res,
   req,
   reqId,
   servedRelay ?? "direct",
   {
    callerHadTools: Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0,
    argSchemas,
    findGlob,
    pathname: "/v1/chat/completions",
    normalizeReasoning: true,
   },
   { upstreamContentType: upstreamRes.headers.get("content-type"), audit: audit?.active ? audit : undefined },
  );
  return;
 }
 const sseText = await upstreamRes.text().catch(() => null);
 if (sseText === null) {
  log("error", "ovh upstream stream unreadable", { status: upstreamRes.status, model: requestedModel }, reqId);
  if (!res.headersSent) {
   res.writeHead(502, { "content-type": "application/json" });
   res.end(JSON.stringify({ error: "upstream error" }));
  } else if (!res.writableEnded) {
   res.end();
  }
  return;
 }
 // The emptiness guard below is about a real upstream *stream*: a 200 body
 // that is not SSE at all is passed through by `convertSseToJson` by
 // contract, and says nothing about starvation.
 const upstreamSpokeSse = looksLikeSse(sseText.trim());
 if (!responsesRequest) {
  const data = convertSseToJson(sseText, pathname, true, undefined, findGlob, undefined, argSchemas);
  // Classified before the starvation guard: a starved turn is exactly the
  // no_tool_calls record worth keeping.
  auditChatBody(audit, data);
  // An upstream that starved the request closes with a bare `data: [DONE]`:
  // the aggregate is an empty assistant turn, which must surface as an error
  // rather than as a finished (and silently blank) completion.
  if (upstreamSpokeSse && ovhAggregateIsEmpty(data)) {
   respondOvhEmptyStream(res, reqId, requestedModel);
   return;
  }
  if (!res.headersSent) {
   res.writeHead(upstreamRes.status, { "content-type": "application/json" });
   res.end(data);
  } else if (!res.writableEnded) {
   res.end();
  }
  return;
 }
 const chat = sseToChatCompletionJson(sseText, true, undefined, findGlob, undefined, argSchemas);
 auditChatCompletion(audit, chat);
 if (upstreamSpokeSse && ovhAnswerIsEmpty(chat)) {
  respondOvhEmptyStream(res, reqId, requestedModel);
  return;
 }
 const resp = chatResponsesJsonFromChatCompletion(chat, requestedModel);
 if (clientRequestedStream) {
  if (!res.headersSent) {
   res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
   });
   res.end(chatResponsesSseFromChatCompletion(resp));
  } else if (!res.writableEnded) {
   res.end();
  }
  return;
 }
 if (!res.headersSent) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(resp));
 } else if (!res.writableEnded) {
  res.end();
 }
}

export interface HandleKiloRequestOptions {
 parsedBody: Record<string, unknown>;
 pathname: string;
 req: http.IncomingMessage;
 res: http.ServerResponse;
 reqId: string;
 clientRequestedStream: boolean;
 sessionKey?: string | null;
 audit?: ToolcallRecorder;
}

/**
 * Keyless gateway handling for Kilo models (both direct Kilo models and
 * Zen sessions failed over to Kilo). Serves chat completions and responses
 * natively, repairs tool arguments, and recovers from 400 token overflows.
 */
export async function handleKiloRequest(opts: HandleKiloRequestOptions): Promise<void> {
 const { parsedBody, pathname, req, res, reqId, clientRequestedStream, sessionKey, audit } = opts;
 const isStream = clientRequestedStream;
 const kiloController = new AbortController();
 const kiloArgSchemas = buildArgRepairSchemas(Array.isArray(parsedBody.tools) ? parsedBody.tools : []);
 const kiloTimeoutId = setTimeout(
  () => kiloController.abort(upstreamTimeoutError()),
  UPSTREAM_HEADER_TIMEOUT_MS,
 );
 const abortKiloOnClientGone = (): void => {
  if (!res.writableEnded) kiloController.abort();
 };
 res.once("close", abortKiloOnClientGone);
 req.once("error", abortKiloOnClientGone);
 let response: Response;
 let servedRelay: string | null = null;
 const kiloUrl = pathname.endsWith("/responses") ? KILO_RESPONSES_URL : KILO_CHAT_URL;
 try {
  response = await relayFetch(
   kiloUrl,
   {
    method: "POST",
    headers: {
     "Content-Type": "application/json",
    },
    body: JSON.stringify(parsedBody),
    signal: kiloController.signal,
   },
   reqId,
   { onServed: (r) => { servedRelay = r; } },
   (info) => audit?.attemptFailure(info),
  );
  if (response.status === 400 && !res.writableEnded) {
   // Token-clamp retry only. The model is NEVER reassigned: a 400 must
   // surface as upstream's verdict for the model the caller asked for, not
   // be answered from another model's stream with only the `model` field as
   // a trace (a silent substitution the product forbids).
   const retryBody = { ...parsedBody };
   let changed = false;
   if (typeof retryBody.max_output_tokens === "number" && retryBody.max_output_tokens > 4096) {
    retryBody.max_output_tokens = 4096;
    changed = true;
   }
   if (typeof retryBody.max_tokens === "number" && retryBody.max_tokens > 4096) {
    retryBody.max_tokens = 4096;
    changed = true;
   }
   if (changed) {
    log("warn", `kilo 400 for model ${String(parsedBody.model)} — retrying with clamped tokens`, { model: parsedBody.model }, reqId);
    try {
     try { await response.body?.cancel(); } catch { }
     const retryRes = await relayFetch(
      kiloUrl,
      {
       method: "POST",
       headers: {
        "Content-Type": "application/json",
       },
       body: JSON.stringify(retryBody),
       signal: kiloController.signal,
      },
      reqId,
      { onServed: (r) => { servedRelay = r; } },
      (info) => audit?.attemptFailure(info),
     );
     if (retryRes.ok) {
      log("info", `kilo 400 recovery succeeded with clamped tokens for model ${String(retryBody.model)}`, { model: retryBody.model }, reqId);
      response = retryRes;
     }
    } catch { }
   }
  }
 } catch (e) {
  log("error", "kilo upstream fetch failed", { error: String(e), model: String(parsedBody.model) }, reqId);
  if (!res.headersSent) {
   res.writeHead(502, { "content-type": "application/json" });
   res.end(JSON.stringify({ error: "upstream error" }));
  } else if (!res.writableEnded) {
   res.end();
  }
  return;
 } finally {
  clearTimeout(kiloTimeoutId);
  res.off("close", abortKiloOnClientGone);
  req.off("error", abortKiloOnClientGone);
 }
 if (res.writableEnded) return;
 if (response.ok) recordUpstreamSuccess("kilo", { sessionKey });
 else audit?.attemptFailure({ attempt: 0, status: response.status, reason: "final-upstream-status" });

 if (isStream && response.ok && response.body) {
  const ct = response.headers.get("content-type") || "text/event-stream";
  res.writeHead(response.status, {
   "content-type": ct,
   "cache-control": "no-cache, no-transform",
   connection: "keep-alive",
   "x-accel-buffering": "no",
  });
  pipeUpstreamStream(
   Readable.fromWeb(
    response.body as unknown as WebReadableStream,
   ),
   res,
   req,
   reqId,
   servedRelay ?? "direct",
   kiloArgSchemas.size > 0
    ? {
     callerHadTools: true,
     argSchemas: kiloArgSchemas,
     pathname: pathname.endsWith("/responses") ? "/v1/responses" : "/v1/chat/completions",
    }
    : undefined,
   { upstreamContentType: response.headers.get("content-type"), audit: audit?.active ? audit : undefined },
  );
 } else {
  const rawUpstreamText = await response.text();
  let rawText = rawUpstreamText;
  if (response.ok && kiloArgSchemas.size > 0) {
   rawText = convertSseToJson(rawText, pathname, true, undefined, undefined, undefined, kiloArgSchemas);
   rawText = repairJsonToolArguments(rawText, pathname, kiloArgSchemas);
  }
  if (response.ok) auditFinalBody(audit, pathname, rawUpstreamText, rawText);
  const data = withRateLimitHint(response.status, rawText);
  const ct = response.headers.get("content-type") || "application/json";
  res.writeHead(response.status, { "content-type": ct });
  res.end(data);
 }
}

/**
 * Relay eligibility: only free-catalog models ride relay egress. Returns true
 * when the model is a non-empty string present in MODEL_MAP or KILO_MODEL_IDS
 * (Kilo traffic leaves via its own branch regardless), and when the model is
 * missing/empty (e.g. GET /v1/models carries no body — preserve routing).
 * Cline and OVH models are direct-only and never relay-eligible. Anything else
 * (unknown/paid model ids, non-strings) goes direct upstream.
 */
export function isRelayEligibleModel(model: unknown): boolean {
 if (model === undefined || model === null) return true;
 if (typeof model !== "string") return false;
 if (model.trim() === "") return true;
 const canonical = resolveCanonicalModelId(model.trim());
 if (isClineModel(canonical)) return false;
 return MODEL_MAP.has(canonical) || KILO_MODEL_IDS.has(canonical) || isFreeCatalogId(canonical) || isOvhModel(canonical);
}

/**
 * True when the resolved Zen transport forbids relay egress: a relay would
 * re-originate the connection and forfeit the sidecar's fingerprint, so the
 * request must ride the direct leg the transport was chosen for.
 */
export function relayBypassedForTransport(mode: ZenTransportMode): boolean {
 return mode === "bun-sidecar";
}

/**
 * Failing-over decision for a canonicalized request body. Only active when
 * the PI_FREEFLOW_ZEN_KILO_FAILOVER opt-in is set; otherwise passthrough.
 * Returns failover
 * with a Kilo model id when a healthy Kilo model is available and either the
 * session already ate a gate 403 (retried/resumed refusals fail over at once,
 * even ungated — replaying a known refusal can never succeed), or every gate
 * holds: Zen upstream model, a path whose body shape matches (chat bodies on
 * chat completions, responses bodies on responses — Kilo serves both natively
 * but a crossed body would 400), Zen currently gated, session never proven
 * working, and the health machine routes this session to failover. Canary
 * sessions pass through carrying the recovery probe; anything else passes
 * through untouched — working sessions are never rerouted.
 */
export type ZenFailoverDecision =
 | { action: "failover"; model: string }
 | { action: "canary" }
 | { action: "passthrough" };

export function classifyZenFailover(
 parsedBody: Record<string, unknown> | null,
 pathname: string,
): ZenFailoverDecision {
 if (!isZenFailoverEnabled()) return { action: "passthrough" };
 if (!parsedBody || typeof parsedBody.model !== "string") return { action: "passthrough" };
 if (getModelUpstream(parsedBody.model) !== "opencode") return { action: "passthrough" };
 const isChatPath = pathname.endsWith("/chat/completions");
 const isResponsesPath = pathname.endsWith("/responses");
 if (!isChatPath && !isResponsesPath) return { action: "passthrough" };
 if (isChatPath && !Array.isArray(parsedBody.messages)) return { action: "passthrough" };
 if (isResponsesPath && parsedBody.input === undefined) return { action: "passthrough" };
 if (!wasGateRejected(parsedBody, pathname)) {
  if (!isUpstreamGated("zen")) return { action: "passthrough" };
  if (!isUnprovenSession(parsedBody, pathname)) return { action: "passthrough" };
  const route = decideZenRoute(parsedBody, pathname);
  if (route === "canary") {
   log("debug", "zen gated — canary session passes through to zen");
   return { action: "canary" };
  }
  if (route !== "failover") return { action: "passthrough" };
 } else {
  log("debug", "zen refused this session before — failing over to Kilo");
 }
 const pick = pickFailoverModel();
 if (!pick) return { action: "passthrough" };
 return { action: "failover", model: pick };
}

const OPENCODE_STALE_VERSION_RE = /opencode\/\d|user-agent|outdated|update (the|your) (cli|client)|upgrade (the|your) (cli|client)|version (too old|no longer supported|not supported|unsupported|deprecated)|minimum.+version|newer version/i;

/**
 * True when an opencode-lane upstream verdict names the client version as the
 * refusal reason — a stale pinned UA that a refresh may repair. 426 always
 * qualifies; 400/403 qualify only on explicit version/upgrade language, and a
 * FreeTierError gate body never qualifies (that is the fingerprint gate, not
 * version drift, and retrying it with a fresh UA would replay the refusal).
 */
export function isStaleOpenCodeVersionError(status: number, bodyText: unknown): boolean {
 if (typeof bodyText !== "string" || bodyText.length === 0) return status === 426;
 if (bodyText.includes("FreeTierError")) return false;
 if (status === 426) return true;
 if (status !== 400 && status !== 403) return false;
 return OPENCODE_STALE_VERSION_RE.test(bodyText);
}
