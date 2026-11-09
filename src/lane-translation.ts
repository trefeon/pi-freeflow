/**
 * Responses <-> Chat body translation.
 *
 * Cline serves chat completions only, so the responses body is reshaped to chat
 * before the Cline branch sends it, and the chat answer is translated back.
 * Tool shape conversion reuses translateToolsForPath; only the message envelopes
 * are remapped here.
 */

import { translateToolsForPath } from "./tool-translation.ts";

const CHATCMPL_PREFIX_RE = /^chatcmpl/;
const RESP_PREFIX_RE = /^resp[_-]?/;

/** Extract plain text from a Responses content field (string or parts array). */
export function responsesTextOf(content: unknown): string | null {
 if (typeof content === "string") return content;
 if (!Array.isArray(content)) return null;
 let text = "";
 let saw = false;
 for (const part of content) {
  if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
  const rec = part as Record<string, unknown>;
  if ((rec.type === "text" || rec.type === "input_text" || rec.type === "output_text" || rec.type === "summary_text") && typeof rec.text === "string") {
   text += rec.text;
   saw = true;
  }
 }
 return saw ? text : null;
}

/** Chat role for a Responses item role; unknown roles ride as user text. */
export function chatRoleFor(role: unknown): string {
 if (role === "assistant" || role === "system" || role === "tool") return role;
 if (role === "developer") return "system";
 return "user";
}

/**
 * Map a Responses `input` (string or item array) to Chat `messages`.
 * function_call items become assistant tool_calls, function_call_output
 * items become tool messages, reasoning items keep only their summary text.
 */
export function responsesInputToChatMessages(input: unknown): Record<string, unknown>[] {
 if (typeof input === "string") return input.length > 0 ? [{ role: "user", content: input }] : [];
 if (!Array.isArray(input)) return [];
 const messages: Record<string, unknown>[] = [];
 for (const item of input) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
  const rec = item as Record<string, unknown>;
  if (rec.type === "function_call") {
   const args = typeof rec.arguments === "string" ? rec.arguments : (rec.arguments !== undefined && rec.arguments !== null ? JSON.stringify(rec.arguments) : "{}");
   const name = typeof rec.name === "string" ? rec.name : "tool";
   const id = typeof rec.call_id === "string" ? rec.call_id : typeof rec.id === "string" ? rec.id : "";
   const call = { id, type: "function", function: { name, arguments: args } };
   const lastMsg = messages[messages.length - 1];
   if (lastMsg && lastMsg.role === "assistant") {
    if (Array.isArray(lastMsg.tool_calls)) {
     (lastMsg.tool_calls as unknown[]).push(call);
    } else {
     lastMsg.tool_calls = [call];
    }
   } else {
    messages.push({ role: "assistant", content: null, tool_calls: [call] });
   }
   continue;
  }
  if (rec.type === "function_call_output") {
   const output = typeof rec.output === "string" ? rec.output : JSON.stringify(rec.output ?? "");
   const callId = typeof rec.call_id === "string" ? rec.call_id : typeof rec.id === "string" ? rec.id : "";
   messages.push({ role: "tool", tool_call_id: callId, content: output });
   continue;
  }
  if (rec.type === "reasoning") {
   const summary = Array.isArray(rec.summary) ? responsesTextOf(rec.summary) : null;
   if (summary !== null && summary.length > 0) messages.push({ role: "assistant", content: summary });
   continue;
  }
  const text = responsesTextOf(rec.content);
  messages.push({ role: chatRoleFor(rec.role), content: text ?? JSON.stringify(item) });
 }
 return messages;
}

/**
 * Build a Chat Completions body from a Responses body. Carries model,
 * instructions (as the leading system message), input, tools (reshaped to
 * chat via translateToolsForPath), tool_choice, and plain sampling scalars.
 * Stream policy stays with the caller: this maps shape, never behavior.
 *
 * Lane-neutral: used by every direct-only lane that serves chat upstream and
 * answers a responses-path caller (Cline, OVHcloud AI Endpoints).
 */
export function chatBodyFromResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
 const out: Record<string, unknown> = {};
 if (typeof body.model === "string") out.model = body.model;
 const messages: Record<string, unknown>[] = [];
 if (typeof body.instructions === "string" && body.instructions.length > 0) {
  messages.push({ role: "system", content: body.instructions });
 }
 messages.push(...responsesInputToChatMessages(body.input));
 out.messages = messages;
 if (Array.isArray(body.tools)) out.tools = translateToolsForPath(body.tools, "/v1/chat/completions");
 if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
 // `max_output_tokens` is the Responses-native cap and is what a host actually
 // sets on this path; without it here the cap silently vanished on the
 // chat-only lanes and the model answered at its own default length.
 for (const key of ["temperature", "top_p", "max_tokens", "max_completion_tokens", "max_output_tokens", "stop", "presence_penalty", "frequency_penalty", "seed", "user", "parallel_tool_calls", "response_format"] as const) {
  if (body[key] !== undefined) out[key] = body[key];
 }
 if (body.max_output_tokens !== undefined && out.max_tokens === undefined) {
  out.max_tokens = body.max_output_tokens;
 }
 if (out.tool_choice !== undefined && typeof out.tool_choice === "object" && out.tool_choice !== null && !Array.isArray(out.tool_choice)) {
  const tc = out.tool_choice as Record<string, unknown>;
  if (tc.type === "function" && typeof tc.name === "string" && tc.function === undefined) {
   out.tool_choice = { type: "function", function: { name: tc.name } };
  }
 }
 return out;
}

/** First chat choice message, or null when the completion carries none. */
export function firstChatMessage(chat: Record<string, unknown>): Record<string, unknown> | null {
 const choices = chat.choices;
 if (!Array.isArray(choices) || choices.length === 0) return null;
 const first = choices[0];
 if (typeof first !== "object" || first === null || Array.isArray(first)) return null;
 const message = (first as Record<string, unknown>).message;
 if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
 return message as Record<string, unknown>;
}

