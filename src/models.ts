/**
 * Static model definitions and upstream routing catalogs for pi-freeflow
 *
 * Defines the 35 verified free models (live-verified 2026-10-22):
 * - 11 OpenCode Zen models (all Chat Completions)
 * - 15 KiloCode Keyless Gateway models (OpenRouter format)
 * - 1 Cline direct-only model (per-user pool; z-ai/glm-5.3-flash)
 * - 8 OVHcloud AI Endpoints models (keyless, direct-only)
 *
 * No static entry declares `api: "openai-responses"` any more: the Zen
 * muse-spark contributor ids went first (1.3 on 2026-10-17, 1.2 on 2026-10-18)
 * and Cline's Muse Spark 1.3 entry stopped resolving upstream on 2026-10-22.
 * The responses plumbing stays for stale caches and future entries.
 *
 * Spec policy (2026-10-22): a fixed model declares its highest well-known
 * spec. The canonical vendor sheet, the twin rows and the built-in catalog are
 * compared field by field (context, output, modalities, effort ladder), and
 * derived conventions are ignored (0.9x output caps, output repeated as the
 * context, router pool ceilings, paid-tier serving configs) — a lane's own
 * top_provider 0.9x figure is used only when the id has no published output
 * and no cross-lane twin. A masked or
 * mixed-backend id is the exception: it follows the serving provider's own
 * declared spec, never a guessed backing model and never a live probe. Where a
 * lane enforces less than the declared spec at runtime, the entry keeps the
 * declared figure and notes the lane cap beside it, so a caller above that cap
 * sees the authentic upstream error rather than a silently reduced catalog.
 */

import type { ModelDef, ThinkingLevelMap, Upstream } from "./types.ts";

/**
 * OpenCode Zen free models verified against the live catalog and inference APIs.
 * Endpoint: https://opencode.ai/inference/v1
 */
