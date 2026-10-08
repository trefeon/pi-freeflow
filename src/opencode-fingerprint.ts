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
 OMP_FINGERPRINT_DEFS,
 OPENCODE_FINGERPRINT_TOOLS,
 buildFindGlobRestore,
 isOmpLikeCaller,
 restoreToolNameForCaller,
 retargetToolChoiceForUpstream,
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
 * needed (effort is supported or model has no map).
 */
function clampedEffortFor(model: string, effort: string): string | null {
 const def = getModelDef(model);
 if (!def?.thinkingLevelMap) return null;
 const map = def.thinkingLevelMap;
 // "off" means disable reasoning entirely — never clamp it even when map says null
 if (effort.toLowerCase() === "off") return null;
 // "ultra" is an unofficial alias for beyond-max; treat as "max"
 const key = (effort.toLowerCase() === "ultra" ? "max" : effort.toLowerCase()) as ThinkingLevel;
 // Effort is supported (non-null) → no clamp
 if (key in map && map[key] !== null && map[key] !== undefined) return null;
 // Effort key is unknown and not "ultra" → let upstream decide
 if (!(key in map) && effort.toLowerCase() !== "ultra") return null;
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
 * Fill for one missing fingerprint slot: the shared OMP real definition when
 * the caller is OMP-like, otherwise the empty COMPAT placeholder Pi keeps.
 * `edit` is always COMPAT, even for OMP-like callers: no single static edit
 * schema executes on either host (OMP is edit-mode dependent, Pi wants
 * edits[]), so it must stay in the cloaked `injected` list, never
 * `injectedReal`. Single lockstep source for the three wire-shape ensure
 * functions below.
 */
function fingerprintFill(name: FingerprintToolName, omp: boolean): { description: string; schema: Record<string, unknown> } {
 if (!omp || name === "edit") return { description: COMPAT_TOOL_DESCRIPTION, schema: { type: "object", properties: {} } };
 const def = OMP_FINGERPRINT_DEFS[name];
 return { description: def.description, schema: { ...(def.parameters as Record<string, unknown>) } };
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
 * Merge missing fingerprint declarations (canonical translator set) into Chat
 * Completions bodies. Case-insensitive and idempotent: Bash counts as bash.
 * Preserves caller tools verbatim; missing slots become executable real
 * definitions for OMP-like callers (edit excepted, always the cloaked
 * placeholder), empty no-ops otherwise. Explicit ompLike
 * overrides auto-detection (pass pre-translation caller names when find was
 * already renamed to glob).
 */
export function ensureChatFingerprintTools(body: Record<string, unknown>, ompLike?: boolean): void {
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
 const omp = ompLike ?? isOmpLikeCaller(present);
 for (const name of OPENCODE_FINGERPRINT_TOOLS) {
  if (present.has(name)) continue;
  const fill = fingerprintFill(name, omp);
  (body.tools as unknown[]).push({
   type: "function",
   function: {
    name,
    description: fill.description,
    parameters: fill.schema,
   },
  });
  present.add(name);
 }
}

/**
 * Merge missing fingerprint declarations (canonical translator set) into
 * Responses API bodies. Case-insensitive and idempotent.
 * Uses the flat Responses tool shape ({ type: "function", name, description, parameters }).
 * Missing slots become executable real definitions for OMP-like callers
 * (edit excepted, always the cloaked placeholder),
 * empty no-ops otherwise; see ensureChatFingerprintTools for the override.
 */
export function ensureResponsesFingerprintTools(body: Record<string, unknown>, ompLike?: boolean): void {
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
 const omp = ompLike ?? isOmpLikeCaller(present);
 for (const name of OPENCODE_FINGERPRINT_TOOLS) {
  if (present.has(name)) continue;
  const fill = fingerprintFill(name, omp);
  (body.tools as unknown[]).push({
   type: "function",
   name,
   description: fill.description,
   parameters: fill.schema,
  });
  present.add(name);
 }
}

/**
 * Merge missing fingerprint declarations (canonical translator set) into
 * Anthropic Messages bodies. Case-insensitive and idempotent.
 * Uses the Anthropic tool shape ({ name, description, input_schema }).
 * Missing slots become executable real definitions for OMP-like callers
 * (edit excepted, always the cloaked placeholder),
 * empty no-ops otherwise; see ensureChatFingerprintTools for the override.
 */
export function ensureMessagesFingerprintTools(body: Record<string, unknown>, ompLike?: boolean): void {
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
 const omp = ompLike ?? isOmpLikeCaller(present);
 for (const name of OPENCODE_FINGERPRINT_TOOLS) {
  if (present.has(name)) continue;
  const fill = fingerprintFill(name, omp);
  (body.tools as unknown[]).push({
   name,
   description: fill.description,
   input_schema: fill.schema,
  });
  present.add(name);
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
 * - `tool_choice` is auto-or-absent: `"none"` (string or `{ type: "none" }`)
 *   is dropped, everything else rides (named choices still retarget find->glob).
 * - `store` defaults to false (never persisted server-side).
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
 const choice = body.tool_choice;
 if (typeof choice === "string" ? choice.toLowerCase() === "none" : (
  choice !== null && typeof choice === "object" && !Array.isArray(choice)
  && (choice as Record<string, unknown>).type === "none"
 )) delete body.tool_choice;
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
 if (body.store === undefined) body.store = false;
}

/**
 * Enforce the full OpenCode free-tier client fingerprint on a parsed request body.
 * Caller placeholders are lowercased (Bash -> bash, tool_choice retargeted),
 * tools translated to the target path's wire shape (Pi find -> upstream glob via
 * src/tool-translation.ts), then the missing slots injected in that shape: real
 * executable definitions for OMP-like callers (ask/task/todo/hub/lsp present,
 * or glob without find, detected on pre-translation caller names), empty
 * no-ops for Pi. `edit` is always the cloaked placeholder (no static edit
 * schema executes on either host). Returns the original stream flag,
 * caller-tools flag, whether injection added tools, and the bounded
 * per-request restore records (caseRestore, findGlob, injected, injectedReal)
 * for downstream cloaking. Cloaking strips by `injected` only: names in
 * `injectedReal` were served with executable definitions, so model calls to
 * them execute downstream instead of being cloaked.
 *
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
 injectedReal: string[];
 argSchemas: Map<string, Record<string, unknown>>;
} {
 const clientRequestedStream = body.stream === true;
 const callerHadTools = Array.isArray(body.tools) && body.tools.length > 0;
 // Zen responses shape conformance first (Chat leftovers, tool_choice none,
 // spark effort clamp, store default): Kilo/Cline bodies never reach here.
 if (pathname.endsWith("/responses")) normalizeResponsesBody(body);
 // Chat path mirrors the responses drop: Zen free tier accepts only auto, so a
 // caller "none" (string or { type: "none" }) would 400 upstream. Messages
 // path keeps its own choice semantics.
 if (!pathname.endsWith("/responses") && !pathname.endsWith("/messages")) {
  const noneChoice = body.tool_choice;
  if (typeof noneChoice === "string" ? noneChoice.toLowerCase() === "none" : (
   noneChoice !== null && typeof noneChoice === "object" && !Array.isArray(noneChoice)
   && (noneChoice as Record<string, unknown>).type === "none"
  )) delete body.tool_choice;
 }
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
 // Captured before translation and injection: the map is keyed by CALLER tool
 // name (what arrives downstream), and injected placeholders must not be
 // repairable.
 const argSchemas = buildArgRepairSchemas(Array.isArray(body.tools) ? body.tools : []);
 const callerUpstream = new Set<string>();
 const callerNames = new Set<string>();
 if (Array.isArray(body.tools)) {
  for (const tool of body.tools) {
   const n = toolNameOf(tool);
   if (n) {
    callerNames.add(n.toLowerCase());
    callerUpstream.add(upstreamToolNameFor(n).toLowerCase());
   }
  }
 }
 // OMP detection runs on pre-translation names: find is still visible here,
 // so Pi find-callers are never mistaken for OMP glob-callers.
 const ompLike = isOmpLikeCaller(callerNames);
 const missing = OPENCODE_FINGERPRINT_TOOLS.filter((n) => !callerUpstream.has(n.toLowerCase()));
 // Cloak list carries the truly-empty placeholders plus `edit` (never
 // executable when injected); real definitions survive downstream so
 // injected OMP calls execute.
 const injected = missing.filter((n) => !ompLike || n === "edit");
 const injectedReal = ompLike ? missing.filter((n) => n !== "edit") : [];

 if (Array.isArray(body.tools)) {
  body.tools = translateToolsForPath(body.tools, pathname);
 }

 const before = Array.isArray(body.tools) ? body.tools.length : 0;
 if (pathname.endsWith("/responses")) {
  ensureResponsesFingerprintTools(body, ompLike);
 } else if (pathname.endsWith("/messages")) {
  ensureMessagesFingerprintTools(body, ompLike);
 } else {
  ensureChatFingerprintTools(body, ompLike);
 }
 const after = Array.isArray(body.tools) ? body.tools.length : 0;

 // Note: Upstream OpenCode Zen explicitly rejects any tool_choice other than "auto"
 // with HTTP 400 (only "auto" is supported). tool_choice is auto-or-absent here:
 // normalizeResponsesBody drops "none" on the responses path, the chat branch above
 // drops it on the chat path, and we never impose a choice.
 // Empty-placeholder callers stay silent via the COMPAT description and the
 // output-aggregator; real OMP definitions execute normally.

 return { clientRequestedStream, callerHadTools, addedTools: after > before, caseRestore, findGlob, injected, injectedReal, argSchemas };
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
        if (tc.function?.name) existing.function.name += tc.function.name;
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

 return {
  id: "resp_fallback",
  object: "response",
  status: "completed",
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
 */
function cloakMessagesContent(
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
 if (!trimmed.includes("data:")) {
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
 } catch {
  return sseText;
 }
}
