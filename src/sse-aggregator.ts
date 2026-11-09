/**
 * SSE stream aggregator and response cloaking for OpenCode Zen free tier.
 *
 * Converts streaming responses (Chat Completions, Responses, Messages) into
 * single non-streaming JSON responses, cloaking injected placeholder tools and
 * restoring caller names and repairing schema arguments.
 */

import { type CaseRestoreMap, restoreCallerName } from "./fingerprint-tools.ts";
import type { FindGlobRestore } from "./tool-translation.ts";
import { repairToolArguments, repairToolArgumentsValue } from "./tool-args.ts";

/**
 * SSE field line at a line start (`data:`/`event:`), CRLF-tolerant. One source
 * of truth for every "is this actually an event stream?" decision: the body
 * gate in src/stream-pipe.ts, the proxy's aggregate gates, and
 * convertSseToJson's own guard.
 *
 * A substring test is not enough. A plain-JSON 200 whose text merely CONTAINS
 * `data:` — a bash command mentioning `metadata:`, a base64 `data:image/png`
 * blob, `multipart/form-data:` — used to be fed to the SSE aggregator and
 * replaced by an empty synthesized completion (content null, tool calls gone,
 * HTTP 200). Line anchoring keeps such bodies byte-identical. Lives here
 * rather than next to stream-pipe's former SSE_START_RE because that module
 * already imports this one: exporting it from there would close an import
 * cycle.
 */
export const SSE_FIELD_LINE_RE = /^(data|event):/m;

const SSE_BLOCK_SPLIT_RE = /\r?\n\r?\n/;
const SSE_LINE_SPLIT_RE = /\r?\n/;

/** True when `text` carries a real SSE field line at a line start. */
export function looksLikeSse(text: string): boolean {
 return text.length > 0 && SSE_FIELD_LINE_RE.test(text);
}

/**
 * Parse raw SSE stream text into individual event blocks.
 */
export function parseSseEvents(text: string): Array<{ event?: string; data: string }> {
 const result: Array<{ event?: string; data: string }> = [];
 const blocks = text.split(SSE_BLOCK_SPLIT_RE);
 for (const block of blocks) {
  const trimmed = block.trim();
  if (!trimmed) continue;
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of trimmed.split(SSE_LINE_SPLIT_RE)) {
   if (line.startsWith("event:")) {
    eventName = line.slice(6).trim();
   } else if (line.startsWith("data:")) {
    dataLines.push(line.slice(5).trimStart());
   }
  }
  if (dataLines.length > 0) {
   result.push({ event: eventName, data: dataLines.join("\n") });
  }
 }
 return result;
}

/** Tool-call name from a Chat Completions tool_calls entry (else ""). */
export function chatCallName(tc: unknown): string {
 if (!tc || typeof tc !== "object" || Array.isArray(tc)) return "";
 const fn = (tc as Record<string, unknown>).function;
 if (!fn || typeof fn !== "object" || Array.isArray(fn)) return "";
 const n = (fn as Record<string, unknown>).name;
 return typeof n === "string" ? n : "";
}

/**
 * Strip injected placeholder calls from a Chat Completions message in place.
 * Tool-less callers never see tool_calls (args folded to text when content is
 * empty); callers with tools keep only their own calls, casing restored.
 *
 * Only names this request actually injected are ever cloaked downstream. The
 * caller's own bash is indistinguishable by name and must survive; legacy
 * direct calls (no record) keep everything.
 */
export function cloakChatMessage(
 msg: unknown,
 callerHadTools: boolean,
 caseRestore?: CaseRestoreMap,
 findGlob?: FindGlobRestore,
 injected?: readonly string[],
 argSchemas?: ReadonlyMap<string, Record<string, unknown>>,
): void {
 if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
 const m = msg as Record<string, unknown>;
 if (!Array.isArray(m.tool_calls)) return;
 const calls = m.tool_calls as unknown[];
 if (!callerHadTools) {
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
  const callName = chatCallName(tc);
  if (callName && injected !== undefined && injected.includes(callName.toLowerCase())) continue;
  if (tc && typeof tc === "object" && !Array.isArray(tc)) {
   const fn = (tc as Record<string, unknown>).function;
   if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === "string") {
    const f = fn as Record<string, unknown>;
    f.name = restoreCallerName(f.name as string, caseRestore, findGlob);
    f.arguments = repairToolArguments(f.name as string, typeof f.arguments === "string" ? f.arguments : "", argSchemas);
   }
  }
  kept.push(tc);
 }
 if (kept.length > 0) m.tool_calls = kept;
 else delete m.tool_calls;
}

