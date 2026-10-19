/**
 * Static model definitions and upstream routing catalogs for pi-freeflow
 *
 * Defines the 35 verified free models (live-verified 2026-10-18):
 * - 12 OpenCode Zen models (all Chat Completions — the last Responses model,
 *   muse-spark-1.2-contributor-free, was deprecated upstream 2026-10-18)
 * - 13 KiloCode Keyless Gateway models (OpenRouter format)
 * - 2 Cline direct-only models (per-user pool; one is Responses API)
 * - 8 OVHcloud AI Endpoints models (keyless, direct-only)
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
  // Context is 262_144 even though the published twin now says 1,048,576
  // (reconciled 2026-10-20): the gateway answers 200 to oversized prompts and
  // silently truncates, so acceptance is not capability. A needle planted
  // at the end of a 248,232-token prompt is recalled; at 250,272 it is not.
  // The published 1M is what the model is declared to support; 262_144 is what
  // this lane actually serves with full recall — keep the measured value.
  contextWindow: 262_144,
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
  contextWindow: 1_048_576,
  maxTokens: 131_072,
 input: ["text", "image", "video"],
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
  // Raised 2026-10-20 (spec reconciliation): 1,048,576 ctx / 182,520 output
  // per the NVIDIA family origin and the paid OpenRouter twin; the Zen free
  // entry advertises the round 1M / 128K.
  contextWindow: 1_048_576,
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
  maxTokens: 262_144,
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
  // Input carries video as well as text/image: the published twin advertises
  // it and video is representable on this lane, so the reconciliation takes
  // the union. The live probe only confirmed image (a 1x1 PNG reads back as
  // "red").
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
  input: ["text", "image", "video"],
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
  id: "space-bunny-free",
  name: "Space Bunny Free [OpenCode]",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 524_288,
 input: ["text", "image", "video"],
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
   max: "max",
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
  // Effort ladder probed level-by-level 2026-10-16: minimal/low/medium/high/
  // xhigh/max all answer 200 (an unsupported value answers 400
  // [invalid_value], so the gateway validates per model), and minimal vs max
  // visibly changes reasoning length. Chat is the only native shape
  // (/v1/responses answers 400 "Model does not support this protocol"),
  // so `api` stays unset. Vision verified live (a 1x1 PNG reads back as a
  // colour). Video is carried from the published twin spec — 2026-10-20
  // reconciliation takes the union of host-representable modalities — while
  // pdf is not representable on this lane and is not offered.
  id: "glm-5.3-flash-free",
  name: "GLM-5.3 Flash [OpenCode]",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  input: ["text", "image", "video"],
  thinkingLevelMap: {
   off: null,
   minimal: "minimal",
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "xhigh",
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
  // Added 2026-10-16 (recheck): live free id on the Zen lane, listed on the
  // official free lineup while models.dev already tags it deprecated — the
  // tag also sits on live ids and on already-dead ones (mimo-v2.5-free), so
  // the live answer decides: chat 200 with tools + stream, and the tool call
  // round-trips. Chat is the only
  // native shape (/v1/responses answers 400 "Model does not support this
  // protocol"), so `api` stays unset. Reasoning: the published ladder lists
  // `high` only; high streams thinking and the unavailable rungs stay null
  // so the picker never offers them. Vision verified live (a 1x1 PNG reads
  // back as "Pink"). Context: published 1,048,576; a dual-canary prompt at
  // ~400K words (~520K tokens, canaries at ~30%/~97% depth) recalls both
  // markers, and a 1.2M-word prompt (~1.56M tokens) draws an empty-bodied
  // 400 — the wall sits between, matching the published figure. maxTokens
  // 131,072 published; 131,073 accepted (acceptance is not a cap, so the
  // published figure stays the budget).
  id: "exo-free",
  name: "Exo [OpenCode]",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  input: ["text", "image"],
  thinkingLevelMap: {
   off: null,
   minimal: null,
   low: null,
   medium: null,
   high: "high",
   xhigh: null,
   max: null,
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
  // Every effort level is accepted and visibly changes reasoning length, so
  // the whole ladder stays selectable; `off` is always null.
  thinkingLevelMap: {
   off: null,
   minimal: "minimal",
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
  // Kilo advertises 512,000 ctx / 460,800 out, but the only provider behind
  // this free id (atlas-cloud) serves a 393,216-token total window: with a
  // 20-token prompt, max_tokens 393,195 answers 200 and 393,196 answers 400,
  // and a 6,014-token prompt moves the boundary by exactly its prompt_tokens
  // (probed 2026-10-20). Declared window is the served one; the output budget
  // keeps 131,072 tokens of prompt headroom under it.
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
 input: ["text", "image", "video"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "nvidia/nemotron-3-ultra-550b-a55b:free",
  name: "Nemotron 3 Ultra 550B [Kilo]",
  reasoning: true,
  // Raised 2026-10-20: 1,048,576 ctx / 182,520 output per the NVIDIA family
  // origin (this entry previously carried the round 1M / 128K).
  contextWindow: 1_048_576,
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
  maxTokens: 262_144,
  input: ["text"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "nvidia/nemotron-3-super-120b-a12b:free",
  name: "Nemotron 3 Super 120B [Kilo]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 262_144,
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
  // Raised 2026-10-20: 1,048,576 ctx / 131,072 output per the published twins
  // (the free entry previously advertised 262,144 / 32,768).
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
  id: "thinkingmachines/inkling-small:free",
  name: "Inkling Small [Kilo]",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 262_144,
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
];

/**
 * Narrow effort map for the Cline flash models still in the catalog (GLM 5.3
 * Flash) — the reference reasoningOptions list effort values [low, high, max]
 * only (no toggle on GLM); minimal/medium/xhigh are not offered so the host
 * never sends an unsupported level (the proxy forwards effort verbatim).
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
 */
