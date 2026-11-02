/**
 * OpenCode Zen free-tier environment block and request body normalization.
 *
 * Enforces the `<env>` system-prompt block required by the OpenCode free-tier gate,
 * normalizes cache keys, Responses bodies, and OpenAI-compat usage options.
 */

import {
 clampedEffortFor,
 enforceAutoToolChoice,
 sanitizeReplayItemNames,
 stripCommentaryPhase,
} from "./fingerprint-tools.ts";

/** Complete `<env>` … `</env>` pair; non-greedy so two blocks stay two matches. */
export const ENV_PAIR_RE = /<env>[\s\S]*?<\/env>/g;
/** A tag whose partner is missing or was stripped: it can shadow the real pair. */
export const ENV_TAG_RE = /<\/?env>/g;
/** The gate's load-bearing key. Any value passes; a different key does not. */
export const WORKING_DIRECTORY_RE = /Working directory:[ \t]*([^\n<]*)/;
/** The gate reads the key, not a usable path: this block is a fingerprint. */
export const FALLBACK_WORKING_DIRECTORY = "(current project)";
/** Multiple newlines (3 or more) normalized to double newlines. */
const MULTI_NEWLINE_RE = /\n{3,}/g;

/** One mutable piece of system-prompt text: the only place a block can live. */
export type SystemText = { read(): string; write(text: string): void };

/** `container[key]` as a mutable string segment. */
export function stringSegment(container: Record<string, unknown>, key: string): SystemText {
 return {
  read: (): string => (typeof container[key] === "string" ? (container[key] as string) : ""),
  write: (text: string): void => {
   container[key] = text;
  },
 };
}

/** The text blocks of a parts array (`content[]` / Anthropic `system[]`). */
export function textBlockSegments(blocks: unknown[]): SystemText[] {
 const segments: SystemText[] = [];
 for (const block of blocks) {
  if (!block || typeof block !== "object" || Array.isArray(block)) continue;
  const rec = block as Record<string, unknown>;
  if (typeof rec.text !== "string") continue;
  segments.push({
   read: (): string => rec.text as string,
   write: (text: string): void => {
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
export function contentSegments(message: Record<string, unknown>): SystemText[] {
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
export function chatSystemSegments(body: Record<string, unknown>): SystemText[] {
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
export function messagesSystemSegments(body: Record<string, unknown>): SystemText[] {
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
export function responsesSystemSegments(body: Record<string, unknown>): SystemText[] {
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
export function envBlocks(segments: SystemText[]): Array<{ segment: number; start: number; end: number; body: string }> {
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
export function stripEnvBlocks(text: string, keep?: { start: number; end: number }): string {
 const strip = (part: string): string => part.replace(ENV_PAIR_RE, "").replace(ENV_TAG_RE, "");
 const result =
  keep === undefined
   ? strip(text)
   : `${strip(text.slice(0, keep.start))}${text.slice(keep.start, keep.end)}${strip(text.slice(keep.end))}`;
 return result.replace(MULTI_NEWLINE_RE, "\n\n").trim();
}

/** The `Working directory:` value the caller already stated, if any. */
export function statedWorkingDirectory(segments: SystemText[]): string | null {
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
 * Normalize the camelCase `promptCacheKey` alias onto `prompt_cache_key` so
 * every session-key reader sees one spelling. A non-empty snake_case value
 * wins; neither spelling is ever stripped on the Zen lane.
 */
export function normalizePromptCacheKey(body: Record<string, unknown>): void {
 const camelKey = body["promptCacheKey"];
 if (typeof camelKey === "string" && camelKey.length > 0 && (typeof body["prompt_cache_key"] !== "string" || (body["prompt_cache_key"] as string).length === 0)) {
  body["prompt_cache_key"] = camelKey;
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
   declares the requested effort as null (unsupported), the effort is clamped
   to the highest supported level. Covers all OpenCode models generically
   (muse-spark, mimo, nemotron, etc.), not just a single model family.
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
