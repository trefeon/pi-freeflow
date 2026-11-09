/**
 * Per-request streaming cloak for the OpenCode fingerprint placeholder tools.
 *
 * The non-streaming aggregator (convertSseToJson in sse-aggregator.ts)
 * strips injected empty-schema placeholders and restores caller names before
 * the host ever sees them. Raw SSE passthrough would leak those placeholders
 * on the streamed path, so this section mirrors the aggregate semantics
 * event-by-event: function_call deltas whose name is in this request's
 * injected list are dropped, surviving names get caller casing (Bash) and the
 * Pi find->glob rename restored. Completed tool arguments are additionally
 * repaired against `argSchemas` on the terminal events that carry the whole
 * payload. State is per-stream (no globals); the non-stream path is untouched.
 */

import type { CaseRestoreMap } from "./fingerprint-tools.ts";
import { restoreToolNameForCaller, type FindGlobRestore } from "./tool-translation.ts";
import { repairToolArguments } from "./tool-args.ts";
import type { ToolcallRepairSink } from "./toolcall-audit.ts";
import {
 accumulateToolCallName,
 cloakMessagesContent,
 SSE_FIELD_LINE_RE,
} from "./sse-aggregator.ts";

/** Re-export for callers expecting single SSE field-line definition access. */
export { SSE_FIELD_LINE_RE };

/** Detect leading event: prefix on an SSE block. */
const EVENT_PREFIX_RE = /^\s*event:/m;

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
 /** Caller tool schemas for argument repair; undefined/empty means byte-identical. */
 argSchemas?: ReadonlyMap<string, Record<string, unknown>>;
 /** Normalize delta.reasoning to delta.reasoning_content for OpenAI/OMP compatibility. */
 normalizeReasoning?: boolean;
}

/** Per-stream drop tracking (delta events carry no name, only an index/id). */
export interface SseStreamCloakState {
 responsesDroppedByIndex: Map<number, boolean>;
 responsesDroppedByItemId: Map<string, boolean>;
 messagesDroppedByIndex: Map<number, boolean>;
 /** Output index -> tool name, so nameless argument deltas can find their schema. */
 responsesNameByIndex: Map<number, string>;
 /** Anthropic block index -> tool name, same purpose for input_json deltas. */
 messagesNameByIndex: Map<number, string>;
 /**
 * Argument fragments for Anthropic tool_use blocks whose schema admits a
 * repair, keyed the same way as the name map above. Streaming APIs deliver
 * arguments in fragments, so a malformed packet can only be judged once
 * complete: those fragments are held here and re-emitted, repaired, on the
 * block's terminal event. Tools absent from `argSchemas` are never buffered,
 * so their arguments still stream incrementally exactly as before.
 */
 messagesArgsByIndex: Map<number, string>;
 /**
 * Chat tool calls tracked PER CALL (defect K1): keyed by the upstream
 * tool-call id whenever the provider sends one (`id:X`), else by the legacy
 * index bucket (`idx:N`). Free models label EVERY parallel call `index: 0`
 * while still sending per-call ids, so index-only keying merged their
 * fragment streams: one call was silently lost and the other received a
 * salvage of the merged junk. Drops, names, buffered arguments and the
 * once-only flush guard are per call; an injected placeholder's drop
 * verdict is never inherited by a real call that reuses its index.
 */
 chatCalls: Map<string, ChatTrackedCall>;
 /**
 * Observed delta index -> key of the call its id-less fragments currently
 * belong to. Resolution mirrors the aggregate cloak exactly
 * (sseToChatCompletionJson): an id-bearing delta (re)binds the index to its
 * id-call; id-less deltas follow the current owner, else the legacy
 * `idx:N` bucket. Never consulted for host-visible indices — that is what
 * {@link chatIndexClaims} is for.
 */
 chatIndexOwner: Map<number, string>;
 /** Host-index claims: index -> key of the call that FIRST assigned it. Set once, never rebound. */
 chatIndexClaims: Map<number, string>;
 /**
 * Fresh sequential index handed out when a call's upstream index is already
 * claimed by another tracked call; strictly above every index seen or
 * assigned so far in this stream.
 */
 chatNextIndex: number;
 /**
 * Per-turn tool-call audit sink for the rewrites this state performs
 * (index collisions, dropped name restatements, withheld arguments, repaired
 * arguments). Absent when the caller did not request an audit.
 */
 audit?: ToolcallRepairSink;
}