/**
 * Fold one streamed `function.name` delta into the accumulated tool name.
 *
 * Providers stream names in two legitimate shapes, and the difference is the
 * presence of arguments on the same delta:
 *
 * - **Fragment** (`name`, no `arguments`): the ordinary piecewise stream — the
 *   delta carries the next slice of the name, so append it.
 * - **Repeat header** (`name` AND `arguments`): OpenCode Zen restates the
 *   WHOLE name on the frame that opens the arguments (observed live
 *   2026-10-22: `name:"get_weather"` alone, then `name:"get_weather",
 *   arguments:"{…}"`). The name there is authoritative, so replace instead of
 *   appending — appending produced `get_weatherget_weather`, a tool name no
 *   tool declaration matches. A full mid-stream restatement is the same shape.
 *
 * Shared by both aggregators (the non-streamed completion cloak and the
 * streaming cloak) so streamed and aggregated output always agree.
 */
export function accumulateToolCallName(
 previous: string | undefined,
 delta: string,
 carriesArguments: boolean,
): string {
 return carriesArguments ? delta : `${previous ?? ""}${delta}`;
}

export function sseToChatCompletionJson(
 sseText: string,
 callerHadTools = true,
 caseRestore?: CaseRestoreMap,
 findGlob?: FindGlobRestore,
 injected?: readonly string[],
 argSchemas?: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
 const events = parseSseEvents(sseText);
 let id = "chatcmpl-freeflow";
 let model = "";
 let created = Math.floor(Date.now() / 1000);
 let finishReason: string | null = null;
 let content = "";
 let reasoningContent = "";
 let role = "assistant";
 let usage: unknown = undefined;
 // Keyed by tool-call id whenever the provider sends one. Index is NOT
 // trustworthy: free models routinely label every parallel call `index: 0`,
 // and merging their fragments produces one unparseable argument blob
 // (observed live: `{"i":"a","op":"done"}{"i":"b","op":"done"}`). Index is
 // only the fallback for providers that omit an id entirely.
 const toolCallsMap = new Map<
  string,
  { id: string; type: string; function: { name: string; arguments: string } }
 >();
 const keyByIndex = new Map<number, string>();

 for (const ev of events) {
  if (ev.data === "[DONE]") continue;
  try {
   const parsed = JSON.parse(ev.data);
   if (parsed.id) id = parsed.id;
   if (parsed.model) model = parsed.model;
   if (parsed.created) created = parsed.created;
   if (parsed.usage) usage = parsed.usage;
   if (Array.isArray(parsed.choices)) {
    for (const c of parsed.choices) {
     if (c.finish_reason) finishReason = c.finish_reason;
     const delta = c.delta;
     if (delta) {
      if (delta.role) role = delta.role;
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") {
       reasoningContent += delta.reasoning_content;
      } else if (typeof delta.reasoning === "string") {
       reasoningContent += delta.reasoning;
      }
      if (Array.isArray(delta.tool_calls)) {
       for (const tc of delta.tool_calls) {
        // The first delta of a call carries its id; later deltas carry only
        // `arguments`. A later id-less delta therefore belongs to whatever
        // call this index already opened.
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const hasId = typeof tc.id === "string" && tc.id !== "";
        let key = hasId ? `id:${tc.id}` : keyByIndex.get(idx);
        if (key === undefined) key = `idx:${idx}`;
        if (hasId) keyByIndex.set(idx, key);
        const existing = toolCallsMap.get(key) ?? {
         id: tc.id || "",
         type: tc.type || "function",
         function: { name: "", arguments: "" },
        };
        if (tc.id) existing.id = tc.id;
        if (tc.type) existing.type = tc.type;
        if (tc.function?.name) {
         // See accumulateToolCallName: a name on an arguments-carrying delta
         // is the whole name restated, not another fragment.
         existing.function.name = accumulateToolCallName(
          existing.function.name,
          tc.function.name,
          typeof tc.function.arguments === "string" && tc.function.arguments !== "",
         );
        }
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        toolCallsMap.set(key, existing);
       }
      }
     }
     // Choice contains a pre-assembled message: cloak before returning.
     if (c.message) {
      cloakChatMessage(c.message, callerHadTools, caseRestore, findGlob, injected, argSchemas);
      return parsed as Record<string, unknown>;
     }
    }
   }
  } catch {
   // ignore unparseable data chunks
  }
 }

 // Map insertion order is emission order, which is what the host expects. The
 // previous numeric sort assumed the keys were indices; they are now ids.
 const toolCalls = Array.from(toolCallsMap.values());

 const message: Record<string, unknown> = {
  role,
  content: content || null,
 };
 if (reasoningContent) {
  message.reasoning_content = reasoningContent;
 }
 if (!callerHadTools) {
  if (!content && toolCalls.length > 0) {
   message.content = toolCalls.map((tc) => tc.function.arguments || tc.function.name).join("\n");
  }
 } else {
  const kept = injected === undefined
   ? toolCalls
   : toolCalls.filter((tc) => !injected.includes(tc.function.name.toLowerCase()));
  for (const tc of kept) {
   tc.function.name = restoreCallerName(tc.function.name, caseRestore, findGlob);
   tc.function.arguments = repairToolArguments(tc.function.name, tc.function.arguments, argSchemas);
  }
  if (kept.length > 0) message.tool_calls = kept;
 }

 return {
  id,
  object: "chat.completion",
  created,
  model,
  choices: [
   {
    index: 0,
    message,
    finish_reason: finishReason ?? "stop",
   },
  ],
  ...(usage ? { usage } : {}),
 };
}

