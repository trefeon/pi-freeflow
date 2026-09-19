/**
 * OpenCode Zen free-tier client fingerprint enforcement & SSE stream aggregator.
 *
 * Upstream OpenCode Zen (/zen/v1/chat/completions, /zen/v1/responses and
 * /zen/v1/messages) validates requests against the official OpenCode agentic
 * client fingerprint. If any of the following 4 axes are missing, upstream
 * answers HTTP 403 FreeTierError:
 * 1. User-Agent (opencode/1.18.31, >= 1.17.0)
 * 2. x-opencode-session (canonical ses_[0-9a-f]{12}[0-9A-Za-z]{14} format)
 * 3. Tools: must declare the placeholder sextet {bash, glob, grep, read, edit, write}
 * 4. Streaming: must be stream: true
 *
 * This module ensures axes 3 and 4 are enforced on outgoing requests, and handles
 * bidirectional streaming conversion: if the client requested non-streaming
 * (stream: false), upstream is still sent stream: true to pass the gate, and the
 * resulting SSE stream is accumulated and converted back to a single JSON response.
 *
 * freeflow serves ONLY OMP and Pi hosts. Either host may send any of its tools
 * (see src/tool-translation.ts for the canonical inventories) in any wire shape,
 * so enforcement renames caller placeholders to lowercase (Bash -> bash,
 * retargeting tool_choice), translates caller tools to the target path's shape
 * (Pi find -> upstream glob via the translator), and only then injects the
 * missing placeholders. Caller tools (ls, powershell, find, web_search, ...)
 * are never dropped. Injected placeholder calls are cloaked from downstream
 * responses on all three paths; caller casing is restored via a bounded
 * per-request map (never module-global).
 */
import {
 COMPAT_TOOL_DESCRIPTION,
 OPENCODE_FINGERPRINT_TOOLS,
 buildFindGlobRestore,
 restoreToolNameForCaller,
 retargetToolChoiceForUpstream,
 translateToolsForPath,
 upstreamToolNameFor,
 type FindGlobRestore,
} from "./tool-translation.ts";

/**
 * Safely extract the tool name whether formatted in Chat Completions style
 * ({ function: { name } }) or flat Responses style ({ name }).
 */
export function toolNameOf(tool: unknown): string {
 if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
 const t = tool as Record<string, unknown>;
 const fn =
  t.function && typeof t.function === "object" && !Array.isArray(t.function)
   ? (t.function as Record<string, unknown>)
   : null;
 const raw = typeof t.name === "string" ? t.name : typeof fn?.name === "string" ? fn.name : "";
 return raw.trim();
}
export { OPENCODE_FINGERPRINT_TOOLS };
export type { FingerprintToolName, FindGlobRestore } from "./tool-translation.ts";

/** Lowercase placeholder names the gate expects (canonical translator set). */
const PLACEHOLDER_BY_LOWER_NAME: Record<string, true> = {};
for (const n of OPENCODE_FINGERPRINT_TOOLS) PLACEHOLDER_BY_LOWER_NAME[n.toLowerCase()] = true;

/** True for placeholder names (case-insensitive): injected compat tools only. */
export function isPlaceholderToolName(name: unknown): boolean {
 return typeof name === "string" && PLACEHOLDER_BY_LOWER_NAME[name.toLowerCase()] === true;
}

/**
 * Bounded per-request restore map: lowercase placeholder name -> caller casing.
 * Built fresh by normalizePlaceholderCase for each enforced request and threaded
 * explicitly through the SSE converters; never module-global.
 */
export type CaseRestoreMap = Record<string, string>;

/**
 * Lowercase caller placeholder declarations (Bash -> bash) in place before
 * injection, so the gate sees canonical names and injection stays duplicate-free.
 * Non-placeholder tools (ls, powershell, find, web_search, ...) pass untouched.
 * Returns the bounded restore map for downstream response cloaking.
 */
export function normalizePlaceholderCase(body: Record<string, unknown>): CaseRestoreMap {
 const restore: CaseRestoreMap = {};
 if (!Array.isArray(body.tools)) return restore;
 for (const tool of body.tools) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
  const t = tool as Record<string, unknown>;
  const fn =
   t.function && typeof t.function === "object" && !Array.isArray(t.function)
    ? (t.function as Record<string, unknown>)
    : null;
  const holder = fn && typeof fn.name === "string" ? fn : typeof t.name === "string" ? t : null;
  if (!holder) continue;
  const original = holder.name as string;
  const lower = original.toLowerCase();
  if (PLACEHOLDER_BY_LOWER_NAME[lower] !== true || original === lower) continue;
  if (restore[lower] === undefined) restore[lower] = original;
  holder.name = lower;
 }
 return restore;
}

