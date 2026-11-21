/**
 * OpenCode Zen free-tier client fingerprint enforcement & coordinator.
 *
 * Upstream OpenCode Zen (/inference/openai/v1/chat/completions, /inference/v1
 * chat/completions, /inference/v1/responses and /inference/v1/messages)
 * validates requests against the official OpenCode agentic client fingerprint
 * (v1 1.19.4 MITM, SG). If any of the following 4 axes are missing, upstream
 * answers HTTP 403 FreeTierError:
 * 1. User-Agent (full CLI shape `opencode/<v> ai-sdk/provider-utils/4.0.23
 *    runtime/bun/1.4.4`; the pinned fallback, live npm lookup,
 *    and the >= 1.17.0 floor live in src/config.ts)
 * 2. x-opencode-session (canonical ses_[0-9a-f]{12}[0-9A-Za-z]{14} format,
 *    stable per conversation) plus a fresh x-opencode-request (msg_*) per
 *    prepare, x-opencode-client cli, and the cwd-derived x-opencode-project
 * 3. Tools: must declare the 11-tool roster {bash, edit, glob, grep, read,
 *    skill, task, todowrite, webfetch, websearch, write} with the verbatim
 *    CLI schemas (bash {command, timeout, workdir}, read {filePath, offset,
 *    limit}, edit {filePath, oldString, newString, replaceAll?}, glob
 *    {pattern, path?}, grep {pattern, path?, include?}, skill {name}, task
 *    {description, prompt, subagent_type, task_id?, command?, background?},
 *    todowrite {todos}, webfetch {url, format?, timeout?}, websearch {query,
 *    numResults?, livecrawl?, type?, contextMaxCharacters?}, write {content,
 *    filePath}). Agent turns send bare model ids with no temperature and no
 *    reasoning_effort; title-only (0-tool) turns keep both.
 * 4. Streaming: must be stream: true with stream_options {include_usage: true}
 *
 * A fifth axis lives in the body rather than the headers: the free tier refuses
 * any request whose system prompt carries no complete `<env>` environment block,
 * and it refuses with HTTP 429 FreeUsageLimitError — the same status and
 * retry-after-to-00:00-UTC body as an exhausted quota, although the quota is
 * untouched (issue #117/#118: same machine, same minute, 200 with the block and
 * 429 without it). See ensureEnvBlock below.
 *
 * This module ensures axes 3 and 4 are enforced on outgoing requests, and handles
 * bidirectional streaming conversion: if the client requested non-streaming
 * (stream: false), upstream is still sent stream: true to pass the gate, and the
 * resulting SSE stream is accumulated and converted back to a single JSON response.
 *
 * freeflow serves ONLY OMP and Pi hosts. Either host may send any of its tools
 * (see src/tool-translation.ts for the canonical inventories) in any wire shape,
 * so enforcement renames caller placeholders to lowercase (Bash -> bash),
 * translates caller tools to the target path's shape
 * (Pi find -> upstream glob via the translator), and only then injects the
 * missing placeholders. Caller tools (ls, powershell, find, web_search, ...)
 * are never dropped. Injected placeholder calls are cloaked from downstream
 * responses on all three paths; caller casing is restored via a bounded
 * per-request map (never module-global).
 *
 * A caller-declared `edit` is the one tool this lane cannot forward verbatim:
 * the gate validates the edit slot's schema, and DeepSeek's free lane rejects
 * OMP's hashline/replace shapes. It therefore rides upstream as `edit_file`
 * with its own schema, while the verbatim CLI `edit` declaration fills the slot
 * as a cloaked compat placeholder. Downstream calls to `edit_file` restore to
 * `edit`, so every host edit mode executes unchanged with no host config edit.
 */

