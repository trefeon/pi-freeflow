/**
 * OpenCode Zen free-tier tool roster injection and choice enforcement.
 *
 * Single owner of the 11-tool roster injection logic, case normalization,
 * commentary stripping, tool_choice auto-reduction, reasoning effort clamping,
 * and replay name sanitization.
 */

import {
 FULL11_TOOL_DEFS,
 FULL11_TOOL_NAMES,
 restoreToolNameForCaller,
 sanitizeUpstreamToolName,
 type FindGlobRestore,
} from "./tool-translation.ts";
import { getModelDef } from "./models.ts";
import type { ThinkingLevel } from "./types.ts";

/** Effort levels in descending priority (off excluded — clamping to off is never correct). */
export const EFFORT_DESCENDING: readonly ThinkingLevel[] = ["max", "xhigh", "high", "medium", "low", "minimal"] as const;

/**
 * Find the highest supported effort for a model whose thinkingLevelMap
 * declares the requested effort as null. Returns null when no clamp is
 * needed (effort is supported or model has no map). The one supported effort
 * that is still rewritten is `ultra` (see below): it is an alias, never a
 * value the gateway enumerates.
 */
export function clampedEffortFor(model: string, effort: string): string | null {
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
 // Effort is supported (non-null) → no clamp needed
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

/** Opt-in empty-tools: "1" skips the 11-injection on tool-less turns; unset → today's 11-injection. */
export const ZEN_EMPTY_TOOLS_ENV = "PI_FREEFLOW_ZEN_EMPTY_TOOLS";

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
export function restoreName(name: string, restore?: CaseRestoreMap): string {
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
export function restoreCallerName(name: string, caseRestore?: CaseRestoreMap, findGlob?: FindGlobRestore): string {
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
export function full11Present(body: Record<string, unknown>): Set<string> {
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
export function stripCommentaryPhase(body: Record<string, unknown>): void {
 const input = body.input;
 if (!Array.isArray(input)) return;
 for (const item of input) {
  if (!item || typeof item !== "object" || Array.isArray(item)) continue;
  const record = item as Record<string, unknown>;
  if (record.role === "assistant" && record.phase === "commentary") delete record.phase;
 }
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
export function restoreNativeEffortAfterChoiceDrop(body: Record<string, unknown>): void {
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
export function enforceAutoToolChoice(body: Record<string, unknown>): void {
 const choice = body.tool_choice;
 if (choice === undefined) return;
 if (typeof choice === "string" && choice.trim().toLowerCase() === "auto") return;
 delete body.tool_choice;
 restoreNativeEffortAfterChoiceDrop(body);
}

/**
 * Chat-lane mirror of the responses effort clamp (normalizeResponsesBody):
 * a host targeting the chat path spells the effort flat — `reasoning_effort`
 * or `reasoningEffort` — and the same clampedEffortFor algorithm applies.
 * A level the model's map declares unsupported is clamped to the highest
 * supported one; a supported level or a key the map does not know is left
 * for upstream to rule on; genuine `off` is never rewritten. The Zen
 * messages lane carries no flat effort spelling, so it is not touched.
 */
export function clampChatReasoningEffort(body: Record<string, unknown>): void {
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
export function highestSupportedEffort(model: string): string | null {
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
export function sanitizeReplayItemNames(body: Record<string, unknown>): void {
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
