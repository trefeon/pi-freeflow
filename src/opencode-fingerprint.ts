/**
 * OpenCode Zen free-tier client fingerprint enforcement & SSE stream aggregator.
 *
 * Upstream OpenCode Zen (/zen/v1/chat/completions and /zen/v1/responses) validates
 * requests against the official OpenCode agentic client fingerprint. If any of the
 * following 4 axes are missing, upstream answers HTTP 403 FreeTierError:
 * 1. User-Agent (opencode/1.18.31, >= 1.17.0)
 * 2. x-opencode-session (canonical ses_[0-9a-f]{12}[0-9A-Za-z]{14} format)
 * 3. Tools: must declare the file-search tool quartet {bash, glob, grep, read}
 * 4. Streaming: must be stream: true
 *
 * This module ensures axes 3 and 4 are enforced on outgoing requests, and handles
 * bidirectional streaming conversion: if the client requested non-streaming
 * (stream: false), upstream is still sent stream: true to pass the gate, and the
 * resulting SSE stream is accumulated and converted back to a single JSON response.
 */

export const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"] as const;

export type FingerprintToolName = (typeof OPENCODE_FINGERPRINT_TOOLS)[number];

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

/**
 * Merge missing {bash, glob, grep, read} tool declarations into Chat Completions bodies.
 * Preserves caller tools verbatim; missing fingerprint tools are appended as no-ops.
 */
export function ensureChatFingerprintTools(body: Record<string, unknown>): void {
 if (!body || typeof body !== "object") return;
 const present = new Set<string>();
 if (Array.isArray(body.tools)) {
  for (const tool of body.tools) {
   const name = toolNameOf(tool);
   if (name) present.add(name);
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
    description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
    parameters: { type: "object", properties: {} },
   },
  });
  present.add(name);
 }
}

/**
 * Merge missing {bash, glob, grep, read} tool declarations into Responses API bodies.
 * Uses the flat Responses tool shape ({ type: "function", name, description, parameters }).
 */
export function ensureResponsesFingerprintTools(body: Record<string, unknown>): void {
 if (!body || typeof body !== "object") return;
 const present = new Set<string>();
 if (Array.isArray(body.tools)) {
  for (const tool of body.tools) {
   const name = toolNameOf(tool);
   if (name) present.add(name);
  }
 } else {
  body.tools = [];
 }
 for (const name of OPENCODE_FINGERPRINT_TOOLS) {
  if (present.has(name)) continue;
  (body.tools as unknown[]).push({
   type: "function",
   name,
   description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
   parameters: { type: "object", properties: {} },
  });
  present.add(name);
 }
}

/**
 * Enforce the full OpenCode free-tier client fingerprint on a parsed request body.
 * Returns whether the client originally requested streaming.
 */
export function enforceOpencodeFingerprint(
 body: Record<string, unknown>,
 pathname: string,
): { clientRequestedStream: boolean; callerHadTools: boolean } {
 const clientRequestedStream = body.stream === true;
 const callerHadTools = Array.isArray(body.tools) && body.tools.length > 0;
 // Upstream Zen free tier mandates stream: true for all free requests
 body.stream = true;

 if (pathname.endsWith("/responses")) {
  ensureResponsesFingerprintTools(body);
  if (body.store === undefined) {
   body.store = false;
  }
 } else {
  ensureChatFingerprintTools(body);
 }

 // Note: Upstream OpenCode Zen explicitly rejects any tool_choice other than "auto"
 // with HTTP 400 (only "auto" is supported). We never impose tool_choice: "none".
 // The explicit placeholder description and output-aggregator guarantee clean text.

 return { clientRequestedStream, callerHadTools };
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
export function sseToChatCompletionJson(
 sseText: string,
 callerHadTools = true,
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
     // Choice contains a pre-assembled message
     if (c.message) {
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
 if (callerHadTools && toolCalls.length > 0) {
  message.tool_calls = toolCalls;
 } else if (!callerHadTools && !content && toolCalls.length > 0) {
  message.content = toolCalls.map((tc) => tc.function.arguments || tc.function.name).join("\n");
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
 * Convert an SSE stream from an OpenAI Responses API endpoint into a single
 * standard non-streaming response object.
 */
export function sseToResponsesJson(
 sseText: string,
 callerHadTools = true,
): Record<string, unknown> {
 const events = parseSseEvents(sseText);
 // 1. Highest fidelity: response.completed event carries the final full response object
 for (let i = events.length - 1; i >= 0; i--) {
  const ev = events[i];
  try {
   const parsed = JSON.parse(ev.data);
   if (parsed?.type === "response.completed" && parsed.response && typeof parsed.response === "object") {
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
    return parsed.response as Record<string, unknown>;
   }
  } catch { }
 }
 // 3. Fallback: parse entire string directly if upstream already returned JSON
 try {
  const parsed = JSON.parse(sseText);
  if (parsed && typeof parsed === "object") return parsed;
 } catch { }

 return {
  id: "resp_fallback",
  object: "response",
  status: "completed",
  output: [],
 };
}

/**
 * Universal SSE-to-JSON aggregator. If input is not SSE, returns it untouched.
 */
export function convertSseToJson(
 sseText: string,
 pathname: string,
 callerHadTools = true,
): string {
 if (!sseText || typeof sseText !== "string") return sseText;
 const trimmed = sseText.trim();
 if (!trimmed.includes("data:")) {
  return sseText;
 }
 try {
  if (pathname.endsWith("/responses")) {
   return JSON.stringify(sseToResponsesJson(trimmed, callerHadTools));
  }
  return JSON.stringify(sseToChatCompletionJson(trimmed, callerHadTools));
 } catch {
  return sseText;
 }
 return sseText;
}
