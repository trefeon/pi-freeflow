/**
 * Tool-call audit trail: a local JSONL record of tool-call turns that failed or
 * needed repair, so "why did the first attempt fail, and does this need a
 * remap?" stays answerable after the fact without replaying a session.
 *
 * PRIVACY: argument contents, message contents and prompts are never written —
 * only tool names, counts, byte lengths, finish reasons and repair kinds.
 * Everything is best-effort: an audit write must never break a request.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveToolcallAuditPath } from "./config.ts";

export type ToolcallWire = "chat" | "responses" | "messages";
export type ToolcallFailure =
 | "no_tool_calls"
 | "unknown_tool_name"
 | "malformed_arguments"
 | "empty_arguments";
/** "unknown" is reserved for callers that cannot classify a turn at all. */
export type ToolcallRemap = "none" | "tool-name" | "model" | "unknown";

export interface ToolcallCall {
 name: string;
 argsBytes: number;
 argsValid: boolean;
 known: boolean;
}

export interface ToolcallRepairSink {
 /** `kind` is a stable label; `detail` must stay non-content (no arguments/prompts). */
 repair(kind: string, detail?: string): void;
}

export interface ToolcallStreamAudit extends ToolcallRepairSink {
 /** Feed one complete SSE block; may contain several `data:` lines. */
 observe(blockText: string): void;
 refireSkipped(): void;
 /**
  * Idempotent: the first call wins. `terminal` defaults to whether a terminal
  * SSE event was actually observed, so a cut stream reads as terminal: false.
  */
 finish(info?: { finishReason?: string | null; terminal?: boolean; unclassifiable?: boolean }): void;
}

export interface ToolcallRecorder extends ToolcallStreamAudit {
 /** False when declaredNames is empty: every method is a no-op and nothing is written. */
 readonly active: boolean;
 attemptFailure(info: { attempt: number; status?: number; reason: string }): void;
 /** Non-stream path: classify an already-assembled chat message. */
 finishFromChat(message: { tool_calls?: unknown }, finishReason?: string | null): void;
}

export interface ToolcallRecorderOptions {
 reqId: string;
 model: string;
 lane: string;
 wire: ToolcallWire;
 stream: boolean;
 declaredNames: readonly string[];
 conversationSeed?: unknown;
 file?: string;
 now?: () => number;
 maxBytes?: number;
}

const MAX_NAME = 64;
const MAX_TEXT = 300;
const MAX_DECLARED = 32;
const MAX_CALLS = 32;
const MAX_ATTEMPT_EVENTS = 32;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
// Arguments are bounded twice: per call (a real tool argument this large is
// already pathological) and per turn across all calls, so a hostile upstream
// cannot grow the recorder by emitting many distinct call ids. `bytes` always
// reports the true payload size; only the retained copy is capped.
const MAX_ARGS_CHARS = 256 * 1024;
const MAX_TURN_ARGS_CHARS = 8 * 1024 * 1024;
const RETRY_TTL_MS = 10 * 60_000;
const RETRY_CACHE_MAX = 256;

interface RetryEntry {
 reqId: string;
 ts: number;
 outcome: "ok" | "failed" | "pending" | "unknown";
 failures: ToolcallFailure[];
 attempt: number;
 repairs: string[];
}

/** Insertion-ordered: a refreshed key moves to the end and eviction takes the head. */
const retryCache = new Map<string, RetryEntry>();

interface CallAcc {
 index: number;
 /** Upstream id (chat `id`, responses item id, messages tool_use id). */
 id: string;
 name: string;
 /** Accumulated arguments, bounded; `bytes` is the unbounded payload size. */
 args: string;
 bytes: number;
}

interface StreamState {
 calls: CallAcc[];
 finishReason: string | null;
 terminalSeen: boolean;
 /** Retained argument characters across every call this turn. */
 argsChars: number;
}

function clip(value: unknown, max: number = MAX_TEXT): string {
 if (typeof value !== "string") return "";
 return value.length > max ? value.slice(0, max) : value;
}

function isArgsObject(args: string): boolean {
 if (args === "") return false;
 try {
  const parsed: unknown = JSON.parse(args);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
 } catch {
  return false;
 }
}

