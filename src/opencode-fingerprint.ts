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
 */

import {
 FULL11_TOOL_NAMES,
 buildFindGlobRestore,
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

/**
 * Enforce the full OpenCode free-tier client fingerprint on a parsed request body.
 * Caller placeholders are lowercased (Bash -> bash),
 * tools translated to the target path's wire shape (Pi find -> upstream glob via
 * src/tool-translation.ts), then the missing live-truth 11-roster slots injected
 * in that shape with their verbatim CLI definitions (bash {command, timeout,
 * workdir}, read {filePath, offset, limit}, edit {filePath, oldString,
 * newString}). `edit` rides real-or-drop: the real schema when injected, still
 * cloaked downstream like every other injected slot. Returns the original
 * stream flag, caller-tools flag, whether injection added tools, and the
 * bounded per-request restore records (caseRestore, findGlob, injected)
 * for downstream cloaking. Cloaking strips by `injected` only: injected slots
 * are never the caller's own tools, so model calls to them never execute.
 * Chat bodies additionally gain stream_options {include_usage: true} for the
 * openai-compat lane.
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
 // Chat path mirrors the responses drop: Zen free tier accepts only auto, so a
 // caller "none" (string or { type: "none" }) would 400 upstream. The Zen
 // messages lane keeps its own choice semantics: Anthropic names choices with
 // `any` / `{ type: "tool", name: ... }`, and the drop would delete them.
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

 // No tool_choice retargeting here: enforceAutoToolChoice above already
 // deleted every non-"auto" choice (Zen accepts only "auto"), so the only
 // survivor is the string "auto" — nothing to rename, no choice to carry.
 const findGlob = buildFindGlobRestore(Array.isArray(body.tools) ? body.tools : []);
 // Captured before translation and injection: the map is keyed by CALLER tool
 // name (what arrives downstream), and injected placeholders must not be
 // repairable.
 const argSchemas = buildArgRepairSchemas(Array.isArray(body.tools) ? body.tools : []);
 const injected: string[] = [];
 let addedTools = false;
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
  // tool, so model calls to them must never execute downstream — edit included,
  // even though it now rides with its real schema (real-or-drop, never a
  // no-op placeholder).
  injected.push(...missing);

  // Zen alone asks for a rename: its free-tier gate looks for the roster name
  // `glob`, so a Pi caller that sent `find` needs it renamed into that slot.
  // Every other lane accepts the caller's own names untouched.
  if (Array.isArray(body.tools)) {
   body.tools = translateToolsForPath(body.tools, pathname, { forFingerprint: true });
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
 }

 // Note: Upstream OpenCode Zen explicitly rejects any tool_choice other than "auto"
 // with HTTP 400 (only "auto" is supported). tool_choice is auto-or-absent on the
 // responses and chat paths (normalizeResponsesBody / enforceAutoToolChoice above),
 // the Zen messages lane keeps the caller's own choice semantics (Anthropic
 // spells choices with `any` / `{ type: "tool", name: ... }`), and we never
 // impose a choice.
 // Empty-placeholder callers stay silent via the COMPAT description and the
 // output-aggregator; real OMP definitions execute normally.

 return { clientRequestedStream, callerHadTools, addedTools, caseRestore, findGlob, injected, argSchemas };
}
