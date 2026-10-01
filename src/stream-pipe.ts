/**
 * Upstream SSE streaming pipeline with thinking sniffing and exception isolation.
 *
 * Prevents upstream stream aborts or timeouts from crashing the host process.
 * Sniffs thinking and reasoning chunks for debug trace logging without payload mutation.
 */

import { randomUUID } from "node:crypto";
import type * as http from "node:http";
import type { Readable } from "node:stream";
import { isDebugEnabled, log } from "./logger.ts";
import { markRelayFailure } from "./relay-state.ts";
import {
 WATCHDOG_SSE_FAIL_RATE,
 WATCHDOG_SSE_MIN_SAMPLES,
 WATCHDOG_SSE_WINDOW,
} from "./config.ts";
import type { CaseRestoreMap, FindGlobRestore } from "./opencode-fingerprint.ts";
import { restoreToolNameForCaller } from "./tool-translation.ts";

/**
 * A premature stream end counts as "substantial" only when BOTH thresholds
 * are strictly exceeded: more than 50 chunks AND more than 100KB. Substantial
 * truncations are reported as incomplete; smaller drops stay failed.
 */
export const SUBSTANTIAL_MIN_CHUNKS = 50;
export const SUBSTANTIAL_MIN_BYTES = 100 * 1024;

export function isSubstantial(chunks: number, bytes: number): boolean {
 return chunks > SUBSTANTIAL_MIN_CHUNKS && bytes > SUBSTANTIAL_MIN_BYTES;
}

/**
 * Failed-SSE rolling window (client watchdog input).
 *
 * The last WATCHDOG_SSE_WINDOW stream outcomes are kept (true = failed,
 * false = ok). Client disconnects and proxy-internal aborts never record —
 * only genuine upstream-side truncation/failure counts as failed, and a
 * clean terminal marker counts as ok. Degraded = at least
 * WATCHDOG_SSE_MIN_SAMPLES outcomes and a failure rate above
 * WATCHDOG_SSE_FAIL_RATE. Exposed on /_health via src/health.ts.
 */
const sseOutcomes: boolean[] = [];
let lastForwardedByteAt = 0;

export function recordSseOutcome(failed: boolean): void {
 sseOutcomes.push(failed);
 if (sseOutcomes.length > WATCHDOG_SSE_WINDOW) sseOutcomes.shift();
}

export function getSseStats(): {
 failures: number;
 total: number;
 rate: number;
 degraded: boolean;
} {
 const total = sseOutcomes.length;
 const failures = sseOutcomes.filter(Boolean).length;
 const rate = total === 0 ? 0 : failures / total;
 return {
  failures,
  total,
  rate,
  degraded: total >= WATCHDOG_SSE_MIN_SAMPLES && rate > WATCHDOG_SSE_FAIL_RATE,
 };
}

/** Timestamp (Date.now()) of the last forwarded stream byte, 0 when no stream has flowed yet. */
export function getLastForwardedByteAt(): number {
 return lastForwardedByteAt;
}

/** Test-only: clear the rolling window and byte timestamp. */
export function _resetSseStatsForTest(): void {
 sseOutcomes.length = 0;
 lastForwardedByteAt = 0;
}
/**
 * Per-request streaming cloak for the OpenCode fingerprint placeholder tools.
 *
 * The non-streaming aggregator (convertSseToJson in opencode-fingerprint.ts)
 * strips injected empty-schema placeholders and restores caller names before
 * the host ever sees them. Raw SSE passthrough would leak those placeholders
 * on the streamed path, so this section mirrors the aggregate semantics
 * event-by-event: function_call deltas whose name is in this request's
 * injected list are dropped, surviving names get caller casing (Bash) and the
 * Pi find->glob rename restored. State is per-stream (no globals); the
 * non-stream path is untouched.
 */
export interface StreamCloakOptions {
 /** False when the caller declared no tools (chat folds dropped args to text). */
 callerHadTools: boolean;
 /** Lowercase placeholder -> caller casing (Bash), built per request. */
 caseRestore?: CaseRestoreMap;
 /** True when the caller sent Pi `find` (upstream `glob` maps back). */
 findGlob?: FindGlobRestore;
 /** Lowercase names this request injected (only these are ever dropped). */
 injected?: readonly string[];
 /** Request pathname; decides the Responses vs Chat event shapes. */
 pathname: string;
}