/**
 * Classify one turn's calls. `known` is exact-case membership in the declared
 * tool set, so a case-only drift surfaces both as `known: false` and as
 * `unknown_tool_name` — the host rejects a case-mismatched name, and repairing
 * it is a tool-name remap, not a different model.
 */
export function classifyToolcalls(
 calls: readonly ToolcallCall[],
 finishReason: string | null | undefined,
): { failures: ToolcallFailure[]; remap: ToolcallRemap } {
 // Reserved: truncated turns ("length") classify like any other, but callers
 // keep passing the reason so a later rule can distinguish them.
 void finishReason;
 const failures: ToolcallFailure[] = [];
 const add = (failure: ToolcallFailure): void => {
  if (!failures.includes(failure)) failures.push(failure);
 };
 if (calls.length === 0) add("no_tool_calls");
 for (const call of calls) {
  if (call.name === "" || !call.known) add("unknown_tool_name");
  if (call.argsBytes === 0) add("empty_arguments");
  else if (!call.argsValid) add("malformed_arguments");
 }
 let remap: ToolcallRemap = "none";
 if (failures.includes("unknown_tool_name")) remap = "tool-name";
 else if (failures.length > 0) remap = "model";
 return { failures, remap };
}

function newCall(index: number, id: string): CallAcc {
 return { index, id, name: "", args: "", bytes: 0 };
}

/**
 * Chat/messages identity is the block index, but a gateway can emit two
 * parallel calls that both claim index 0 while carrying distinct ids — treat a
 * differing id at the same index as a separate call instead of merging them.
 */
function findByIndex(calls: CallAcc[], index: number, id: string): CallAcc | null {
 for (let i = calls.length - 1; i >= 0; i--) {
  const call = calls[i];
  if (call.index !== index) continue;
  if (id !== "" && call.id !== "" && call.id !== id) continue;
  return call;
 }
 return null;
}

function findById(calls: CallAcc[], id: string): CallAcc | null {
 if (id === "") return null;
 for (let i = calls.length - 1; i >= 0; i--) {
  if (calls[i].id === id) return calls[i];
 }
 return null;
}

function appendArgs(state: StreamState, call: CallAcc, chunk: string): void {
 if (chunk === "") return;
 call.bytes += Buffer.byteLength(chunk, "utf8");
 const room = Math.min(
  MAX_ARGS_CHARS - call.args.length,
  MAX_TURN_ARGS_CHARS - state.argsChars,
 );
 if (room <= 0) return;
 const take = chunk.length > room ? chunk.slice(0, room) : chunk;
 call.args += take;
 state.argsChars += take.length;
}

/** Whole-argument frame (Responses `arguments.done`, `output_item.done`). */
function setArgs(state: StreamState, call: CallAcc, args: string): void {
 call.bytes = Buffer.byteLength(args, "utf8");
 state.argsChars -= call.args.length;
 const room = Math.max(
  0,
  Math.min(MAX_ARGS_CHARS, MAX_TURN_ARGS_CHARS - state.argsChars),
 );
 const take = args.length > room ? args.slice(0, room) : args;
 call.args = take;
 state.argsChars += take.length;
}

/** Register one call unless the per-turn call budget is already spent. */
function pushCall(state: StreamState, index: number, id: string): CallAcc | null {
 if (state.calls.length >= MAX_CALLS) return null;
 const call = newCall(index, id);
 state.calls.push(call);
 return call;
}

