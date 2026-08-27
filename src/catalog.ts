/**
 * Dynamic catalog discovery, caching, and model enrichment for pi-freeflow
 *
 * Provides 1-hour atomic disk caching with safe offline fallback to verified static definitions.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	CATALOG_CACHE_FILE,
	CATALOG_CACHE_TTL_MS,
	KILO_CHAT_URL,
	OPENCODE_API_URL,
	opencodeHeaders,
} from "./config.ts";
import { log, logDebug, logWarn } from "./logger.ts";
import {
	ALL_MODELS,
	KILO_MODELS,
	KILO_MODEL_IDS,
	KNOWN_MODELS,
	MODEL_MAP,
	OPENCODE_MODELS,
	getAllRegisteredModels,
} from "./models.ts";
import type {
	CatalogCacheData,
	RawModelItem,
	RegisteredModel,
	Upstream,
} from "./types.ts";

/**
 * Pruned model IDs that must never re-enter the catalog via disk cache or upstream merge.
 */
const DEAD_MODEL_IDS = new Set<string>(["deepseek-v4-flash-free", "x-preview-f-free"]);

/**
 * In-memory cache of currently active/available free models.
 * Initialized with all 21 verified models for 0ms instant availability.
 */
let aliveCatalog: RegisteredModel[] = ALL_MODELS.map((m) => ({
	...m,
	source: KILO_MODEL_IDS.has(m.id) ? ("kilo" as const) : ("opencode" as const),
}));
/**
 * Get current in-memory alive catalog
 */
export function getAliveCatalog(): RegisteredModel[] {
	return aliveCatalog;
}

/**
 * Set in-memory alive catalog
 */
export function setAliveCatalog(catalog: RegisteredModel[]): void {
	aliveCatalog = catalog;
}

/**
 * Overlay a refreshed model list onto a base list without dropping base entries.
 * Fresh entries win on id collision; unknown fresh ids are appended after the base.
 * Guards the background refresh against a partial upstream cache removing
 * verified static models from provider registration.
 * Filters pruned dead IDs so they never re-enter via fresh upstream data.
 */
export function mergeCatalog(
	base: RegisteredModel[],
	fresh: RegisteredModel[],
): RegisteredModel[] {
	const filteredFresh = fresh.filter((m) => !DEAD_MODEL_IDS.has(m.id));
	const byId = new Map(base.map((m) => [m.id, m]));
	for (const m of filteredFresh) byId.set(m.id, m);
	// Ensure no dead IDs survive even if base was stale
	return [...byId.values()].filter((m) => !DEAD_MODEL_IDS.has(m.id));
}

/**
 * Format a clean, human-readable display name for any upstream model ID.
 */