/**
 * Streaming state of ONE chat tool call. Exported only because it hangs off
 * the exported per-stream state; treat it as pipe-internal.
 */
export interface ChatTrackedCall {
 /** Never emit this call: injected placeholder, or a tool-less caller's call. */
 dropped: boolean;
 /**
  * Restored host-facing name, folded from every name-bearing delta:
  * fragments append, a delta that also carries arguments restates the whole
  * name and replaces (see accumulateToolCallName).
  */
 name: string | undefined;
 /**
 * True once a name-bearing delta decided this tool is repairable and its
 * fragments must be withheld: the packet is only judgeable once whole, so
 * the fragments re-emerge whole+repaired on the call's terminal event.
 */
 buffered: boolean;
 /** Buffered argument prefix while {@link buffered} is true ("" until a fragment arrives). */
 args: string;
 /**
 * Host-visible index: the call's FIRST assigned index — its first observed
 * index — unless that upstream index was claimed by another tracked call,
 * in which case a fresh sequential index was handed out in arrival order.
 */
 hostIndex: number;
 /** Emitted-once guard: a flush entry already went out for this call (terminal or end-of-stream). */
 flushed: boolean;
}

/** Map key of a chat tool call that announced an upstream id. */
export function chatCallIdKey(id: string): string {
 return `id:${id}`;
}

/** Legacy map key of the id-less fragment bucket for one observed delta index. */
export function chatIndexKey(idx: number): string {
 return `idx:${idx}`;
}

export function createSseStreamCloakState(audit?: ToolcallRepairSink): SseStreamCloakState {
 const state: SseStreamCloakState = {
  responsesDroppedByIndex: new Map(),
  responsesDroppedByItemId: new Map(),
  messagesDroppedByIndex: new Map(),
  responsesNameByIndex: new Map(),
  messagesNameByIndex: new Map(),
  messagesArgsByIndex: new Map(),
  chatCalls: new Map(),
  chatIndexOwner: new Map(),
  chatIndexClaims: new Map(),
  chatNextIndex: 0,
 };
 if (audit !== undefined) state.audit = audit;
 return state;
}

/**
 * Emit every tool call still holding buffered arguments, then clear the
 * buffers. The fragments were withheld so the packet could be judged whole
 * (see {@link SseStreamCloakState}); the terminal event that normally releases
 * them never arrived when upstream cut the stream without one, and without
 * this the client would receive a tool call whose `arguments` were deleted and
 * never re-emitted. Repaired exactly as the terminal path repairs.
 *
 * Shape follows the pathname: Chat re-emits one `tool_calls` delta, Anthropic
 * one `input_json_delta` per open block. Responses carries whole arguments on
 * its `.done` event and buffers nothing, so it has nothing to flush.
 * Returns null when nothing is buffered.
 */
