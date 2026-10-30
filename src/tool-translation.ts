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
 *   and `type` is set per target shape. `strict` rides top-level on the
 *   Responses/Anthropic shapes and inside the chat `function` wrapper. Never
 *   injects `additionalProperties`.
 * - Non-function tools (e.g. Responses built-ins like { type: "web_search" })
 *   pass through verbatim.
 * - `parameters` and Anthropic `input_schema` are treated as the same schema.
 * - First-seen wins on duplicate names, compared case-insensitively on the
 *   upstream name (so `Bash` never duplicates `bash`, `find` collapses with
 *   `glob`). Re-translating translated output adds zero tools (idempotent).
 * - `tool_choice` is never imposed and never rewritten: Zen accepts only
 *   "auto", so the fingerprint lane drops every other choice (see
 *   enforceAutoToolChoice) and no carrier is needed. Request-side only: no
 *   response path carries a choice back to the caller.
 */

/** Compat placeholder tools the upstream gate expects (all lowercase). */
export const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read", "edit", "write"] as const;
export type FingerprintToolName = (typeof OPENCODE_FINGERPRINT_TOOLS)[number];

/**
 * Live-truth 11-tool roster (v1 1.19.4 MITM, SG): the default lane declares
 * these verbatim, replacing the OMP/COMPAT placeholder fills. bash/read/edit
 * carry the verbatim CLI schemas (bash {command, timeout, workdir}, read
 * {filePath, offset, limit}, edit {filePath, oldString, newString,
 * replaceAll?}); the rest carry the CLI-declared shapes: glob {pattern,
 * path?}, grep {pattern, path?, include?}, skill {name}, task {description,
 * prompt, subagent_type, task_id?, command?, background?}, todowrite {todos},
 * webfetch {url, format?, timeout?}, websearch {query, numResults?,
 * livecrawl?, type?, contextMaxCharacters?}, write {content, filePath}.
 */
export const FULL11_TOOL_NAMES = [
 "bash", "edit", "glob", "grep", "read",
 "skill", "task", "todowrite", "webfetch", "websearch", "write",
] as const;
export type Full11ToolName = (typeof FULL11_TOOL_NAMES)[number];
// NOTE(#124): when the live matrix proves v2 tool names matter (shell vs bash,
// path vs filePath), gate FULL11_TOOL_DEFS selection behind
// PI_FREEFLOW_OPENCODE_UA_V2 (v2 UA ⇒ v2 schemas); default stays 1.19 roster.

