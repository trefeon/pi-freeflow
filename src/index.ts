/**
 * pi-freeflow — Modular, high-resiliency LLM extension for Pi & Oh My Pi (OMP)
 *
 * Provides access to 23 free models (9 OpenCode Zen + 14 KiloCode Gateway) with:
 * - Single-port daemon reuse on 18080 across concurrent subagents
 * - Multi-cloud rolling egress relays (Vercel Edge, Cloudflare, Deno)
 * - 0ms instant startup with verified static catalog and background live health checks
 * - Per-model thinking/reasoning translation and streaming SSE pass-through
 */

import type * as http from "node:http";
import {
	getAliveCatalog,
	readCatalogCache,
	refreshCatalog,
	setAliveCatalog,
} from "./catalog.ts";
import { createCommandSpec, updateStatusBar } from "./commands.ts";
import { DEFAULT_HOST, HOST, PORT } from "./config.ts";
import { log, logInfo, logWarn } from "./logger.ts";
import { ALL_MODELS, KILO_MODEL_IDS, MODEL_MAP, getAllRegisteredModels, resolveCanonicalModelId } from "./models.ts";
import { isProxyAlive, startProxy } from "./proxy.ts";
import { resetRateLimits } from "./rate-limiter.ts";
import {
	getActiveRelayState,
	resolveRelayState,
	setActiveRelayState,
	setStatusUi,
	setFreeFlowModelActive,
} from "./relay-state.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
	RegisteredModel,
} from "./types.ts";

// Re-export all sub-modules for clean library and programmatic usage
export * from "./types.ts";
export * from "./config.ts";
export * from "./logger.ts";
export * from "./rate-limiter.ts";
export * from "./models.ts";
export * from "./catalog.ts";
export * from "./relay-state.ts";
export * from "./relay.ts";
export * from "./deploy.ts";
export * from "./stream-pipe.ts";
export * from "./proxy.ts";
export * from "./commands.ts";

/**
 * Construct standard ProviderConfig for pi-ai / OMP registration.
 */
export function buildProviderConfig(
	models: RegisteredModel[],
	port: number = PORT,
): ProviderConfig {
	return {
		baseUrl: `http://${HOST}:${port}/v1`,
		apiKey: "placeholder",
		api: "openai-completions",
		compat: { supportsDeveloperRole: false },
		models: models.map((m) => {
			const efforts = m.thinkingLevelMap
				? (Object.keys(m.thinkingLevelMap) as (keyof typeof m.thinkingLevelMap)[]).filter(
						(k) => m.thinkingLevelMap![k] !== null && k !== "off",
					)
				: ["minimal", "low", "medium", "high", "xhigh"];

			return {
				id: m.id,
				name: m.name,
				api: m.api,
				reasoning: m.reasoning,
				thinking: m.reasoning
					? {
							mode: "effort",
							efforts: efforts.length > 0 ? efforts : ["low", "high", "max"],
						}
					: undefined,
				thinkingLevelMap: m.thinkingLevelMap,
				input: m.input ?? ["text"],
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: m.thinkingFormat
					? {
							supportsDeveloperRole: false,
							thinkingFormat: m.thinkingFormat,
						}
					: m.api === "openai-responses"
						? { sessionAffinityFormat: "openai-nosession" }
						: m.source === "kilo"
							? {
									supportsDeveloperRole: false,
									supportsReasoningEffort: false,
								}
							: {
									supportsDeveloperRole: false,
									supportsReasoningEffort: true,
								},
			};
		}),
	};
}

/**
 * Main extension entrypoint
 */
