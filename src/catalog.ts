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
	CATALOG_REFRESH_TIMEOUT_MS,
	KILO_CHAT_URL,
	OPENCODE_API_URL,
	opencodeHeaders,
} from "./config.ts";
import { log, logDebug, logWarn } from "./logger.ts";
import {
	ALL_MODELS,
	KILO_MODEL_IDS,
	MODEL_MAP,
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
export const DEAD_MODEL_IDS = new Set<string>(["deepseek-v4-flash-free", "x-preview-f-free"]);
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
 * Preserves etag for conditional If-None-Match requests.
 */
export function readCatalogCache(): CatalogCacheData | null {
	try {
		if (!fs.existsSync(CATALOG_CACHE_FILE)) {
			return null;
		}
		const raw = fs.readFileSync(CATALOG_CACHE_FILE, "utf8");
		const data = JSON.parse(raw) as CatalogCacheData;
		if (!Array.isArray(data.models)) {
			return null;
		}
		data.models = data.models.filter((m) => !DEAD_MODEL_IDS.has(m.id));
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
 * Persists etag alongside models for subsequent If-None-Match conditional requests.
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
 * Uses ETag conditional requests (If-None-Match) to avoid re-merging unchanged
 * catalogs; a 304 Not Modified response skips merge and returns the in-memory
 * catalog unchanged. Falls back gracefully to cached or static models if network
 * requests fail.
 */
export async function refreshCatalog(force = false): Promise<RegisteredModel[]> {
	// Thin provider: serve fresh disk cache instantly when valid
	const disk = readCatalogCache();
	if (disk && Array.isArray(disk.models) && disk.models.length > 0) {
		const age = Date.now() - (disk.timestamp ?? 0);
		if (!force && age < CATALOG_CACHE_TTL_MS) {
			aliveCatalog = disk.models.filter((m) => !DEAD_MODEL_IDS.has(m.id));
			return aliveCatalog;
		}
	}

	// Resolve etag from fresh or stale cache for conditional request
	let cachedEtag: string | undefined = disk?.etag;
	let staleForEtag: CatalogCacheData | null = disk;
	if (!cachedEtag) {
		try {
			if (fs.existsSync(CATALOG_CACHE_FILE)) {
				const raw = fs.readFileSync(CATALOG_CACHE_FILE, "utf8");
				const stale = JSON.parse(raw) as CatalogCacheData;
				cachedEtag = stale.etag;
				staleForEtag = stale;
			}
		} catch (err) {
			logDebug("Failed reading stale catalog cache for etag", { error: String(err) });
		}
	}

	// Attempt conditional fetch with If-None-Match when we have an etag
	if (cachedEtag || force) {
		try {
			const headers: Record<string, string> = { ...opencodeHeaders() };
			if (cachedEtag) {
				headers["If-None-Match"] = cachedEtag;
			}
			const res = await fetch(`${OPENCODE_API_URL}/models`, {
				headers,
				// A hung upstream must not freeze /freeflow refresh: abort after
				// CATALOG_REFRESH_TIMEOUT_MS and fall back to cache below.
				signal: AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS),
			});
			if (res.status === 304) {
				// Not modified — skip merge, extend timestamp to avoid tight loop
				if (staleForEtag && Array.isArray(staleForEtag.models)) {
					try {
						writeCatalogCache({ ...staleForEtag, timestamp: Date.now() });
					} catch {}
				}
				return aliveCatalog;
			}
			if (res.ok) {
				const newEtag = res.headers.get("etag") ?? res.headers.get("ETag") ?? cachedEtag;
				const body: unknown = await res.json();
				let rawList: RawModelItem[] = [];
				if (Array.isArray(body)) {
					rawList = body as RawModelItem[];
				} else if (body !== null && typeof body === "object" && "data" in body) {
					const dataVal = body.data as unknown;
					if (Array.isArray(dataVal)) {
						rawList = dataVal as RawModelItem[];
					}
				}
				if (rawList.length > 0) {
					const fresh = rawList.map((r) => enrichModelDef(r, "opencode"));
					const merged = mergeCatalog(aliveCatalog, fresh);
					aliveCatalog = merged;
					writeCatalogCache({
						timestamp: Date.now(),
						opencode: fresh.map((m) => m.id),
						kilo: staleForEtag?.kilo ?? [],
						models: merged,
						etag: newEtag ?? cachedEtag,
					});
					return aliveCatalog;
				}
				// Empty payload but 200 — treat as no-op, return current
				if (newEtag && newEtag !== cachedEtag && staleForEtag) {
					writeCatalogCache({ ...staleForEtag, timestamp: Date.now(), etag: newEtag });
				}
				return aliveCatalog;
			}
		} catch (err) {
			if ((err as Error)?.name === "AbortError") {
				logWarn("Catalog refresh timed out — using cached/static fallback", {
					timeoutMs: CATALOG_REFRESH_TIMEOUT_MS,
				});
			} else {
				logDebug("Conditional catalog fetch failed, falling back to cache", { error: String(err) });
			}
		}
	}

	// Stale cache still better than empty — return it without network (filtered)
	if (disk && Array.isArray(disk.models) && disk.models.length > 0) {
		const filtered = disk.models.filter((m) => !DEAD_MODEL_IDS.has(m.id));
		if (filtered.length >= ALL_MODELS.length) {
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
				if (filtered.length >= ALL_MODELS.length) {
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