/** Per-stream drop tracking (delta events carry no name, only an index/id). */
export interface SseStreamCloakState {
 responsesDroppedByIndex: Map<number, boolean>;
 responsesDroppedByItemId: Map<string, boolean>;
 chatDroppedByIndex: Map<number, boolean>;
 messagesDroppedByIndex: Map<number, boolean>;
}

export function createSseStreamCloakState(): SseStreamCloakState {
 return {
  responsesDroppedByIndex: new Map(),
  responsesDroppedByItemId: new Map(),
  chatDroppedByIndex: new Map(),
  messagesDroppedByIndex: new Map(),
 };
}

/**
 * True when the stream needs no rewrite and must flow byte-identical:
 * nothing injected, no casing to restore, no find->glob rename, and the
 * caller declared tools. Tool-less callers must still cloak on every path
 * when the injected record exists (legacy direct calls keep everything).
 */
export function shouldBypassStreamCloak(cloak?: StreamCloakOptions): boolean {
 if (!cloak) return true;
 if (cloak.injected !== undefined && cloak.injected.length > 0) return false;
 if (cloak.caseRestore && Object.keys(cloak.caseRestore).length > 0) return false;
 if (cloak.findGlob?.renamedFindToGlob === true) return false;
 // Tool-less callers must still see tool calls stripped when the
 // injected record exists (legacy direct calls keep everything).
 if (!cloak.callerHadTools && cloak.injected !== undefined) return false;
 return true;
}

function isInjectedName(name: unknown, injected?: readonly string[]): boolean {
 return typeof name === "string" && injected !== undefined && injected.includes(name.toLowerCase());
}

/** Caller casing first, then the Pi find->glob rename (upstream glob->find). */
function restoreStreamName(name: string, cloak: StreamCloakOptions): string {
 const cased = cloak.caseRestore?.[name.toLowerCase()] ?? name;
 return cloak.findGlob ? restoreToolNameForCaller(cased, cloak.findGlob) : cased;
}

/** Split a raw SSE block into its event name and data payload (if any). */
function splitSseBlock(block: string): { event?: string; data?: string; hasData: boolean } {
 let eventName: string | undefined;
 const dataLines: string[] = [];
 let hasData = false;
 for (const line of block.split(/\r?\n/)) {
  if (line.startsWith("event:")) {
   eventName = line.slice(6).trim();
  } else if (line.startsWith("data:")) {
   hasData = true;
   dataLines.push(line.slice(5).trimStart());
  }
 }
 if (!hasData) return { event: eventName, hasData };
 return { event: eventName, data: dataLines.join("\n"), hasData };
}

/** Re-emit a rewritten event, preserving the original event/data framing. */
function emitSseBlock(event: string | undefined, payload: string, hadEventPrefix: boolean): string {
 if (hadEventPrefix) return `event: ${event ?? ""}\ndata: ${payload}`;
 return `data: ${payload}`;
}


/**
 * Rewrite one Responses SSE block: drop injected function_call items/deltas,
 * restore surviving names, cloak completed/incomplete/failed response objects.
 * Returns null to drop the block, otherwise the (possibly rewritten) block.
 */
