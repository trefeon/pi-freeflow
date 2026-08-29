/**
 * Static model definitions and upstream routing catalogs for pi-freeflow
 *
 * Defines the 25 verified free models:
 * - 7 OpenCode Zen models (1 Responses API + 6 Chat Completions)
 * - 18 KiloCode Keyless Gateway models (17 OpenRouter format + 1 Standard format)
 */

import type { ModelDef, ThinkingLevelMap, Upstream } from "./types.ts";

/**
 * OpenCode Zen free models verified against the live catalog and inference APIs.
 * Endpoint: https://opencode.ai/zen/v1
 */
export const OPENCODE_MODELS: ModelDef[] = [
	{
		id: "muse-spark-1.2-contributor-free",
		name: "Muse Spark 1.2 (1M)",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		api: "openai-responses",
		input: ["text", "image"],
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,},
	},
	{
		id: "mimo-v2.5-free",
		name: "MiMo V2.5 (1M)",
		reasoning: true,
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
			max: null,},
	},
	{
		id: "hy3-free",
		name: "Hy3 (262K)",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 128_000,
		input: ["text"],
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,},
	},
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra (1M)",
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
			max: null,},
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning (1M)",
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
			max: null,},
	},
	{
		id: "big-pickle",
		name: "Big Pickle",
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
			max: "max",},
	},
	{
		id: "laguna-s-2.1-free",
		name: "Laguna S 2.1 (256K)",
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
			max: null,},
	},
];

/**
 * Shared effort map for Kilo reasoning models — verified live 2026-08-29:
 * gateway accepts flat reasoning_effort minimal..xhigh for every reasoning
 * model; stepfun/step-3.7-flash measured monotonic 77→313 thinking chars
 * across minimal→xhigh. Declaring the map locks the picker (instead of
 * host guessing) and matches the OpenCode-model pattern.
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
 * Endpoint: https://api.kilo.ai/api/gateway/chat/completions
 */
export const KILO_MODELS: ModelDef[] = [
	{
		id: "dots-studio/dots-3-note-preview:free",
		name: "Dots3-Note Preview (512K)",
		reasoning: true,
		contextWindow: 512_000,
		maxTokens: 512_000,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "stepfun/step-3.7-flash:free",
		name: "Step 3.7 Flash",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
		name: "Nemotron 3 Nano Omni",
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: 131_072,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "nvidia/nemotron-3-ultra-550b-a55b:free",
		name: "Nemotron 3 Ultra 550B (1M)",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		input: ["text"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "nvidia/nemotron-3.5-lightning:free",
		name: "Nemotron 3.5 Lightning (Kilo)",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 262_144,
		input: ["text"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "nvidia/nemotron-3-super-120b-a12b:free",
		name: "Nemotron 3 Super 120B",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
		input: ["text"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "tencent/hy3:free",
		name: "Tencent Hy3 (Kilo)",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 128_000,
		input: ["text"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "cohere/north-mini-code:free",
		name: "North Mini Code",
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: 64_000,
		input: ["text"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "poolside/laguna-s-2.1:free",
		name: "Laguna S 2.1 (Kilo)",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 32_768,
		input: ["text"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "poolside/laguna-xs-2.1:free",
		name: "Laguna XS 2.1",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 32_768,
		input: ["text"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "liquid/lfm-2.5-2.6b:free",
		name: "Liquid LFM 2.5",
		reasoning: true,
		contextWindow: 65_536,
		maxTokens: 32_768,
		input: ["text"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "kilo-auto/free",
		name: "Kilo Auto",
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: 10_000,
		input: ["text"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "openrouter/free",
		name: "OpenRouter Auto",
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 65_536,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
		thinkingLevelMap: KILO_REASONING_MAP,
	},
	{
		id: "nvidia/nemotron-3.5-content-safety:free",
		name: "Nemotron Content Safety",
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 8_192,
		input: ["text", "image"],
	},
{
	id: "meituan/longcat-2.0-free",
	name: "LongCat 2.0 (1M)",
	reasoning: true,
	contextWindow: 1_048_756,
	maxTokens: 262_144,
	input: ["text"],
	thinkingFormat: "openrouter",
	thinkingLevelMap: KILO_REASONING_MAP,
},
{
	id: "minimax/minimax-m2.7:free",
	name: "MiniMax M2.7 (free)",
	reasoning: true,
	contextWindow: 196_608,
	maxTokens: 196_608,
	input: ["text"],
	thinkingFormat: "openrouter",
	thinkingLevelMap: KILO_REASONING_MAP,
},
{
	id: "minimax/minimax-m3:free",
	name: "MiniMax M3 (free)",
	reasoning: true,
	contextWindow: 1_048_576,
	maxTokens: 524_288,
	input: ["text"],
	thinkingFormat: "openrouter",
	thinkingLevelMap: KILO_REASONING_MAP,
},
{
	id: "inclusionai/ling-3.0-flash-fin:free",
	name: "Ling 3.0 Flash Fin",
	reasoning: true,
	contextWindow: 262_144,
	maxTokens: 32_768,
	input: ["text"],
	thinkingFormat: "openrouter",
	thinkingLevelMap: KILO_REASONING_MAP,
},
];

/**
 * Model ID Aliases — maps user-friendly / slash-free CLI IDs to canonical upstream model IDs.
 * Single clean alias per model (no :free duplicates). Wrong cross-lab aliases removed:
 * - Muse Spark 1.2 = Meta Superintelligence Labs (not Anthropic Claude) → removed claude-sonnet aliases
 * - Laguna S 2.1 = Poolside (not MiniMax) → removed minimax-m2.1 alias
 * - Hy3 = Tencent Hunyuan (not Alibaba Qwen) → removed qwen3-coder alias
 */
export const MODEL_ALIASES: Record<string, string> = {
	// Kilo Gateway — slash-free & colon-free clean aliases (one per model)
	"dots-3-note-preview": "dots-studio/dots-3-note-preview:free",
	"step-3.7-flash": "stepfun/step-3.7-flash:free",
	"nemotron-3-nano-omni": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
	"nemotron-3-ultra-550b": "nvidia/nemotron-3-ultra-550b-a55b:free",
	"nemotron-3.5-lightning": "nvidia/nemotron-3.5-lightning:free",
	"nemotron-3-super": "nvidia/nemotron-3-super-120b-a12b:free",
	"north-mini-code": "cohere/north-mini-code:free",
	"lfm-2.5": "liquid/lfm-2.5-2.6b:free",
	"content-safety": "nvidia/nemotron-3.5-content-safety:free",
	"longcat-2.0": "meituan/longcat-2.0-free",
	"minimax-m2.7": "minimax/minimax-m2.7:free",
	"minimax-m3": "minimax/minimax-m3:free",
	"ling-3.0-flash-fin": "inclusionai/ling-3.0-flash-fin:free",
	// provider-prefixed short aliases (slash-normalized)
	"hy3:free": "tencent/hy3:free",
	"laguna-s-2.1:free": "poolside/laguna-s-2.1:free",
	"laguna-xs-2.1:free": "poolside/laguna-xs-2.1:free",
	"kilo-auto": "kilo-auto/free",
	"openrouter": "openrouter/free",
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
 * Combined list of all 25 static free models (canonical)
 */
export const ALL_MODELS: ModelDef[] = [...OPENCODE_MODELS, ...KILO_MODELS];

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
 * Determine the upstream provider for a given model ID
 */
export function getModelUpstream(id: string): Upstream {
	return isKiloModel(id) ? "kilo" : "opencode";
}
