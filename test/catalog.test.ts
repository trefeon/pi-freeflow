/**
 * Unit tests for catalog merging.
 *
 * The background catalog refresh must never remove verified static models from
 * provider registration, even when a cached upstream list is partial, and fresh
 * entries must override stale ones by id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEAD_MODEL_IDS, isFreeCatalogId, mergeCatalog, refreshCatalog } from "../src/catalog.ts";
import { CATALOG_CACHE_FILE, CATALOG_CACHE_TTL_MS } from "../src/config.ts";
import { ALL_MODELS, getModelUpstream } from "../src/models.ts";
import type { RegisteredModel } from "../src/types.ts";

function model(id: string, maxTokens: number, source: "opencode" | "kilo"): RegisteredModel {
	return {
		id,
		name: id,
		reasoning: false,
		contextWindow: 1000,
		maxTokens,
		input: ["text"],
		source,
	};
}

const BASE: RegisteredModel[] = [model("alpha-free", 100, "opencode"), model("beta-free", 200, "kilo")];

test("mergeCatalog overrides matching ids with fresh entries", () => {
	const merged = mergeCatalog(BASE, [model("alpha-free", 999, "opencode")]);
	assert.equal(merged.length, 2);
	const alpha = merged.find((m) => m.id === "alpha-free");
	assert.ok(alpha);
	assert.equal(alpha.maxTokens, 999);
});

test("mergeCatalog keeps base entries missing from the fresh list", () => {
	const merged = mergeCatalog(BASE, [model("alpha-free", 111, "opencode")]);
	assert.ok(merged.some((m) => m.id === "beta-free"));
	assert.equal(merged.find((m) => m.id === "beta-free")?.maxTokens, 200);
});

test("mergeCatalog appends unknown fresh ids after the base", () => {
	const merged = mergeCatalog(BASE, [model("gamma-new-free", 300, "kilo")]);
	assert.deepEqual(
		merged.map((m) => m.id),
		["alpha-free", "beta-free", "gamma-new-free"],
	);
});

test("mergeCatalog with an empty fresh list returns the base unchanged", () => {
	const merged = mergeCatalog(BASE, []);
	assert.deepEqual(merged, BASE);
});

test("refreshCatalog uses If-None-Match ETag and skips merge on 304", async () => {
	const realFetch = globalThis.fetch;
	try {
		// Simulate upstream 304 Not Modified
		globalThis.fetch = async () =>
			new Response(null, { status: 304, headers: { etag: '"abc123"' } });
		const result = await refreshCatalog(true);
		assert.ok(Array.isArray(result), "refreshCatalog must return array on 304");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("refreshCatalog passes an abortable timeout signal and falls back instead of hanging", async () => {
	const realFetch = globalThis.fetch;
	try {
		let captured: RequestInit | undefined;
		const { promise: fetchCalled, resolve: markCalled } = Promise.withResolvers<void>();
		globalThis.fetch = async (_url, init) => {
			captured = init;
			markCalled();
			// Simulate a hung upstream: never settles on its own; the abort
			// signal is the only way out (the CATALOG_REFRESH_TIMEOUT_MS timer).
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			return promise;
		};
		const resultP = refreshCatalog(true);
		await fetchCalled; // the fetch is executing now
		assert.ok(captured?.signal, "the upstream fetch must receive an abortable signal");
		captured?.signal?.dispatchEvent(new Event("abort"));
		const result = await resultP;
		assert.ok(Array.isArray(result), "a hung upstream must fall back to cache/static, not hang");
	} finally {
		globalThis.fetch = realFetch;
	}
});

/**
 * Static ids an older catalog cache cannot know about: the Cline entries were
 * added after earlier releases wrote their cache, so a legacy list can hold as
 * many entries as the static set while still missing these two ids.
 */
const STATIC_IDS_ABSENT_FROM_LEGACY_CACHE = [
	"cline-free/muse-spark-1.3-contributor",
	"z-ai/glm-5.3-flash",
];