/**
 * Strip injected placeholder function_call items from a Responses object in
 * place. Only names this request injected are removed; caller calls keep
 * restored names (caller casing, upstream glob back to caller find). Tool-less
 * callers never see function_call items: every call is dropped, never leaked.
 * Ids ride verbatim; arguments are repaired against the caller's declared
 * schema when it says the emitted shape cannot be right.
 */
export function cloakResponsesObject(
 resp: unknown,
 callerHadTools = true,
 caseRestore?: CaseRestoreMap,
 findGlob?: FindGlobRestore,
 injected?: readonly string[],
 argSchemas?: ReadonlyMap<string, Record<string, unknown>>,
): void {
 if (!resp || typeof resp !== "object" || Array.isArray(resp)) return;
 const output = (resp as Record<string, unknown>).output;
 if (!Array.isArray(output)) return;
 const kept: unknown[] = [];
 for (const item of output) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
   const rec = item as Record<string, unknown>;
   if (rec.type === "function_call") {
    if (typeof rec.name === "string" && injected !== undefined && injected.includes(rec.name.toLowerCase())) continue;
    if (!callerHadTools) continue;
    if (typeof rec.name === "string") {
     const name = restoreCallerName(rec.name, caseRestore, findGlob);
     rec.name = name;
     rec.arguments = repairToolArguments(name, typeof rec.arguments === "string" ? rec.arguments : "", argSchemas);
    }
   }
  }
  kept.push(item);
 }
 (resp as Record<string, unknown>).output = kept;
}

/**
 * Convert an SSE stream from an OpenAI Responses API endpoint into a single
 * standard non-streaming response object.
 */