/**
 * Build a Responses object from a Chat Completion object. Text becomes the
 * assistant message item, tool_calls become function_call items, usage rides
 * verbatim. `finish_reason: "length"` reports incomplete, else completed.
 */
export function chatResponsesJsonFromChatCompletion(chat: Record<string, unknown>, fallbackModel: string): Record<string, unknown> {
 const message = firstChatMessage(chat);
 const model = typeof chat.model === "string" && chat.model.length > 0 ? chat.model : fallbackModel;
 const id = typeof chat.id === "string" ? chat.id.replace(CHATCMPL_PREFIX_RE, "resp") : "resp_cline";
 // Both hosts key their text block off the item id — Pi builds `textSignature`
 // from item.id, OMP stores itemId — and each synthesizes a fallback when it
 // is missing, so the message item carries one derived from the response id,
 // the way upstream OpenAI ids share a suffix.
 const messageId = `msg_${id.replace(RESP_PREFIX_RE, "")}`;
 const choices = chat.choices;
 const first = Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object" && choices[0] !== null ? (choices[0] as Record<string, unknown>) : {};
 const status = first.finish_reason === "length" ? "incomplete" : "completed";
 const output: Record<string, unknown>[] = [];
 if (message) {
  const text = typeof message.content === "string" ? message.content : null;
  if (text !== null && text.length > 0) {
   output.push({ type: "message", id: messageId, role: typeof message.role === "string" ? message.role : "assistant", status, content: [{ type: "output_text", text }] });
  }
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
   for (const tc of toolCalls) {
    if (typeof tc !== "object" || tc === null || Array.isArray(tc)) continue;
    const rec = tc as Record<string, unknown>;
    const fn = typeof rec.function === "object" && rec.function !== null && !Array.isArray(rec.function) ? (rec.function as Record<string, unknown>) : {};
    const args = typeof fn.arguments === "string" ? fn.arguments : (fn.arguments !== undefined && fn.arguments !== null ? JSON.stringify(fn.arguments) : "{}");
    const callId = typeof rec.id === "string" && rec.id.length > 0 ? rec.id : `call_cline_${output.length}`;
    output.push({ type: "function_call", id: callId, call_id: callId, name: typeof fn.name === "string" ? fn.name : "tool", arguments: args });
   }
  }
 }
 const out: Record<string, unknown> = {
  id,
  object: "response",
  created_at: typeof chat.created === "number" ? chat.created : Math.floor(Date.now() / 1000),
  model,
  output,
  status,
 };
 if (chat.usage !== undefined) out.usage = chat.usage;
 return out;
}

/**
 * Wrap a Responses object in the minimal valid Responses SSE sequence
 * (created + completed + DONE) so streamed responses-path clients get a
 * stream even though the upstream lane only serves chat. Round-trips through
 * sseToResponsesJson: the completed event carries the full object.
 *
 * Every output item is framed the way hosts consume streams: it opens with
 * `response.output_item.added` before its deltas and closes with
 * `response.output_item.done` after them. A host creates a slot only on
 * `added` and DROPS a keyed delta that has no open slot (Pi
 * api/openai-responses-shared.ts createSlot/getSlot; OMP
 * providers/openai-shared.ts registerOpenItem/lookupOpenItem), so a message
 * item emitted as bare `response.output_text.delta` frames left every
 * chat-only lane answer blank on the caller side.
 */
export function chatResponsesSseFromChatCompletion(resp: Record<string, unknown>): string {
 const head = { type: "response.created", response: { id: resp.id, object: "response", model: resp.model } };
 let out = `event: response.created\ndata: ${JSON.stringify(head)}\n\n`;
 const output = resp.output;
 if (Array.isArray(output)) {
  for (let idx = 0; idx < output.length; idx++) {
   const item = output[idx] as Record<string, unknown>;
   if (item && item.type === "message" && Array.isArray(item.content)) {
    const parts = item.content as Record<string, unknown>[];
    const hasText = parts.some((p) => p && p.type === "output_text" && typeof p.text === "string" && p.text.length > 0);
    // An item carrying no text (a pure tool-call turn) stays unopened: opening
    // and closing it would leave the host with an empty text block.
    if (hasText) {
     out += `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: idx,
      item: { type: "message", id: item.id, role: typeof item.role === "string" ? item.role : "assistant", status: "in_progress", content: [] },
     })}\n\n`;
     for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const p = parts[partIndex];
      if (p && p.type === "output_text" && typeof p.text === "string" && p.text.length > 0) {
       out += `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: idx,
        content_index: partIndex,
        delta: p.text,
       })}\n\n`;
      }
     }
     out += `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: idx,
      item,
     })}\n\n`;
    }
   } else if (item && item.type === "function_call") {
    out += `event: response.output_item.added\ndata: ${JSON.stringify({
     type: "response.output_item.added",
     output_index: idx,
     item: {
      type: "function_call",
      id: item.id,
      call_id: item.call_id,
      name: item.name,
      arguments: "",
     },
    })}\n\n`;
    if (typeof item.arguments === "string" && item.arguments.length > 0) {
     out += `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      output_index: idx,
      delta: item.arguments,
     })}\n\n`;
    }
    out += `event: response.output_item.done\ndata: ${JSON.stringify({
     type: "response.output_item.done",
     output_index: idx,
     item,
    })}\n\n`;
   }
  }
 }
 const done = { type: "response.completed", response: resp };
 out += `event: response.completed\ndata: ${JSON.stringify(done)}\n\n`;
 out += `data: [DONE]\n\n`;
 return out;
}