/**
 * Retarget a caller tool_choice that names a placeholder in original casing
 * ({function:{name}}, {name}) to the lowercased name. String choices
 * ("auto", ...) and non-placeholder names pass untouched. Request-side only.
 */
export function retargetToolChoice(body: Record<string, unknown>): void {
 const choice = body.tool_choice;
 if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
 const c = choice as Record<string, unknown>;
 const fn =
  c.function && typeof c.function === "object" && !Array.isArray(c.function)
   ? (c.function as Record<string, unknown>)
   : null;
 if (fn && typeof fn.name === "string" && isPlaceholderToolName(fn.name)) {
  fn.name = (fn.name as string).toLowerCase();
 }
 if (typeof c.name === "string" && isPlaceholderToolName(c.name)) {
  c.name = (c.name as string).toLowerCase();
 }
}

/** Restore caller casing on one downstream tool name (bounded map, else verbatim). */
function restoreName(name: string, restore?: CaseRestoreMap): string {
 if (restore) {
  const hit = restore[name.toLowerCase()];
  if (hit !== undefined) return hit;
 }
 return name;
}

/**
 * Full downstream restore: caller casing first, then the translator's
 * find->glob mapping (upstream glob back to caller find when renamed).
 */
function restoreCallerName(name: string, caseRestore?: CaseRestoreMap, findGlob?: FindGlobRestore): string {
 const cased = restoreName(name, caseRestore);
 return findGlob ? restoreToolNameForCaller(cased, findGlob) : cased;
}

/**
 * Merge missing placeholder declarations (canonical translator set) into Chat
 * Completions bodies. Case-insensitive and idempotent: Bash counts as bash.
 * Preserves caller tools verbatim; missing placeholders appended as no-ops.
 */
export function ensureChatFingerprintTools(body: Record<string, unknown>): void {
 if (!body || typeof body !== "object") return;
 const present = new Set<string>();
 if (Array.isArray(body.tools)) {
  for (const tool of body.tools) {
   const name = toolNameOf(tool);
   if (name) present.add(name.toLowerCase());
  }
 } else {
  body.tools = [];
 }
 for (const name of OPENCODE_FINGERPRINT_TOOLS) {
  if (present.has(name)) continue;
  (body.tools as unknown[]).push({
   type: "function",
   function: {
    name,
    description: COMPAT_TOOL_DESCRIPTION,
    parameters: { type: "object", properties: {} },
   },
  });
  present.add(name);
 }
}

/**
 * Merge missing placeholder declarations (canonical translator set) into
 * Responses API bodies. Case-insensitive and idempotent.
 * Uses the flat Responses tool shape ({ type: "function", name, description, parameters }).
 */
export function ensureResponsesFingerprintTools(body: Record<string, unknown>): void {
 if (!body || typeof body !== "object") return;
 const present = new Set<string>();
 if (Array.isArray(body.tools)) {
  for (const tool of body.tools) {
   const name = toolNameOf(tool);
   if (name) present.add(name.toLowerCase());
  }
 } else {
  body.tools = [];
 }
 for (const name of OPENCODE_FINGERPRINT_TOOLS) {
  if (present.has(name)) continue;
  (body.tools as unknown[]).push({
   type: "function",
   name,
   description: COMPAT_TOOL_DESCRIPTION,
   parameters: { type: "object", properties: {} },
  });
  present.add(name);
 }
}

/**
 * Merge missing placeholder declarations (canonical translator set) into
 * Anthropic Messages bodies. Case-insensitive and idempotent.
 * Uses the Anthropic tool shape ({ name, description, input_schema }).
 */
export function ensureMessagesFingerprintTools(body: Record<string, unknown>): void {
 if (!body || typeof body !== "object") return;
 const present = new Set<string>();
 if (Array.isArray(body.tools)) {
  for (const tool of body.tools) {
   const name = toolNameOf(tool);
   if (name) present.add(name.toLowerCase());
  }
 } else {
  body.tools = [];
 }
 for (const name of OPENCODE_FINGERPRINT_TOOLS) {
  if (present.has(name)) continue;
  (body.tools as unknown[]).push({
   name,
   description: COMPAT_TOOL_DESCRIPTION,
   input_schema: { type: "object", properties: {} },
  });
  present.add(name);
 }
}

/**
 * Enforce the full OpenCode free-tier client fingerprint on a parsed request body.
 * Caller placeholders are lowercased (Bash -> bash, tool_choice retargeted),
 * tools translated to the target path's wire shape (Pi find -> upstream glob via
 * src/tool-translation.ts), then the missing placeholders injected in that shape.
 * Returns the original stream flag, caller-tools flag, whether injection added
 * tools, and the bounded per-request restore records (caseRestore, findGlob,
 * injected) for downstream response cloaking.
 */