export const CLINE_MODELS: ModelDef[] = [
 {
  id: "cline-free/muse-spark-1.3-contributor",
  name: "Muse Spark 1.3 [Cline]",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  api: "openai-responses",
 input: ["text", "image", "video"],
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
  id: "z-ai/glm-5.3-flash",
  name: "GLM 5.3 Flash [Cline]",
  reasoning: true,
 contextWindow: 1_048_576,
  maxTokens: 131_072,
 input: ["text", "image", "video"],
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
 medium: null,
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
 * Specs (measured live 2026-10-13, reconciled against every twin provider
 * carrying a spec on 2026-10-20): contextWindow is OVH's advertised value —
 * the lane hard-caps there, so a twin advertising a larger window on another
 * provider is not served here and must not be copied in. maxTokens is the
 * highest published ceiling OVH actually accepts with a small prompt: the
 * `/v1/models` max_completion_tokens field repeats the context window, and a
 * request whose prompt + max reaches that window is refused (probed
 * 2026-10-20), so the echoed figure is not a usable budget. The Qwen family
 * accepts 131,072; the two 32K-output models use their published 32,768.
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
  maxTokens: 131_072,
  input: ["text"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/gpt-oss-20b",
  name: "GPT-OSS 20B [OVH]",
  reasoning: true,
  contextWindow: 131_072,
  maxTokens: 131_072,
  input: ["text"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/Qwen3.5-397B-A17B",
  name: "Qwen3.5 397B A17B [OVH]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 131_072,
  input: ["text", "image"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/Qwen3.5-9B",
  name: "Qwen3.5 9B [OVH]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 131_072,
  input: ["text", "image"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/Qwen3.6-27B",
  name: "Qwen3.6 27B [OVH]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 131_072,
  input: ["text", "image"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/Qwen3.8-27B",
  name: "Qwen3.8 27B [OVH]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 131_072,
  input: ["text", "image"],
  thinkingLevelMap: OVH_REASONING_MAP,
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
 */
export const MODEL_ALIASES: Record<string, string> = {
 "dots-3-note-preview": "dots-studio/dots-3-note-preview:free",
 "nemotron-3-nano-omni": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
 "nemotron-3-ultra-550b": "nvidia/nemotron-3-ultra-550b-a55b:free",
 "nemotron-3.5-lightning": "nvidia/nemotron-3.5-lightning:free",
 "nemotron-3-super": "nvidia/nemotron-3-super-120b-a12b:free",
 "north-mini-code": "cohere/north-mini-code:free",
 "lfm-2.5": "liquid/lfm-2.5-2.6b:free",
 "glm-5.3-flash": "glm-5.3-flash-free",
 "exo": "exo-free",
 "glyph-cluster": "stealth/glyph-cluster",
 "inkling-small": "thinkingmachines/inkling-small:free",
 "mimo-v2.6-flash": "mimo-v2.6-flash-free",
 "nemotron-3.5-super-vl": "nemotron-3.5-super-vl-free",
 "space-bunny": "space-bunny-free",
 "longcat-2.5-preview": "longcat-2.5-preview-free",
 "longcat": "longcat-2.5-preview-free",
 "beam": "beam-free",
 "deepseek-v4.1-flash": "deepseek-v4.1-flash-free",
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