/** Persist a catalog cache fixture; ageMs > TTL makes it stale (hidden from readCatalogCache). */
function writeCacheFile(models: RegisteredModel[], ageMs: number): void {
	assert.ok(
		CATALOG_CACHE_FILE.startsWith(os.tmpdir()),
		"catalog cache must live in the test sandbox (run with --import ./test/setup.mjs)",
	);
	fs.mkdirSync(path.dirname(CATALOG_CACHE_FILE), { recursive: true });
	fs.writeFileSync(
		CATALOG_CACHE_FILE,
		JSON.stringify({
			timestamp: Date.now() - ageMs,
			opencode: [],
			kilo: [],
			models,
			etag: '"legacy-cache"',
		}),
		"utf8",
	);
}

/** Run a refresh with a stubbed fetch, restoring the real one afterwards. */
async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
	const realFetch = globalThis.fetch;
	try {
		globalThis.fetch = impl;
		return await run();
	} finally {
		globalThis.fetch = realFetch;
	}
}

/**
 * Cache fixture imitating a catalog written before the Cline entries existed:
 * every static id except those two, padded with rotated-in upstream frees so
 * the total still matches the static size (the old "cache is big enough"
 * heuristic accepted it).
 */
function legacyCacheModels(): RegisteredModel[] {
	const models: RegisteredModel[] = ALL_MODELS.filter(
		(m) => !STATIC_IDS_ABSENT_FROM_LEGACY_CACHE.includes(m.id),
	).map((m) => ({ ...m, source: getModelUpstream(m.id) }));
	let i = 0;
	while (models.length < ALL_MODELS.length) {
		models.push(model(`zen-rotated-${i++}-free`, 100, "opencode"));
	}
	return models;
}

function assertIdsPresent(result: readonly RegisteredModel[], ids: readonly string[], why: string): void {
	for (const id of ids) {
		assert.ok(
			result.some((m) => m.id === id),
			`${id} must stay in the catalog: ${why}`,
		);
	}
}

test("refreshCatalog keeps static ids a stale >= static-size cache omits (network down)", async () => {
	writeCacheFile(legacyCacheModels(), CATALOG_CACHE_TTL_MS + 60_000);
	const result = await withFetch(
		async () => {
			throw new Error("network down");
		},
		() => refreshCatalog(false),
	);
	assertIdsPresent(
		result,
		STATIC_IDS_ABSENT_FROM_LEGACY_CACHE,
		"an oversized stale cache overlaid on the static base never drops static ids",
	);
});

test("refreshCatalog(true) keeps static ids a fresh oversized cache omits when upstream returns 500", async () => {
	writeCacheFile(legacyCacheModels(), 0);
	const result = await withFetch(
		async () => new Response("upstream down", { status: 500 }),
		() => refreshCatalog(true),
	);
	assertIdsPresent(
		result,
		STATIC_IDS_ABSENT_FROM_LEGACY_CACHE,
		"a forced refresh against a failing upstream overlays the cache on the static base",
	);
});

test("refreshCatalog overlays a partial cache without losing static ids or the cached entries", async () => {
	const partial = [
		model("zen-partial-one-free", 111, "opencode"),
		model("zen-partial-two-free", 222, "opencode"),
	];
	writeCacheFile(partial, CATALOG_CACHE_TTL_MS + 60_000);
	const result = await withFetch(
		async () => {
			throw new Error("network down");
		},
		() => refreshCatalog(false),
	);
	assertIdsPresent(
		result,
		ALL_MODELS.map((m) => m.id),
		"a partial cache must not shrink the catalog below the static set",
	);
	for (const entry of partial) {
		const kept = result.find((m) => m.id === entry.id);
		assert.ok(kept, `${entry.id} from the partial cache must be kept`);
		assert.equal(kept.maxTokens, entry.maxTokens);
	}
});
test("union-alpha is a dead model id (pruned, never re-enters)", () => {
	assert.equal(DEAD_MODEL_IDS.has("union-alpha"), true);
	assert.equal(isFreeCatalogId("union-alpha"), false);
	assert.equal(ALL_MODELS.some((m) => m.id === "union-alpha"), false);
});