export function enforceOpencodeFingerprint(
 body: Record<string, unknown>,
 pathname: string,
): {
 clientRequestedStream: boolean;
 callerHadTools: boolean;
 addedTools: boolean;
 caseRestore: CaseRestoreMap;
 findGlob: FindGlobRestore;
 injected: string[];
} {
 const clientRequestedStream = body.stream === true;
 const callerHadTools = Array.isArray(body.tools) && body.tools.length > 0;
 // Upstream Zen free tier mandates stream: true for all free requests
 body.stream = true;

 const caseRestore = normalizePlaceholderCase(body);
 retargetToolChoice(body);

 const findGlob = buildFindGlobRestore(Array.isArray(body.tools) ? body.tools : []);
 // Caller tool_choice naming `find` must ride upstream as `glob` — the rename
 // above collapses the declaration, so an unretargeted choice dangles.
 if (body.tool_choice !== undefined) {
  body.tool_choice = retargetToolChoiceForUpstream(body.tool_choice, findGlob) as Record<string, unknown> | string;
 }
 const callerUpstream = new Set<string>();
 if (Array.isArray(body.tools)) {
  for (const tool of body.tools) {
   const n = toolNameOf(tool);
   if (n) callerUpstream.add(upstreamToolNameFor(n).toLowerCase());
  }
 }
 const injected = OPENCODE_FINGERPRINT_TOOLS.filter((n) => !callerUpstream.has(n.toLowerCase()));

 if (Array.isArray(body.tools)) {
  body.tools = translateToolsForPath(body.tools, pathname);
 }

 const before = Array.isArray(body.tools) ? body.tools.length : 0;
 if (pathname.endsWith("/responses")) {
  ensureResponsesFingerprintTools(body);
  if (body.store === undefined) {
   body.store = false;
  }
 } else if (pathname.endsWith("/messages")) {
  ensureMessagesFingerprintTools(body);
 } else {
  ensureChatFingerprintTools(body);
 }
 const after = Array.isArray(body.tools) ? body.tools.length : 0;

 // Note: Upstream OpenCode Zen explicitly rejects any tool_choice other than "auto"
 // with HTTP 400 (only "auto" is supported). We never impose tool_choice: "none".
 // The explicit placeholder description and output-aggregator guarantee clean text.

 return { clientRequestedStream, callerHadTools, addedTools: after > before, caseRestore, findGlob, injected };
}

/**
 * Parse raw SSE stream text into individual event blocks.
 */
export function parseSseEvents(text: string): Array<{ event?: string; data: string }> {
 const result: Array<{ event?: string; data: string }> = [];
 const blocks = text.split(/\r?\n\r?\n/);
 for (const block of blocks) {
  const trimmed = block.trim();
  if (!trimmed) continue;
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
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

/**
 * Convert an SSE stream from an OpenAI-compatible Chat Completions endpoint
 * into a single standard non-streaming ChatCompletion JSON response.
 */
/** Tool-call name from a Chat Completions tool_calls entry (else ""). */
function chatCallName(tc: unknown): string {
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
 */
/**
 * Only names this request actually injected are ever cloaked downstream. The
 * caller's own bash is indistinguishable by name and must survive; legacy
 * direct calls (no record) keep everything.
 */
function cloakChatMessage(
 msg: unknown,
 callerHadTools: boolean,
 caseRestore?: CaseRestoreMap,
 findGlob?: FindGlobRestore,
 injected?: readonly string[],
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
    (fn as Record<string, unknown>).name = restoreCallerName(
     (fn as Record<string, unknown>).name as string,
     caseRestore,
     findGlob,
    );
   }
  }
  kept.push(tc);
 }
 if (kept.length > 0) m.tool_calls = kept;
 else delete m.tool_calls;
}

export function sseToChatCompletionJson(
 sseText: string,
 callerHadTools = true,
 caseRestore?: CaseRestoreMap,
 findGlob?: FindGlobRestore,
 injected?: readonly string[],
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
 const toolCallsMap = new Map<
  number,
  { id: string; type: string; function: { name: string; arguments: string } }
 >();

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
        const idx = tc.index ?? 0;
        const existing = toolCallsMap.get(idx) ?? {
         id: tc.id || "",
         type: tc.type || "function",
         function: { name: "", arguments: "" },
        };
        if (tc.id) existing.id = tc.id;
        if (tc.type) existing.type = tc.type;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        toolCallsMap.set(idx, existing);
       }
      }
     }
     // Choice contains a pre-assembled message: cloak before returning.
     if (c.message) {
      cloakChatMessage(c.message, callerHadTools, caseRestore, findGlob, injected);
      return parsed as Record<string, unknown>;
     }
    }
   }
  } catch {
   // ignore unparseable data chunks
  }
 }

 const toolCalls = Array.from(toolCallsMap.entries())
  .sort(([a], [b]) => a - b)
  .map(([, tc]) => tc);

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
  for (const tc of kept) tc.function.name = restoreCallerName(tc.function.name, caseRestore, findGlob);
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
 * place. Only names this request injected are removed, whether or not the
 * caller declared tools; caller calls keep restored names.
 */
