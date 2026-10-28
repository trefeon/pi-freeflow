/**
 * OpenCode Zen free-tier client fingerprint enforcement & SSE stream aggregator.
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
 FULL11_TOOL_DEFS,
 FULL11_TOOL_NAMES,
 buildFindGlobRestore,
 restoreToolNameForCaller,
 sanitizeUpstreamToolName,
 translateToolsForPath,
 upstreamToolNameFor,
 type FindGlobRestore,
 type FingerprintToolName,
} from "./tool-translation.ts";
import { buildArgRepairSchemas, repairToolArguments, repairToolArgumentsValue } from "./tool-args.ts";
import { getModelDef } from "./models.ts";
import type { ThinkingLevel } from "./types.ts";

/** Effort levels in descending priority (off excluded — clamping to off is never correct). */
const EFFORT_DESCENDING: ThinkingLevel[] = ["max", "xhigh", "high", "medium", "low", "minimal"];

/**
 * Find the highest supported effort for a model whose thinkingLevelMap
 * declares the requested effort as null. Returns null when no clamp is
 * needed (effort is supported or model has no map). The one supported effort
 * that is still rewritten is `ultra` (see below): it is an alias, never a
 * value the gateway enumerates.
 */
function clampedEffortFor(model: string, effort: string): string | null {
 const def = getModelDef(model);
 if (!def?.thinkingLevelMap) return null;
 const map = def.thinkingLevelMap;
 // "off" means disable reasoning entirely — never clamp it even when map says null
 if (effort.toLowerCase() === "off") return null;
 // "ultra" is an unofficial alias for beyond-max: treated as "max" for the
 // support test, and rewritten to the model's own mapped value below. Using
 // the alias only for the clamp test left `ultra` on the wire, and the
 // gateway answers 400 for every effort level its model does not enumerate.
 const isUltra = effort.toLowerCase() === "ultra";
 const key = (isUltra ? "max" : effort.toLowerCase()) as ThinkingLevel;
 // Alias of a supported level: rewrite, because upstream knows the level, not
 // the alias.
 if (isUltra && key in map && map[key] !== null && map[key] !== undefined) return map[key];
 // Effort is supported (non-null) → no clamp
 if (key in map && map[key] !== null && map[key] !== undefined) return null;
 // Effort key is unknown and not "ultra" → let upstream decide
 if (!(key in map) && !isUltra) return null;
 // Find highest supported effort
 for (const level of EFFORT_DESCENDING) {
  if (map[level] !== null && map[level] !== undefined) return level;
 }
 return null;
}

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
export type { FindGlobRestore } from "./tool-translation.ts";

/** Lowercase roster names the gate expects (live-truth 11-tool roster). */
const PLACEHOLDER_BY_LOWER_NAME: Record<string, true> = {};
for (const n of FULL11_TOOL_NAMES) PLACEHOLDER_BY_LOWER_NAME[n.toLowerCase()] = true;

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
 * Merge the missing live-truth 11-tool roster into a body in its wire shape.
 * Idempotent and case-insensitive; caller tools pass through verbatim.
 * Every slot carries the verbatim CLI definition (edit included — real
 * schema, never a no-op placeholder), and every injected slot stays in the
 * cloak list so model calls to non-caller tools never execute downstream.
 */
function full11Present(body: Record<string, unknown>): Set<string> {
 const present = new Set<string>();
 if (Array.isArray(body.tools)) {
  for (const tool of body.tools) {
   const name = toolNameOf(tool);
   if (name) present.add(name.toLowerCase());
  }
 } else {
  body.tools = [];
 }
 return present;
}

export function ensureChatFull11Tools(body: Record<string, unknown>): void {
 if (!body || typeof body !== "object") return;
 const present = full11Present(body);
 for (const name of FULL11_TOOL_NAMES) {
  if (present.has(name)) continue;
  const def = FULL11_TOOL_DEFS[name];
  (body.tools as unknown[]).push({
   type: "function",
   function: {
    name,
    description: def.description,
    parameters: { ...(def.parameters as Record<string, unknown>) },
   },
  });
  present.add(name);
 }
}

