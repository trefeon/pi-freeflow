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