import {
 COMPAT_TOOL_DESCRIPTION,
 FULL11_TOOL_NAMES,
 buildFindGlobRestore,
 canonicalizeTool,
 restoreToolNameForCaller,
 translateToolsForPath,
 upstreamToolNameFor,
 type FindGlobRestore,
} from "./tool-translation.ts";
import { OPENCODE_MODELS, resolveCanonicalModelId } from "./models.ts";
import { buildArgRepairSchemas } from "./tool-args.ts";
import {
 type CaseRestoreMap,
 ZEN_EMPTY_TOOLS_ENV,
 clampChatReasoningEffort,
 enforceAutoToolChoice,
 ensureChatFull11Tools,
 ensureMessagesFull11Tools,
 ensureResponsesFull11Tools,
 normalizePlaceholderCase,
 toolNameOf,
} from "./fingerprint-tools.ts";
import {
 applyOpenAiCompatVariant,
 ensureEnvBlock,
 normalizePromptCacheKey,
 normalizeResponsesBody,
} from "./fingerprint-env.ts";

export * from "./fingerprint-tools.ts";
export * from "./fingerprint-env.ts";
export * from "./sse-aggregator.ts";
export type { FindGlobRestore } from "./tool-translation.ts";

/** Unwrap a function tool in either chat ({ function }) or Responses/flat shape. */
function toolHolderOf(tool: unknown): Record<string, unknown> | null {
 if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
 const rec = tool as Record<string, unknown>;
 const fn = rec.function;
 return fn && typeof fn === "object" && !Array.isArray(fn) ? (fn as Record<string, unknown>) : rec;
}

function toolDescriptionOf(tool: unknown): string {
 const holder = toolHolderOf(tool);
 return holder !== null && typeof holder.description === "string" ? holder.description : "";
}

/**
 * Label an injected gate slot that stands in for a disguised caller tool.
 * Its parameters stay the CLI shape the gate checks; the description is what
 * stops the model from calling it instead of the caller's real, restored tool.
 */
function markToolAsCompatPlaceholder(tools: unknown, name: string): void {
 if (!Array.isArray(tools)) return;
 const wanted = name.trim().toLowerCase();
 for (const tool of tools) {
  const holder = toolHolderOf(tool);
  if (holder === null) continue;
  const raw = holder.name;
  if (typeof raw === "string" && raw.trim().toLowerCase() === wanted) {
   holder.description = COMPAT_TOOL_DESCRIPTION;
  }
 }
}

/**
 * The messages lane keeps Anthropic named choices. A choice naming a caller
 * tool whose wire spelling was rewritten (find->glob, gate disguise, folded
 * name) must follow the rename, or upstream sees a choice for a tool the
 * request no longer declares.
 */
function retargetMessagesToolChoice(body: Record<string, unknown>, findGlob: FindGlobRestore): void {
 const choice = body.tool_choice;
 if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return;
 const rec = choice as Record<string, unknown>;
 if (rec.type !== "tool" || typeof rec.name !== "string") return;
 const wanted = rec.name.trim().toLowerCase();
 const tools = Array.isArray(body.tools) ? body.tools : [];
 for (const tool of tools) {
  const canon = canonicalizeTool(tool);
  if (!canon) continue;
  if (restoreToolNameForCaller(canon.name, findGlob).trim().toLowerCase() === wanted) {
   rec.name = canon.name.trim();
   return;
  }
 }
}