function rewriteResponsesBlock(
 block: string,
 state: SseStreamCloakState,
 cloak: StreamCloakOptions,
): string | null {
 const { event, data, hasData } = splitSseBlock(block);
 if (!hasData || data === undefined || data === "[DONE]") return block;
 let parsed: Record<string, unknown>;
 try {
  const p: unknown = JSON.parse(data);
  if (!p || typeof p !== "object" || Array.isArray(p)) return block;
  parsed = p as Record<string, unknown>;
 } catch {
  return block;
 }
 const type = parsed.type;
 const hadEventPrefix = /^\s*event:/m.test(block);

 // New function_call item announced: drop when injected; tool-less callers
 // drop every function_call, never leaking calls downstream. Ids and
 // arguments ride verbatim (only the name is ever rewritten).
 if (type === "response.output_item.added" || type === "response.output_item.done") {
  const item = parsed.item;
  if (item && typeof item === "object" && !Array.isArray(item)) {
   const rec = item as Record<string, unknown>;
   if (rec.type === "function_call" && typeof rec.name === "string") {
    if (isInjectedName(rec.name, cloak.injected) || !cloak.callerHadTools) {
     const itemId = rec.id ?? rec.call_id;
     if (typeof parsed.output_index === "number") state.responsesDroppedByIndex.set(parsed.output_index, true);
     if (typeof itemId === "string") state.responsesDroppedByItemId.set(itemId, true);
     return null;
    }
    const restored = restoreStreamName(rec.name, cloak);
    if (restored !== rec.name) {
     rec.name = restored;
     return emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
    }
   }
  }
  return block;
 }

 // Argument deltas carry no name: earlier added/done decisions rule by index/id.
 // Tool-less callers drop every function_call_arguments delta outright.
 if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
  if (!cloak.callerHadTools) return null;
  const droppedByIndex = typeof parsed.output_index === "number" && state.responsesDroppedByIndex.get(parsed.output_index) === true;
  const droppedById = typeof parsed.item_id === "string" && state.responsesDroppedByItemId.get(parsed.item_id) === true;
  if (droppedByIndex || droppedById) return null;
  return block;
 }

 // Terminal/fallback objects may still embed injected calls: cloak in place.
 if (
  (type === "response.completed" || type === "response.incomplete" || type === "response.failed") &&
  parsed.response &&
  typeof parsed.response === "object" &&
  !Array.isArray(parsed.response)
 ) {
  const before = JSON.stringify((parsed.response as Record<string, unknown>).output);
  cloakStreamResponsesObject(parsed.response, cloak);
  const after = JSON.stringify((parsed.response as Record<string, unknown>).output);
  if (before !== after) return emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
  // Names may have been restored without length change: compare whole object.
  const beforeAll = data;
  const rewritten = JSON.stringify(parsed);
  if (rewritten !== beforeAll) return emitSseBlock(event, rewritten, hadEventPrefix);
  return block;
 }
 return block;
}

/** Aggregate-cloak mirror for a Responses object: drop injected (all calls when tool-less), restore kept. */
function cloakStreamResponsesObject(resp: unknown, cloak: StreamCloakOptions): void {
 if (!resp || typeof resp !== "object" || Array.isArray(resp)) return;
 const output = (resp as Record<string, unknown>).output;
 if (!Array.isArray(output)) return;
 const kept: unknown[] = [];
 for (const item of output) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
   const rec = item as Record<string, unknown>;
   if (rec.type === "function_call") {
    if (isInjectedName(rec.name, cloak.injected)) continue;
    if (!cloak.callerHadTools) continue;
    if (typeof rec.name === "string") rec.name = restoreStreamName(rec.name, cloak);
   }
  }
  kept.push(item);
 }
 (resp as Record<string, unknown>).output = kept;
}

/**
 * Rewrite one Chat Completions SSE block: drop injected delta.tool_calls
 * (including nameless argument continuations via per-index tracking), restore
 * surviving names. Tool-less callers lose all tool_calls with arguments
 * folded to content, mirroring the aggregate cloak. Null drops the block.
 */
