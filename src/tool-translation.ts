/**
 * Tool translation across the three wire APIs pi-freeflow serves.
 *
 * freeflow is used ONLY by OMP and Pi hosts (never generic OpenAI clients),
 * so the proxy must accept every tool either host can send and reshape it for
 * whichever upstream API the request targets:
 * - Chat Completions (`/v1/chat/completions`): { type: "function", function: { name, description, parameters } }
 * - Responses (`/v1/responses`): { type: "function", name, description, parameters }
 * - Anthropic Messages (`/v1/messages`): { name, description, input_schema }
 *
 * Canonical host inventories (grounded in the reference checkouts):
 * - Pi: `ToolName` union in reference/pi/packages/coding-agent/src/core/tools/index.ts
 * - OMP: `BUILTIN_TOOL_NAMES` in reference/oh-my-pi/packages/coding-agent/src/tools/builtin-names.ts
 *   plus `browser`/`computer` (top-level tools present in the checkout but not
 *   yet listed in builtin-names.ts).
 *
 * Translation rules:
 * - Function tools are normalized to { name, description, parameters, strict? }
 *   and re-emitted in the target shape. Caller tools are NEVER dropped or renamed,
 *   except Pi `find` which upstream has no fingerprint name for: it is renamed
 *   to `glob` upstream (all three shapes, params/description verbatim) and
 *   restored downstream via FindGlobRestore. OMP `glob` is untouched.
 * - Tools already in the target shape pass through verbatim (identical
 *   reference, every extra field intact). Cross-shape conversion carries
 *   `description`/`parameters`/`strict` verbatim plus every other top-level
 *   caller field, except the wire-shape-forbidden keys which are remapped:
 *   chat `function` wrapper <-> flat `name`, `parameters` <-> `input_schema`,
 *   and `type` is set per target shape. Never injects `additionalProperties`.
 * - Non-function tools (e.g. Responses built-ins like { type: "web_search" })
 *   pass through verbatim.
 * - `parameters` and Anthropic `input_schema` are treated as the same schema.
 * - First-seen wins on duplicate names, compared case-insensitively on the
 *   upstream name (so `Bash` never duplicates `bash`, `find` collapses with
 *   `glob`). Re-translating translated output adds zero tools (idempotent).
 * - `tool_choice` is never imposed; use retargetToolChoiceForUpstream /
 *   restoreToolChoiceForCaller to carry a caller choice across the find->glob
 *   rename in both directions.
 */

/** Compat placeholder tools the upstream gate expects (all lowercase). */
export const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read", "edit", "write"] as const;
export type FingerprintToolName = (typeof OPENCODE_FINGERPRINT_TOOLS)[number];

/** Pi host tools: ToolName union in reference/pi packages/coding-agent/src/core/tools/index.ts */
export const PI_TOOL_NAMES = [
 "read",
 "bash",
 "powershell",
 "edit",
 "write",
 "grep",
 "find",
 "ls",
] as const;

/** OMP host built-ins: BUILTIN_TOOL_NAMES in reference/oh-my-pi packages/coding-agent/src/tools/builtin-names.ts plus browser/computer */
export const OMP_TOOL_NAMES = [
 "read",
 "bash",
 "edit",
 "ast_grep",
 "ast_edit",
 "ask",
 "debug",
 "eval",
 "github",
 "glob",
 "grep",
 "lsp",
 "checkpoint",
 "rewind",
 "security_scan",
 "task",
 "hub",
 "todo",
 "web_search",
 "write",
 "memory_edit",
 "retain",
 "recall",
 "reflect",
 "learn",
 "manage_skill",
 "browser",
 "computer",
] as const;

/** OMP hidden tools: HIDDEN_TOOL_NAMES in the same OMP module. */
export const OMP_HIDDEN_TOOL_NAMES = ["yield", "goal", "think"] as const;

