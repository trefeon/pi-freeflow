/**
 * Static model definitions and upstream routing catalogs for pi-freeflow
 *
 * Defines the 23 verified free models:
 * - 9 OpenCode Zen models (2 Responses API + 7 Chat Completions)
 * - 14 KiloCode Keyless Gateway models (11 OpenRouter format + 3 Standard format)
 */

import type { ModelDef, Upstream } from "./types.ts";

/**
 * OpenCode Zen free models verified against the live catalog and inference APIs.
 * Endpoint: https://opencode.ai/zen/v1
 */
export const OPENCODE_MODELS: ModelDef[] = [
	{
		id: "deepseek-v4-flash-free",
		name: "DeepSeek V4 Flash (1M)",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		input: ["text"],
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		},
	},
	{
		id: "x-preview-f-free",
		name: "Ox Alpha (1M)",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		input: ["text", "image"],
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		},
	},
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
			max: "max",
		},
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
			max: "high",
		},
	},
	{
		id: "hy3-free",
		name: "Hy3 (262K)",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
		input: ["text"],
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		},
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
			minimal: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		},
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
			minimal: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		},
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
			minimal: "high",
			low: "high",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		},
	},
	{
		id: "laguna-s-2.1-free",
		name: "Laguna S 2.1 (1M)",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		input: ["text"],
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		},
	},
];

/**
 * Backward compatibility alias for OPENCODE_MODELS
 */
export const KNOWN_MODELS = OPENCODE_MODELS;

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
	},
	{
		id: "stepfun/step-3.7-flash:free",
		name: "Step 3.7 Flash",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
	},
	{
		id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
		name: "Nemotron 3 Nano Omni",
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: 65_536,
		input: ["text", "image"],
		thinkingFormat: "openrouter",
	},
	{
		id: "nvidia/nemotron-3-ultra-550b-a55b:free",
		name: "Nemotron 3 Ultra 550B (1M)",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		input: ["text"],
		thinkingFormat: "openrouter",
	},
	{
		id: "nvidia/nemotron-3.5-lightning:free",
		name: "Nemotron 3.5 Lightning (Kilo)",
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		input: ["text"],
		thinkingFormat: "openrouter",
	},
	{
		id: "nvidia/nemotron-3-super-120b-a12b:free",
		name: "Nemotron 3 Super 120B",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
		input: ["text"],
		thinkingFormat: "openrouter",
	},
	{
		id: "tencent/hy3:free",
		name: "Tencent Hy3 (Kilo)",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 262_144,
		input: ["text"],
	},
	{
		id: "cohere/north-mini-code:free",
		name: "North Mini Code",
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: 64_000,
		input: ["text"],
		thinkingFormat: "openrouter",
	},
	{
		id: "poolside/laguna-s-2.1:free",
		name: "Laguna S 2.1 (Kilo)",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		input: ["text"],
		thinkingFormat: "openrouter",
	},
	{
		id: "poolside/laguna-xs-2.1:free",
		name: "Laguna XS 2.1",
		reasoning: true,
		contextWindow: 262_144,
		maxTokens: 32_768,
		input: ["text"],
		thinkingFormat: "openrouter",
	},
	{
		id: "liquid/lfm-2.5-2.6b:free",
		name: "Liquid LFM 2.5",
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 32_768,
		input: ["text"],
		thinkingFormat: "openrouter",
	},
	{
		id: "kilo-auto/free",
		name: "Kilo Auto",
		reasoning: false,
		contextWindow: 256_000,
		maxTokens: 10_000,
		input: ["text"],
	},
	{
		id: "openrouter/free",
		name: "OpenRouter Auto",
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: 65_536,
		input: ["text", "image"],
	},
	{
		id: "nvidia/nemotron-3.5-content-safety:free",
		name: "Nemotron Content Safety",
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 8_192,
		input: ["text", "image"],
	},
];

/**
 * Model ID Aliases — maps user-friendly / slash-free CLI IDs to canonical upstream model IDs.
 */
export const MODEL_ALIASES: Record<string, string> = {
	// Kilo Gateway slash-free & colon-free CLI aliases
	"dots-3-note-preview": "dots-studio/dots-3-note-preview:free",
	"dots-3-note-preview:free": "dots-studio/dots-3-note-preview:free",
	"step-3.7-flash": "stepfun/step-3.7-flash:free",
	"step-3.7-flash:free": "stepfun/step-3.7-flash:free",
	"nemotron-3-nano-omni": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
	"nemotron-3-nano-omni:free": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
	"nemotron-3-ultra-550b": "nvidia/nemotron-3-ultra-550b-a55b:free",
	"nemotron-3-ultra-550b:free": "nvidia/nemotron-3-ultra-550b-a55b:free",
	"nemotron-3-super": "nvidia/nemotron-3-super-120b-a12b:free",
	"nemotron-3-super:free": "nvidia/nemotron-3-super-120b-a12b:free",
	"hy3:free": "tencent/hy3:free",
	"north-mini-code": "cohere/north-mini-code:free",
	"north-mini-code:free": "cohere/north-mini-code:free",
	"laguna-s-2.1:free": "poolside/laguna-s-2.1:free",
	"laguna-xs-2.1:free": "poolside/laguna-xs-2.1:free",
	"lfm-2.5": "liquid/lfm-2.5-2.6b:free",
	"lfm-2.5:free": "liquid/lfm-2.5-2.6b:free",
	"content-safety": "nvidia/nemotron-3.5-content-safety:free",
	"content-safety:free": "nvidia/nemotron-3.5-content-safety:free",
	"kilo-auto": "kilo-auto/free",
	"openrouter": "openrouter/free",

	// OpenCode Zen aliases
	"claude-sonnet-4.5-free": "muse-spark-1.2-contributor-free",
	"claude-sonnet-4.5-contributor-free": "muse-spark-1.2-contributor-free",
	"grok-code-fast-1-preview-f-free": "x-preview-f-free",
	"minimax-m2.1-free": "laguna-s-2.1-free",
	"qwen3-coder-480b-free": "hy3-free",
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
 * Combined list of all 23 static free models (canonical)
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