export const OPENCODE_MODELS: ModelDef[] = [
 {
  id: "cat-jam-free",
  name: "Cat Jam [OpenCode]",
  reasoning: true,
  // Confirmed 2026-10-20: the endpoint refuses a 1.05M-token prompt with
  // "maximum context length is 1048576 tokens", and a 900,337-token needle
  // probe recalled correctly. The earlier ~250K miss was recall, not
  // truncation.
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  input: ["text"],
  // Effort ladder live-probed 2026-10-16: the gateway enumerates
  // max/xhigh/high/medium/low as the supported set for this model — a probe
  // with `minimal`, `none`, or a bogus value answers 400 naming exactly
  // that list, and `max` answers 200 with a populated reasoning stream. So
  // `max` is a real level here, not a silent clamp.
  thinkingLevelMap: {
   off: null,
   minimal: null,
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "xhigh",
   max: "max",
  },
 },
 {
  id: "mimo-v2.6-flash-free",
  name: "MiMo V2.6 Flash [OpenCode]",
  reasoning: true,
  // Built-in catalog spec: 1,048,576 context / 131,072 output (the origin
  // model and every paid twin agree). The free lane enforces a lower runtime
  // cap in practice (measured ~348K; 349K is refused), but the catalog follows
  // the model's built-in highest spec, so the authentic upstream error is what
  // a caller sees above the lane's cap.
  contextWindow: 1_048_576,
  maxTokens: 131_072,
 input: ["text", "image"],
  thinkingLevelMap: {
   off: null,
   minimal: "low",
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "high",
   max: null,
  },
 },
 {
  id: "nemotron-3-ultra-free",
  name: "Nemotron 3 Ultra [OpenCode]",
  reasoning: true,
  // The lane itself caps at 1,000,000 (a 1.29M-token request is refused with
  // "maximum context length is 1000000 tokens"); the 1,048,576 figure belongs
  // to a different provider row and is not served here.
  contextWindow: 1_000_000,
  maxTokens: 182_520,
  input: ["text"],
  thinkingLevelMap: {
   off: null,
   minimal: "minimal",
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "xhigh",
   max: null,
  },
 },
 {
  id: "nemotron-3.5-lightning-free",
  name: "Nemotron 3.5 Lightning [OpenCode]",
  reasoning: true,
  contextWindow: 1_000_000,
  // Highest published output below the window (OpenRouter/Kilo paid twins);
  // the 262,144 figures repeat the context as the output cap.
  maxTokens: 235_929,
  input: ["text"],
  thinkingLevelMap: {
   off: null,
   minimal: "minimal",
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "xhigh",
   max: null,
  },
 },
 {
  // Added 2026-10-16 (issue #62). Listed on the live Zen /v1/models free list
  // and served through the fingerprint path (chat 200 with the tool sextet +
  // stream:true); absent from the static catalog until now, so the dynamic
  // merge registered it via the enrichModelDef heuristic, which guesses
  // reasoning:false and no effort map for this id (no magic substring) — that
  // is why the picker offered no thinking levels at all.
  // Context: 1,048,576 — the value both the models.dev opencode twin and the
  // NVIDIA family origin publish, adopted 2026-10-20 (this entry previously
  // carried the round 1M). maxTokens 235,929 is the highest output ceiling
  // published across the free and paid twins; the gateway also accepted
  // 131,072 through 524,288 on probe, and acceptance is not a cap, so the
  // published figure stays the budget.
  // The upstream twin advertises video, but the host's ModelInputType has no
  // video member, so only text and image are declared. Video remains
  // documented in the README; it is not selectable in the picker.
  // Effort ladder probed level-by-level 2026-10-16: minimal/low/medium/high/
  // xhigh all answer 200 with reasoning (an unsupported value answers 400, so
  // the gateway validates per model); `max` also 200s but stays hidden
  // because the published ladder caps at xhigh. `none` disables reasoning
  // upstream but maps nowhere here, like `off` on every entry.
  // Vision verified live: a 1x1 PNG reads back as "red". Chat is the only
  // native shape — /v1/responses answers 400 "Model does not support this
  // protocol", so `api` stays unset.
  id: "nemotron-3.5-super-vl-free",
  name: "Nemotron 3.5 Super VL [OpenCode]",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 235_929,
  input: ["text", "image"],
  thinkingLevelMap: {
   off: null,
   minimal: "minimal",
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "xhigh",
   max: null,
  },
 },
 {
  id: "big-pickle",
  name: "Big Pickle [OpenCode]",
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 32_000,
  input: ["text"],
  thinkingLevelMap: {
   off: null,
   minimal: null,
   low: null,
   medium: null,
   high: "high",
   xhigh: null,
   max: "max",
  },
 },
 {
  id: "longcat-2.5-preview-free",
  name: "LongCat 2.5 Preview [OpenCode]",
  reasoning: true,
  // Raised 2026-10-20 (spec reconciliation): 1,048,576 ctx per the published
  // twin, replacing the round 1M this entry used to declare.
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  input: ["text", "image"],
  thinkingLevelMap: {
   off: null,
   minimal: "minimal",
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "xhigh",
   max: null,
  },
 },
 {
  // Added 2026-10-16 (issue #71 drift): Zen v1.19.2 added this free id;
  // served through the fingerprint path (chat 200 with tools + stream).
  // Context is 1,048,576 — the published twin value, adopted 2026-10-20
  // (models.dev's 200,000 figure for the free id is a stale under-report: a
  // marker planted at 90% depth of a ~250K-word prompt is recalled, and only
  // above ~1M words does the gateway refuse with context_length_exceeded).
  // It now matches the non-free twin (z-ai/glm-5.3-flash, Cline lane,
  // 1,048,576 in this catalog); the 450K/700K-word recall probes timed out upstream and stayed
  // inconclusive. maxTokens 131,072 is the highest output published across the
  // twins — models.dev's free entry claims only 32,000, while the gateway
  // accepted up to 131,072; acceptance is not a cap, so the twin figure stays
  // the budget.
  // Effort ladder: the free and paid datasheets both publish low/high/max
  // (models.dev opencode + OMP's committed row); the other rungs stay null.
  // Chat is the only native shape (/v1/responses answers 400
  // "Model does not support this protocol"), so `api` stays unset. Vision is
  // published. Video and PDF are documented upstream capabilities, but the
  // host carries no input type for them, so neither is declared.
  id: "glm-5.3-flash-free",
  name: "GLM-5.3 Flash [OpenCode]",
  reasoning: true,
  // Built-in catalog spec: 1,048,576 context. The free lane's runtime cap is
  // lower (296,517 accepted, 298,556 refused), but the catalog follows the
  // model's built-in highest spec and surfaces the upstream error.
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  input: ["text", "image"],
  thinkingLevelMap: {
   off: null,
   minimal: null,
   low: "low",
   medium: null,
   high: "high",
   xhigh: null,
   max: "max",
  },
 },
 {
  // Added 2026-10-17: Reflection AI's Beam 501B open-weight MoE model (23B active),
  // added as a limited-time free model on OpenCode Zen (/zen/v1/models: beam-free).
  // Live-probed 2026-10-17: 200 with stream:true and tool sextet.
  // Context window: 1_048_576 tokens (1M), maxTokens: 131_072.
  // Probed boundary: filler up to 900,000 words (~1.1M tokens) answers 200.
  // Input: text-only (image probe answers 400 "Beam supports text input only").
  // Wire format: Chat Completions (/v1/responses answers 400 ModelProtocolUnsupported).
  // Reasoning effort ladder: minimal is rejected with 400 (unsupported_value),
  // low/medium/high/xhigh/max all answer 200 with reasoning.
  id: "beam-free",
  name: "Beam Free [OpenCode]",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  input: ["text"],
  thinkingLevelMap: {
   off: null,
   minimal: null,
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "xhigh",
   max: "max",
  },
 },
{
  // Added 2026-10-15: new free model on the OpenCode Zen lane. Live-verified by
  // probe, NOT copied from the published catalog — the entry for this exact
  // free id claimed 200,000 context, which the gateway contradicts (see below).
  // The reconciled twin spec (2026-10-20) now publishes the full 1M, so the
  // declared number is the 1,048,576 the twin states rather than the round 1M
  // this entry used to carry.
  id: "deepseek-v4.1-flash-free",
  name: "DeepSeek V4.1 Flash [OpenCode]",
  reasoning: true,
  requiresReasoningContentOnAssistantMessages: true,
  // 1,048,576, matching both the published twin and the probe: a marker
  // planted mid-prompt is still recalled through prompt_tokens=1,030,800, and
  // the gateway turns an oversized request away with an empty-bodied 400
  // somewhere above ~1.05M. The stale 200k figure described a different,
  // confusingly similar paid id; the reconciled twin now agrees with the probe.
  contextWindow: 1_048_576,
  // 393,216 output tokens: the live gateway boundary (it accepts 393,216 =
  // 384 * 1024 and rejects 393,217+ with 400), which is also the highest
  // figure published across the twins — models.dev rounds it down to 384,000,
  // and the boundary probe is what the request budget is set to.
  maxTokens: 393_216,
  // Chat Completions only — a Responses-shaped request is refused with
  // 400 ModelProtocolUnsupported. `api` left unset, which means chat.
  input: ["text", "image"],
  // Vision verified live (a 1x1 PNG reads back as "Pink"). Video is not
  // advertised for this model upstream, so it is not offered here.
  // Effort ladder: both datasheets publish exactly low/high/max; the other
  // rungs stay null instead of exposing an unlisted value.
  thinkingLevelMap: {
   off: null,
   minimal: null,
   low: "low",
   medium: null,
   high: "high",
   xhigh: null,
   max: "max",
  },
},
 {
  // Added 2026-10-22. Availability on this lane is bursty: the same day it
  // answered 1 of 19 probes across ~25 minutes and later 8 of 8 over 43
  // seconds through an owned proxy. A 503 "Endpoint is unavailable" burst is
  // retryable, not a death signal — never prune on it.
  // Context: 262,144 measured. The gateway refuses a 323,580-token input with
  // "longer than the model's context length (262144)", and a needle planted
  // at prompt_tokens 129,736 is recalled. One near-window sample at 258,970
  // missed once, so the top of the window is a recall boundary, not a
  // truncation boundary.
  // maxTokens: 65,536 published (models.dev /opencode). Acceptance is not a
  // cap — 65,536 and 70,000 both answer 200 — so the published figure stays
  // the budget.
  // Effort ladder: low/medium/high/xhigh/max all answer 200 with reasoning.
  // `off` and a bogus value answer 422 with the generic "Endpoint is
  // unavailable" body, and `minimal` is accepted but absent from the
  // published ladder, so all three stay null.
  // Verified natively on BOTH shapes: chat stream + tool call + agent loop,
  // and /v1/responses with bare-string and array input. /v1/messages is
  // refused 400 ModelProtocolUnsupported. `api` stays unset (chat is the
  // default) so the responses path keeps its native mapping. The
  // /v1/responses + tools path was not reachable during the outage window,
  // so that specific combination is unverified.
  id: "flint-40b-free",
  name: "Flint 40B [OpenCode]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 65_536,
  input: ["text"],
  thinkingLevelMap: {
   off: null,
   minimal: null,
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "xhigh",
   max: "max",
  },
 },
];