/** Every tool name either host can send (MCP `mcp__*` and xd:// device names pass through as-is). */
export const ALL_HOST_TOOL_NAMES: ReadonlySet<string> = new Set([
 ...PI_TOOL_NAMES,
 ...OMP_TOOL_NAMES,
 ...OMP_HIDDEN_TOOL_NAMES,
]);

/** Placeholder description for injected compatibility tools: must never be invoked. */
export const COMPAT_TOOL_DESCRIPTION =
 "Do not call this tool. It exists only for API compatibility and must never be invoked.";

export interface CanonicalTool {
 name: string;
 description: string;
 parameters: Record<string, unknown>;
 strict?: boolean;
}

function nestedFn(t: Record<string, unknown>): Record<string, unknown> | null {
 const fn = t.function;
 return typeof fn === "object" && fn !== null && !Array.isArray(fn)
  ? (fn as Record<string, unknown>)
  : null;
}

function schemaOf(t: Record<string, unknown>, fn: Record<string, unknown> | null): Record<string, unknown> {
 for (const key of ["parameters", "input_schema"]) {
  const direct = t[key];
  if (typeof direct === "object" && direct !== null && !Array.isArray(direct)) {
   return direct as Record<string, unknown>;
  }
  if (fn) {
   const nested = fn[key];
   if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
   }
  }
 }
 return { type: "object", properties: {} };
}

/**
 * Normalize one wire tool to canonical form. Returns null for entries that
 * are not function tools (they must pass through verbatim, not be dropped).
 * Captures `strict` when the caller set a boolean (top-level only; the
 * function wrapper never carries it on the wire).
 */
export function canonicalizeTool(tool: unknown): CanonicalTool | null {
 if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return null;
 const t = tool as Record<string, unknown>;
 const fn = nestedFn(t);
 const rawName =
  typeof t.name === "string" && t.name.trim()
   ? t.name.trim()
   : fn && typeof fn.name === "string"
    ? fn.name.trim()
    : "";
 if (!rawName) return null;
 const type = typeof t.type === "string" ? t.type : "";
 // Function tools across all three APIs. Anything else (web_search,
 // code_interpreter, custom MCP wrappers) is not ours to reshape.
 if (type !== "" && type !== "function") return null;
 const canon: CanonicalTool = {
  name: rawName,
  description:
   typeof t.description === "string"
    ? t.description
    : fn && typeof fn.description === "string"
     ? fn.description
     : "",
  parameters: schemaOf(t, fn),
 };
 if (typeof t.strict === "boolean") canon.strict = t.strict;
 return canon;
}

/** Canonical tool -> Chat Completions shape. Carries `strict` verbatim when set. */
export function toChatTool(t: CanonicalTool): Record<string, unknown> {
 const out: Record<string, unknown> = {
  type: "function",
  function: {
   name: t.name,
   description: t.description,
   parameters: t.parameters,
  },
 };
 if (typeof t.strict === "boolean") out.strict = t.strict;
 return out;
}
/** Canonical tool -> Responses shape. Carries `strict` verbatim when set. */
export function toResponsesTool(t: CanonicalTool): Record<string, unknown> {
 const out: Record<string, unknown> = {
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.parameters,
 };
 if (typeof t.strict === "boolean") out.strict = t.strict;
 return out;
}
/** Canonical tool -> Anthropic Messages shape. Carries `strict` verbatim when set. */
export function toAnthropicTool(t: CanonicalTool): Record<string, unknown> {
 const out: Record<string, unknown> = {
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
 };
 if (typeof t.strict === "boolean") out.strict = t.strict;
 return out;
}

/** Which wire API does this proxy path target? */
export function apiForPathname(pathname: string): "responses" | "messages" | "chat" {
 if (pathname.endsWith("/responses")) return "responses";
 if (pathname.endsWith("/messages")) return "messages";
 return "chat";
}