export function ensureResponsesFull11Tools(body: Record<string, unknown>): void {
 if (!body || typeof body !== "object") return;
 const present = full11Present(body);
 for (const name of FULL11_TOOL_NAMES) {
  if (present.has(name)) continue;
  const def = FULL11_TOOL_DEFS[name];
  (body.tools as unknown[]).push({
   type: "function",
   name,
   description: def.description,
   parameters: { ...(def.parameters as Record<string, unknown>) },
  });
  present.add(name);
 }
}

export function ensureMessagesFull11Tools(body: Record<string, unknown>): void {
 if (!body || typeof body !== "object") return;
 const present = full11Present(body);
 for (const name of FULL11_TOOL_NAMES) {
  if (present.has(name)) continue;
  const def = FULL11_TOOL_DEFS[name];
  (body.tools as unknown[]).push({
   name,
   description: def.description,
   input_schema: { ...(def.parameters as Record<string, unknown>) },
  });
  present.add(name);
 }
}

/**
 * Drop `phase: "commentary"` from assistant message items in the replayed
 * history.
 *
 * Upstream tags the lead-in text of a tool-calling turn `phase: "commentary"`
 * and the closing answer `phase: "final_answer"`. When the model narrates a
 * tool call and emits none (the muse-spark ATEM leak, upstream
 * anomalyco/opencode#44659), that commentary item ends its own turn — and
 * upstream then rejects every replay of the history with `400
 * invalid_request_error: The request contains invalid parameters`.
 *
 * Measured on `muse-spark-1.3-contributor-free`, one field at a time: the
 * phase alone decides it. A terminal commentary item 400s; the same item
 * followed by a function call, or by a `final_answer` item, returns 200; the
 * id prefix and the text are irrelevant. Only the phase field is removed, and
 * `phase` is output metadata the model never reads as instruction, so dropping
 * it cannot change the answer.
 *
 * Every assistant message is swept, not just the turn's last item: upstream
 * validates the whole replayed history, and a host may seat `system`,
 * `developer` or additional-tool items between a commentary item and the next
 * user message, so a tail-only sweep would miss one. One sweep also covers a
 * commentary item left behind by an earlier turn once later turns append to
 * the same history.
 */
function stripCommentaryPhase(body: Record<string, unknown>): void {
 const input = body.input;
 if (!Array.isArray(input)) return;
 for (const item of input) {
  if (!item || typeof item !== "object" || Array.isArray(item)) continue;
  const record = item as Record<string, unknown>;
  if (record.role === "assistant" && record.phase === "commentary") delete record.phase;
 }
}

/**
 * Reduce `tool_choice` to what Zen accepts: `"auto"`, or absent.
 *
 * Upstream rejects every other value with `400 only "auto" is supported for
 * tool_choice` — `"none"`, `"required"`, and named function choices alike
 * (measured live 2026-10-12 on `muse-spark-1.3-contributor-free`, responses and
 * chat). Absent means the same thing as `"auto"`, so an unsupported choice is
 * dropped rather than translated. A choice is never imposed on a host that
 * sent none.
 *
 * Dropping a choice can leave a host's native reasoning switched off: OMP
 * forces its synthetic `think` tool with `reasoning: { effort: "none" }`
 * (captured request 2026-10-12), so removing the forced call without
 * restoring native effort would run the model with no reasoning at all.
 */
function enforceAutoToolChoice(body: Record<string, unknown>): void {
 const choice = body.tool_choice;
 if (choice === undefined) return;
 if (typeof choice === "string" && choice.trim().toLowerCase() === "auto") return;
 delete body.tool_choice;
 restoreNativeEffortAfterChoiceDrop(body);
}

/**
 * Put native reasoning back when the only thing enabling it was a dropped
 * forced tool call.
 *
 * `"none"` is not a reasoning-off switch upstream, it is an unsupported value:
 * `muse-spark-1.3-contributor-free` answers `400 reasoning_effort 'none' is
 * not supported` (measured 2026-10-12). So the override is replaced with the
 * model's own highest supported level rather than merely deleted, and a model
 * whose declared map supports nothing but `off` gets the field dropped.
 * Genuine reasoning-off (`"off"`) is the caller's real intent, never rewritten.
 */
