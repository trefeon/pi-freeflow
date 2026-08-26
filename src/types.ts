/**
 * Core type definitions for pi-freeflow
 */

export type ProviderApi = "openai-completions" | "openai-responses";
export type Upstream = "opencode" | "kilo";

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export type ModelInputType = "text" | "image";

export interface ModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	api?: ProviderApi;
	input?: ModelInputType[];
	thinkingFormat?: "openrouter";
	thinkingLevelMap?: ThinkingLevelMap;
}

export type RegisteredModel = ModelDef & {
	source: Upstream;
};

export interface KnownRelay {
	url: string;
	label?: string;
	addedAt?: string;
}
export type RelayMode = "auto" | "on" | "off";

export interface RelayState {
	mode?: RelayMode;
	enabled: boolean;
	url: string;
	relays: KnownRelay[];
}
export type LogLevel = "debug" | "info" | "warn" | "error" | "audit";

export interface DebugState {
	debug: boolean;
	level?: LogLevel;
}

export interface RawModelItem {
	id: string;
	name?: string;
	context_length?: number;
	max_tokens?: number;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	[key: string]: unknown;
}

export interface CatalogCacheData {
	timestamp: number;
	opencode: string[];
	kilo: string[];
	models?: RegisteredModel[];
}

export interface RateLimitEntry {
	count: number;
	resetAt: number;
}

export interface RateLimitStatus {
	allowed: boolean;
	remaining: number;
	resetAt: number;
	limit: number;
	count: number;
}

// ── Extension API & UI Types (compatible with @earendil-works/pi-coding-agent) ──

export interface ExtensionUIContext {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, status: string | undefined): void;
	input(prompt: string, defaultValue?: string): Promise<string | undefined>;
	select(prompt: string, options: string[]): Promise<string | undefined>;
	confirm?(prompt: string): Promise<boolean>;
}

export interface ExtensionContext {
	ui: ExtensionUIContext;
	[key: string]: unknown;
}

export interface CommandCompletion {
	value: string;
	label?: string;
	description?: string;
}

export interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => CommandCompletion[];
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

export interface ProviderModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ProviderModelCompat {
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	thinkingFormat?: "openrouter" | string;
	sessionAffinityFormat?: "openai-nosession" | string;
	[key: string]: unknown;
}

export interface ProviderModelConfig {
	id: string;
	name: string;
	api?: ProviderApi;
	reasoning?: boolean;
	thinking?: {
		mode: string;
		efforts?: string[];
		[key: string]: unknown;
	};
	thinkingLevelMap?: ThinkingLevelMap;
	input?: ModelInputType[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: ProviderModelCost;
	compat?: ProviderModelCompat;
}

export interface ProviderConfig {
	baseUrl: string;
	apiKey: string;
	api: ProviderApi;
	compat?: {
		supportsDeveloperRole?: boolean;
		[key: string]: unknown;
	};
	models: ProviderModelConfig[];
}

export interface ExtensionAPI {
	registerProvider(name: string, config: ProviderConfig): void;
	registerCommand(name: string, spec: RegisteredCommand): void;
	on?(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
	sendUserMessage?(message: string, options?: { deliverAs?: string }): void;
	[key: string]: unknown;
}