function isChatShape(tool: Record<string, unknown>): boolean {
 const fn = tool.function;
 return typeof fn === "object" && fn !== null && !Array.isArray(fn) &&
  typeof (fn as Record<string, unknown>).name === "string";
}

function isResponsesShape(tool: Record<string, unknown>): boolean {
 return tool.type === "function" && typeof tool.name === "string";
}

function isAnthropicShape(tool: Record<string, unknown>): boolean {
 // Anthropic tools carry input_schema and no type/function wrapper.
 // A flat { name, parameters } tool is NOT anthropic shape: it still needs
 // conversion (responses tools share the flat name field).
 if (tool.type === "function" || isChatShape(tool)) return false;
 if (typeof tool.name !== "string") return false;
 const schema = tool.input_schema;
 return typeof schema === "object" && schema !== null && !Array.isArray(schema);
}

function alreadyTargetShape(tool: Record<string, unknown>, api: "responses" | "messages" | "chat"): boolean {
 return api === "responses" ? isResponsesShape(tool) : api === "messages" ? isAnthropicShape(tool) : isChatShape(tool);
}

/**
 * Pi `find` has no upstream fingerprint name: callers send `find`, upstream
 * must see `glob` (params/description verbatim). OMP `glob` is untouched.
 */
export function isFindToolName(name: string): boolean {
 return name.trim().toLowerCase() === "find";
}
/** Upstream name for a caller tool name: `find` (any case) becomes `glob`. */
export function upstreamToolNameFor(name: string): string {
 return isFindToolName(name) ? "glob" : name.trim();
}
/**
 * Restore record for the find->glob rename. True only when the caller sent
 * `find` (any case) without also sending `glob`: the single upstream `glob`
 * unambiguously stands for the caller `find`. When the caller sent both,
 * upstream collapses to one `glob` (first-seen wins) and no restore applies.
 */
export interface FindGlobRestore {
 renamedFindToGlob: boolean;
}
/** Inspect the original caller tools (pre-translate) for the find->glob case. */
export function buildFindGlobRestore(callerTools: unknown[]): FindGlobRestore {
 let sawFind = false;
 let sawGlob = false;
 for (const tool of callerTools) {
  const canon = canonicalizeTool(tool);
  if (!canon) continue;
  if (isFindToolName(canon.name)) sawFind = true;
  else if (canon.name.trim().toLowerCase() === "glob") sawGlob = true;
  if (sawFind && sawGlob) break;
 }
 return { renamedFindToGlob: sawFind && !sawGlob };
}
/** Downstream name: map the upstream `glob` back to caller `find` when renamed. */
export function restoreToolNameForCaller(name: string, restore: FindGlobRestore): string {
 if (restore.renamedFindToGlob && name.trim().toLowerCase() === "glob") return "find";
 return name;
}
function retargetChoice(value: unknown, from: string, to: string): unknown {
 if (typeof value === "string") {
  return value.trim().toLowerCase() === from ? to : value;
 }
 if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
 const rec = value as Record<string, unknown>;
 let changed = false;
 let out: Record<string, unknown> = rec;
 const clone = (): void => {
  if (!changed) {
   out = { ...rec };
   changed = true;
  }
 };
 if (typeof rec.name === "string" && rec.name.trim().toLowerCase() === from) {
  clone();
  out.name = to;
 }
 const fn = rec.function;
 if (typeof fn === "object" && fn !== null && !Array.isArray(fn)) {
  const fnRec = fn as Record<string, unknown>;
  if (typeof fnRec.name === "string" && fnRec.name.trim().toLowerCase() === from) {
   clone();
   out.function = { ...fnRec, name: to };
  }
 }
 return out;
}
/**
 * Carry a caller `tool_choice` upstream across the rename (`find`->`glob`).
 * Strings, `{ name }`, and `{ function: { name } }` shapes are retargeted;
 * everything else (notably `"auto"`) passes through untouched. Never imposed:
 * callers without a choice get no choice added.
 */