export function flushBufferedToolArgs(
 state: SseStreamCloakState,
 cloak: StreamCloakOptions,
): string | null {
 if (state.messagesArgsByIndex.size > 0) {
  const blocks: string[] = [];
  for (const [index, args] of state.messagesArgsByIndex) {
   const name = state.messagesNameByIndex.get(index) ?? "";
   const repaired = repairToolArguments(name, args, cloak.argSchemas);
   if (repaired !== args) state.audit?.repair("arguments-repaired", name);
   blocks.push(
    `event: content_block_delta\ndata: ${JSON.stringify({
     type: "content_block_delta",
     index,
     delta: { type: "input_json_delta", partial_json: repaired },
    })}\n\n`,
   );
  }
  state.messagesArgsByIndex.clear();
  state.messagesNameByIndex.clear();
  return blocks.join("");
 }
 const calls: unknown[] = [];
 for (const call of state.chatCalls.values()) {
  // The flushed guard makes this one-shot even when a terminal flush
  // already emitted the call whole earlier in the stream.
  if (!call.buffered || call.flushed) continue;
  const name = call.name;
  if (name === undefined) continue;
  const args = call.args;
  call.flushed = true;
  call.buffered = false;
  call.args = "";
  const repairedArgs = repairToolArguments(name, args, cloak.argSchemas);
  if (repairedArgs !== args) state.audit?.repair("arguments-repaired", name);
  calls.push({ index: call.hostIndex, type: "function", function: { name, arguments: repairedArgs } });
 }
 if (calls.length === 0) return null;
 return `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: calls } }] })}\n\n`;
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
 if (cloak.findGlob?.renamed && Object.keys(cloak.findGlob.renamed).length > 0) return false;
 // Tool-less callers must still see tool calls stripped when the
 // injected record exists (legacy direct calls keep everything).
 if (!cloak.callerHadTools && cloak.injected !== undefined) return false;
 // A repairable schema means fragmented arguments must be buffered.
 if (cloak.argSchemas !== undefined && cloak.argSchemas.size > 0) return false;
 if (cloak.normalizeReasoning === true) return false;
 return true;
}

export function isInjectedName(name: unknown, injected?: readonly string[]): boolean {
 return typeof name === "string" && injected !== undefined && injected.includes(name.toLowerCase());
}

/** True when the request declared a schema for this tool, so its arguments can be repaired. */
export function isRepairableTool(
 name: string,
 schemas: ReadonlyMap<string, Record<string, unknown>> | undefined,
): boolean {
 return schemas !== undefined && schemas.size > 0 && schemas.has(name.trim().toLowerCase());
}

/** Caller casing first, then the Pi find->glob rename (upstream glob->find). */
export function restoreStreamName(name: string, cloak: StreamCloakOptions): string {
 const cased = cloak.caseRestore?.[name.toLowerCase()] ?? name;
 return cloak.findGlob ? restoreToolNameForCaller(cased, cloak.findGlob) : cased;
}