function restoreNativeEffortAfterChoiceDrop(body: Record<string, unknown>): void {
 const model = body.model;
 if (typeof model !== "string") return;
 const replacement = highestSupportedEffort(model);
 if (replacement === null) return;
 const nested = body.reasoning;
 if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
  const rec = nested as Record<string, unknown>;
  if (typeof rec.effort === "string" && rec.effort.trim().toLowerCase() === "none") {
   rec.effort = replacement;
   return;
  }
 }
 for (const key of ["reasoning_effort", "reasoningEffort"] as const) {
  const flat = body[key];
  if (typeof flat === "string" && flat.trim().toLowerCase() === "none") {
   body[key] = replacement;
   return;
  }
 }
}

/**
 * Highest non-null level a model's declared map supports, or null when the
 * model declares no map or only supports `off` (nothing to fall back to).
 */
/**
 * Chat-lane mirror of the responses effort clamp (normalizeResponsesBody):
 * a host targeting the chat path spells the effort flat — `reasoning_effort`
 * or `reasoningEffort` — and the same clampedEffortFor algorithm applies.
 * A level the model's map declares unsupported is clamped to the highest
 * supported one; a supported level or a key the map does not know is left
 * for upstream to rule on; genuine `off` is never rewritten. The Zen
 * messages lane carries no flat effort spelling, so it is not touched.
 */
function clampChatReasoningEffort(body: Record<string, unknown>): void {
 const model = body.model;
 if (typeof model !== "string") return;
 for (const key of ["reasoning_effort", "reasoningEffort"] as const) {
  const flat = body[key];
  if (typeof flat !== "string") continue;
  const clamped = clampedEffortFor(model, flat);
  if (clamped !== null) body[key] = clamped;
 }
}

/**
 * Highest non-null level a model's declared map supports, or null when the
 * model declares no map or only supports `off` (nothing to fall back to).
 */
function highestSupportedEffort(model: string): string | null {
 const map = getModelDef(model)?.thinkingLevelMap;
 if (!map) return null;
 for (const level of EFFORT_DESCENDING) {
  if (map[level] !== null && map[level] !== undefined) return level;
 }
 return null;
}

/**
 * Fold the name of a replayed tool-call item to a shape upstream accepts.
 *
 * A model can emit a malformed call and the host then replays it in `input[]`
 * forever: upstream validates every replayed item, so one call named
 * `id id=` (captured in a live session, emitted by `space-bunny-free`) 400s
 * every subsequent turn of that conversation. Declarations were sanitized
 * already; this covers the calls.
 */
function sanitizeReplayItemNames(body: Record<string, unknown>): void {
 const input = body.input;
 if (!Array.isArray(input)) return;
 for (const item of input) {
  if (!item || typeof item !== "object" || Array.isArray(item)) continue;
  const record = item as Record<string, unknown>;
  if (record.type !== "function_call" && record.type !== "custom_tool_call") continue;
  const name = record.name;
  if (typeof name !== "string") continue;
  const folded = sanitizeUpstreamToolName(name, new Set());
  if (folded !== name) record.name = folded;
 }
}

/**
 * Normalize a Zen Responses body to what upstream accepts. OMP/Pi hosts
 * sometimes carry Chat Completions leftovers on the responses path and
 * upstream rejects them with 400:
 * - `messages` becomes `input` (copied when `input` is absent, dropped either
 *   way — the responses API has no `messages` field).
 * - `max_tokens` / `max_completion_tokens` become `max_output_tokens` (copied
 *   when absent, dropped either way).
 * - `temperature` / `top_p` are dropped (Responses rejects them).
 * - `response_format` is dropped (Chat Completions field, Responses rejects it).
 * - `parallel_tool_calls: false` is dropped; absent-or-true rides verbatim.
 * - `tool_choice` is auto-or-absent: `"auto"` rides verbatim and everything
   else is dropped, because Zen supports no other value (see
   enforceAutoToolChoice).
 * - `store` defaults to false (never persisted server-side).
 * - Assistant message items lose `phase: "commentary"`; upstream 400s the whole
   request otherwise (see stripCommentaryPhase).
 * - Reasoning effort is clamped per model: when the model's thinkingLevelMap
 *   declares the requested effort as null (unsupported), the effort is clamped
 *   to the highest supported level. Covers all OpenCode models generically
 *   (muse-spark, mimo, nemotron, etc.), not just a single model family.
 * Zen-responses only: chat/messages paths keep their own fields, and Kilo/Cline
 * bodies never reach here (the proxy fingerprints Zen bodies exclusively).
 */