function rewriteChatBlock(
 block: string,
 state: SseStreamCloakState,
 cloak: StreamCloakOptions,
): string | null {
 const { data, hasData } = splitSseBlock(block);
 if (!hasData || data === undefined || data === "[DONE]") return block;
 let parsed: Record<string, unknown>;
 try {
  const p: unknown = JSON.parse(data);
  if (!p || typeof p !== "object" || Array.isArray(p)) return block;
  parsed = p as Record<string, unknown>;
 } catch {
  return block;
 }
 if (!Array.isArray(parsed.choices)) return block;
 let changed = false;
 let allDeltasEmpty = true;
 for (const choice of parsed.choices) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
  const c = choice as Record<string, unknown>;
  // Pre-assembled message riding a stream: cloak like the aggregate path.
  if (c.message && typeof c.message === "object" && !Array.isArray(c.message)) {
   cloakStreamChatMessage(c.message, cloak);
   changed = true;
   allDeltasEmpty = false;
   continue;
  }
  const delta = c.delta;
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
   if (c.finish_reason || c.text || c.logprobs) allDeltasEmpty = false;
   continue;
  }
  const d = delta as Record<string, unknown>;
  if (!Array.isArray(d.tool_calls)) {
   if (Object.keys(d).length > 0) allDeltasEmpty = false;
   continue;
  }
  const kept: unknown[] = [];
  let folded = "";
  for (const tc of d.tool_calls as unknown[]) {
   if (!tc || typeof tc !== "object" || Array.isArray(tc)) continue;
   const rec = tc as Record<string, unknown>;
   const idx = typeof rec.index === "number" ? rec.index : 0;
   const fn = rec.function;
   const fnRec = fn && typeof fn === "object" && !Array.isArray(fn) ? (fn as Record<string, unknown>) : null;
   const name = fnRec && typeof fnRec.name === "string" && fnRec.name !== "" ? (fnRec.name as string) : "";
   if (!cloak.callerHadTools) {
    state.chatDroppedByIndex.set(idx, true);
    if (fnRec) {
     folded += (typeof fnRec.arguments === "string" && fnRec.arguments) || name;
    }
    changed = true;
    continue;
   }
   if (name !== "") {
    if (isInjectedName(name, cloak.injected)) {
     state.chatDroppedByIndex.set(idx, true);
     changed = true;
     continue;
    }
    const restored = restoreStreamName(name, cloak);
    if (restored !== name && fnRec) {
     fnRec.name = restored;
     changed = true;
    }
    state.chatDroppedByIndex.delete(idx);
    kept.push(tc);
    continue;
   }
   // Nameless continuation (argument chunk): follows the index verdict.
   if (state.chatDroppedByIndex.get(idx) === true) {
    changed = true;
    continue;
   }
   kept.push(tc);
  }
  if (kept.length > 0) {
   d.tool_calls = kept;
   allDeltasEmpty = false;
  } else {
   delete d.tool_calls;
   changed = true;
   if (folded !== "") {
    d.content = `${typeof d.content === "string" ? d.content : ""}${folded}`;
   }
   if (Object.keys(d).length > 0) allDeltasEmpty = false;
  }
  if (Object.keys(d).length === 0 && !c.finish_reason) {
   // Fully emptied delta: contributes nothing downstream.
  } else if (Object.keys(d).length > 0) {
   allDeltasEmpty = false;
  }
 }
 if (allDeltasEmpty && changed) return null;
 if (!changed) return block;
 const hadEventPrefix = /^\s*event:/m.test(block);
 const { event } = splitSseBlock(block);
 return emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
}

/** Aggregate-cloak mirror for a Chat message: drop injected, restore kept. */
function cloakStreamChatMessage(msg: unknown, cloak: StreamCloakOptions): void {
 if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
 const m = msg as Record<string, unknown>;
 if (!Array.isArray(m.tool_calls)) return;
 const calls = m.tool_calls as unknown[];
 if (!cloak.callerHadTools) {
  if ((!m.content || m.content === "") && calls.length > 0) {
   m.content = calls
    .map((tc) => {
     if (!tc || typeof tc !== "object" || Array.isArray(tc)) return "";
     const fn = (tc as Record<string, unknown>).function;
     if (!fn || typeof fn !== "object" || Array.isArray(fn)) return "";
     const f = fn as Record<string, unknown>;
     return (typeof f.arguments === "string" && f.arguments) || (typeof f.name === "string" && f.name) || "";
    })
    .join("\n");
  }
  delete m.tool_calls;
  return;
 }
 const kept: unknown[] = [];
 for (const tc of calls) {
  let callName = "";
  if (tc && typeof tc === "object" && !Array.isArray(tc)) {
   const fn = (tc as Record<string, unknown>).function;
   if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === "string") {
    callName = (fn as Record<string, unknown>).name as string;
   }
  }
  if (callName && isInjectedName(callName, cloak.injected)) continue;
  if (tc && typeof tc === "object" && !Array.isArray(tc)) {
   const fn = (tc as Record<string, unknown>).function;
   if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === "string") {
    (fn as Record<string, unknown>).name = restoreStreamName(
     (fn as Record<string, unknown>).name as string,
     cloak,
    );
   }
  }
  kept.push(tc);
 }
 if (kept.length > 0) m.tool_calls = kept;
 else delete m.tool_calls;
}