export function sseToResponsesJson(
 sseText: string,
 callerHadTools = true,
 caseRestore?: CaseRestoreMap,
 findGlob?: FindGlobRestore,
 injected?: readonly string[],
 argSchemas?: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
 const events = parseSseEvents(sseText);
 // 1. Highest fidelity: response.completed event carries the final full response object
 for (let i = events.length - 1; i >= 0; i--) {
  const ev = events[i];
  try {
   const parsed = JSON.parse(ev.data);
   if (parsed?.type === "response.completed" && parsed.response && typeof parsed.response === "object") {
    cloakResponsesObject(parsed.response, callerHadTools, caseRestore, findGlob, injected, argSchemas);
    return parsed.response as Record<string, unknown>;
   }
  } catch { }
 }
 // 2. Secondary fallback: check any event with a response object
 for (let i = events.length - 1; i >= 0; i--) {
  const ev = events[i];
  try {
   const parsed = JSON.parse(ev.data);
   if (parsed?.type === "response.created" || parsed?.type === "response.in_progress") continue;
   if (parsed?.response && typeof parsed.response === "object") {
    cloakResponsesObject(parsed.response, callerHadTools, caseRestore, findGlob, injected, argSchemas);
    return parsed.response as Record<string, unknown>;
   }
  } catch { }
 }
 // 3. Fallback: parse entire string directly if upstream already returned JSON
 try {
  const parsed = JSON.parse(sseText);
  if (parsed && typeof parsed === "object") {
   cloakResponsesObject(parsed, callerHadTools, caseRestore, findGlob, injected, argSchemas);
   return parsed;
  }
 } catch { }

 // Nothing in the stream carried a response object: the upstream turn ended
 // without one. Report that honestly — a `completed` answer with zero output
 // reads to the host as "the model chose to say nothing", which is a
 // different (and wrong) claim than "the stream was cut".
 return {
  id: "resp_fallback",
  object: "response",
  status: "incomplete",
  output: [],
 };
}

/**
 * Drop placeholder tool_use blocks from a complete Anthropic message in place.
 * Only names this request injected are removed; caller blocks keep restored
 * names (caller casing, upstream glob back to caller find). Tool-less callers
 * never see tool_use: stray placeholder input folds to text, matching the
 * SSE aggregator fallback below. Ids ride verbatim; `input` is repaired
 * against the caller's declared schema when the emitted shape cannot be right.
 *
 * Exported so the streaming cloak applies these identical rules to a `message`
 * frame that arrives mid-stream, instead of forwarding it verbatim.
 */
export function cloakMessagesContent(
 msg: unknown,
 callerHadTools: boolean,
 caseRestore?: CaseRestoreMap,
 findGlob?: FindGlobRestore,
 injected?: readonly string[],
 argSchemas?: ReadonlyMap<string, Record<string, unknown>>,
): void {
 if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
 const content = (msg as Record<string, unknown>).content;
 if (!Array.isArray(content)) return;
 const kept: unknown[] = [];
 const folded: string[] = [];
 for (const block of content) {
  if (
   block &&
   typeof block === "object" &&
   !Array.isArray(block) &&
   (block as Record<string, unknown>).type === "tool_use"
  ) {
   const rec = block as Record<string, unknown>;
   const isInjected = typeof rec.name === "string" && injected !== undefined && injected.includes(rec.name.toLowerCase());
   if (callerHadTools && !isInjected) {
    if (typeof rec.name === "string") {
     const name = restoreCallerName(rec.name, caseRestore, findGlob);
     rec.name = name;
     rec.input = repairToolArgumentsValue(name, rec.input, argSchemas);
    }
    kept.push(block);
   } else if (!callerHadTools) {
    let text = "";
    if (typeof rec.input === "string") text = rec.input;
    else if (rec.input !== null && typeof rec.input === "object") {
     try {
      text = JSON.stringify(rec.input);
     } catch {
      text = "";
     }
    }
    folded.push(text || (typeof rec.name === "string" ? rec.name : ""));
   }
   continue;
  }
  kept.push(block);
 }
 if (!callerHadTools && kept.every((b) => !(b && typeof b === "object" && !Array.isArray(b) && (b as Record<string, unknown>).type === "text"))) {
  const fallback = folded.filter(Boolean).join("\n");
  if (fallback) kept.push({ type: "text", text: fallback });
 }
 (msg as Record<string, unknown>).content = kept;
}

/**
 * Convert an SSE stream from an Anthropic Messages endpoint into a single
 * standard non-streaming message object. Aggregates content_block deltas
 * (text + tool_use input_json) into content blocks.
 */
