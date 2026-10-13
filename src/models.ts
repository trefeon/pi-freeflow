/**
 * Static model definitions and upstream routing catalogs for pi-freeflow
 *
 * Defines the 37 verified free models (live-verified 2026-10-13):
 * - 11 OpenCode Zen models (2 Responses API + 9 Chat Completions)
 * - 15 KiloCode Keyless Gateway models (OpenRouter format)
 * - 2 Cline direct-only models (per-user pool)
 * - 9 OVHcloud AI Endpoints models (keyless, direct-only)
 */

import type { ModelDef, ThinkingLevelMap, Upstream } from "./types.ts";

/**
 * OpenCode Zen free models verified against the live catalog and inference APIs.
 * Endpoint: https://opencode.ai/zen/v1
 */
export const OPENCODE_MODELS: ModelDef[] = [
 {
  id: "cat-jam-free",
  name: "Cat Jam [OpenCode]",
  reasoning: true,
  // Context is 262_144, NOT the 1M an acceptance probe suggests: the gateway
  // answers 200 to oversized prompts and silently truncates. A needle planted
  // at the end of a 248,232-token prompt is recalled; at 250,272 it is not.
  // Cross-checked against the published spec, which agrees.
  contextWindow: 262_144,
  maxTokens: 131_072,
  input: ["text"],
  thinkingLevelMap: {
   off: null,
   minimal: null,
   low: "low",
   medium: "medium",
   high: "high",
   xhigh: "xhigh",
   max: null,
  },
 },
 {
  id: "muse-spark-1.2-contributor-free",
  name: "Muse Spark 1.2 [OpenCode]",
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
  id: "muse-spark-1.3-contributor-free",
  name: "Muse Spark 1.3 [OpenCode]",
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
  contextWindow: 1_000_000,
  maxTokens: 128_000,
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
  contextWindow: 1_000_000,
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
 // Added 2026-10-09: replaces fledge-alpha-free (withdrawn upstream —
 // absent from the live list, chat 401 "not supported"). Live on the Zen
 // list; gated-lane 403 matches the working models from a refused egress,
 // so it rides the same fingerprint path. Specs per models.dev
 // (opencode/step-5-preview-free) + StepFun docs, NOT the enrichModelDef
 // substring heuristic (which yields reasoning:false / 262K / text-only):
 // 1M ctx, 64K max output, text+image+video, efforts low/medium/high only.
 // minimal is explicitly null (omitting the key leaves it selectable in
 // the host); xhigh/max are unsupported upstream.
 id: "step-5-preview-free",
 name: "Step 5 Preview [OpenCode]",
 reasoning: true,
 contextWindow: 1_000_000,
 maxTokens: 65_536,
 input: ["text", "image", "video"],
 thinkingLevelMap: {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
 },
 },
 {
  id: "ling-3.1-flash-free",
  name: "Ling 3.1 Flash Free [OpenCode]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 32_768,
  input: ["text"],
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
  name: "Dots3-Note Preview (512K) [Kilo]",
  reasoning: true,
  contextWindow: 512_000,
  maxTokens: 512_000,
  input: ["text", "image"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  name: "Nemotron 3 Nano Omni [Kilo]",
  reasoning: true,
  contextWindow: 256_000,
  maxTokens: 131_072,
 input: ["text", "image", "video"],
  thinkingFormat: "openrouter",
  thinkingLevelMap: KILO_REASONING_MAP,
 },
 {
  id: "nvidia/nemotron-3-ultra-550b-a55b:free",
  name: "Nemotron 3 Ultra 550B [Kilo]",
  reasoning: true,
  contextWindow: 1_000_000,
  maxTokens: 128_000,
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
  contextWindow: 262_144,
  maxTokens: 32_768,
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
  contextWindow: 65_536,
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
  // Added 2026-10-09: replaces step-3.7-flash (demoted to paid upstream —
  // :free ID 404s keyless). Live on Kilo free list (isFree:true, 0/0
  // pricing, 1M ctx) + keyless chat served (429 provider concurrency).
  id: "stepfun/step-5-preview-free",
  name: "Step 5 Preview [Kilo]",
  reasoning: true,
  contextWindow: 1_000_000,
 maxTokens: 65_536,
 input: ["text", "image", "video"],
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
 {
  // Added 2026-10-07: live on Kilo free list (isFree:true, 0/0 pricing, 262K ctx)
  id: "inclusionai/ling-3.1-flash",
  name: "Ling 3.1 Flash [Kilo]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 32_768,
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
 * Specs (measured live 2026-10-13 and cross-checked against every twin
 * provider carrying a spec): contextWindow is OVH's advertised value;
 * maxTokens is deliberately the conservative FLOOR across twin providers —
 * per-provider output caps for the same model range from 4K to 256K, and a
 * cap that is too low never breaks a request while one that is too high lets
 * a host ask for an output the provider refuses. OVH itself enforces only
 * `context - prompt` (verified by binary search), so these are safe request
 * budgets rather than a refusal boundary.
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
  maxTokens: 32_768,
  input: ["text"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/gpt-oss-20b",
  name: "GPT-OSS 20B [OVH]",
  reasoning: true,
  contextWindow: 131_072,
  maxTokens: 32_768,
  input: ["text"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/Qwen3.5-397B-A17B",
  name: "Qwen3.5 397B A17B [OVH]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 65_536,
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
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/Qwen3.8-27B",
  name: "Qwen3.8 27B [OVH]",
  reasoning: true,
  contextWindow: 262_144,
  maxTokens: 32_768,
  input: ["text", "image"],
  thinkingLevelMap: OVH_REASONING_MAP,
 },
 {
  id: "ovh-free/Mistral-Small-3.2-24B-Instruct-2506",
  name: "Mistral Small 3.2 24B [OVH]",
  reasoning: false,
  contextWindow: 131_072,
  maxTokens: 16_384,
  input: ["text", "image"],
 },
 {
  id: "ovh-free/Mistral-7B-Instruct-v0.3",
  name: "Mistral 7B Instruct v0.3 [OVH]",
  reasoning: false,
  contextWindow: 65_536,
  maxTokens: 65_536,
  input: ["text"],
 },
 {
  id: "ovh-free/Meta-Llama-3_3-70B-Instruct",
  name: "Meta Llama 3.3 70B Instruct [OVH]",
  reasoning: false,
  contextWindow: 131_072,
  maxTokens: 16_384,
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
 "step-5-preview:kilo": "stepfun/step-5-preview-free",
 "glyph-cluster": "stealth/glyph-cluster",
 "inkling-small": "thinkingmachines/inkling-small:free",
 "mimo-v2.6-flash": "mimo-v2.6-flash-free",
 "space-bunny": "space-bunny-free",
 "longcat-2.5-preview": "longcat-2.5-preview-free",
 "longcat": "longcat-2.5-preview-free",
 "step-5-preview": "step-5-preview-free",
 "ling-3.1-flash": "ling-3.1-flash-free",
 "ling-3.1-flash:kilo": "inclusionai/ling-3.1-flash",
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
"mistral-7b-v0.3": "ovh-free/Mistral-7B-Instruct-v0.3",
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
 * Combined list of all 36 static free models (canonical)
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