/** Split a raw SSE block into its event name and data payload (if any). */
export function splitSseBlock(block: string): { event?: string; data?: string; hasData: boolean } {
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
export function emitSseBlock(event: string | undefined, payload: string, hadEventPrefix: boolean): string {
 if (hadEventPrefix) return `event: ${event ?? ""}\ndata: ${payload}`;
 return `data: ${payload}`;
}

/**
 * Rewrite one Responses SSE block: drop injected function_call items/deltas,
 * restore surviving names, cloak completed/incomplete/failed response objects.
 * Returns null to drop the block, otherwise the (possibly rewritten) block.
 */
export function rewriteResponsesBlock(
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
 const hadEventPrefix = EVENT_PREFIX_RE.test(block);

 // New function_call item announced: drop when injected; tool-less callers
 // drop every function_call, never leaking calls downstream. Ids ride
 // verbatim; `output_item.done` carries the whole argument string, so that is
 // where schema repair applies (name-only deltas cannot be repaired yet).
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
    if (typeof parsed.output_index === "number") state.responsesNameByIndex.set(parsed.output_index, restored);
    if (type === "response.output_item.done") {
     rec.name = restored;
     const originalArgs = typeof rec.arguments === "string" ? rec.arguments : "";
     const repairedArgs = repairToolArguments(restored, originalArgs, cloak.argSchemas);
     if (repairedArgs !== originalArgs) state.audit?.repair("arguments-repaired", restored);
     rec.arguments = repairedArgs;
     return emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
    }
    if (restored !== rec.name) {
     rec.name = restored;
     return emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
    }
   }
  }
  return block;
 }

 // Argument deltas carry no name: earlier added/done decisions rule by index/id.
 // Tool-less callers drop every function_call_arguments delta outright. The
 // `.done` event carries the whole `arguments` string, so it is repairable.
 if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
  if (!cloak.callerHadTools) return null;
  const droppedByIndex = typeof parsed.output_index === "number" && state.responsesDroppedByIndex.get(parsed.output_index) === true;
  const droppedById = typeof parsed.item_id === "string" && state.responsesDroppedByItemId.get(parsed.item_id) === true;
  if (droppedByIndex || droppedById) return null;
  if (type === "response.function_call_arguments.done" && typeof parsed.arguments === "string") {
   const name = typeof parsed.output_index === "number" ? state.responsesNameByIndex.get(parsed.output_index) : undefined;
   if (name !== undefined) {
    const repairedArgs = repairToolArguments(name, parsed.arguments, cloak.argSchemas);
    if (repairedArgs !== parsed.arguments) {
     state.audit?.repair("arguments-repaired", name);
     parsed.arguments = repairedArgs;
     return emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
    }
   }
  }
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
export function cloakStreamResponsesObject(resp: unknown, cloak: StreamCloakOptions): void {
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
 * Resolve ONE chat tool_calls record to its tracked call, registering the
 * call on first sight.
 *
 * Keying mirrors the aggregate cloak (sseToChatCompletionJson): a record with
 * a non-empty id is keyed `id:<id>`; an id-less record joins whatever call
 * currently OWNS its index (`chatIndexOwner`, which id-bearing deltas
 * rebind), else the legacy `idx:<index>` bucket — so id-less parallel calls
 * sharing `index: 0` still merge into one fragment stream, exactly as
 * before. Host index = the call's first observed index unless that upstream
 * index is ALREADY CLAIMED by another tracked call (`chatIndexClaims`), in
 * which case the next fresh sequential index is handed out in arrival order.
 * The claim deliberately counts dropped calls too: the ticket rule is
 * "claimed by ANOTHER tracked call", and a dropped placeholder has already
 * moved the claim bookkeeping even though it emits nothing.
 */
export function chatTrackedCall(
 state: SseStreamCloakState,
 rec: Record<string, unknown>,
): { call: ChatTrackedCall; key: string; idx: number } {
 const idx = typeof rec.index === "number" ? rec.index : 0;
 if (idx + 1 > state.chatNextIndex) state.chatNextIndex = idx + 1;
 const id = typeof rec.id === "string" && rec.id !== "" ? rec.id : undefined;
 let key: string;
 if (id !== undefined) {
  key = chatCallIdKey(id);
  // Id-bearing deltas (re)bind the index owner; later id-less fragments
  // follow, and a real call reusing an injected placeholder's index takes
  // the connection over instead of inheriting its drop verdict.
  state.chatIndexOwner.set(idx, key);
 } else {
  key = state.chatIndexOwner.get(idx) ?? chatIndexKey(idx);
 }
 const known = state.chatCalls.get(key);
 if (known !== undefined) return { call: known, key, idx };
 // First sight: assign the host-visible index. A claimed upstream index
 // forces a fresh sequential index above every index seen or assigned so
 // far; the fresh index is itself claimed so a later real call keeps clear.
 const claim = state.chatIndexClaims.get(idx);
 let call: ChatTrackedCall;
 if (claim === undefined) {
  state.chatIndexClaims.set(idx, key);
  call = { dropped: false, name: undefined, buffered: false, args: "", hostIndex: idx, flushed: false };
 } else {
  call = { dropped: false, name: undefined, buffered: false, args: "", hostIndex: state.chatNextIndex++, flushed: false };
  state.chatIndexClaims.set(call.hostIndex, key);
  // Audit: two tracked calls claimed one upstream index; the host index was
  // re-homed sequentially so the wire stays well-formed.
  state.audit?.repair("parallel-index-collision", `idx:${idx}`);
 }
 state.chatCalls.set(key, call);
 return { call, key, idx };
}

/**
 * Point one EMITTED chat tool_call delta at its call's host index. The
 * rewrite must only ever fire in index-collision cases, so byte-identity
 * holds for every single-call stream: an unchanged index is left untouched,
 * and a record with NO index field (host-defaulted 0) only gains one when
 * the host index is not 0.
 */
export function chatRewriteDeltaIndex(rec: Record<string, unknown>, call: ChatTrackedCall): boolean {
 if (typeof rec.index === "number") {
  if (rec.index === call.hostIndex) return false;
  rec.index = call.hostIndex;
  return true;
 }
 if (call.hostIndex === 0) return false;
 rec.index = call.hostIndex;
 return true;
}

/**
 * Terminal chunk for chat choice: absorb any tool-call argument fragment
 * riding the finish_reason chunk into its call's buffered prefix, then
 * re-emit every buffered call's whole argument packet, repaired, at ITS host
 * index. Returns true if delta was mutated.
 *
 * Flush-entry id policy: entries keep today's exact shape
 * {index, type:"function", function:{name,arguments}} WITHOUT the call id.
 * Hosts assemble streamed tool_calls by index, and every delta of the call —
 * including the id-bearing name-delta — is emitted at the same rewritten
 * host index, so the host has already bound the id; the stable shape also
 * keeps the single-call flush byte-identical.
 */
export function flushChatTerminalToolCalls(
 d: Record<string, unknown>,
 state: SseStreamCloakState,
 cloak: StreamCloakOptions,
 flushedKeys: Set<string>,
 flushedEntries: Set<Record<string, unknown>>,
): boolean {
 let rewrote = false;

 for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
  if (!tc || typeof tc !== "object" || Array.isArray(tc)) continue;
  const rec = tc as Record<string, unknown>;
  const { call } = chatTrackedCall(state, rec);
  const fn = rec.function;
  const fnRec = fn && typeof fn === "object" && !Array.isArray(fn) ? (fn as Record<string, unknown>) : null;
  if (call.buffered && !call.flushed && fnRec && typeof fnRec.arguments === "string") {
   call.args += fnRec.arguments;
  }
 }

 const flushed: unknown[] = [];
 for (const [key, call] of state.chatCalls) {
  if (!call.buffered || call.flushed) continue;
  const name = call.name;
  if (name === undefined) continue;
  call.flushed = true;
  call.buffered = false;
  const args = call.args;
  call.args = "";
  flushedKeys.add(key);
  const repairedArgs = repairToolArguments(name, args, cloak.argSchemas);
  if (repairedArgs !== args) state.audit?.repair("arguments-repaired", name);
  const entry = { index: call.hostIndex, type: "function", function: { name, arguments: repairedArgs } };
  flushedEntries.add(entry);
  flushed.push(entry);
 }

 if (flushed.length === 0 && !rewrote) return false;

 // Records riding the finish chunk whose call was just flushed are removed
 // (their fragments were absorbed above); surviving records keep flowing but
 // are first pointed at their call's host index.
 const remaining = (Array.isArray(d.tool_calls) ? d.tool_calls : []).filter((tc) => {
  if (!tc || typeof tc !== "object" || Array.isArray(tc)) return true;
  const rec = tc as Record<string, unknown>;
  const { call, key } = chatTrackedCall(state, rec);
  if (flushedKeys.has(key)) return false;
  if (chatRewriteDeltaIndex(rec, call)) rewrote = true;
  return true;
 });
 d.tool_calls = [...remaining, ...flushed];
 return true;
}