export function sseToMessagesJson(
 sseText: string,
 callerHadTools = true,
 caseRestore?: CaseRestoreMap,
 findGlob?: FindGlobRestore,
 injected?: readonly string[],
 argSchemas?: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown> {
 const events = parseSseEvents(sseText);
 let id = "msg_freeflow";
 let model = "";
 let stopReason: string | null = null;
 let usage: unknown = undefined;
 const textByIndex = new Map<number, string>();
 const toolByIndex = new Map<number, { id: string; name: string; inputJson: string }>();

 for (const ev of events) {
  if (ev.data === "[DONE]") continue;
  let parsed: Record<string, unknown>;
  try {
   parsed = JSON.parse(ev.data) as Record<string, unknown>;
  } catch {
   continue;
  }
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "message_start") {
   const msg = parsed.message as Record<string, unknown> | undefined;
   if (msg) {
    if (typeof msg.id === "string") id = msg.id;
    if (typeof msg.model === "string") model = msg.model;
   }
   continue;
  }
  if (type === "content_block_start") {
   const index = typeof parsed.index === "number" ? parsed.index : 0;
   const block = parsed.content_block as Record<string, unknown> | undefined;
   const blockType = block && typeof block.type === "string" ? block.type : "";
   if (blockType === "tool_use") {
    toolByIndex.set(index, {
     id: typeof block?.id === "string" ? (block.id as string) : "",
     name: typeof block?.name === "string" ? (block.name as string) : "",
     inputJson: "",
    });
   } else if (!toolByIndex.has(index)) {
    textByIndex.set(index, typeof block?.text === "string" ? (block.text as string) : "");
   }
   continue;
  }
  if (type === "content_block_delta") {
   const index = typeof parsed.index === "number" ? parsed.index : 0;
   const delta = parsed.delta as Record<string, unknown> | undefined;
   const deltaType = delta && typeof delta.type === "string" ? delta.type : "";
   if (deltaType === "text_delta" && typeof delta?.text === "string") {
    textByIndex.set(index, (textByIndex.get(index) ?? "") + (delta.text as string));
   } else if (deltaType === "input_json_delta" && typeof delta?.partial_json === "string") {
    const existing = toolByIndex.get(index) ?? { id: "", name: "", inputJson: "" };
    existing.inputJson += delta.partial_json as string;
    toolByIndex.set(index, existing);
   }
   continue;
  }
  if (type === "message_delta") {
   const delta = parsed.delta as Record<string, unknown> | undefined;
   if (delta && typeof delta.stop_reason === "string") stopReason = delta.stop_reason as string;
   if (parsed.usage !== undefined) usage = parsed.usage;
   continue;
  }
  if (type === "message" && parsed.role !== undefined) {
   cloakMessagesContent(parsed, callerHadTools, caseRestore, findGlob, injected, argSchemas);
   return parsed;
  }
 }

 const content: Record<string, unknown>[] = [];
 const order = Array.from(new Set([...textByIndex.keys(), ...toolByIndex.keys()])).sort((a, b) => a - b);
 for (const index of order) {
  const tool = toolByIndex.get(index);
  if (tool && (tool.id || tool.name)) {
   if (callerHadTools && (injected === undefined || !injected.includes(tool.name.toLowerCase()))) {
    let input: unknown = {};
    try {
     input = tool.inputJson ? JSON.parse(tool.inputJson) : {};
    } catch {
     input = {};
    }
    const name = restoreCallerName(tool.name, caseRestore, findGlob);
    content.push({ type: "tool_use", id: tool.id, name, input: repairToolArgumentsValue(name, input, argSchemas) });
   }
   continue;
  }
  const text = textByIndex.get(index) ?? "";
  if (text) content.push({ type: "text", text });
 }
 if (!callerHadTools && content.length === 0 && toolByIndex.size > 0) {
  const fallback = Array.from(toolByIndex.values())
   .map((t) => t.inputJson || t.name)
   .join("\n");
  if (fallback) content.push({ type: "text", text: fallback });
 }

 return {
  id,
  type: "message",
  role: "assistant",
  model,
  content,
  stop_reason: stopReason ?? "end_turn",
  ...(usage ? { usage } : {}),
 };
}