export function retargetToolChoiceForUpstream(choice: unknown, restore: FindGlobRestore): unknown {
 if (!restore.renamedFindToGlob) return choice;
 return retargetChoice(choice, "find", "glob");
}
/** Carry an upstream `tool_choice` back to the caller (`glob`->`find`). */
export function restoreToolChoiceForCaller(choice: unknown, restore: FindGlobRestore): unknown {
 if (!restore.renamedFindToGlob) return choice;
 return retargetChoice(choice, "glob", "find");
}
/** Extra top-level caller fields survive cross-shape conversion verbatim. */
function carryExtraFields(
 rec: Record<string, unknown>,
 converted: Record<string, unknown>,
): void {
 for (const key of Object.keys(rec)) {
  if (
   key === "type" ||
   key === "function" ||
   key === "name" ||
   key === "description" ||
   key === "parameters" ||
   key === "input_schema" ||
   key === "strict"
  ) continue;
  if (!(key in converted)) converted[key] = rec[key];
 }
}
/**
 * Reshape a caller tool array for the target path. Tools already in the
 * target shape pass through verbatim (identical reference, every extra field
 * intact) except Pi `find`, which is renamed to `glob` even when the shape
 * already matches (new object, params/description verbatim). Function tools
 * in another shape are converted, carrying `description`/`parameters`/`strict`
 * verbatim plus every other top-level caller field except the
 * wire-shape-forbidden keys (`type`/`function` wrapper, `name`, `description`,
 * `parameters`/`input_schema`), which are remapped per target shape. Never
 * injects `additionalProperties`. Every other entry passes through verbatim.
 * Duplicates collapse first-seen-wins on the lowercased upstream name, so
 * `Bash` never duplicates `bash` and `find` collapses with `glob`.
 * Re-translating translated output adds zero tools. Never returns null entries.
 * `tool_choice` is never imposed here; use the retarget helpers to carry it.
 */
export function translateToolsForPath(tools: unknown[], pathname: string): Record<string, unknown>[] {
 const api = apiForPathname(pathname);
 const seen = new Set<string>();
 const out: Record<string, unknown>[] = [];
 for (const tool of tools) {
  if (typeof tool !== "object" || tool === null || Array.isArray(tool)) continue;
  const rec = tool as Record<string, unknown>;
  const canon = canonicalizeTool(tool);
  if (!canon) {
   // Non-function tool (or unparsable): keep verbatim so built-ins survive.
   out.push(rec);
   continue;
  }
  const upstreamName = upstreamToolNameFor(canon.name);
  const key = upstreamName.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  const needsRename = upstreamName !== canon.name;
  if (!needsRename && alreadyTargetShape(rec, api)) {
   out.push(rec);
   continue;
  }
  const renamed: CanonicalTool = needsRename
   ? { ...canon, name: upstreamName }
   : canon;
  const converted =
   api === "responses"
    ? toResponsesTool(renamed)
    : api === "messages"
     ? toAnthropicTool(renamed)
     : toChatTool(renamed);
  carryExtraFields(rec, converted);
  out.push(converted);
 }
 return out;
}
/**
 * Inject the missing compat placeholder tools into an already-translated tool
 * array, using the target path's shape. Idempotent and case-insensitive:
 * `Bash` satisfies `bash` and is never duplicated.
 */
export function injectFingerprintTools(
 tools: Record<string, unknown>[],
 pathname: string,
): Record<string, unknown>[] {
 const present = new Set<string>();
 for (const tool of tools) {
  const canon = canonicalizeTool(tool);
  if (canon) present.add(canon.name.trim().toLowerCase());
 }
 const api = apiForPathname(pathname);
 for (const name of OPENCODE_FINGERPRINT_TOOLS) {
  if (present.has(name.toLowerCase())) continue;
  const canon: CanonicalTool = {
   name,
   description: COMPAT_TOOL_DESCRIPTION,
   parameters: { type: "object", properties: {} },
  };
  tools.push(
   api === "responses"
    ? toResponsesTool(canon)
    : api === "messages"
     ? toAnthropicTool(canon)
     : toChatTool(canon),
  );
  present.add(name.toLowerCase());
 }
 return tools;
}

