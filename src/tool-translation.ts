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
 *
 * Translation rules:
 * - Function tools are normalized to { name, description, parameters } and
 *   re-emitted in the target shape. Caller tools are NEVER dropped or renamed.
 * - Non-function tools (e.g. Responses built-ins like { type: "web_search" })
 *   pass through verbatim.
 * - `parameters` and Anthropic `input_schema` are treated as the same schema.
 * - First-seen wins on duplicate names.
 */

/** File-search tool quartet the upstream OpenCode Zen free tier mandates. */
export const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"] as const;

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

/** OMP host built-ins: BUILTIN_TOOL_NAMES in reference/oh-my-pi packages/coding-agent/src/tools/builtin-names.ts */
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
 return {
  name: rawName,
  description:
   typeof t.description === "string"
    ? t.description
    : fn && typeof fn.description === "string"
     ? fn.description
     : "",
  parameters: schemaOf(t, fn),
 };
}

/** Canonical tool -> Chat Completions shape. */
export function toChatTool(t: CanonicalTool): Record<string, unknown> {
 return {
  type: "function",
  function: {
   name: t.name,
   description: t.description,
   parameters: t.parameters,
  },
 };
}

/** Canonical tool -> Responses shape. */
export function toResponsesTool(t: CanonicalTool): Record<string, unknown> {
 return {
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.parameters,
 };
}

/** Canonical tool -> Anthropic Messages shape. */
export function toAnthropicTool(t: CanonicalTool): Record<string, unknown> {
 return {
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
 };
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
 * Reshape a caller tool array for the target path. Tools already in the
 * target shape pass through verbatim (every extra field intact); function
 * tools in another shape are converted, carrying `strict` when the caller
 * set it (all three APIs accept it). Every other entry passes through
 * verbatim. Duplicates collapse first-seen-wins. Never returns null entries.
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
  if (seen.has(canon.name)) continue;
  seen.add(canon.name);
  if (alreadyTargetShape(rec, api)) {
   out.push(rec);
   continue;
  }
  const converted =
   api === "responses"
    ? toResponsesTool(canon)
    : api === "messages"
     ? toAnthropicTool(canon)
     : toChatTool(canon);
  if (typeof rec.strict === "boolean") converted.strict = rec.strict;
  out.push(converted);
 }
 return out;
}

/**
 * Inject the missing fingerprint quartet into an already-translated tool
 * array, using the target path's shape. Idempotent.
 */
export function injectFingerprintTools(
 tools: Record<string, unknown>[],
 pathname: string,
): Record<string, unknown>[] {
 const present = new Set<string>();
 for (const tool of tools) {
  const canon = canonicalizeTool(tool);
  if (canon) present.add(canon.name);
 }
 const api = apiForPathname(pathname);
 for (const name of OPENCODE_FINGERPRINT_TOOLS) {
  if (present.has(name)) continue;
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
  present.add(name);
 }
 return tools;
}