export function formatCleanDisplayName(id: string, customName?: string): string {
	if (customName && customName.trim()) {
		return customName.trim();
	}
	const known = MODEL_MAP.get(id);
	if (known && known.name) {
		return known.name;
	}

	// Strip provider prefix ("nvidia/", "stepfun/", "dots-studio/", etc.)
	let clean = id.replace(/^[a-zA-Z0-9_.-]+\//, "");
	// Strip variant suffixes
	clean = clean.replace(/:(free|preview|exacto|default|batch)$/i, "");
	clean = clean.replace(/-(free|contributor|preview)$/i, "");

	// Capitalize words with acronym preservation
	const parts = clean.split(/[-_]/).map((w) => {
		const lower = w.toLowerCase();
		if (lower === "gpt") return "GPT";
		if (lower === "ai") return "AI";
		if (lower === "lfm") return "LFM";
		if (lower === "hy3") return "Hy3";
		if (lower === "mimo") return "MiMo";
		if (lower === "ocr") return "OCR";
		return w.charAt(0).toUpperCase() + w.slice(1);
	});

	return parts.join(" ");
}

/**
 * Enrich a raw upstream model item into a fully typed RegisteredModel.
 */
export function enrichModelDef(raw: RawModelItem, source: Upstream): RegisteredModel {
	const known = MODEL_MAP.get(raw.id);
	if (known) {
		return { ...known, source };
	}

	const idLower = raw.id.toLowerCase();
	const hasVision =
		idLower.includes("vision") ||
		idLower.includes("vl") ||
		idLower.includes("omni") ||
		idLower.includes("note") ||
		idLower.includes("image");
	const hasReasoning =
		idLower.includes("reasoning") ||
		idLower.includes("r1") ||
		idLower.includes("o1") ||
		idLower.includes("think") ||
		idLower.includes("spark");

	let contextWindow =
		typeof raw.context_length === "number" ? raw.context_length : 262_144;
	if (
		idLower.includes("1m") ||
		idLower.includes("ultra") ||
		idLower.includes("lightning") ||
		idLower.includes("mimo-v2.5") ||
		idLower.includes("muse-spark")
	) {
		contextWindow = 1_048_576;
	}

	let maxTokens =
		typeof raw.max_output_tokens === "number"
			? raw.max_output_tokens
			: 65_536;
	if (idLower.includes("ultra") || idLower.includes("lightning")) {
		maxTokens = 131_072;
	}

	const isResponses = raw.id === "muse-spark-1.2-contributor-free";

	return {
		id: raw.id,
		name: formatCleanDisplayName(raw.id),
		source,
		reasoning: hasReasoning,
		contextWindow,
		maxTokens,
		api: isResponses ? "openai-responses" : undefined,
		input: hasVision ? ["text", "image"] : ["text"],
		thinkingFormat: source === "kilo" && hasReasoning ? "openrouter" : undefined,
	};
}

/**
 * Read cached catalog data from disk if valid and unexpired.
 * Filters out pruned dead IDs so stale disk entries never repopulate the catalog.
 */
export function readCatalogCache(): CatalogCacheData | null {
	try {
		if (!fs.existsSync(CATALOG_CACHE_FILE)) {
			return null;
		}
		const raw = fs.readFileSync(CATALOG_CACHE_FILE, "utf8");
		const data = JSON.parse(raw) as CatalogCacheData;
		if (Array.isArray(data.models)) {
			data.models = data.models.filter((m) => !DEAD_MODEL_IDS.has(m.id));
		}
		if (Date.now() - data.timestamp < CATALOG_CACHE_TTL_MS) {
			return data;
		}
	} catch (err) {
		logDebug("Failed reading catalog cache", { error: String(err) });
	}
	return null;
}

/**
 * Atomically write catalog cache data to disk using temporary file + rename.
 */
export function writeCatalogCache(data: CatalogCacheData): void {
	try {
		const dir = path.dirname(CATALOG_CACHE_FILE);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const tmpPath = `${CATALOG_CACHE_FILE}.${randomUUID()}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
		fs.renameSync(tmpPath, CATALOG_CACHE_FILE);
	} catch (err) {
		logWarn("Could not persist catalog cache to disk", { error: String(err) });
	}
}

/**
 * Refresh free model catalog from OpenCode Zen and KiloCode Gateway endpoints.
 * Falls back gracefully to cached or static models if network requests fail.
 */
export async function refreshCatalog(force = false): Promise<RegisteredModel[]> {
	// Thin provider: no live fetch — subagents must not hit upstream directly
	// (proxy-only). Host Pi/OMP owns dynamic discovery via fetchDynamicModels (24h).
	// We only serve disk cache if fresh, otherwise static 21-model aliveCatalog.
	const disk = readCatalogCache();
	if (disk && Array.isArray(disk.models) && disk.models.length > 0) {
		const age = Date.now() - (disk.timestamp ?? 0);
		if (!force && age < CATALOG_CACHE_TTL_MS) {
			aliveCatalog = disk.models.filter((m) => !DEAD_MODEL_IDS.has(m.id));
			return aliveCatalog;
		}
		// Stale cache still better than empty — return it without network (filtered)
		const filtered = disk.models.filter((m) => !DEAD_MODEL_IDS.has(m.id));
		if (filtered.length >= 21) {
			aliveCatalog = filtered;
			return aliveCatalog;
		}
	}
	// No valid fresh cache — try stale disk cache directly (readCatalogCache returns null when expired)
	try {
		if (fs.existsSync(CATALOG_CACHE_FILE)) {
			const raw = fs.readFileSync(CATALOG_CACHE_FILE, "utf8");
			const stale = JSON.parse(raw) as CatalogCacheData;
			if (Array.isArray(stale.models) && stale.models.length > 0) {
				const filtered = stale.models.filter((m) => !DEAD_MODEL_IDS.has(m.id));
				if (filtered.length >= 21) {
					aliveCatalog = filtered;
					return aliveCatalog;
				}
			}
		}
	} catch (err) {
		logDebug("Failed reading stale catalog cache", { error: String(err) });
	}
	// No valid cache — return in-memory static 21 (host will refresh if needed)
	return aliveCatalog;
}