/**
 * Rewrite one Anthropic Messages SSE block: drop injected tool_use blocks
 * (including input_json continuations via per-index tracking), restore
 * surviving names. Tool-less callers drop every tool_use, never leaking
 * calls downstream. Null drops the block.
 */
function rewriteMessagesBlock(
 block: string,
 state: SseStreamCloakState,
 cloak: StreamCloakOptions,
): string | null {
 const { event, data, hasData } = splitSseBlock(block);
 if (!hasData || data === undefined || data === "[DONE]") return block;
 let parsed: Record<string, unknown>;
 try {
  const p: unknown = JSON.parse(data);
  if (!p || typeof p !== "object" || Array.isArray(p)) return block;
  parsed = p as Record<string, unknown>;
 } catch {
  return block;
 }
 const type = typeof parsed.type === "string" ? parsed.type : "";
 const hadEventPrefix = /^\s*event:/m.test(block);
 const index = typeof parsed.index === "number" ? parsed.index : 0;
 // New content block announced: drop injected tool_use, else restore name.
 if (type === "content_block_start") {
  const cb = parsed.content_block;
  if (cb && typeof cb === "object" && !Array.isArray(cb) && (cb as Record<string, unknown>).type === "tool_use") {
   const rec = cb as Record<string, unknown>;
   if (typeof rec.name === "string" && (isInjectedName(rec.name, cloak.injected) || !cloak.callerHadTools)) {
    state.messagesDroppedByIndex.set(index, true);
    return null;
   }
   if (typeof rec.name === "string") {
    const restored = restoreStreamName(rec.name, cloak);
    if (restored !== rec.name) {
     rec.name = restored;
     return emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
    }
   }
  }
  return block;
 }
 // Input deltas carry no name: the start verdict rules by index.
 if (type === "content_block_delta") {
  if (state.messagesDroppedByIndex.get(index) === true) return null;
  return block;
 }
 // Block close for a dropped tool_use carries no name: drop it too.
 if (type === "content_block_stop") {
  if (state.messagesDroppedByIndex.get(index) === true) {
   state.messagesDroppedByIndex.delete(index);
   return null;
  }
  return block;
 }
 return block;
}

/**
 * Rewrite one raw SSE block for the streaming cloak. Returns null to drop
 * the block, otherwise the block to forward (identical string when no change,
 * so full-inventory streams stay byte-identical).
 */
export function rewriteSseBlock(
 block: string,
 state: SseStreamCloakState,
 cloak: StreamCloakOptions,
): string | null {
 if (block.trim() === "") return block;
 if (cloak.pathname.endsWith("/responses")) return rewriteResponsesBlock(block, state, cloak);
 if (cloak.pathname.endsWith("/messages")) return rewriteMessagesBlock(block, state, cloak);
 return rewriteChatBlock(block, state, cloak);
}
/**
 * Pipes an upstream readable stream to a client HTTP response.
 *
 * - Flushes HTTP headers immediately for low Time-to-First-Byte (TTFB).
 * - Detects thinking/reasoning tokens in chunks for diagnostic logs.
 * - Handles upstream errors (returns 502 if headers unsent) and ends response.
 * - Cleans up resources and destroys upstream stream on client disconnect/abort.
 * - Optional per-request `cloak`: rewrites SSE events inline (placeholder
 *   strip + caller-name restore); bypassed streams flow byte-identical.
 */