export const FULL11_TOOL_DEFS: Record<Full11ToolName, { description: string; parameters: Record<string, unknown> }> = {
 bash: {
  description: "Run a shell command and return its output.",
  parameters: {
   type: "object",
   properties: {
    command: { type: "string", description: "The command to execute" },
    timeout: { type: "integer", description: "Optional timeout in milliseconds" },
    workdir: { type: "string", description: "The working directory to run the command in" },
   },
   required: ["command"],
  },
 },
 edit: {
  description: "Edit a file by replacing oldString with newString.",
  parameters: {
   type: "object",
   properties: {
    filePath: { type: "string", description: "The absolute path to the file to edit" },
    oldString: { type: "string", description: "The exact string to replace" },
    newString: { type: "string", description: "The replacement string" },
    replaceAll: { type: "boolean", description: "Replace all occurrences of oldString (default false)" },
   },
   required: ["filePath", "oldString", "newString"],
  },
 },
 glob: {
  description: "Find files by glob pattern.",
  parameters: {
   type: "object",
   properties: {
    pattern: { type: "string", description: "The glob pattern to match" },
    path: { type: "string", description: "The directory to search in" },
   },
   required: ["pattern"],
  },
 },
 grep: {
  description: "Search file contents for a pattern.",
  parameters: {
   type: "object",
   properties: {
    pattern: { type: "string", description: "The search pattern" },
    path: { type: "string", description: "File or directory to search" },
    include: { type: "string", description: "File pattern to include in the search" },
   },
   required: ["pattern"],
  },
 },
 read: {
  description: "Read the contents of a file or directory.",
  parameters: {
   type: "object",
   properties: {
    filePath: { type: "string", description: "The absolute path to the file or directory to read" },
    offset: { type: "integer", description: "The line number to start reading from (1-indexed)" },
    limit: { type: "integer", description: "The maximum number of lines to read" },
   },
   required: ["filePath"],
  },
 },
 skill: {
  description: "Load an available skill by name.",
  parameters: {
   type: "object",
   properties: {
    name: { type: "string", description: "The skill name to load" },
   },
   required: ["name"],
  },
 },
 task: {
  description: "Launch a subagent task.",
  parameters: {
   type: "object",
   properties: {
    description: { type: "string", description: "A short description of the task" },
    prompt: { type: "string", description: "The task prompt for the subagent" },
    subagent_type: { type: "string", description: "The type of specialized agent to use for this task" },
    task_id: { type: "string", description: "Only set to resume a previous task in the same subagent session" },
    command: { type: "string", description: "The command that triggered this task" },
    background: { type: "boolean", description: "Run the agent in the background" },
   },
   required: ["description", "prompt", "subagent_type"],
  },
 },
 todowrite: {
  description: "Manage the task todo list.",
  parameters: {
   type: "object",
   properties: {
    todos: { type: "array", description: "The todo items", items: { type: "object" } },
   },
   required: ["todos"],
  },
 },
 webfetch: {
  description: "Fetch the contents of a URL.",
  parameters: {
   type: "object",
   properties: {
    url: { type: "string", description: "The URL to fetch" },
    format: { type: "string", description: "The format to return the content in", enum: ["text", "markdown", "html"] },
    timeout: { type: "number", description: "Optional timeout in seconds (max 120)" },
   },
   required: ["url"],
  },
 },
 websearch: {
  description: "Search the web for information.",
  parameters: {
   type: "object",
   properties: {
    query: { type: "string", description: "The search query" },
    numResults: { type: "number", description: "Number of search results to return" },
    livecrawl: { type: "string", description: "Live-crawl mode", enum: ["fallback", "preferred"] },
    type: { type: "string", description: "Search type", enum: ["auto", "fast", "deep"] },
    contextMaxCharacters: { type: "number", description: "Maximum characters for context string" },
   },
   required: ["query"],
  },
 },
 write: {
  description: "Write a file to disk.",
  parameters: {
   type: "object",
   properties: {
    filePath: { type: "string", description: "The absolute path to the file to write" },
    content: { type: "string", description: "The file content" },
   },
   required: ["filePath", "content"],
  },
 },
};

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

/**
 * OMP host built-ins: BUILTIN_TOOL_NAMES in
 * reference/oh-my-pi/packages/coding-agent/src/tools/builtin-names.ts, plus
 * browser/computer (real top-level tools in the same checkout) and `hub`.
 *
 * `find` here is OMP's semantic search (reference/oh-my-pi
 * tools/jfind/index.ts:54), NOT Pi's file finder: they are different tools
 * with different schemas, and both are declared together whenever the session
 * enables it. That is why the translator renames `find` to `glob` only when the
 * caller left the `glob` slot empty — see translateToolsForPath.
 */