/**
 * Rewrite one Chat Completions SSE block: drop injected delta.tool_calls
 * (including nameless continuations via per-call tracking), restore surviving
 * names, and keep host-visible indices true: collisions on one upstream
 * index (free models label every parallel call index 0) are rewritten to
 * distinct sequential indices while the call stays one call.
 * Tool-less callers lose all tool_calls with arguments folded to content,
 * mirroring the aggregate cloak. Null drops the block.
 */
export function rewriteChatBlock(
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
  if (cloak.normalizeReasoning && typeof d.reasoning === "string" && typeof d.reasoning_content !== "string") {
   d.reasoning_content = d.reasoning;
   changed = true;
   allDeltasEmpty = false;
  }
  // Terminal chunk for this choice: re-emit every buffered tool call's whole
  // argument packet, repaired, at its host index. The fragments never went
  // out, so this is the first and only time the client sees them. Runs
  // before the tool_calls branch because the terminal chunk usually carries
  // an empty delta. Call keys flushed on this block: their arguments are
  // final, so the per-delta loop below must not buffer them a second time.
  const flushedKeys = new Set<string>();
  const flushedEntries = new Set<Record<string, unknown>>();
  if (c.finish_reason && flushChatTerminalToolCalls(d, state, cloak, flushedKeys, flushedEntries)) {
   changed = true;
  }
  if (!Array.isArray(d.tool_calls)) {
   if (Object.keys(d).length > 0) allDeltasEmpty = false;
   continue;
  }
  const kept: unknown[] = [];
  let folded = "";
  for (const tc of d.tool_calls as unknown[]) {
   if (!tc || typeof tc !== "object" || Array.isArray(tc)) continue;
   // Flush entry rebuilt by the terminal flush above: pure passthrough.
   // These carry no id, so key resolution would misbind them to whichever
   // call currently owns the index — today's code skipped them the same way
   // via the index-keyed flushedIndices set.
   if (flushedEntries.has(tc as Record<string, unknown>)) {
    kept.push(tc);
    continue;
   }
   const rec = tc as Record<string, unknown>;
   const { call, key } = chatTrackedCall(state, rec);
   const fn = rec.function;
   const fnRec = fn && typeof fn === "object" && !Array.isArray(fn) ? (fn as Record<string, unknown>) : null;
   const name = fnRec && typeof fnRec.name === "string" && fnRec.name !== "" ? (fnRec.name as string) : "";
   if (!cloak.callerHadTools) {
    call.dropped = true;
    if (fnRec) {
     folded += (typeof fnRec.arguments === "string" && fnRec.arguments) || name;
    }
    changed = true;
    continue;
   }
   if (name !== "") {
    if (isInjectedName(name, cloak.injected)) {
     // The verdict is the CALL's, not the index's: a real id-bearing call
     // reusing this index rebinds the fragment owner (chatIndexOwner) and
     // inherits nothing.
     call.dropped = true;
     changed = true;
     continue;
    }
    const restored = restoreStreamName(name, cloak);
    // Fold this delta's name into the call's accumulated name: a name-only
    // delta is a fragment (append), a delta that ALSO carries arguments
    // restates the whole name (replace) — same rule as the aggregate cloak,
    // see accumulateToolCallName. When the restated name is the one the host
    // already holds, it is dropped from the wire instead of re-sent: the host
    // concatenates streamed name deltas, so a second copy would hand it
    // `get_weatherget_weather`.
    const previousName = call.name;
    const hasArgs = fnRec !== null && typeof fnRec.arguments === "string" && fnRec.arguments !== "";
    const toolName = accumulateToolCallName(previousName, restored, hasArgs);
    const nameRepeated = hasArgs && previousName !== undefined && toolName === previousName;
    call.name = toolName;
    if (nameRepeated && fnRec) {
     delete fnRec.name;
     changed = true;
     // Audit: the upstream restated a name the host already holds; the copy
     // was kept off the wire so the host does not concatenate it.
     state.audit?.repair("name-restated", toolName);
    } else if (restored !== name && fnRec) {
     fnRec.name = restored;
     changed = true;
    }
    call.dropped = false;
    if (isRepairableTool(toolName, cloak.argSchemas) && !call.flushed && !flushedKeys.has(key)) {
     // Hold this call's arguments: the packet is only judgeable once whole,
     // so it is re-emitted repaired on the terminal finish_reason chunk.
     // Reset-then-absorb mirrors the old per-index buffer exactly.
     if (!call.buffered) {
      state.audit?.repair("arguments-buffered", toolName);
      call.buffered = true;
      call.args = "";
     }
     if (fnRec && typeof fnRec.arguments === "string" && fnRec.arguments !== "") {
      call.args += fnRec.arguments;
      delete fnRec.arguments;
      changed = true;
     }
     if (nameRepeated && fnRec && Object.keys(fnRec).length === 0) {
      // Repeat header whose name and arguments both moved elsewhere: the
      // delta has nothing left to tell the host.
      continue;
     }
     kept.push(tc);
     if (chatRewriteDeltaIndex(rec, call)) changed = true;
     continue;
    }
    kept.push(tc);
    if (chatRewriteDeltaIndex(rec, call)) changed = true;
    continue;
   }
   // Nameless continuation (argument chunk): follows the CALL's verdict.
   if (call.dropped) {
    changed = true;
    continue;
   }
   if (call.buffered && fnRec && typeof fnRec.arguments === "string") {
    call.args += fnRec.arguments;
    delete fnRec.arguments;
    changed = true;
    continue;
   }
   kept.push(tc);
   if (chatRewriteDeltaIndex(rec, call)) changed = true;
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
 const hadEventPrefix = EVENT_PREFIX_RE.test(block);
 const { event } = splitSseBlock(block);
 return emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
}

/** Aggregate-cloak mirror for a Chat message: drop injected, restore kept. */
export function cloakStreamChatMessage(msg: unknown, cloak: StreamCloakOptions): void {
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
export function rewriteMessagesBlock(
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
 const hadEventPrefix = EVENT_PREFIX_RE.test(block);
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
    rec.name = restored;
    state.messagesNameByIndex.set(index, restored);
    if (isRepairableTool(restored, cloak.argSchemas)) {
     if (!state.messagesArgsByIndex.has(index)) state.audit?.repair("arguments-buffered", restored);
     state.messagesArgsByIndex.set(index, typeof rec.input === "string" ? rec.input : "");
    }
    return emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
   }
  }
  return block;
 }
 // Input deltas carry no name: the start verdict rules by index. Repairable
 // tools buffer their fragments, re-emitted whole on content_block_stop.
 if (type === "content_block_delta") {
  if (state.messagesDroppedByIndex.get(index) === true) return null;
  const delta = parsed.delta as Record<string, unknown> | undefined;
  if (state.messagesArgsByIndex.has(index) && delta && typeof delta.partial_json === "string") {
   state.messagesArgsByIndex.set(index, (state.messagesArgsByIndex.get(index) ?? "") + delta.partial_json);
   return null;
  }
  return block;
 }
 // Block close for a dropped tool_use carries no name: drop it too.
 if (type === "content_block_stop") {
  if (state.messagesDroppedByIndex.get(index) === true) {
   state.messagesDroppedByIndex.delete(index);
   return null;
  }
  const buffered = state.messagesArgsByIndex.get(index);
  if (buffered === undefined) return block;
  const name = state.messagesNameByIndex.get(index) ?? "";
  state.messagesArgsByIndex.delete(index);
  state.messagesNameByIndex.delete(index);
  const repaired = repairToolArguments(name, buffered, cloak.argSchemas);
  if (repaired !== buffered) state.audit?.repair("arguments-repaired", name);
  const flushed: Record<string, unknown> = {
   type: "content_block_delta",
   index,
   delta: { type: "input_json_delta", partial_json: repaired },
  };
  const stopBlock = emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
  return `${emitSseBlock("content_block_delta", JSON.stringify(flushed), true)}\n\n${stopBlock}`;
 }
 // A `message` frame carries a whole finished message mid-stream. It needs the
 // same treatment the aggregate path gives it — injected tool_use dropped,
 // caller names restored, inputs repaired — otherwise a placeholder call leaks
 // downstream and a malformed one reaches the host unrepaired. Any block still
 // buffering arguments is completed first so nothing is orphaned.
 if (type === "message") {
  const flushed = flushBufferedToolArgs(state, cloak);
  cloakMessagesContent(parsed.message ?? parsed, cloak.callerHadTools, cloak.caseRestore, cloak.findGlob, cloak.injected, cloak.argSchemas);
  if (flushed === null) return emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix);
  return `${flushed}${emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix)}`;
 }
 // A tool_use block still holding buffered arguments is completed HERE, while
 // its own event order is intact: `message_delta` / `message_stop` close the
 // message, so the recovered `input_json_delta` has to precede them. (An
 // end-of-stream flush would emit it after `message_stop`, where a strict
 // Anthropic client has already closed the message.)
 if (type === "message_delta" || type === "message_stop") {
  const flushed = flushBufferedToolArgs(state, cloak);
  if (flushed === null) return block;
  return `${flushed}${emitSseBlock(event, JSON.stringify(parsed), hadEventPrefix)}`;
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