function cloakResponsesObject(resp: unknown, caseRestore?: CaseRestoreMap, findGlob?: FindGlobRestore, injected?: readonly string[]): void {
 if (!resp || typeof resp !== "object" || Array.isArray(resp)) return;
 const output = (resp as Record<string, unknown>).output;
 if (!Array.isArray(output)) return;
 const kept: unknown[] = [];
 for (const item of output) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
   const rec = item as Record<string, unknown>;
   if (rec.type === "function_call") {
    if (typeof rec.name === "string" && injected !== undefined && injected.includes(rec.name.toLowerCase())) continue;
    if (typeof rec.name === "string") rec.name = restoreCallerName(rec.name, caseRestore, findGlob);
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
): Record<string, unknown> {
 const events = parseSseEvents(sseText);
 // 1. Highest fidelity: response.completed event carries the final full response object
 for (let i = events.length - 1; i >= 0; i--) {
  const ev = events[i];
  try {
   const parsed = JSON.parse(ev.data);
   if (parsed?.type === "response.completed" && parsed.response && typeof parsed.response === "object") {
    cloakResponsesObject(parsed.response, caseRestore, findGlob, injected);
    return parsed.response as Record<string, unknown>;
   }
  } catch { }
 }
 // 2. Secondary fallback: check any event with a response object
 for (let i = events.length - 1; i >= 0; i--) {
  const ev = events[i];
  try {
   const parsed = JSON.parse(ev.data);
   if (parsed?.response && typeof parsed.response === "object") {
    cloakResponsesObject(parsed.response, caseRestore, findGlob, injected);
    return parsed.response as Record<string, unknown>;
   }
  } catch { }
 }
 // 3. Fallback: parse entire string directly if upstream already returned JSON
 try {
  const parsed = JSON.parse(sseText);
  if (parsed && typeof parsed === "object") {
   cloakResponsesObject(parsed, caseRestore, findGlob, injected);
   return parsed;
  }
 } catch { }

 return {
  id: "resp_fallback",
  object: "response",
  status: "completed",
  output: [],
 };
}
/**
 * Drop placeholder tool_use blocks from a complete Anthropic message in place.
 * Tool-less callers never see tool_use; callers with tools keep only their own
 * blocks, names restored.
 */
function cloakMessagesContent(
 msg: unknown,
 callerHadTools: boolean,
 caseRestore?: CaseRestoreMap,
 findGlob?: FindGlobRestore,
 injected?: readonly string[],
): void {
 if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
 const content = (msg as Record<string, unknown>).content;
 if (!Array.isArray(content)) return;
 const kept: unknown[] = [];
 for (const block of content) {
  if (
   block &&
   typeof block === "object" &&
   !Array.isArray(block) &&
   (block as Record<string, unknown>).type === "tool_use"
  ) {
   const rec = block as Record<string, unknown>;
   if (typeof rec.name === "string" && injected !== undefined && injected.includes(rec.name.toLowerCase())) continue;
   if (callerHadTools) {
    if (typeof rec.name === "string") rec.name = restoreCallerName(rec.name, caseRestore, findGlob);
    kept.push(block);
   }
   continue;
  }
  kept.push(block);
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
   cloakMessagesContent(parsed, callerHadTools, caseRestore, findGlob, injected);
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
    content.push({ type: "tool_use", id: tool.id, name: restoreCallerName(tool.name, caseRestore, findGlob), input });
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
): string {
 if (!sseText || typeof sseText !== "string") return sseText;
 const trimmed = sseText.trim();
 if (!trimmed.includes("data:")) {
  return sseText;
 }
 try {
  if (pathname.endsWith("/responses")) {
   return JSON.stringify(sseToResponsesJson(trimmed, callerHadTools, caseRestore, findGlob, injected));
  }
  if (pathname.endsWith("/messages")) {
   return JSON.stringify(sseToMessagesJson(trimmed, callerHadTools, caseRestore, findGlob, injected));
  }
  return JSON.stringify(sseToChatCompletionJson(trimmed, callerHadTools, caseRestore, findGlob, injected));
 } catch {
  return sseText;
 }
 return sseText;
}