export function normalizeResponsesBody(body: Record<string, unknown>): void {
 if (!body || typeof body !== "object") return;
 if (body.input === undefined && Array.isArray(body.messages)) {
  body.input = body.messages;
 }
 delete body.messages;
 stripCommentaryPhase(body);
 // After input[] exists: a replayed call name is only folded once the array is
 // the one upstream will read.
 sanitizeReplayItemNames(body);
 if (body.max_output_tokens === undefined) {
  if (typeof body.max_tokens === "number") body.max_output_tokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === "number") body.max_output_tokens = body.max_completion_tokens;
 }
 delete body.max_tokens;
 delete body.max_completion_tokens;
 delete body.temperature;
 delete body.top_p;
 delete body.response_format;
 if (body.parallel_tool_calls === false) delete body.parallel_tool_calls;
 if (typeof body.model === "string") {
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
   const effort = (reasoning as Record<string, unknown>).effort;
   if (typeof effort === "string") {
    const clamped = clampedEffortFor(body.model as string, effort);
    if (clamped !== null) (reasoning as Record<string, unknown>).effort = clamped;
   }
  }
  for (const key of ["reasoning_effort", "reasoningEffort"] as const) {
   const flat = body[key];
   if (typeof flat === "string") {
    const clamped = clampedEffortFor(body.model as string, flat);
    if (clamped !== null) body[key] = clamped;
   }
  }
 }
 // After the effort clamp: dropping a forced tool call is what triggers the
 // native-effort restore, so it runs once clamping is settled.
 enforceAutoToolChoice(body);
 if (body.store === undefined) body.store = false;
}

/** Complete `<env>` … `</env>` pair; non-greedy so two blocks stay two matches. */
const ENV_PAIR_RE = /<env>[\s\S]*?<\/env>/g;
/** A tag whose partner is missing or was stripped: it can shadow the real pair. */
const ENV_TAG_RE = /<\/?env>/g;
/** The gate's load-bearing key. Any value passes; a different key does not. */
const WORKING_DIRECTORY_RE = /Working directory:[ \t]*([^\n<]*)/;
/** The gate reads the key, not a usable path: this block is a fingerprint. */
const FALLBACK_WORKING_DIRECTORY = "(current project)";

/** One mutable piece of system-prompt text: the only place a block can live. */
type SystemText = { read(): string; write(text: string): void };

/** `container[key]` as a mutable string segment. */
function stringSegment(container: Record<string, unknown>, key: string): SystemText {
 return {
  read: () => (typeof container[key] === "string" ? (container[key] as string) : ""),
  write: (text) => {
   container[key] = text;
  },
 };
}

/** The text blocks of a parts array (`content[]` / Anthropic `system[]`). */
function textBlockSegments(blocks: unknown[]): SystemText[] {
 const segments: SystemText[] = [];
 for (const block of blocks) {
  if (!block || typeof block !== "object" || Array.isArray(block)) continue;
  const rec = block as Record<string, unknown>;
  if (typeof rec.text !== "string") continue;
  segments.push({
   read: () => rec.text as string,
   write: (text) => {
    rec.text = text;
   },
  });
 }
 return segments;
}

/**
 * Text segments of a `content` field: a plain string, or the text blocks of a
 * parts array (Chat Completions spells message content both ways). A parts
 * array with no text block gains one, because there is nowhere else to append.
 */
function contentSegments(message: Record<string, unknown>): SystemText[] {
 const content = message.content;
 if (!Array.isArray(content)) {
  if (typeof content !== "string") message.content = "";
  return [stringSegment(message, "content")];
 }
 const segments = textBlockSegments(content);
 if (segments.length > 0) return segments;
 const block: Record<string, unknown> = { type: "text", text: "" };
 content.push(block);
 return [stringSegment(block, "text")];
}

/**
 * Chat Completions system prompt: every `role: "system"` message in order.
 * A body with none gains one at the top.
 */
function chatSystemSegments(body: Record<string, unknown>): SystemText[] {
 const existing = body.messages;
 // A non-array messages value carries no system prompt; coerce to an array
 // so the env block still lands (a shape violation either way, but a 429
 // without the block hides the real error).
 if (existing !== undefined && !Array.isArray(existing)) body.messages = [];
 const messages: unknown[] = Array.isArray(body.messages) ? body.messages : ((body.messages = []) as unknown[]);
 const segments: SystemText[] = [];
 for (const message of messages) {
  if (!message || typeof message !== "object" || Array.isArray(message)) continue;
  const rec = message as Record<string, unknown>;
  if (rec.role !== "system") continue;
  segments.push(...contentSegments(rec));
 }
 if (segments.length > 0) return segments;
 const added: Record<string, unknown> = { role: "system", content: "" };
 messages.unshift(added);
 return [stringSegment(added, "content")];
}