function asRecord(value: unknown): Record<string, unknown> | null {
 return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function observeChat(evt: Record<string, unknown>, state: StreamState): void {
 const choices = evt["choices"];
 if (!Array.isArray(choices) || choices.length === 0) return;
 const choice = asRecord(choices[0]);
 if (!choice) return;
 const finish = choice["finish_reason"];
 if (typeof finish === "string" && finish !== "") {
  state.finishReason = finish;
  state.terminalSeen = true;
 }
 const delta = asRecord(choice["delta"]) ?? asRecord(choice["message"]);
 if (!delta) return;
 const tcs = delta["tool_calls"];
 if (!Array.isArray(tcs)) return;
 for (const raw of tcs) {
  const tc = asRecord(raw);
  if (!tc) continue;
  const index = typeof tc["index"] === "number" ? tc["index"] : state.calls.length;
  const id = clip(tc["id"], MAX_TEXT);
  const fn = asRecord(tc["function"]);
  const name = typeof fn?.["name"] === "string" ? (fn["name"] as string) : "";
  const args = typeof fn?.["arguments"] === "string" ? (fn["arguments"] as string) : "";
  let call = findByIndex(state.calls, index, id);
  if (!call) {
   call = pushCall(state, index, id);
   if (!call) continue;
  } else if (call.id === "" && id !== "") {
   call.id = id;
  }
  if (name !== "") {
   // Name fragments append — except the duplicated-name upstream defect, where a
   // frame carries arguments together with the whole name and would otherwise
   // glue "read" onto "read".
   call.name = args === "" ? call.name + name : name;
  }
  if (args !== "") appendArgs(state, call, args);
 }
}

function observeResponses(evt: Record<string, unknown>, state: StreamState): void {
 const type = typeof evt["type"] === "string" ? (evt["type"] as string) : "";
 if (type === "response.output_item.added" || type === "response.output_item.done") {
  const item = asRecord(evt["item"]);
  if (!item || item["type"] !== "function_call") return;
  const id = item["id"] !== undefined ? clip(item["id"], MAX_TEXT) : clip(item["call_id"], MAX_TEXT);
  let call = findById(state.calls, id);
  if (!call) {
   call = pushCall(state, state.calls.length, id);
   if (!call) return;
  }
  const name = clip(item["name"], MAX_TEXT);
  if (name !== "") call.name = name;
  // The id is re-announced with the whole argument string; setArgs keeps a later
  // `.done` idempotent against the deltas already accumulated.
  if (typeof item["arguments"] === "string" && item["arguments"] !== "") {
   setArgs(state, call, item["arguments"] as string);
  }
  return;
 }
 if (type === "response.function_call_arguments.delta") {
  const id = clip(evt["item_id"], MAX_TEXT);
  let call = findById(state.calls, id);
  if (!call) {
   call = pushCall(state, state.calls.length, id);
   if (!call) return;
  }
  if (typeof evt["delta"] === "string") appendArgs(state, call, evt["delta"] as string);
  return;
 }
 if (type === "response.function_call_arguments.done") {
  const id = clip(evt["item_id"], MAX_TEXT);
  let call = findById(state.calls, id);
  if (!call) {
   call = pushCall(state, state.calls.length, id);
   if (!call) return;
  }
  if (typeof evt["arguments"] === "string") setArgs(state, call, evt["arguments"] as string);
  return;
 }
 if (
  type === "response.completed" ||
  type === "response.incomplete" ||
  type === "response.failed"
 ) {
  const response = asRecord(evt["response"]);
  const status = clip(response?.["status"], MAX_TEXT);
  state.finishReason = status !== "" ? status : type.slice("response.".length);
  state.terminalSeen = true;
 }
}

function observeMessages(evt: Record<string, unknown>, state: StreamState): void {
 const type = typeof evt["type"] === "string" ? (evt["type"] as string) : "";
 const index = typeof evt["index"] === "number" ? (evt["index"] as number) : state.calls.length;
 if (type === "content_block_start") {
  const block = asRecord(evt["content_block"]);
  if (!block || block["type"] !== "tool_use") return;
  const id = clip(block["id"], MAX_TEXT);
  let call = findByIndex(state.calls, index, id);
  if (!call) {
   call = pushCall(state, index, id);
   if (!call) return;
  }
  const name = clip(block["name"], MAX_TEXT);
  if (name !== "") call.name = name;
  return;
 }
 if (type === "content_block_delta") {
  const delta = asRecord(evt["delta"]);
  if (!delta || delta["type"] !== "input_json_delta") return;
  let call = findByIndex(state.calls, index, "");
  if (!call) {
   call = pushCall(state, index, "");
   if (!call) return;
  }
  if (typeof delta["partial_json"] === "string") {
   appendArgs(state, call, delta["partial_json"] as string);
  }
  return;
 }
 if (type === "message_delta") {
  const delta = asRecord(evt["delta"]);
  const stop = clip(delta?.["stop_reason"], MAX_TEXT);
  if (stop !== "") {
   state.finishReason = stop;
   state.terminalSeen = true;
  }
 }
}

/**
 * Create the audit recorder for one turn. Other modules observe SSE blocks,
 * report repairs and call finish() once; this module owns all of the
 * interpretation, bounding and persistence.
 */
export function createToolcallRecorder(opts: ToolcallRecorderOptions): ToolcallRecorder {
 const active = opts.declaredNames.length > 0;
 const now = opts.now ?? Date.now;
 const maxBytes =
  typeof opts.maxBytes === "number" && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
 const declaredExact = new Set(opts.declaredNames);
 const declaredSummary = opts.declaredNames.slice(0, MAX_DECLARED).map((name) => clip(name, MAX_NAME));
 const state: StreamState = { calls: [], finishReason: null, terminalSeen: false, argsChars: 0 };
 const repairs: Array<{ kind: string; detail?: string }> = [];
 const seedKey =
  !active || opts.conversationSeed === undefined ? "" : seedOf(opts.conversationSeed);
 const createdAt = now();
 const priorEntry = seedKey === "" ? undefined : retryCache.get(seedKey);
 const prior =
  priorEntry && createdAt - priorEntry.ts >= 0 && createdAt - priorEntry.ts < RETRY_TTL_MS
   ? priorEntry
   : undefined;
 const attempt = prior ? prior.attempt + 1 : 1;
 const retryOf = prior ? prior.reqId : null;
 // Register the in-flight turn so a host re-send that races this turn's
 // teardown still chains to it instead of starting a second attempt 1.
 if (seedKey !== "") {
  retryCache.delete(seedKey);
  retryCache.set(seedKey, {
   reqId: clip(opts.reqId, MAX_TEXT),
   ts: createdAt,
   outcome: "pending",
   failures: [],
   attempt,
   repairs: [],
  });
  while (retryCache.size > RETRY_CACHE_MAX) {
   const oldest = retryCache.keys().next();
   if (oldest.done) break;
   retryCache.delete(oldest.value);
  }
 }
 let refireSkip = false;
 let attemptEvents = 0;
 let finished = false;

 const append = (event: Record<string, unknown>): void => {
  try {
   const target = opts.file ?? resolveToolcallAuditPath();
   try {
    if (fs.statSync(target).size > maxBytes) fs.renameSync(target, `${target}.1`);
   } catch {
    // Missing file or a locked rename: the append is still worth doing.
   }
   fs.mkdirSync(path.dirname(target), { recursive: true });
   fs.appendFileSync(target, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
   // Audit is best-effort by contract.
  }
 };

 const complete = (
  finishReason: string | null,
  terminal: boolean,
  unclassifiable = false,
 ): void => {
  if (finished) return;
  finished = true;
  const calls = state.calls.slice(0, MAX_CALLS).map((call) => ({
   name: clip(call.name, MAX_NAME),
   argsBytes: call.bytes,
   argsValid: isArgsObject(call.args),
   known: declaredExact.has(call.name),
  }));
  // A body that never carried an event stream says nothing about the model:
  // report it as unknown instead of accusing it of answering without tools.
  const classified = unclassifiable
   ? { failures: [] as ToolcallFailure[], remap: "unknown" as const }
   : classifyToolcalls(calls, finishReason);
  append({
   ts: now(),
   kind: "summary",
   reqId: clip(opts.reqId, MAX_TEXT),
   model: clip(opts.model, MAX_TEXT),
   lane: clip(opts.lane, MAX_TEXT),
   wire: opts.wire,
   stream: opts.stream,
   attempt,
   retryOf,
   declared: declaredSummary,
   calls,
   finishReason: finishReason === null ? null : clip(finishReason, MAX_TEXT),
   terminal,
   refireSkipped: refireSkip,
   repairs: repairs.slice(),
   failures: classified.failures,
   remap: classified.remap,
  });
  if (seedKey !== "") {
   const current = retryCache.get(seedKey);
   // An earlier turn may finish after its own host re-send already chained;
   // never let it overwrite the newer attempt's record.
   if (current === undefined || attempt >= current.attempt) {
    retryCache.delete(seedKey);
    retryCache.set(seedKey, {
     reqId: clip(opts.reqId, MAX_TEXT),
     ts: now(),
     outcome: unclassifiable
      ? "unknown"
      : classified.failures.length === 0
        ? "ok"
        : "failed",
     failures: classified.failures,
     attempt,
     repairs: repairs.map((repair) => repair.kind),
    });
   }
   while (retryCache.size > RETRY_CACHE_MAX) {
    const oldest = retryCache.keys().next();
    if (oldest.done) break;
    retryCache.delete(oldest.value);
   }
  }
 };

 if (active && prior) {
  append({
   ts: createdAt,
   kind: "retry-detected",
   reqId: clip(opts.reqId, MAX_TEXT),
   model: clip(opts.model, MAX_TEXT),
   lane: clip(opts.lane, MAX_TEXT),
   attempt,
   retryOf,
   firstOutcome: prior.outcome,
   firstFailures: prior.failures.slice(),
   firstRepairs: prior.repairs.slice(),
  });
 }

 return {
  active,
  observe(blockText: string): void {
   if (!active) return;
   const text = typeof blockText === "string" ? blockText : "";
   for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let evt: Record<string, unknown> | null;
    try {
     evt = asRecord(JSON.parse(payload));
    } catch {
     continue;
    }
    if (!evt) continue;
    if (opts.wire === "chat") observeChat(evt, state);
    else if (opts.wire === "responses") observeResponses(evt, state);
    else observeMessages(evt, state);
   }
  },
  repair(kind: string, detail?: string): void {
   if (!active) return;
   const key = clip(kind, MAX_NAME);
   if (key === "" || repairs.some((repair) => repair.kind === key)) return;
   const entry: { kind: string; detail?: string } = { kind: key };
   const bounded = clip(detail, MAX_NAME);
   if (bounded !== "") entry.detail = bounded;
   repairs.push(entry);
  },
  refireSkipped(): void {
   if (!active) return;
   refireSkip = true;
  },
  finish(info?: { finishReason?: string | null; terminal?: boolean; unclassifiable?: boolean }): void {
   if (!active) return;
   complete(
    info && info.finishReason !== undefined ? info.finishReason : state.finishReason,
    info && info.terminal !== undefined ? info.terminal : state.terminalSeen,
    info?.unclassifiable === true,
   );
  },
  attemptFailure(info: { attempt: number; status?: number; reason: string }): void {
   if (!active || attemptEvents >= MAX_ATTEMPT_EVENTS) return;
   attemptEvents++;
   const event: Record<string, unknown> = {
    ts: now(),
    kind: "attempt-failure",
    reqId: clip(opts.reqId, MAX_TEXT),
    model: clip(opts.model, MAX_TEXT),
    lane: clip(opts.lane, MAX_TEXT),
    attempt: typeof info?.attempt === "number" ? info.attempt : attempt,
    reason: clip(info?.reason, MAX_TEXT),
   };
   if (typeof info?.status === "number") event["status"] = info.status;
   append(event);
  },
  finishFromChat(message: { tool_calls?: unknown }, finishReason?: string | null): void {
   if (!active || finished) return;
   const tcs = message?.tool_calls;
   if (Array.isArray(tcs)) {
    for (const raw of tcs) {
     const tc = asRecord(raw);
     if (!tc) continue;
     const fn = asRecord(tc["function"]);
     const call = pushCall(state, state.calls.length, clip(tc["id"], MAX_TEXT));
     if (!call) break;
     call.name = clip(fn?.["name"], MAX_NAME);
     setArgs(state, call, typeof fn?.["arguments"] === "string" ? (fn["arguments"] as string) : "");
    }
   }
   const reason = finishReason !== undefined ? finishReason : state.finishReason;
   complete(reason, reason !== null && reason !== "" ? true : state.terminalSeen);
  },
 };
}

/** Conversation key for retry correlation: first 16 hex of sha256(seed). */
function seedOf(seed: unknown): string {
 try {
  const json = JSON.stringify(seed);
  if (json === undefined) return "";
  return createHash("sha256").update(json, "utf8").digest("hex").slice(0, 16);
 } catch {
  return "";
 }
}