/**
 * Universal SSE-to-JSON aggregator. If input is not SSE, returns it untouched.
 */
export function convertSseToJson(
 sseText: string,
 pathname: string,
 callerHadTools = true,
 caseRestore?: CaseRestoreMap,
 findGlob?: FindGlobRestore,
 injected?: readonly string[],
 argSchemas?: ReadonlyMap<string, Record<string, unknown>>,
): string {
 if (!sseText || typeof sseText !== "string") return sseText;
 const trimmed = sseText.trim();
 if (!looksLikeSse(trimmed)) {
  return sseText;
 }
 try {
  if (pathname.endsWith("/responses")) {
   return JSON.stringify(sseToResponsesJson(trimmed, callerHadTools, caseRestore, findGlob, injected, argSchemas));
  }
  if (pathname.endsWith("/messages")) {
   return JSON.stringify(sseToMessagesJson(trimmed, callerHadTools, caseRestore, findGlob, injected, argSchemas));
  }
  return JSON.stringify(sseToChatCompletionJson(trimmed, callerHadTools, caseRestore, findGlob, injected, argSchemas));
 } catch (error) {
  // Every caller has already committed to `content-type: application/json`
  // by the time this runs, so handing back the raw SSE bytes would deliver a
  // parse error with no diagnosis. Say what happened, and keep the payload
  // reachable under `raw` so nothing is silently destroyed.
  return JSON.stringify({
   error: {
    message: "upstream stream could not be aggregated into a JSON answer",
    detail: String(error).slice(0, 300),
    raw: sseText.slice(0, 2000),
   },
  });
 }
}

/**
 * Repair the tool calls inside an already-JSON answer body.
 *
 * A lane that passes the caller's `stream` through untouched (Kilo) answers a
 * non-streaming caller with a plain `chat.completion` / `response` object, not
 * SSE. The SSE aggregators above never see that body, so the malformed
 * arguments reached the host unrepaired on exactly the requests that asked for
 * no stream. Repairs each call in place and re-serializes only when something
 * actually changed, so a well-formed answer keeps its byte-identical body.
 * Returns the input string untouched when it is not JSON or has no tool calls.
 */
export function repairJsonToolArguments(
 bodyText: string,
 pathname: string,
 argSchemas: ReadonlyMap<string, Record<string, unknown>> | undefined,
): string {
 if (argSchemas === undefined || argSchemas.size === 0 || !bodyText.trimStart().startsWith("{")) return bodyText;
 let parsed: unknown;
 try {
  parsed = JSON.parse(bodyText);
 } catch {
  return bodyText;
 }
 if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return bodyText;
 const body = parsed as Record<string, unknown>;
 let changed = false;
 const repairCall = (name: string, args: string): string => {
  const repaired = repairToolArguments(name, args, argSchemas);
  if (repaired !== args) changed = true;
  return repaired;
 };
 if (pathname.endsWith("/responses")) {
  const output = body.output;
  if (!Array.isArray(output)) return bodyText;
  for (const item of output) {
   if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
   const rec = item as Record<string, unknown>;
   if (rec.type !== "function_call" || typeof rec.name !== "string" || typeof rec.arguments !== "string") continue;
   rec.arguments = repairCall(rec.name, rec.arguments);
  }
 } else {
  const choices = body.choices;
  if (!Array.isArray(choices)) return bodyText;
  for (const choice of choices) {
   if (choice === null || typeof choice !== "object" || Array.isArray(choice)) continue;
   const message = (choice as Record<string, unknown>).message;
   if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
   const calls = (message as Record<string, unknown>).tool_calls;
   if (!Array.isArray(calls)) continue;
   for (const call of calls) {
    if (call === null || typeof call !== "object" || Array.isArray(call)) continue;
    const fn = (call as Record<string, unknown>).function;
    if (fn === null || typeof fn !== "object" || Array.isArray(fn)) continue;
    const fnRec = fn as Record<string, unknown>;
    if (typeof fnRec.name !== "string" || typeof fnRec.arguments !== "string") continue;
    fnRec.arguments = repairCall(fnRec.name, fnRec.arguments);
   }
  }
 }
 return changed ? JSON.stringify(body) : bodyText;
}
