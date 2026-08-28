/**
 * pi-freeflow — Modular, high-resiliency LLM extension for Pi & Oh My Pi (OMP)
 *
 * Provides access to 21 free models (7 OpenCode Zen + 14 KiloCode Gateway) with:
 * - Single-port daemon reuse on 28180 across concurrent subagents
 * - Multi-cloud rolling egress relays (Vercel Edge, Cloudflare, Deno)
 * - 0ms instant startup with verified static catalog and background live health checks
 * - Per-model thinking/reasoning translation and streaming SSE pass-through
 */
import fs from "node:fs";
import path from "node:path";
import type * as http from "node:http";
import {
	getAliveCatalog,
	mergeCatalog,
	readCatalogCache,
	refreshCatalog,
	setAliveCatalog,
} from "./catalog.ts";
import { createCommandSpec, updateStatusBar } from "./commands.ts";
import { DEFAULT_HOST, HOST, LEGACY_PORT, ONBOARDED_FLAG_FILE, PORT } from "./config.ts";
import { log, logInfo, logWarn } from "./logger.ts";
import { ALL_MODELS, KILO_MODEL_IDS, MODEL_MAP, getAllRegisteredModels, resolveCanonicalModelId } from "./models.ts";
import { isProxyAlive, startProxy } from "./proxy.ts";
import { resetRateLimits } from "./rate-limiter.ts";
import { checkForUpdateInBackground } from "./update-checker.ts";
import {
	ensureRelay,
	getActiveRelayState,
	resolveRelayState,
	setActiveRelayState,
	setStatusUi,
	setFreeFlowModelActive,
	shortRelayLabel,
} from "./relay-state.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
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
 * Bind widget click to relay picker when host supports it.
 * Feature-detects `onStatusClick` (or similar) on ExtensionUIContext.
 * Falls back to no-op; status hint already tells user to use `/freeflow use`.
 */