export const OMP_TOOL_NAMES = [
 "read",
 "bash",
 "edit",
 "ast_grep",
 "ast_edit",
 "ask",
 "debug",
 "ida",
 "eval",
 "github",
 "glob",
 "grep",
 "find",
 "lsp",
 "checkpoint",
 "rewind",
 "context_notes",
 "new_context",
 "security_scan",
 "task",
 "wait",
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

/** OMP settings-gated custom tools: appended to customTools in sdk.ts (generate_image gated on settings generate_image.enabled, tts on speechgen.enabled). Not in BUILTIN_TOOL_NAMES; model-callable when enabled. */
export const OMP_CUSTOM_TOOL_NAMES = ["generate_image", "tts"] as const;

/** Every tool name either host can send (MCP `mcp__*` and xd:// device names pass through as-is). */
export const ALL_HOST_TOOL_NAMES: ReadonlySet<string> = new Set([
 ...PI_TOOL_NAMES,
 ...OMP_TOOL_NAMES,
 ...OMP_HIDDEN_TOOL_NAMES,
 ...OMP_CUSTOM_TOOL_NAMES,
]);

/** Placeholder description for injected compatibility tools: must never be invoked. */
export const COMPAT_TOOL_DESCRIPTION =
 "Do not call this tool. It exists only for API compatibility and must never be invoked.";

/**
 * Real minimal executable definitions for the fingerprint slots, used when the
 * caller looks like OMP (full tool inventory covers these names, so the model
 * may legitimately invoke them and the host can execute them). Single source
 * of truth for every injection site; Pi callers keep the empty COMPAT
 * placeholders above. Descriptions must never match COMPAT_TOOL_DESCRIPTION.
 *
 * `edit` is deliberately absent: OMP's edit schema is edit-mode dependent
 * (default hashline `{ input }`, replace `{ path, old_string, new_string }`,
 * patch `{ path, edits[] }`) while Pi wants `{ path, edits[{ oldText,
 * newText }] }`, so no single static def executes on either host. An injected
 * edit rides the cloak list (see enforceOpencodeFingerprint in
 * src/opencode-fingerprint.ts); a caller-declared edit still passes through
 * verbatim and executes normally.
 *
 * `glob` carries OMP GlobTool's real shape: the pattern carrier is `path`
 * (optional — omitted searches the workspace root), never a required
 * `pattern` prop.
 */
export const OMP_FINGERPRINT_DEFS: Record<Exclude<FingerprintToolName, "edit">, { description: string; parameters: Record<string, unknown> }> = {
 bash: {
  description: "Run a shell command and return its output.",
  parameters: {
   type: "object",
   properties: { command: { type: "string", description: "Shell command to run." } },
   required: ["command"],
  },
 },
 glob: {
  description: "Find files by glob pattern.",
  parameters: {
   type: "object",
   properties: {
    path: { type: "string", description: "Glob, file, or directory to search — a single path or a semicolon-delimited list. Omitted searches the workspace root." },
    hidden: { type: "boolean", description: "Include hidden files." },
    gitignore: { type: "boolean", description: "Respect gitignore." },
    limit: { type: "number", description: "Max results." },
   },
  },
 },
 grep: {
  description: "Search file contents for a pattern.",
  parameters: {
   type: "object",
   properties: {
    pattern: { type: "string", description: "Search pattern." },
    path: { type: "string", description: "File or directory to search." },
   },
   required: ["pattern"],
  },
 },
 read: {
  description: "Read a file from disk.",
  parameters: {
   type: "object",
   properties: { path: { type: "string", description: "File path to read." } },
   required: ["path"],
  },
 },
 write: {
  description: "Write a file to disk.",
  parameters: {
   type: "object",
   properties: {
    path: { type: "string", description: "File path to write." },
    content: { type: "string", description: "File content." },
   },
   required: ["path", "content"],
  },
 },
};

/** Verbatim OpenCode 1.19.0 bash/read parameter schemas (capture, word-for-word). */
export const BASH_READ_119_PARAM_SCHEMAS: Record<"bash" | "read", Record<string, unknown>> = {
 bash: {
  type: "object",
  properties: {
   command: { type: "string", description: "The command to execute" },
   timeout: { type: "integer", description: "Optional timeout in milliseconds" },
   workdir: { type: "string", description: "The working directory to run the command in" },
  },
  required: ["command"],
 },
 read: {
  type: "object",
  properties: {
   filePath: { type: "string", description: "The absolute path to the file or directory to read" },
   offset: { type: "integer", description: "The line number to start reading from (1-indexed)" },
   limit: { type: "integer", description: "The maximum number of lines to read" },
  },
  required: ["filePath"],
 },
};

/** Verbatim OpenCode v2.0.26 read/shell tool definitions (capture, word-for-word). */
export const READ_SHELL_V2_DEFS: Record<"read" | "shell", { description: string; parameters: Record<string, unknown> }> = {
 read: {
  description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
  parameters: {
   type: "object",
   properties: {
    path: { type: "string", description: "File or directory to read" },
    offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
    limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
   },
   required: ["path"],
   additionalProperties: false,
  },
 },
 shell: {
  description: "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete. DO NOT poll for completion.",
  parameters: {
   type: "object",
   properties: {
    command: { type: "string", description: "Shell command string to execute" },
    workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
    timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
    background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using the shell tool. You will be notified when it completes. DO NOT poll for completion." },
   },
   required: ["command"],
   additionalProperties: false,
  },
 },
};

/** Minimal valid schemas for injected compat tools to satisfy upstream inference gate. */
export const COMPAT_FINGERPRINT_SCHEMAS: Record<FingerprintToolName, Record<string, unknown>> = {
 bash: {
  type: "object",
  properties: { command: { type: "string", description: "Shell command to run." } },
  required: ["command"],
 },
 read: {
  type: "object",
  properties: { path: { type: "string", description: "File path to read." } },
  required: ["path"],
 },
 glob: {
  type: "object",
  properties: { path: { type: "string", description: "Search path." } },
 },
 grep: {
  type: "object",
  properties: { pattern: { type: "string", description: "Search pattern." } },
  required: ["pattern"],
 },
 edit: {
  type: "object",
  properties: { path: { type: "string", description: "File path to edit." } },
  required: ["path"],
 },
 write: {
  type: "object",
  properties: { path: { type: "string", description: "File path to write." } },
  required: ["path"],
 },
};

/** Caller tool names that only an OMP host sends (never Pi). */
export const OMP_CALLER_MARKERS = ["ask", "task", "todo", "hub", "lsp"] as const;

/**
 * True when a lowercased caller-tool name set looks like OMP: any of
 * ask/task/todo/hub/lsp present, or `glob` present at all.
 *
 * `glob` alone is the discriminator because Pi has no such tool (its file
 * finder is `find`, reference/pi core/tools/index.ts:95) while OMP declares
 * both. The old test was "glob without find", which assumed `find` was
 * Pi-exclusive; OMP ships a semantic `find` too (reference/oh-my-pi
 * tools/jfind/index.ts:54), so an OMP read-only session carrying glob+find was
 * classified as Pi and its fingerprint slots came back as non-executable
 * placeholders. Case-insensitive; pass already-lowercased names.
 */
export function isOmpLikeCaller(lowerNames: Iterable<string>): boolean {
 const set = lowerNames instanceof Set ? lowerNames : new Set(lowerNames);
 for (const m of OMP_CALLER_MARKERS) if (set.has(m)) return true;
 return set.has("glob");
}

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
 * Captures `strict` when the caller set a boolean, at either wire placement:
 * top-level (the Responses/Kilo/Anthropic position) or inside the chat
 * `function` wrapper (the canonical chat position).
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
 else if (fn && typeof fn.strict === "boolean") canon.strict = fn.strict;
 return canon;
}