export function pipeUpstreamStream(
 nodeStream: Readable,
 res: http.ServerResponse,
 req: http.IncomingMessage,
 reqId?: string,
 relayUrl?: string,
 cloak?: StreamCloakOptions,
): void {
 const rid = reqId || randomUUID().slice(0, 8);
 let totalChunks = 0;
 let totalBytes = 0;
 let thinkingChunks = 0;
 let thinkingBytes = 0;
 let firstChunkAt: number | null = null;
 const startAt = Date.now();
 const isResponsesApi = req.url?.includes("/responses") ?? false;
 let hasTerminalEvent = false;
 // Abort-cause tracking: only genuine upstream-side truncation may penalize
 // relay health. Client disconnects and clean upstream ends must not.
 let upstreamEnded = false;
 let clientAborted = false;
 // Terminal-marker scan carry: holds the tail of the previously scanned
 // view so a marker split across adjacent chunks ("[DO" | "NE]") is still
 // recognized. Longest marker is "response.completed" (18 bytes); 32
 // gives comfortable headroom.
 let terminalScanCarry = Buffer.alloc(0);
 // Streaming cloak: per-stream rewrite state (null = byte-identical passthrough).
 const cloakState = cloak && !shouldBypassStreamCloak(cloak) ? createSseStreamCloakState() : null;
 // Holds the trailing incomplete SSE block across chunks; complete blocks are
 // rewritten and forwarded, so a function_call name split across chunks still
 // matches its injected record.
 let sseBuffer = "";
 // Watchdog outcome: recorded exactly once per stream. Client disconnects
 // and proxy-internal aborts set clientAborted first, so the ensure path
 // below skips them and the window only reflects upstream-side results.
 let outcomeRecorded = false;
 const recordOnce = (failed: boolean): void => {
  if (outcomeRecorded) return;
  outcomeRecorded = true;
  recordSseOutcome(failed);
 };

 const sniffThinking = (chunk: Buffer | string): boolean => {
  const s =
   typeof chunk === "string"
    ? chunk
    : chunk.toString("utf8", 0, Math.min(chunk.length, 4000));
  return (
   s.includes("reasoning") ||
   s.includes("thinking") ||
   s.includes("<think>") ||
   s.includes("reasoning_content") ||
   s.includes('"type":"thinking"') ||
   s.includes("thinking_delta")
  );
 };

 const checkTerminalEvent = (s: string): boolean => {
  return (
   s.includes("response.completed") ||
   s.includes("response.done") ||
   s.includes("response.failed") ||
   s.includes("response.incomplete") ||
   s.includes("[DONE]")
  );
 };
 /**
  * Forward one rewritten SSE block: terminal-marker scan plus the shared
  * backpressure/flush handling, so cloaked streams keep the raw path's
  * delivery guarantees.
  */
 const forwardText = (text: string): void => {
  const buf = Buffer.from(text, "utf8");
  const scanBuf =
   terminalScanCarry.length > 0
    ? Buffer.concat([terminalScanCarry, buf])
    : buf;
  if (!hasTerminalEvent && checkTerminalEvent(scanBuf.toString("utf8"))) {
   hasTerminalEvent = true;
  }
  terminalScanCarry = Buffer.from(scanBuf.subarray(Math.max(0, scanBuf.length - 32)));
  const canContinue = res.write(text);
  if (canContinue === false && !nodeStream.destroyed) {
   nodeStream.pause();
   const onDrain = () => {
    res.off("drain", onDrain);
    if (!nodeStream.destroyed) nodeStream.resume();
   };
   res.once("drain", onDrain);
  }
  const maybeFlush = res as unknown as { flush?: () => void };
  if (typeof maybeFlush.flush === "function") {
   maybeFlush.flush();
  }
 };
 const sseBoundary = /\r?\n\r?\n/;
 const ensureTerminalEvent = (
  isError = false,
  errorMsg?: string,
  penalizeRelay = true,
 ) => {
  if (hasTerminalEvent || res.writableEnded) return;
  if (!clientAborted) recordOnce(penalizeRelay || isError);
  // Only genuine upstream-side truncation penalizes relay health.
  // Client disconnects and clean upstream ends leave it untouched.
  if (penalizeRelay && relayUrl && relayUrl !== "direct") {
   markRelayFailure(relayUrl, 0, errorMsg || "stream truncated prematurely");
  }
  if (isResponsesApi && totalChunks > 0) {
   try {
    if (isError) {
     res.write(
      `\nevent: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"stream_error","message":${JSON.stringify(errorMsg || "Upstream stream disconnected unexpectedly")}}}}\n\n`,
     );
    } else {
     res.write(
      `\nevent: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"cancelled"}}}\n\n`,
     );
    }
    hasTerminalEvent = true;
    log(
     "warn",
     `injected synthetic response.${isError ? "failed" : "incomplete"} for prematurely truncated stream`,
     { totalChunks, totalBytes, isError, errorMsg },
     rid,
    );
   } catch { }
  } else if (!isResponsesApi && totalChunks > 0) {
   try {
    res.write("\ndata: [DONE]\n\n");
    hasTerminalEvent = true;
   } catch { }
  }
 };

 try {
  if (typeof res.flushHeaders === "function") {
   res.flushHeaders();
  }
 } catch { }
 nodeStream.on("data", (chunk: Buffer | string) => {
  try {
   if (firstChunkAt === null) {
    firstChunkAt = Date.now();
    const ttfb = firstChunkAt - startAt;
    log("debug", `stream first chunk in ${ttfb}ms`, undefined, rid);
   }
   totalChunks++;
   const chunkSize =
    typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
   totalBytes += chunkSize;
   lastForwardedByteAt = Date.now();

   if (sniffThinking(chunk)) {
    thinkingChunks++;
    thinkingBytes += chunkSize;
    if (isDebugEnabled() && thinkingChunks <= 3) {
     const preview =
      typeof chunk === "string"
       ? chunk.slice(0, 600)
       : chunk.toString("utf8", 0, 600);
     log(
      "debug",
      `thinking chunk #${thinkingChunks}`,
      { preview: preview.slice(0, 400) },
      rid,
     );
    }
   }
   if (cloakState && cloak) {
    // Cloaked stream: buffer across chunks so event names split mid-chunk
    // still match, rewrite complete SSE blocks, and drop injected calls.
    sseBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let boundary = sseBoundary.exec(sseBuffer);
    while (boundary) {
     const block = sseBuffer.slice(0, boundary.index);
     sseBuffer = sseBuffer.slice(boundary.index + boundary[0].length);
     const rewritten = rewriteSseBlock(block, cloakState, cloak);
     if (rewritten !== null) forwardText(`${rewritten}\n\n`);
     boundary = sseBoundary.exec(sseBuffer);
    }
    return;
   }
   // Always scan the FULL chunk plus the small carry from the previous
   // view. SSE chunks are KBs at most, so includes() over everything
   // is negligible against correctness — the removed head/tail windows
   // are exactly what let markers buried mid-chunk or split across
   // adjacent chunks escape and cause duplicate synthetic terminals.
   const buf =
    typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
   const scanBuf =
    terminalScanCarry.length > 0
     ? Buffer.concat([terminalScanCarry, buf])
     : buf;
   if (!hasTerminalEvent && checkTerminalEvent(scanBuf.toString("utf8"))) {
    hasTerminalEvent = true;
   }
   terminalScanCarry = Buffer.from(scanBuf.subarray(Math.max(0, scanBuf.length - 32)));

   const canContinue = res.write(chunk);
   if (canContinue === false && !nodeStream.destroyed) {
    // Backpressure: pause the upstream source until the client
    // socket drains, instead of buffering an unbounded amount into
    // the response. 'drain' might never fire if the client closes —
    // the close handlers below destroy the stream regardless of
    // its paused state.
    nodeStream.pause();
    const onDrain = () => {
     res.off("drain", onDrain);
     if (!nodeStream.destroyed) nodeStream.resume();
    };
    res.once("drain", onDrain);
   }
   const maybeFlush = res as unknown as { flush?: () => void };
   if (typeof maybeFlush.flush === "function") {
    maybeFlush.flush();
   }
  } catch { }
 });

 nodeStream.on("error", (e: unknown) => {
  const errorMsg = (e as Error)?.message || String(e);
  // An abort (client disconnect or a proxy-internal header timeout marked
  // FF_INTERNAL_ABORT) is not a relay fault — never penalize relay health,
  // and behave like a client abort for the terminal marker. Only genuine
  // upstream-side failures (socket errors, truncation) penalize.
  // Stream errors are always Error subclasses (node/undici).
  const streamErr = e as Error & { code?: string };
  const isInternalAbort =
   streamErr?.name === "AbortError" || streamErr?.code === "FF_INTERNAL_ABORT";
  log(
   isInternalAbort ? "warn" : "error",
   isInternalAbort
    ? "upstream stream aborted (internal cancel/timeout)"
    : "upstream stream error",
   { error: errorMsg, totalChunks, thinkingChunks, hasTerminalEvent },
   rid,
  );
  try {
   if (!res.headersSent) {
    res.writeHead(502, { "content-type": "application/json" });
   } else if (isInternalAbort) {
    clientAborted = true;
    ensureTerminalEvent(false, errorMsg || "stream interrupted", false);
   } else {
    ensureTerminalEvent(!isSubstantial(totalChunks, totalBytes), errorMsg, true);
   }
   if (!res.writableEnded) {
    res.end();
   }
  } catch { }
 });

 nodeStream.on("end", () => {
  upstreamEnded = true;
  // Cloaked streams hold the trailing incomplete block: flush it (rewritten)
  // ahead of the terminal-marker check so a coalesced final event still counts.
  if (cloakState && cloak && sseBuffer.trim() !== "") {
   const tail = sseBuffer;
   sseBuffer = "";
   const rewritten = rewriteSseBlock(tail, cloakState, cloak);
   if (rewritten !== null) forwardText(`${rewritten}\n\n`);
  }
  if (hasTerminalEvent) recordOnce(false);
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  if (!hasTerminalEvent && totalChunks > 0) {
   // Clean upstream end without a detectable marker: keep the host
   // contract (synthetic terminal) but never blame the relay.
   ensureTerminalEvent(
    false,
    "upstream ended without terminal marker",
    false,
   );
  }
  if (thinkingChunks > 0) {
   log(
    "info",
    `stream ended in ${elapsed}s — ${totalChunks} chunks (${(totalBytes / 1024).toFixed(1)}KB), thinking: ${thinkingChunks} chunks (${(thinkingBytes / 1024).toFixed(1)}KB)`,
    undefined,
    rid,
   );
  } else if (isDebugEnabled()) {
   log(
    "debug",
    `stream ended in ${elapsed}s — ${totalChunks} chunks (${(totalBytes / 1024).toFixed(1)}KB), no thinking detected`,
    undefined,
    rid,
   );
  }
  try {
   if (!res.writableEnded) res.end();
  } catch { }
 });

 nodeStream.on("close", () => {
  try {
   if (!hasTerminalEvent && totalChunks > 0) {
    if (clientAborted || upstreamEnded) {
     // Client disconnect teardown or post-end cleanup — the relay
     // is not at fault; still give the host a terminal event.
     ensureTerminalEvent(false, "stream interrupted by client", false);
    } else {
     // Upstream socket died mid-stream with no error event.
     // For muse-spark large payloads: raxtant 514KB failed but feoni 802KB
     // succeeded with same 2.6MB in — so this is edge-specific, not pure
     // provider token limit. Keep penalize=true to rotate failing relay,
     // but inject incomplete (not failed) for substantial to avoid alarming
     // stream_error. Small premature (<50 chunks) stays failed+penalize.
     ensureTerminalEvent(!isSubstantial(totalChunks, totalBytes), "stream closed prematurely", true);
    }
   }
   if (!res.writableEnded) res.end();
  } catch { }
 });

 req.on("aborted", () => {
  clientAborted = true;
  log("warn", "client aborted — destroying upstream", { totalChunks }, rid);
  if (!nodeStream.destroyed) nodeStream.destroy();
 });

 req.on("close", () => {
  if (!upstreamEnded && !nodeStream.destroyed) {
   clientAborted = true;
   nodeStream.destroy();
  }
 });

 res.on("close", () => {
  if (
   !upstreamEnded &&
   !res.writableEnded &&
   !nodeStream.destroyed
  ) {
   clientAborted = true;
   nodeStream.destroy();
  }
 });

 res.on("error", () => {
  if (!upstreamEnded && !nodeStream.destroyed) {
   clientAborted = true;
   nodeStream.destroy();
  }
 });
}