export function bindWidgetClick(ui: ExtensionUIContext): void {
	const anyUi = ui as unknown as Record<string, unknown>;
	const candidates = ["onStatusClick", "onStatusBarClick", "onWidgetClick"] as const;
	let clickFn: ((h: () => void | Promise<void>) => unknown) | undefined;
	for (const name of candidates) {
		const v = anyUi[name];
		if (typeof v === "function") {
			clickFn = v as (h: () => void | Promise<void>) => unknown;
			break;
		}
	}
	if (!clickFn) return;
	try {
		clickFn.call(anyUi, async () => {
			try {
				const state = getActiveRelayState();
				if (!state.relays.length) {
					ui.notify("Use /freeflow use — no relays saved. Add one with /freeflow add <URL>", "info");
					return;
				}
				const fmt = (r: { url: string; label?: string }, idx: number) => {
					const isAct = r.url === state.url ? "★ " : "  ";
					const lbl = r.label ? `[${r.label}] ` : `[${shortRelayLabel(r.url, state.relays)}] `;
					return `${isAct}[${idx + 1}] ${lbl}→ ${r.url}`;
				};
				const opts = state.relays.map(fmt);
				const choice = await ui.select("Switch active relay", opts);
				if (!choice) return;
				const idx = opts.indexOf(choice);
				const match = idx >= 0 ? state.relays[idx] : undefined;
				// Fallback find by formatting match
				const resolved = match ?? state.relays.find((r, i) => fmt(r, i) === choice);
				if (!resolved) return;
				state.enabled = true;
				state.url = resolved.url;
				ensureRelay(state, resolved.url, resolved.label);
				setActiveRelayState(state);
				setStatusUi(ui);
				updateStatusBar(ui);
				ui.notify(`Relay active: ${resolved.label || shortRelayLabel(resolved.url, state.relays)}`, "info");
			} catch {}
		});
	} catch {}
}


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
	// Dual-probe: probe current PORT first; if missing, check LEGACY_PORT so existing v1.4.9
	// sessions on 18080 are seamlessly reused without split-brain or duplicate daemons.
	let alreadyRunning = await isProxyAlive(PORT);
	if (alreadyRunning) {
		logInfo(
			`Reusing existing pi-freeflow proxy daemon on http://${HOST}:${PORT}`,
		);
		actualPort = PORT;
	} else if (PORT !== LEGACY_PORT && (await isProxyAlive(LEGACY_PORT))) {
		logInfo(
			`Reusing existing legacy pi-freeflow proxy daemon on http://${HOST}:${LEGACY_PORT}`,
		);
		alreadyRunning = true;
		actualPort = LEGACY_PORT;
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
	const registerCatalog = (models: RegisteredModel[]): void => {

		pi.registerProvider(
			"freeflow",
			buildProviderConfig(models, actualPort),
		);
	};
	registerCatalog(registeredCatalog);
	// Self-heal: if this session attached to an external daemon that later died,
	// re-bind on the next lifecycle event so model calls recover without a restart.
	let ensuringDaemon = false;
	const ensureDaemon = async (): Promise<void> => {
		if (ensuringDaemon) return;
		ensuringDaemon = true;
		try {
			if (await isProxyAlive(actualPort)) return;
			// If actualPort died, check if another daemon is alive on PORT or LEGACY_PORT before binding
			if (await isProxyAlive(PORT)) {
				actualPort = PORT;
				registerCatalog(getAliveCatalog());
				logInfo(`Re-attached to proxy daemon on http://${HOST}:${PORT}`);
				return;
			}
			if (PORT !== LEGACY_PORT && (await isProxyAlive(LEGACY_PORT))) {
				actualPort = LEGACY_PORT;
				registerCatalog(getAliveCatalog());
				logInfo(`Re-attached to legacy proxy daemon on http://${HOST}:${LEGACY_PORT}`);
				return;
			}
			const r = await startProxy();
			if (r.server) server = r.server;
			if (r.port) actualPort = r.port;
			registerCatalog(getAliveCatalog());
			logWarn("proxy daemon was lost — re-bound locally", { port: actualPort });
		} catch (e) {
			logWarn("proxy daemon lost and re-bind failed", { error: String(e) });
		} finally {
			ensuringDaemon = false;
		}
	};

	// 4. Background Catalog Refresh
	// Asynchronously probe live upstreams and update the provider if alive model list changes
	refreshCatalog(false)
		.then((aliveModels) => {
			if (aliveModels.length > 0) {
				setAliveCatalog(aliveModels);
				registerCatalog(mergeCatalog(registeredCatalog, aliveModels));
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
		registerCatalog(updatedModels);
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
		await ensureDaemon();
		const freshRelayState = resolveRelayState();
		setStatusUi(ctx.ui);
		try { bindWidgetClick(ctx.ui); } catch {}

		// First-run onboarding: write the flag before notifying so a crash can
		// never re-fire the message; never block session start.
		try {
			if (!fs.existsSync(ONBOARDED_FLAG_FILE)) {
				fs.mkdirSync(path.dirname(ONBOARDED_FLAG_FILE), { recursive: true });
				fs.writeFileSync(ONBOARDED_FLAG_FILE, "1", "utf8");
				const hint =
					freshRelayState.relays.length > 0
						? `Relay pool ready: ${freshRelayState.relays.length} relay(s). Run /freeflow for pool management.`
						: "Relay pool empty — direct mode. Run /freeflow deploy to add your own egress.";
				ctx.ui?.notify?.(
					`freeflow ready: 21 free models via local proxy 127.0.0.1:28180. ${hint}`,
					"info",
				);
			}
		} catch {}

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
		try { checkForUpdateInBackground(ctx.ui as unknown as ExtensionUIContext); } catch {}
	});
	pi.on?.("model_select", async (event, ctx: ExtensionContext) => {
		await ensureDaemon();
		const freshRelayState = resolveRelayState();
		setStatusUi(ctx.ui);
		try { bindWidgetClick(ctx.ui); } catch {}
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
			const closing = server;
			server = null;
			closing.close();
			// Node 18.2+: closeIdleConnections exists at runtime even if lib types lag
			const closable = closing as unknown as { closeIdleConnections?: () => void };
			closable.closeIdleConnections?.();
			resetRateLimits();
			logInfo("shutdown complete");
		}
	});
}