/** Canonical tool -> Chat Completions shape. Carries `strict` verbatim when set. */
export function toChatTool(t: CanonicalTool): Record<string, unknown> {
 const fn: Record<string, unknown> = {
  name: t.name,
  description: t.description,
  parameters: t.parameters,
 };
 // The chat wire puts `strict` inside the `function` wrapper (canonical
 // position); a top-level `strict` on the tool object is not the chat shape.
 if (typeof t.strict === "boolean") fn.strict = t.strict;
 return { type: "function", function: fn };
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
 * Restore records for the upstream-name rewrites: `find`->`glob` and the
 * sanitization of names upstream rejects. `renamed` maps every rewritten
 * upstream name (lowercased) back to the caller's original, so an emitted
 * call still resolves to the tool the caller actually registered.
 *
 * `renamedFindToGlob` is true only when the caller sent `find` (any case)
 * without also sending `glob`: the single upstream `glob` unambiguously stands
 * for the caller `find`. When the caller sent both, upstream collapses to one
 * `glob` (first-seen wins) and no single-name restore applies.
 */
export interface FindGlobRestore {
 renamedFindToGlob: boolean;
 /** Sanitized upstream name (lowercased) -> caller name. Absent when every
  * caller name was already upstream-legal, so nothing was rewritten. */
 renamed?: Record<string, string>;
}

/**
 * Upstream accepts only `^[a-zA-Z0-9_.-]+$` as a tool name and answers
 * `400 \`name\` must match` otherwise. Hosts do send such names — measured in
 * live Pi sessions: `TG drive` (space), `env:production` (colon) — so the
 * whole request dies on one badly named tool.
 *
 * Every character outside the allowed set folds to `_`, and a collision with
 * an already-emitted name gets a numeric suffix. The caller name is recorded
 * so `restoreToolNameForCaller` puts it back; the model never sees a name it
 * cannot match against its own earlier call. A name that already matches is
 * returned unchanged, so well-formed tool sets are untouched.
 */
const UPSTREAM_NAME_SHAPE = /^[a-zA-Z0-9_.-]+$/;

/**
 * Fold one caller tool name to a shape upstream accepts. Deterministic, and a
 * pure function of the name: the same input always sanitizes to the same
 * output, which is what lets the caller name be recovered downstream.
 */
export function sanitizeUpstreamToolName(name: string, taken: ReadonlySet<string>): string {
 const trimmed = name.trim();
 if (UPSTREAM_NAME_SHAPE.test(trimmed)) return trimmed;
 let folded = trimmed.replace(/[^a-zA-Z0-9_.-]/g, "_");
 // A name made entirely of invalid characters would sanitize to a leading
 // run of underscores and collide with every other such name; anchor it.
 if (folded.length === 0) folded = "tool";
 let candidate = folded;
 let n = 2;
 while (taken.has(candidate.toLowerCase())) {
  candidate = `${folded}_${n}`;
  n += 1;
 }
 return candidate;
}
/** Inspect the original caller tools (pre-translate) for the rewrite cases. */
export function buildFindGlobRestore(callerTools: unknown[]): FindGlobRestore {
 // Same rule as translateToolsForPath: the find->glob rename fires only when
 // the caller left the `glob` slot empty. OMP declares both real tools, so
 // there the rename must not happen and `find` must keep its own name.
 const callerDeclaresGlob = callerTools.some((tool) => {
  const canon = canonicalizeTool(tool);
  return canon !== null && canon.name.trim().toLowerCase() === "glob";
 });
 const nameFor = (name: string): string => (callerDeclaresGlob ? name.trim() : upstreamToolNameFor(name));
 const renamed: Record<string, string> = {};
 // Same first-seen-wins order and case rules as translateToolsForPath, so
 // the recorded map keys match the names that actually reach upstream.
 const seen = new Set<string>();
 for (const tool of callerTools) {
  const canon = canonicalizeTool(tool);
  if (!canon) continue;
  const callerName = canon.name;
  const upstreamName = nameFor(callerName);
  // Mirrors translateToolsForPath: dedup on the lowercased
  // pre-sanitization name (a collapsed duplicate never reaches upstream),
  // then sanitize with the caller's casing intact.
  const dedupKey = upstreamName.toLowerCase();
  if (seen.has(dedupKey)) continue;
  seen.add(dedupKey);
  const sanitized = sanitizeUpstreamToolName(upstreamName, seen);
  if (sanitized.toLowerCase() !== dedupKey) seen.add(sanitized.toLowerCase());
  // Only character-folding rewrites belong in the sanitized map. The
  // find->glob rename is a single-name fallback, so a name that came in
  // as `find` must not be recorded here: upstream `glob` may be the
  // caller's own glob.
  if (sanitized !== callerName && !isFindToolName(callerName)) {
   renamed[sanitized.toLowerCase()] = callerName;
  }
 }
 const sawFind = callerTools.some((tool) => {
  const canon = canonicalizeTool(tool);
  return canon !== null && isFindToolName(canon.name);
 });
 const restored: FindGlobRestore = { renamedFindToGlob: sawFind && !callerDeclaresGlob, renamed };
 return restored;
}
/**
 * Downstream name: undo the upstream rewrites. The sanitized map is checked
 * first because it is keyed by the exact name upstream saw; the find->glob
 * case stays as the single-name fallback.
 */
export function restoreToolNameForCaller(name: string, restore: FindGlobRestore): string {
 const sanitized = restore.renamed?.[name.trim().toLowerCase()];
 if (sanitized !== undefined) return sanitized;
 if (restore.renamedFindToGlob && name.trim().toLowerCase() === "glob") return "find";
 return name;
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
 * Reshape a caller tool array for the target path. Tools already in the target
 * shape pass through verbatim (identical reference, every extra field intact).
 * Function tools in another shape are converted, carrying
 * `description`/`parameters`/`strict` verbatim plus every other top-level
 * caller field except the wire-shape-forbidden keys (`type`/`function`
 * wrapper, `name`, `description`, `parameters`/`input_schema`), which are
 * remapped per target shape. Never injects `additionalProperties`. Every other
 * entry passes through verbatim. Duplicates collapse first-seen-wins on the
 * lowercased upstream name, so `Bash` never duplicates `bash`. Re-translating
 * translated output adds zero tools. Never returns null entries.
 * `tool_choice` is never imposed here.
 *
 * Names ride the caller's own unless `forFingerprint` is set — that flag exists
 * for the OpenCode free tier alone, whose gate expects the sextet name `glob`
 * and therefore needs Pi's `find` renamed into it. On every other lane the
 * rename is pure loss: the upstream would have accepted `find`, and the host
 * gets `find` back and dispatches it natively.
 */
export function translateToolsForPath(tools: unknown[], pathname: string, opts?: { forFingerprint?: boolean }): Record<string, unknown>[] {
 const api = apiForPathname(pathname);
 // Only the OpenCode free tier needs a tool renamed: its gate looks for a
 // sextet whose `glob` slot Pi's `find` can fill. Every other upstream accepts
 // the caller's own names, so on those lanes the name rides verbatim in BOTH
 // directions and the host dispatches it natively — nothing to translate, and
 // nothing to restore.
 //
 // Even on the fingerprint lane the rename is skipped when the caller declared
 // `glob` itself: OMP declares both `glob` (file patterns) and `find`
 // (semantic search, reference/oh-my-pi tools/jfind/index.ts:54), and renaming
 // there would collapse two real tools into one under the other's schema.
 let callerDeclaresGlob = false;
 for (const tool of tools) {
  const canon = canonicalizeTool(tool);
  if (canon && canon.name.trim().toLowerCase() === "glob") {
   callerDeclaresGlob = true;
   break;
  }
 }
 const renameFind = opts?.forFingerprint === true && !callerDeclaresGlob;
 const upstreamNameFor = (name: string): string => (renameFind ? upstreamToolNameFor(name) : name.trim());
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
 // Duplicate collapse stays first-seen-wins on the lowercased upstream name
 // (`Bash` never duplicates `bash`, a Pi `find` still collapses with `glob`)
 // and runs on the pre-sanitization name: the emitted name keeps the caller's
 // casing, and the sanitizer only ever folds characters the upstream shape
 // forbids.
 const dedupKey = upstreamNameFor(canon.name).toLowerCase();
 if (seen.has(dedupKey)) continue;
 seen.add(dedupKey);
 // The find->glob rename and the name sanitization share one upstream name,
 // so a caller tool needing either is emitted under a single new name.
 const upstreamName = sanitizeUpstreamToolName(upstreamNameFor(canon.name), seen);
 if (upstreamName.toLowerCase() !== dedupKey) seen.add(upstreamName.toLowerCase());
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
 * Responses <-> Chat body translation. Cline serves chat completions only, so
 * the responses body is reshaped to chat before the Cline branch sends it,
 * and the chat answer is translated back. Tool shape conversion reuses
 * translateToolsForPath; only the message envelopes are remapped here.
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
 // Both hosts key their text block off the item id — Pi builds `textSignature`
 // from item.id, OMP stores itemId — and each synthesizes a fallback when it
 // is missing, so the message item carries one derived from the response id,
 // the way upstream OpenAI ids share a suffix.
 const messageId = `msg_${id.replace(/^resp[_-]?/, "")}`;
 const choices = chat.choices;
 const first = Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object" && choices[0] !== null ? (choices[0] as Record<string, unknown>) : {};
 const status = first.finish_reason === "length" ? "incomplete" : "completed";
 const output: Record<string, unknown>[] = [];
 if (message) {
  const text = typeof message.content === "string" ? message.content : null;
  if (text !== null && text.length > 0) {
   output.push({ type: "message", id: messageId, role: "assistant", status, content: [{ type: "output_text", text }] });
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