/**
 * Shared effort map for Kilo reasoning models — verified live 2026-08-29:
 * gateway accepts flat reasoning_effort minimal..xhigh for every reasoning
 * model; a StepFun reasoning model (step-3.7-flash, since retired from the
 * free list) measured monotonic 77→313 thinking chars across minimal→xhigh.
 * Declaring the map locks the picker (instead of host guessing) and matches
 * the OpenCode-model pattern.
 */
const KILO_REASONING_MAP: ThinkingLevelMap = {
 off: null,
 minimal: "minimal",
 low: "low",
 medium: "medium",
 high: "high",
 xhigh: "xhigh",
 max: null,
};

/**
 * KiloCode Gateway free models (keyless — https://kilo.ai/docs/gateway).
 */
export const KILO_MODELS: ModelDef[] = [
 {
  id: "dots-studio/dots-3-note-preview:free",
  name: "Dots3-Note Preview (384K) [Kilo]",
  reasoning: true,
  // Kilo publishes 512,000 ctx / 460,800 out, but the only provider behind
  // this free id (atlas-cloud) serves a 393,216-token total window. Re-probed
  // 2026-10-20: with a 20-token prompt, max_tokens 393,195 answers 200 and
  // 460,800 answers 400 "bad request". Declared values are the served window
  // and an output budget that keeps prompt headroom under it.
  contextWindow: 393_216,
  maxTokens: 262_144,
  input: ["text", "image"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  name: "Nemotron 3 Nano Omni [Kilo]",
  reasoning: true,
  // Reconciled 2026-10-20: 262,144 ctx and 65,536 output per the model's own
  // published spec; the previous 256,000 / 131,072 pair was a rounded-down
  // context with an output figure the spec does not carry.
  contextWindow: 262_144,
  maxTokens: 65_536,
 input: ["text", "image"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "nvidia/nemotron-3-ultra-550b-a55b:free",
  name: "Nemotron 3 Ultra 550B [Kilo]",
  reasoning: true,
  // The gateway caps this id at 1,000,000 (a 1.11M-token request is refused
  // with "maximum context length is 1000000 tokens").
  contextWindow: 1_000_000,
  maxTokens: 182_520,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "nvidia/nemotron-3.5-lightning:free",
  name: "Nemotron 3.5 Lightning [Kilo]",
  reasoning: true,
  contextWindow: 1_000_000,
  // Highest published output below the window (OpenRouter/Kilo paid twins);
  // the 262,144 figures repeat the context as the output cap.
  maxTokens: 235_929,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "cohere/north-mini-code:free",
  name: "North Mini Code [Kilo]",
  reasoning: true,
  contextWindow: 256_000,
  maxTokens: 64_000,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "poolside/laguna-s-2.1:free",
  name: "Laguna S 2.1 [Kilo]",
  reasoning: true,
  // Built-in catalog spec: 1,048,576 context. The free gateway's runtime cap
  // is 262,144; the catalog follows the model's built-in highest spec and
  // surfaces the upstream error above that cap.
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "poolside/laguna-xs-2.1:free",
  name: "Laguna XS 2.1 [Kilo]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 32_768,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "liquid/lfm-2.5-2.6b:free",
  name: "Liquid LFM 2.5 [Kilo]",
  reasoning: true,
  // Raised 2026-10-20 to the 128,000 ctx the published twin advertises; the
  // 32,768 output ceiling is unchanged.
  contextWindow: 128_000,
  maxTokens: 32_768,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "kilo-auto/free",
  name: "Kilo Auto [Kilo]",
  reasoning: true,
  contextWindow: 256_000,
  maxTokens: 10_000,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "openrouter/free",
  name: "OpenRouter Auto [Kilo]",
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 65_536,
  input: ["text", "image"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  // Added 2026-10-09: live on Kilo free list (isFree:true, 0/0 pricing,
  // 256K ctx) + keyless chat 200.
  id: "stealth/glyph-cluster",
  name: "Glyph Cluster [Kilo]",
  reasoning: true,
  contextWindow: 256_000,
  maxTokens: 256_000,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  // Added 2026-10-22: exact gateway id, tool call + agent loop verified on
  // both the chat and /v1/responses paths.
  // 1,000,000 / 131,072 is the FREE row, and it agrees everywhere it is
  // published: the Kilo free listing, the gateway `top_provider`, the Kilo
  // model page, OpenRouter, and models.dev's free row. The 262,144 / 235,929
  // pair belongs to the PAID row behind a different id — never copy it here.
  // Thinking: the gateway's reasoning_options expose a type toggle; every
  // effort value answers 200 but the deltas are cosmetic, so the shared Kilo
  // map is the honest declaration.
  // Data caveat: NVIDIA's trial terms set mayTrainOnYourPrompts true for this
  // free id, so treat prompts as non-private.
  // Reliability: `max` can draw a transient 502/503 upstream; it is
  // retryable and does not indicate model death.
  id: "nvidia/nemotron-3.5-super-vl:free",
  name: "Nemotron 3.5 Super VL [Kilo]",
  reasoning: true,
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  input: ["text", "image"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  // Added 2026-10-22: this is the Kilo twin of the Zen `beam-free` entry
  // (same Reflection AI weights). 1,048,576 / 131,072 agrees across the
  // gateway, models.dev (kilo, vercel and opencode rows) and the vendor docs,
  // so no reconciliation was needed. Tool call + agent loop verified on chat
  // and /v1/responses.
  // Always-on reasoning: the model thinks even with `none`/`off`, so the
  // toggle cannot disable it and only the effort ladder is exposed. `minimal`
  // is accepted but ignored upstream, hence null. `max` is a real level.
  // Upstream echoes the bare model id `reflection/beam` without a provider
  // field; the catalog keeps the `reflection/beam-free` listing id here so
  // alongside `beam-kilo` routing stays unambiguous against the Zen `beam`.
  id: "reflection/beam-free",
  name: "Beam 1.0 [Kilo]",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: {
   off: null,
   minimal: null,
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "xhigh",
   max: "max",
  },
 },
 {
  // Added 2026-10-22: exact gateway id, tool call + agent loop verified on
  // both the chat and /v1/responses paths. Same weights as the Zen
  // `flint-40b-free` entry, which publishes 65,536 output for them, so the
  // declared output is the conservative published figure.
  // Context: the vendor card says prompt and output SHARE the 262,144 window.
  // The gateway reports 235,929 for this id, which is its 0.9x-window
  // convention rather than a measured cap; the shared published window is the
  // declared value.
  // Thinking is mandatory: `none` answers 400, so `off` stays null. Reasoning
  // is verbose — on a tight max_tokens budget the thinking can consume the
  // whole allowance and end the turn with empty content, which is a budget
  // symptom, not a dead model.
  id: "recursive/flint-v1.0:free",
  name: "Flint 40B [Kilo]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 65_536,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  // Added 2026-10-22: exact gateway id, tool call + agent loop verified on
  // both the chat and /v1/responses paths. 262,144 / 235,929 is the pair this
  // lane publishes through the gateway `top_provider`, and no cross-lane cap
  // exists for the id — there is no twin elsewhere to reconcile against.
  // Both figures follow the same 0.9x-window convention: prompt and output
  // share the 262,144 window, so 235,929 is the output budget that still
  // leaves prompt headroom.
  // `none` disables thinking and answers 200, but like `off` everywhere else
  // it maps nowhere here, so the shared Kilo ladder is declared.
  // Reliability: roughly 60 percent of attempts hit the shared Phala 429
  // quota. A 429 means the model is alive and rate-limited — never prune on
  // it; the same id answers 200 once the shared pool frees up.
  id: "xingchen-agi/xing4.0-29b-a4b:free",
  name: "Xing4.0 29B A4B [Kilo]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 235_929,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
];

/**
 * Narrow effort map for the Cline model in the catalog (GLM 5.3 Flash) — the
 * reference reasoningOptions list effort values [low, high, max] only (no
 * toggle on GLM); minimal/medium/xhigh are not offered so the host never
 * sends an unsupported level (the proxy forwards effort verbatim).
 */
const CLINE_FLASH_REASONING_MAP: ThinkingLevelMap = {
 off: null,
 minimal: null,
 low: "low",
 medium: null,
 high: "high",
 xhigh: null,
 max: "max",
};

/**
 * Cline free models (per-user local pool — https://api.cline.bot).
 * Direct-only: never served through the relay pool. IDs are Cline-native
 * and collision-free against the OpenCode/Kilo catalogs (the Kilo-routed
 * poolside/laguna-s-2.1:free is intentionally NOT duplicated here).
 * Endpoint: https://api.cline.bot/api/v1/chat/completions
 *
 * `cline-free/muse-spark-1.3-contributor` was the last entry declaring
 * `api: "openai-responses"`; it stopped resolving upstream on 2026-10-22
 * (Cline answers 404 "Cline has no such model"), so the catalog now carries
 * chat-completions models only on this lane.
 */
export const CLINE_MODELS: ModelDef[] = [
 {
  id: "z-ai/glm-5.3-flash",
  name: "GLM 5.3 Flash [Cline]",
  reasoning: true,
 contextWindow: 1_048_576,
  maxTokens: 131_072,
 input: ["text", "image"],
  thinkingLevelMap: CLINE_FLASH_REASONING_MAP,
 },
];

/**
 * Narrow effort map for the OVH reasoning models — probed live 2026-10-13:
 * `reasoning_effort: "low"` and `"high"` are accepted (HTTP 200 with a
 * populated reasoning stream). minimal/medium/xhigh/max were not confirmed,
 * so they map to null and the picker never offers them. `minimal` must be an
 * explicit null, not an omitted key: omitting it leaves the level selectable
 * in the host. Same shape as CLINE_FLASH_REASONING_MAP.
 */
const OVH_REASONING_MAP: ThinkingLevelMap = {
 off: null,
 minimal: null,
 low: "low",
 medium: "medium",
 high: "high",
 xhigh: null,
 max: null,
};

/**
 * Qwen3.6/Qwen3.8 on OVH publish one extra rung: models.dev's ovhcloud row
 * lists none/minimal/low/medium/high, unlike the 3.5 pairs and gpt-oss which
 * start at low. No xhigh/max on either.
 */
const OVH_QWEN_REASONING_MAP: ThinkingLevelMap = {
 off: null,
 minimal: "minimal",
 low: "low",
 medium: "medium",
 high: "high",
 xhigh: null,
 max: null,
};

/**
 * Catalog-id namespace for the OVH lane. OVH model ids are case-sensitive on
 * the wire and several carry capitals and dots, so the prefix namespaces the
 * lane (and keeps the id recognized by isFreeCatalogId) while the suffix is
 * sent upstream verbatim.
 */
export const OVH_MODEL_PREFIX = "ovh-free/";

/**
 * OVHcloud AI Endpoints free models — keyless, direct-only.
 * Endpoint: https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
 *
 * Every id is OVH-native with an `ovh-free/` prefix; upstream only knows the
 * suffix (a prefixed id answers 404 `model_not_found`, verified 2026-10-13),
 * so the proxy strips the prefix on the wire. `api` stays unset, i.e.
 * openai-completions: chat is the native shape and responses is forwarded
 * natively too (with store:false injected). Anthropic messages is not served
 * (`/v1/messages` answers 404 unknown_url upstream).
 *
 * Specs (datasheets only, reconciled 2026-10-20): contextWindow is OVH's own
 * advertised value — the lane hard-caps there, so a twin advertising a larger
 * window on another provider is not served here and must not be copied in.
 * maxTokens is the highest output published by a twin below the window (the
 * `/v1/models` max_completion_tokens field repeats the context, so that echo
 * is discarded): 235,929 for the 397B and 3.8, 65,536 for the 9B, 3.6 and
 * both gpt-oss models. Effort rungs come from models.dev's ovhcloud rows,
 * not from wire probes: gpt-oss and the 3.5 Qwens list low/medium/high, the
 * 3.6/3.8 add minimal.
 *
 * Vision was probed with a generated solid-colour PNG sent as a data URL,
 * twice with two different colours to defeat a memorised answer: the four
 * Qwens and Mistral-Small-3.2 named the colour; Mistral-7B and Llama-3.3-70B
 * answer HTTP 400 to an image part; gpt-oss-120b returns 200 while its own
 * reasoning says it cannot see the image, so it is text-only. Reasoning is
 * the presence of a populated `reasoning`/`reasoning_content` field on a
 * non-tool answer.
 */
export const OVH_MODELS: ModelDef[] = [
 {
  id: "ovh-free/gpt-oss-120b",
  name: "GPT-OSS 120B [OVH]",
  reasoning: true,
  contextWindow: 131_072,
  maxTokens: 65_536,
  input: ["text"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/gpt-oss-20b",
  name: "GPT-OSS 20B [OVH]",
  reasoning: true,
  contextWindow: 131_072,
  maxTokens: 65_536,
  input: ["text"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/Qwen3.5-397B-A17B",
  name: "Qwen3.5 397B A17B [OVH]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 235_929,
  input: ["text", "image"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/Qwen3.5-9B",
  name: "Qwen3.5 9B [OVH]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 65_536,
  input: ["text", "image"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/Qwen3.6-27B",
  name: "Qwen3.6 27B [OVH]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 65_536,
  input: ["text", "image"],
  thinkingLevelMap: OVH_QWEN_REASONING_MAP,
 },
 {
  id: "ovh-free/Qwen3.8-27B",
  name: "Qwen3.8 27B [OVH]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 235_929,
  input: ["text", "image"],
  thinkingLevelMap: OVH_QWEN_REASONING_MAP,
 },
 {
  id: "ovh-free/Mistral-Small-3.2-24B-Instruct-2506",
  name: "Mistral Small 3.2 24B [OVH]",
  reasoning: false,
  contextWindow: 131_072,
  maxTokens: 32_768,
  input: ["text", "image"],
 },
 {
  id: "ovh-free/Meta-Llama-3_3-70B-Instruct",
  name: "Meta Llama 3.3 70B Instruct [OVH]",
  reasoning: false,
  contextWindow: 131_072,
  maxTokens: 32_768,
  input: ["text"],
 },
];

/**
 * Resolve any OVH id to the bare id OVH knows on the wire. Canonicalises
 * first, then strips: a short alias (`llama-3.3-70b`) must resolve to
 * `ovh-free/Meta-Llama-3_3-70B-Instruct` before the prefix comes off, or it
 * reaches OVH unrecognised and answers 404 `model_not_found` (live
 * 2026-10-13, both for a prefixed id and for an alias sent verbatim). The
 * remainder is case-sensitive, so it is returned unchanged.
 */
export function ovhUpstreamModelId(id: string): string {
 const canonical = resolveCanonicalModelId(id);
 return canonical.startsWith(OVH_MODEL_PREFIX)
  ? canonical.slice(OVH_MODEL_PREFIX.length)
  : canonical;
}

/**
 * Model ID Aliases — maps user-friendly / slash-free CLI IDs to canonical upstream model IDs.
 * Single clean alias per model (no :free duplicates). Wrong cross-lab aliases removed:
 * - Muse Spark 1.2 = Meta Superintelligence Labs (not Anthropic Claude) → removed claude-sonnet aliases
 * - Laguna S 2.1 = Poolside (not MiniMax) → removed minimax-m2.1 alias
 * - Hy3 = Tencent Hunyuan (not Alibaba Qwen) → removed qwen3-coder alias
 * - Both free MiniMax M3.1 Flash endpoints retired on 2026-10-23 (Zen 410,
 *   Kilo 404 model-not-found) → removed minimax-m3.1-flash alias; a short
 *   name must never route to the surviving paid id
 */
export const MODEL_ALIASES: Record<string, string> = {
 "dots-3-note-preview": "dots-studio/dots-3-note-preview:free",
 "nemotron-3-nano-omni": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
 "nemotron-3-ultra-550b": "nvidia/nemotron-3-ultra-550b-a55b:free",
 "nemotron-3.5-lightning": "nvidia/nemotron-3.5-lightning:free",
 "north-mini-code": "cohere/north-mini-code:free",
 "lfm-2.5": "liquid/lfm-2.5-2.6b:free",
 "glm-5.3-flash": "glm-5.3-flash-free",
 "glyph-cluster": "stealth/glyph-cluster",
 "mimo-v2.6-flash": "mimo-v2.6-flash-free",
 "nemotron-3.5-super-vl": "nemotron-3.5-super-vl-free",
 "longcat-2.5-preview": "longcat-2.5-preview-free",
 "longcat": "longcat-2.5-preview-free",
 "beam": "beam-free",
 "deepseek-v4.1-flash": "deepseek-v4.1-flash-free",
 "flint": "flint-40b-free",
 "flint-kilo": "recursive/flint-v1.0:free",
 "beam-kilo": "reflection/beam-free",
 "xing4.0": "xingchen-agi/xing4.0-29b-a4b:free",
 // provider-prefixed short aliases (slash-normalized)
 "laguna-s-2.1:free": "poolside/laguna-s-2.1:free",
 "laguna-xs-2.1:free": "poolside/laguna-xs-2.1:free",
 "kilo-auto": "kilo-auto/free",
 "openrouter": "openrouter/free",
// OVHcloud AI Endpoints — slash-free spellings of the `ovh-free/` ids.
"gpt-oss-120b": "ovh-free/gpt-oss-120b",
"gpt-oss-20b": "ovh-free/gpt-oss-20b",
"qwen3.5-397b": "ovh-free/Qwen3.5-397B-A17B",
"qwen3.5-9b": "ovh-free/Qwen3.5-9B",
"qwen3.6-27b": "ovh-free/Qwen3.6-27B",
"qwen3.8-27b": "ovh-free/Qwen3.8-27B",
"mistral-small-3.2": "ovh-free/Mistral-Small-3.2-24B-Instruct-2506",
"llama-3.3-70b": "ovh-free/Meta-Llama-3_3-70B-Instruct",
};

/**
 * Resolve any model alias to its canonical upstream model ID.
 */
export function resolveCanonicalModelId(id: string): string {
 const clean = (id || "").trim();
 return MODEL_ALIASES[clean] || clean;
}
/**
 * Set of all KiloCode model IDs (including aliases) for fast lookup
 */
export const KILO_MODEL_IDS = new Set<string>([
 ...KILO_MODELS.map((m) => m.id),
 ...Object.entries(MODEL_ALIASES)
  .filter(([_, target]) => KILO_MODELS.some((km) => km.id === target))
  .map(([alias]) => alias),
]);

/**
 * Set of all Cline model IDs (including aliases) for fast lookup
 */
export const CLINE_MODEL_IDS = new Set<string>([
 ...CLINE_MODELS.map((m) => m.id),
 ...Object.entries(MODEL_ALIASES)
  .filter(([_, target]) => CLINE_MODELS.some((cm) => cm.id === target))
  .map(([alias]) => alias),
]);

/**
 * Set of all OVH model IDs (including aliases) for fast lookup
 */
export const OVH_MODEL_IDS = new Set<string>([
 ...OVH_MODELS.map((m) => m.id),
 ...Object.entries(MODEL_ALIASES)
  .filter(([_, target]) => OVH_MODELS.some((om) => om.id === target))
  .map(([alias]) => alias),
]);
/**
 * Combined list of all 35 static free models (canonical)
 */
export const ALL_MODELS: ModelDef[] = [...OPENCODE_MODELS, ...KILO_MODELS, ...CLINE_MODELS, ...OVH_MODELS];

/**
 * Map of model ID -> ModelDef
 */
export const MODEL_MAP = new Map<string, ModelDef>(
 ALL_MODELS.map((m): [string, ModelDef] => [m.id, m]),
);

/**
 * Get full list of registered canonical models for Pi/OMP provider registration
 */
export function getAllRegisteredModels(): ModelDef[] {
 return ALL_MODELS;
}

/**
 * Lookup a model definition by ID (supporting alias fallback)
 */
export function getModelDef(id: string): ModelDef | undefined {
 return MODEL_MAP.get(id) || MODEL_MAP.get(resolveCanonicalModelId(id));
}


/**
 * Check if a model ID belongs to KiloCode Gateway
 */
export function isKiloModel(id: string): boolean {
 const canonical = resolveCanonicalModelId(id);
 return KILO_MODEL_IDS.has(id) || KILO_MODEL_IDS.has(canonical);
}

/**
 * Check if a model ID belongs to Cline
 */
export function isClineModel(id: string): boolean {
 const canonical = resolveCanonicalModelId(id);
 return CLINE_MODEL_IDS.has(id) || CLINE_MODEL_IDS.has(canonical);
}

/**
 * Check if a model ID belongs to OVHcloud AI Endpoints
 */
export function isOvhModel(id: string): boolean {
 const canonical = resolveCanonicalModelId(id);
 return OVH_MODEL_IDS.has(id) || OVH_MODEL_IDS.has(canonical);
}

/**
 * Determine the upstream provider for a given model ID
 */
export function getModelUpstream(id: string): Upstream {
 if (isClineModel(id)) return "cline";
 if (isOvhModel(id)) return "ovh";
 return isKiloModel(id) ? "kilo" : "opencode";
}