/**
 * Enforce the full OpenCode free-tier client fingerprint on a parsed request body.
 * Caller placeholders are lowercased (Bash -> bash),
 * tools translated to the target path's wire shape (Pi find -> upstream glob via
 * src/tool-translation.ts), then the missing live-truth 11-roster slots injected
 * in that shape with their verbatim CLI definitions (bash {command, timeout,
 * workdir}, read {filePath, offset, limit}, edit {filePath, oldString,
 * newString}). A caller-declared `edit` is renamed to `edit_file` and never
 * occupies the gate slot: some free lanes (DeepSeek) reject every other edit
 * shape, so the slot is always the CLI declaration, injected as a cloaked compat
 * placeholder. Downstream calls to `edit_file` restore to the caller's `edit`
 * and execute normally. Chat bodies additionally gain stream_options
 * {include_usage: true} for the openai-compat lane.
 * `argSchemas` (lowercased caller tool name -> declared parameters) lets
 * downstream repair malformed arguments against the caller's own schema; it
 * is empty when no caller tool declares a structured parameter, so such
 * requests keep streaming byte-identically.
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
 argSchemas: Map<string, Record<string, unknown>>;
} {
 const clientRequestedStream = body.stream === true;
 normalizePromptCacheKey(body);
 const callerHadTools = Array.isArray(body.tools) && body.tools.length > 0;
 // Opt-in title-only lane: with PI_FREEFLOW_ZEN_EMPTY_TOOLS=1 a tool-less
 // caller rides through with 0 tools (still stream:true + stream_options +
 // env block). Default (unset) keeps today's 11-injection.
 const emptyToolsLane = process.env[ZEN_EMPTY_TOOLS_ENV] === "1" && !callerHadTools;
 // Zen takes the bare model id: the live CLI sends `model: <bare>` (e.g.
 // glm-5.3-flash-free), never the `opencode/`-prefixed catalog id the host
 // may carry. Strip one prefix so a prefixed id still routes.
 if (typeof body.model === "string") {
  const stripped = body.model.startsWith("opencode/") ? body.model.slice("opencode/".length) : body.model;
  const canonical = resolveCanonicalModelId(stripped);
  body.model = OPENCODE_MODELS.some((m) => m.id === canonical) ? canonical : stripped;
 }
 // Zen responses shape conformance first (Chat leftovers, tool_choice, spark
 // effort clamp, store default): Kilo/Cline bodies never reach here.
 if (pathname.endsWith("/responses")) normalizeResponsesBody(body);
 else if (pathname.endsWith("/chat/completions")) clampChatReasoningEffort(body);
 // Chat and responses drop every non-"auto" choice (Zen accepts only "auto").
 // The messages lane keeps Anthropic choices, so a named choice follows any
 // wire-name rewrite after translation (find->glob, gate disguise, folding).
 if (!pathname.endsWith("/messages")) enforceAutoToolChoice(body);
 // Agent turns carry no sampling knobs: the live CLI's agent calls send
 // neither temperature nor reasoning_effort, while its title calls
 // (0 caller tools) send both. Strip on tool-carrying turns only; the
 // title-only path keeps the caller's values (clamped above).
 if (callerHadTools && !pathname.endsWith("/messages")) {
  delete body.temperature;
  delete body.reasoning_effort;
  delete body.reasoningEffort;
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
   delete (reasoning as Record<string, unknown>).effort;
   if (Object.keys(reasoning as Record<string, unknown>).length === 0) delete body.reasoning;
  }
 }
 // Upstream Zen free tier mandates stream: true for all free requests
 body.stream = true;
 // Fifth axis, body-side: a system prompt without a complete env block answers
 // 429 FreeUsageLimitError (see ensureEnvBlock). After the shape normalization
 // above, so the responses path edits the field upstream will actually read.
 ensureEnvBlock(body, pathname);

 const caseRestore = normalizePlaceholderCase(body);

 // No tool_choice retargeting on chat or responses: enforceAutoToolChoice
 // above already deleted every non-"auto" choice (Zen accepts only "auto"),
 // so the only survivor is the string "auto" — nothing to rename. The
 // messages lane keeps its choices and retargets named ones after translation.
 const findGlob = buildFindGlobRestore(Array.isArray(body.tools) ? body.tools : [], { forFingerprint: true });
 // Captured before translation and injection: the map is keyed by CALLER tool
 // name (what arrives downstream), and injected placeholders must not be
 // repairable.
 const argSchemas = buildArgRepairSchemas(Array.isArray(body.tools) ? body.tools : []);
 const injected: string[] = [];
 let addedTools = false;
 const callerEditTool = Array.isArray(body.tools)
  ? body.tools.find((tool) => toolNameOf(tool).toLowerCase() === "edit")
  : undefined;
 const callerHadCompatEdit =
  callerEditTool !== undefined && toolDescriptionOf(callerEditTool) === COMPAT_TOOL_DESCRIPTION;
 if (emptyToolsLane) {
  // Title-only lane: no injection, but the chat lane still carries the usage
  // accounting the CLI's openai-compat request sends.
  if (!pathname.endsWith("/responses") && !pathname.endsWith("/messages")) applyOpenAiCompatVariant(body);
 } else {
  const callerUpstream = new Set<string>();
  if (Array.isArray(body.tools)) {
   for (const tool of body.tools) {
    const n = toolNameOf(tool);
    if (n) {
     callerUpstream.add(upstreamToolNameFor(n).toLowerCase());
    }
   }
  }
  const missing = FULL11_TOOL_NAMES.filter((n) => !callerUpstream.has(n.toLowerCase()));
  // Cloak list carries every injected slot: none of them is the caller's own
  // tool, so model calls to them must never execute downstream. The edit slot
  // is always the CLI compat declaration — the caller's real edit rides as
  // `edit_file` and is restored downstream — so it stays in this list even when
  // the caller declared an edit.
  injected.push(...missing);

  // Zen alone asks for a rename: its free-tier gate looks for the roster name
  // `glob`, so a Pi caller that sent `find` needs it renamed into that slot.
  // Every other lane accepts the caller's own names untouched.
  if (Array.isArray(body.tools)) {
   const translatedTools = translateToolsForPath(body.tools, pathname, { forFingerprint: true });
   body.tools = translatedTools;
   if (pathname.endsWith("/messages")) retargetMessagesToolChoice(body, findGlob);
   // Recompute against the names upstream will actually see. A disguised
   // caller tool (`edit` -> `edit_file`) no longer fills the gate slot, so that
   // slot must be injected with the CLI definition it is checked against.
   const translatedUpstream = new Set<string>();
   for (const tool of translatedTools) {
    const n = toolNameOf(tool);
    if (n) translatedUpstream.add(upstreamToolNameFor(n).toLowerCase());
   }
   missing.length = 0;
   missing.push(...FULL11_TOOL_NAMES.filter((n) => !translatedUpstream.has(n.toLowerCase())));
   injected.length = 0;
   injected.push(...missing);
  }

  const before = Array.isArray(body.tools) ? body.tools.length : 0;
  if (pathname.endsWith("/responses")) {
   ensureResponsesFull11Tools(body);
  } else if (pathname.endsWith("/messages")) {
   ensureMessagesFull11Tools(body);
  } else {
   ensureChatFull11Tools(body);
   // The openai-compat lane carries usage accounting the way the CLI's
   // openai-compat request does.
   applyOpenAiCompatVariant(body);
  }
  const after = Array.isArray(body.tools) ? body.tools.length : 0;
  addedTools = after > before;
  if (injected.includes("edit")) {
   markToolAsCompatPlaceholder(body.tools, "edit");
  } else if (callerHadCompatEdit) {
   // Already a placeholder from an earlier enforce pass (a retry of the same
   // repaired body): keep it non-executable even though nothing was injected.
   injected.push("edit");
  }
 }

 // Note: Upstream OpenCode Zen explicitly rejects any tool_choice other than "auto"
 // with HTTP 400 (only "auto" is supported). tool_choice is auto-or-absent on the
 // responses and chat paths (normalizeResponsesBody / enforceAutoToolChoice above),
 // the Zen messages lane keeps the caller's own choice semantics (Anthropic
 // spells choices with `any` / `{ type: "tool", name: ... }`), and we never
 // impose a choice.
 // Injected edit slots are always the COMPAT declaration marked above; when the
 // caller declared its own edit it rides as `edit_file` and is restored
 // downstream. Placeholder calls stay silent, real caller tools execute.

 return { clientRequestedStream, callerHadTools, addedTools, caseRestore, findGlob, injected, argSchemas };
}