/** Anthropic Messages system prompt: `system` is a string or a text-block array. */
function messagesSystemSegments(body: Record<string, unknown>): SystemText[] {
 const system = body.system;
 if (Array.isArray(system)) {
  const segments = textBlockSegments(system);
  if (segments.length > 0) return segments;
  const block: Record<string, unknown> = { type: "text", text: "" };
  system.push(block);
  return [stringSegment(block, "text")];
 }
 if (typeof system !== "string") body.system = "";
 return [stringSegment(body, "system")];
}

/**
 * Responses system prompt: `instructions`, or the `system` / `developer` items
 * a host seats in `input[]` instead. Real OpenCode clients send `instructions`,
 * so a host that sends neither gets one.
 */
function responsesSystemSegments(body: Record<string, unknown>): SystemText[] {
 if (typeof body.instructions === "string") return [stringSegment(body, "instructions")];
 const input = body.input;
 if (Array.isArray(input)) {
  const segments: SystemText[] = [];
  for (const item of input) {
   if (!item || typeof item !== "object" || Array.isArray(item)) continue;
   const rec = item as Record<string, unknown>;
   if (rec.role !== "system" && rec.role !== "developer") continue;
   if (typeof rec.content === "string") {
    segments.push(stringSegment(rec, "content"));
   } else if (Array.isArray(rec.content)) {
    // Array-content system/developer items (Responses text-block parts):
    // edit the text blocks in place rather than ignoring the item.
    segments.push(...textBlockSegments(rec.content));
   } else {
    continue;
   }
  }
  if (segments.length > 0) return segments;
 }
 body.instructions = "";
 return [stringSegment(body, "instructions")];
}

/**
 * Every complete env block in the system text, in wire order. Upstream reads
 * only the FIRST pair, which is why order decides whether a request passes.
 */
function envBlocks(segments: SystemText[]): Array<{ segment: number; start: number; end: number; body: string }> {
 const blocks: Array<{ segment: number; start: number; end: number; body: string }> = [];
 segments.forEach((segment, index) => {
  for (const match of segment.read().matchAll(ENV_PAIR_RE)) {
   if (match.index === undefined) continue;
   blocks.push({ segment: index, start: match.index, end: match.index + match[0].length, body: match[0] });
  }
 });
 return blocks;
}

/** Drop every env block and stray tag from `text`, keeping one pair verbatim. */
function stripEnvBlocks(text: string, keep?: { start: number; end: number }): string {
 const strip = (part: string) => part.replace(ENV_PAIR_RE, "").replace(ENV_TAG_RE, "");
 const result =
  keep === undefined
   ? strip(text)
   : `${strip(text.slice(0, keep.start))}${text.slice(keep.start, keep.end)}${strip(text.slice(keep.end))}`;
 return result.replace(/\n{3,}/g, "\n\n").trim();
}

/** The `Working directory:` value the caller already stated, if any. */
function statedWorkingDirectory(segments: SystemText[]): string | null {
 for (const segment of segments) {
  const value = WORKING_DIRECTORY_RE.exec(segment.read())?.[1]?.trim();
  if (value) return value;
 }
 return null;
}

/**
 * Build the exact 5-line env block the live CLI sends (v1 1.19.4 MITM, SG):
 * Working directory, Workspace root, Is git, Platform, Today's date.
 * The directory values fall back to the fingerprint constant when the caller
 * stated nothing — the gate reads the keys, not usable paths.
 */
export function buildLiveEnvBlock(workingDirectory: string): string {
 const today = new Date().toISOString().slice(0, 10);
 return [
  "<env>",
  `  Working directory: ${workingDirectory}`,
  `  Workspace root: ${workingDirectory}`,
  "  Is git: false",
  `  Platform: ${process.platform}`,
  `  Today's date: ${today}`,
  "</env>",
 ].join("\n");
}