/**
 * Responses <-> Chat body translation. Cline serves chat completions only, so
 * responses-path requests for Cline models are translated to chat upstream
 * and the chat answer is translated back. Tool shape conversion reuses
 * translateToolsForPath; only the message envelopes are remapped here.
 * Server-side pointers (`previous_response_id`) and caller-bound reasoning
 * blobs never cross: text is extracted, everything else is dropped, so the
 * translated body stays portable by construction.
 */

/** Extract plain text from a Responses content field (string or parts array). */
function responsesTextOf(content: unknown): string | null {
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
function chatRoleFor(role: unknown): string {
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
   const args = typeof rec.arguments === "string" ? rec.arguments : JSON.stringify(rec.arguments ?? {});
   const name = typeof rec.name === "string" ? rec.name : "tool";
   const id = typeof rec.call_id === "string" ? rec.call_id : typeof rec.id === "string" ? rec.id : "";
   messages.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] });
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
 */
export function clineChatBodyFromResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
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
 for (const key of ["temperature", "top_p", "max_tokens", "max_completion_tokens", "stop", "presence_penalty", "frequency_penalty", "seed", "user", "parallel_tool_calls", "response_format"] as const) {
  if (body[key] !== undefined) out[key] = body[key];
 }
 return out;
}

/** First chat choice message, or null when the completion carries none. */
function firstChatMessage(chat: Record<string, unknown>): Record<string, unknown> | null {
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
 const id = typeof chat.id === "string" ? chat.id.replace(/^chatcmpl/, "resp") : "resp_cline";
 const output: Record<string, unknown>[] = [];
 if (message) {
  const text = typeof message.content === "string" ? message.content : null;
  if (text !== null && text.length > 0) {
   output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  }
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
   for (const tc of toolCalls) {
    if (typeof tc !== "object" || tc === null || Array.isArray(tc)) continue;
    const rec = tc as Record<string, unknown>;
    const fn = typeof rec.function === "object" && rec.function !== null && !Array.isArray(rec.function) ? (rec.function as Record<string, unknown>) : {};
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    const callId = typeof rec.id === "string" && rec.id.length > 0 ? rec.id : `call_cline_${output.length}`;
    output.push({ type: "function_call", id: callId, call_id: callId, name: typeof fn.name === "string" ? fn.name : "tool", arguments: args });
   }
  }
 }
 const choices = chat.choices;
 const first = Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object" && choices[0] !== null ? (choices[0] as Record<string, unknown>) : {};
 const out: Record<string, unknown> = {
  id,
  object: "response",
  created_at: typeof chat.created === "number" ? chat.created : Math.floor(Date.now() / 1000),
  model,
  output,
  status: first.finish_reason === "length" ? "incomplete" : "completed",
 };
 if (chat.usage !== undefined) out.usage = chat.usage;
 return out;
}

/**
 * Wrap a Responses object in the minimal valid Responses SSE sequence
 * (created + completed + DONE) so streamed responses-path clients get a
 * stream even though Cline only serves chat upstream. Round-trips through
 * sseToResponsesJson: the completed event carries the full object.
 */
export function chatResponsesSseFromChatCompletion(resp: Record<string, unknown>): string {
 const head = { type: "response.created", response: { id: resp.id, object: "response", model: resp.model } };
 const done = { type: "response.completed", response: resp };
 return `event: response.created\ndata: ${JSON.stringify(head)}\n\n` +
  `event: response.completed\ndata: ${JSON.stringify(done)}\n\n` +
  `data: [DONE]\n\n`;
}