export default async function (pi: ExtensionAPI): Promise<void> {
	logInfo("pi-freeflow extension initializing...");


	let server: http.Server | null = null;
	let actualPort = PORT;

	// 2. Single-Port Shared Pattern: Check if daemon is already running (e.g. parent session)
	const alreadyRunning = await isProxyAlive(PORT);
	if (alreadyRunning) {
		logInfo(
			`Reusing existing pi-freeflow proxy daemon on http://${HOST}:${PORT}`,
		);
		actualPort = PORT;
	} else {
		try {
			const r = await startProxy();
			server = r.server;
			actualPort = r.port;
		} catch (e) {
			log(
				"error",
				"extension inactive — could not bind proxy port. resolve the port conflict and restart pi.",
				{ error: String(e) },
			);
			return;
		}
	}

	// 3. Instant 0ms Static Catalog Registration
	// Register static models immediately on boot so Pi/OMP picker is populated with zero latency!
	const registeredCatalog: RegisteredModel[] = ALL_MODELS.map((m) => ({
		...m,
		source: KILO_MODEL_IDS.has(m.id) ? "kilo" : "opencode",
	}));
	setAliveCatalog(registeredCatalog);
	pi.registerProvider(
		"freeflow",
		buildProviderConfig(registeredCatalog, actualPort),
	);

	// 4. Background Catalog Refresh
	// Asynchronously probe live upstreams and update the provider if alive model list changes
	refreshCatalog(false)
		.then((aliveModels) => {
			if (aliveModels.length > 0) {
				setAliveCatalog(aliveModels);
				pi.registerProvider(
					"freeflow",
					buildProviderConfig(registeredCatalog, actualPort),
				);
				logInfo(
					`Catalog refreshed: ${aliveModels.length} models verified active`,
				);
			}
		})
		.catch((err) => {
			logWarn("Background catalog refresh failed; retaining static catalog", {
				error: String(err),
			});
		});

	// 5. Register slash command
	const commandSpec = createCommandSpec(pi, (updatedModels) => {
		pi.registerProvider(
			"freeflow",
			buildProviderConfig(updatedModels, actualPort),
		);
	});
	pi.registerCommand("freeflow", commandSpec);

	// 6. Lifecycle Listeners
	function isFreeFlowModelMatch(provider?: string, modelId?: string): boolean {
		if (provider === "freeflow") return true;
		if (typeof modelId === "string" && modelId.trim()) {
			const clean = modelId.trim();
			const canonical = resolveCanonicalModelId(clean);
			return (
				MODEL_MAP.has(clean) ||
				MODEL_MAP.has(canonical) ||
				getAliveCatalog().some((m) => m.id === clean || m.id === canonical)
			);
		}
		// When provider and modelId are not yet populated on session_start,
		// default to true so the widget is present when starting with freeflow
		if (!provider && !modelId) {
			return true;
		}
		return false;
	}

	pi.on?.("session_start", async (_event, ctx: ExtensionContext) => {
		const freshRelayState = resolveRelayState();
		setStatusUi(ctx.ui);

		let provider: string | undefined;
		let modelId: string | undefined;
		if (ctx && typeof ctx === "object" && "model" in ctx && ctx.model && typeof ctx.model === "object") {
			const m = ctx.model;
			if ("provider" in m && typeof m.provider === "string") {
				provider = m.provider;
			}
			if ("id" in m && typeof m.id === "string") {
				modelId = m.id;
			}
		}
		const isFreeFlow = isFreeFlowModelMatch(provider, modelId);
		setFreeFlowModelActive(isFreeFlow);

		if (freshRelayState.mode !== "off") {
			freshRelayState.enabled = freshRelayState.relays.length > 0;
			setActiveRelayState(freshRelayState, false);
		}

		if (isFreeFlow) {
			updateStatusBar(ctx.ui);
		} else {
			ctx.ui?.setStatus?.("freeflow", undefined);
		}
	});

	pi.on?.("model_select", async (event, ctx: ExtensionContext) => {
		const freshRelayState = resolveRelayState();
		setStatusUi(ctx.ui);
		let provider: string | undefined;
		let modelId: string | undefined;
		if (event && typeof event === "object" && "model" in event && event.model && typeof event.model === "object") {
			const m = event.model;
			if ("provider" in m && typeof m.provider === "string") {
				provider = m.provider;
			}
			if ("id" in m && typeof m.id === "string") {
				modelId = m.id;
			}
		} else if (ctx && typeof ctx === "object" && "model" in ctx && ctx.model && typeof ctx.model === "object") {
			const m = ctx.model;
			if ("provider" in m && typeof m.provider === "string") {
				provider = m.provider;
			}
			if ("id" in m && typeof m.id === "string") {
				modelId = m.id;
			}
		}
		const isFreeFlow = isFreeFlowModelMatch(provider, modelId);
		setFreeFlowModelActive(isFreeFlow);

		if (freshRelayState.mode !== "off") {
			freshRelayState.enabled = freshRelayState.relays.length > 0;
			setActiveRelayState(freshRelayState, false);
		}

		if (isFreeFlow) {
			updateStatusBar(ctx.ui);
		} else {
			ctx.ui?.setStatus?.("freeflow", undefined);
		}
	});
	pi.on?.("session_shutdown", () => {
		if (server) {
			logInfo("shutting down proxy daemon...");
			server.close();
			server = null;
			resetRateLimits();
			logInfo("shutdown complete");
		}
	});
}