/**
 * Guarantee the free-tier environment gate: exactly one `<env>` … `</env>` pair
 * in the system prompt, with `Working directory:` inside it.
 *
 * Measured 2026-10-24 (issues #117/#118): a body with the block answers 200 and
 * the same body without it answers 429 FreeUsageLimitError, on the same machine
 * within the same minute, with the retry-after countdown still hours away from
 * 00:00 UTC. The countdown is a generic error body, not a quota window, so a
 * host that never emits the block fails on the direct route no matter what
 * else the lane gets right.
 *
 * Two measured traps decide the shape of this function:
 * - Upstream reads only the FIRST pair in the text. A stale or partial copy
 *   above the real block shadows it and still 429s, even though the block
 *   itself is complete and correct. So a fix must leave exactly one pair, not
 *   merely append one.
 * - `Working directory:` is load-bearing. A plausible-looking block carrying
 *   `Platform:` or `Shell:` instead is refused; a block carrying only
 *   `Working directory:` is accepted. So an existing block without the key is
 *   replaced rather than kept and duplicated.
 *
 * A host block that already satisfies both rides through byte-for-byte: the
 * host knows its environment, this module does not. Anything else is folded
 * into the last system message, which upstream accepts on every wire shape.
 */
export function ensureEnvBlock(body: Record<string, unknown>, pathname: string): void {
 if (!body || typeof body !== "object") return;
 const segments = pathname.endsWith("/responses")
  ? responsesSystemSegments(body)
  : pathname.endsWith("/messages")
   ? messagesSystemSegments(body)
   : chatSystemSegments(body);
 if (segments.length === 0) return;
 const blocks = envBlocks(segments);
 const carrying = blocks.find((block) => WORKING_DIRECTORY_RE.test(block.body));
 // Already the single pair upstream reads, with the key inside: leave it be.
 if (carrying !== undefined && blocks.length === 1) return;
 segments.forEach((segment, index) => {
  segment.write(stripEnvBlocks(segment.read(), carrying !== undefined && carrying.segment === index ? carrying : undefined));
 });
 if (carrying !== undefined) return;
 const last = segments[segments.length - 1];
 const text = last.read();
 last.write(`${text ? `${text}\n\n` : ""}${buildLiveEnvBlock(statedWorkingDirectory(segments) ?? FALLBACK_WORKING_DIRECTORY)}`);
}

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
 const callerHadTools = Array.isArray(body.tools) && body.tools.length > 0;
 // Zen takes the bare model id: the live CLI sends `model: <bare>` (e.g.
 // glm-5.3-flash-free), never the `opencode/`-prefixed catalog id the host
 // may carry. Strip one prefix so a prefixed id still routes.
 if (typeof body.model === "string" && body.model.startsWith("opencode/")) {
  body.model = body.model.slice("opencode/".length);
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
 const injected = [...missing];

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

 // Note: Upstream OpenCode Zen explicitly rejects any tool_choice other than "auto"
 // with HTTP 400 (only "auto" is supported). tool_choice is auto-or-absent on the
 // responses and chat paths (normalizeResponsesBody / enforceAutoToolChoice above),
 // the Zen messages lane keeps the caller's own choice semantics (Anthropic
 // spells choices with `any` / `{ type: "tool", name: ... }`), and we never
 // impose a choice.
 // Empty-placeholder callers stay silent via the COMPAT description and the
 // output-aggregator; real OMP definitions execute normally.

 return { clientRequestedStream, callerHadTools, addedTools: after > before, caseRestore, findGlob, injected, argSchemas };
}

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
const SSE_FIELD_LINE_RE = /^(data|event):/m;

/** True when `text` carries a real SSE field line at a line start. */
export function looksLikeSse(text: string): boolean {
 return text.length > 0 && SSE_FIELD_LINE_RE.test(text);
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
function cloakResponsesObject(
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

/**
 * OpenAI-compat body variant for the default lane: mark the body for usage
 * accounting the way the CLI's openai-compat request does. Merges into an
 * existing stream_options object rather than replacing it. Applied to every
 * chat-lane enforcement (see enforceOpencodeFingerprint).
 */
export function applyOpenAiCompatVariant(body: Record<string, unknown>): void {
 if (!body || typeof body !== "object") return;
 const existing = body.stream_options;
 if (existing && typeof existing === "object" && !Array.isArray(existing)) {
  (existing as Record<string, unknown>).include_usage = true;
  return;
 }
 body.stream_options = { include_usage: true };
}
