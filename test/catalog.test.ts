/**
 * Unit tests for catalog merging.
 *
 * The background catalog refresh must never remove verified static models from
 * provider registration, even when a cached upstream list is partial, and fresh
 * entries must override stale ones by id.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DEAD_MODEL_IDS,
	enrichModelDef,
	getActiveModelUpstream,
	getAliveCatalog,
	getLastCatalogRefreshStatus,
	isFreeCatalogId,
	mergeCatalog,
	parseKiloCatalogResponse,
	refreshCatalog,
	resolveActiveModelId,
	setAliveCatalog,
	syncAliveCatalogFromCache,
} from "../src/catalog.ts";
import {
	CATALOG_CACHE_FILE,
	CATALOG_CACHE_LOCK_FILE,
	CATALOG_CACHE_TTL_MS,
	KILO_CATALOG_URL,
} from "../src/config.ts";
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

afterEach(() => {
	setAliveCatalog(ALL_MODELS.map((entry) => ({ ...entry, source: getModelUpstream(entry.id) })));
	fs.rmSync(CATALOG_CACHE_FILE, { force: true });
	fs.rmSync(CATALOG_CACHE_LOCK_FILE, { force: true });
	const dir = path.dirname(CATALOG_CACHE_FILE);
	const prefix = `${path.basename(CATALOG_CACHE_FILE)}.`;
	if (fs.existsSync(dir)) {
		for (const entry of fs.readdirSync(dir)) {
			if (entry.startsWith(prefix) && entry.endsWith(".tmp")) fs.rmSync(path.join(dir, entry), { force: true });
		}
	}
});

function kiloRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		name: `Upstream ${id}`,
		isFree: true,
		pricing: { prompt: "0", completion: "0" },
		architecture: {
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
		},
		context_length: 1_048_576,
		top_provider: { context_length: 1_048_576, max_completion_tokens: 131_072 },
		supported_parameters: ["tools", "reasoning", "reasoning_effort"],
		opencode: {
			reasoning_options: [{ type: "effort", values: ["none", "low", "high", "max"] }],
		},
		...overrides,
	};
}

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

test("refreshCatalog sends and updates independent ETags while a 304 advances both timestamps", async () => {
	const realFetch = globalThis.fetch;
	const stale = Date.now() - CATALOG_CACHE_TTL_MS - 5000;
	const zen = model("etag-zen-free", 1000, "opencode");
	const kilo = model("etag-kilo:free", 1000, "kilo");
	fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({
		version: 2,
		sources: {
			opencode: { timestamp: stale, etag: "zen-old", ids: [zen.id], models: [zen] },
			kilo: { timestamp: stale, etag: "kilo-old", ids: [kilo.id], models: [kilo] },
		},
	}));
	const requested = new Map<string, string | null>();
	try {
		globalThis.fetch = async (url, init) => {
			const source = String(url) === KILO_CATALOG_URL ? "kilo" : "opencode";
			requested.set(source, new Headers(init?.headers).get("if-none-match"));
			return new Response(null, { status: 304, headers: { etag: `${source}-new` } });
		};
		const result = await refreshCatalog(true);
		assert.ok(result.some((entry) => entry.id === zen.id));
		assert.ok(result.some((entry) => entry.id === kilo.id));
		assert.deepEqual(Object.fromEntries(requested), { opencode: "zen-old", kilo: "kilo-old" });
		const persisted = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, "utf8"));
		assert.ok(persisted.sources.opencode.timestamp > stale);
		assert.ok(persisted.sources.kilo.timestamp > stale);
		assert.equal(persisted.sources.opencode.etag, "opencode-new");
		assert.equal(persisted.sources.kilo.etag, "kilo-new");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("refreshCatalog passes an abortable timeout signal and falls back instead of hanging", async () => {
	const realFetch = globalThis.fetch;
	try {
		const captured: RequestInit[] = [];
		const { promise: fetchesCalled, resolve: markCalled } = Promise.withResolvers<void>();
		globalThis.fetch = async (_url, init) => {
			captured.push(init ?? {});
			if (captured.length === 2) markCalled();
			// Simulate a hung upstream: never settles on its own; the abort
			// signal is the only way out (the CATALOG_REFRESH_TIMEOUT_MS timer).
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			return promise;
		};
		const resultP = refreshCatalog(true);
		await fetchesCalled;
		assert.equal(captured.length, 2, "Zen and Kilo must refresh concurrently");
		for (const init of captured) {
			assert.ok(init.signal, "each upstream fetch must receive an abortable signal");
			init.signal?.dispatchEvent(new Event("abort"));
		}
		const result = await resultP;
		assert.ok(Array.isArray(result), "a hung upstream must fall back to cache/static, not hang");
	} finally {
		globalThis.fetch = realFetch;
	}
});

/**
 * Static ids an older catalog cache cannot know about: the surviving Cline
 * entry was added after earlier releases wrote their cache, so a legacy list
 * can hold as many entries as the static set while still missing this id.
 */
const STATIC_IDS_ABSENT_FROM_LEGACY_CACHE = [
	"cline/nemotron-3.5-super-vl",
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
 * Cache fixture imitating a catalog written before the surviving Cline entry
 * existed: every static id except the one above, padded with rotated-in
 * upstream frees so the total still matches the static size (the old "cache is
 * big enough" heuristic accepted it).
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
test("refreshCatalog overlays the cache on a 304 so dynamic ids survive (issue: 304 drops them)", async () => {
	// A 304 revalidates upstream before any 200 merge, so the cached list is the
	// only record of a dynamically discovered id this process never merged: the
	// 304 branch must overlay it exactly like the stale-cache branches, or the
	// id vanishes from this process's catalog.
	const dynamic = model("zen-304-dynamic-free", 4242, "opencode");
	writeCacheFile(
		[...ALL_MODELS.map((m) => ({ ...m, source: getModelUpstream(m.id) })), dynamic],
		CATALOG_CACHE_TTL_MS + 60_000,
	);
	const requested: string[] = [];
	const result = await withFetch(
		async (url) => {
			requested.push(String(url));
			return new Response(null, { status: 304, headers: { etag: '"legacy-cache"' } });
		},
		() => refreshCatalog(false),
	);
	assert.equal(requested.length, 2, "the conditional refresh must revalidate Zen and Kilo");
	const kept = result.find((m) => m.id === dynamic.id);
	assert.ok(kept, "a 304 must keep the cached dynamic free id");
	assert.equal(kept.maxTokens, 4242, "the cached row, not a rebuilt one, must survive");
	assertIdsPresent(result, STATIC_IDS_ABSENT_FROM_LEGACY_CACHE, "a 304 must keep the static base");
});

test("step-5-preview entries stay dead across both lanes (2026-10-16)", () => {
	assert.equal(DEAD_MODEL_IDS.has("step-5-preview-free"), true);
	assert.equal(DEAD_MODEL_IDS.has("stepfun/step-5-preview-free"), true);
	assert.equal(isFreeCatalogId("step-5-preview-free"), false);
	assert.equal(isFreeCatalogId("stepfun/step-5-preview-free"), false);
	assert.equal(ALL_MODELS.some((m) => m.id === "step-5-preview-free"), false);
	assert.equal(ALL_MODELS.some((m) => m.id === "stepfun/step-5-preview-free"), false);
});

test("both free MiniMax M3.1 Flash endpoints are dead (2026-10-23)", () => {
	for (const id of ["minimax-m3.1-flash-free", "minimax/minimax-m3.1-flash:free"]) {
		assert.equal(DEAD_MODEL_IDS.has(id), true, id + " must be dead-listed");
		assert.equal(isFreeCatalogId(id), false, id + " must never enter the picker");
		assert.equal(ALL_MODELS.some((m) => m.id === id), false, id + " must not be in the static catalog");
	}
	assert.equal(isFreeCatalogId("minimax-m3.1-flash"), false);
});

test("union-alpha is a dead model id (pruned, never re-enters)", () => {
	assert.equal(DEAD_MODEL_IDS.has("union-alpha"), true);
	assert.equal(isFreeCatalogId("union-alpha"), false);
	assert.equal(ALL_MODELS.some((m) => m.id === "union-alpha"), false);
});

test("jev-1.13-free cannot return through the Zen runtime refresh", () => {
	// Static exclusion: never registered.
	assert.equal(DEAD_MODEL_IDS.has("jev-1.13-free"), true);
	assert.equal(ALL_MODELS.some((m) => m.id === "jev-1.13-free"), false);
	// Dynamic exclusion stage 1 (mirrors refreshCatalog): a live upstream-style
	// Zen object for this id is filtered before enrichment.
	const rawUpstream = [{ id: "jev-1.13-free", context_length: 262144, max_tokens: 32768 }];
	const freeRawList = rawUpstream.filter((r) => r && typeof r.id === "string" && isFreeCatalogId(r.id));
	assert.equal(freeRawList.length, 0, "jev-1.13-free must not pass the free-id filter");
	// Dynamic exclusion stage 2: even an enriched entry cannot survive the merge.
	const enriched = enrichModelDef({ id: "jev-1.13-free" }, "opencode");
	const base: RegisteredModel[] = ALL_MODELS.map((m) => ({ ...m, source: getModelUpstream(m.id) }));
	const merged = mergeCatalog(base, [{ ...enriched, source: "opencode" as const }]);
	assert.equal(merged.some((m) => m.id === "jev-1.13-free"), false, "jev-1.13-free must not survive mergeCatalog");
	assert.equal(merged.length, base.length, "dropping jev must not shrink the static catalog");
});

test("deepseek-v4-flash-free stays excluded while served models are untouched", () => {
	assert.equal(DEAD_MODEL_IDS.has("deepseek-v4-flash-free"), true);
	assert.equal(isFreeCatalogId("deepseek-v4-flash-free"), false);
	assert.equal(ALL_MODELS.some((m) => m.id === "deepseek-v4-flash-free"), false);
	const base: RegisteredModel[] = ALL_MODELS.map((m) => ({ ...m, source: getModelUpstream(m.id) }));
	const merged = mergeCatalog(base, [model("deepseek-v4-flash-free", 100, "opencode")]);
	assert.equal(merged.some((m) => m.id === "deepseek-v4-flash-free"), false);
	assert.equal(merged.length, base.length);
});

test("nemotron-3.5-super-vl-free repairs a reasoning-less dynamic entry (issue #62)", () => {
	// Before the static entry existed, the runtime merge registered this id
	// through enrichModelDef, which guesses reasoning:false and no effort map —
	// the picker then offered no thinking levels. A stale disk cache can still
	// carry that row, so a merge must repair it against the static definition.
	const stale: RegisteredModel = {
		id: "nemotron-3.5-super-vl-free",
		name: "Nemotron 3.5 Super Vl",
		reasoning: false,
		contextWindow: 262_144,
		maxTokens: 65_536,
		input: ["text", "image"],
		source: "opencode",
	};
	const merged = mergeCatalog([], [stale]);
	const repaired = merged.find((m) => m.id === "nemotron-3.5-super-vl-free");
	assert.ok(repaired, "the stale row must survive as the repaired static entry");
	assert.equal(repaired.reasoning, true);
	assert.equal(repaired.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(repaired.maxTokens, 235_929);
});

test("enrichModelDef honors explicit contextWindow and max_tokens over id heuristics and ignores non-positive numbers", () => {
	const explicit = enrichModelDef(
		{
			id: "custom-ultra-lightning-1m-free",
			contextWindow: 128_000,
			max_tokens: 16_384,
		},
		"opencode",
	);
	assert.equal(explicit.contextWindow, 128_000, "explicit contextWindow must not be overwritten by 1m/ultra heuristic");
	assert.equal(explicit.maxTokens, 16_384, "raw.max_tokens must be honored and not overwritten by ultra/lightning heuristic");

	const fallbackHeuristic = enrichModelDef(
		{
			id: "custom-ultra-1m-free",
			contextWindow: 0,
			maxTokens: -5,
		},
		"opencode",
	);
	assert.equal(fallbackHeuristic.contextWindow, 1_048_576, "non-positive contextWindow falls back to id heuristic");
	assert.equal(fallbackHeuristic.maxTokens, 131_072, "non-positive maxTokens falls back to id heuristic");
});

test("parseKiloCatalogResponse admits an unknown free row and rejects paid, priced, tool-less, dead, and malformed rows", () => {
	const rows = parseKiloCatalogResponse({
		data: [
			kiloRow("lab/dynamic-unknown:free"),
			kiloRow("lab/dynamic-unknown", { isFree: false }),
			kiloRow("particle/particle-1", { pricing: { prompt: "0", completion: "0.5" } }),
			kiloRow("lab/no-tools:free", { supported_parameters: ["reasoning"] }),
			kiloRow("mimo-v2.5-free"),
			kiloRow("lab/no-output:free", { architecture: { input_modalities: ["text"], output_modalities: [] } }),
			kiloRow("lab/no-limit:free", { top_provider: { max_completion_tokens: 0 } }),
		],
	});
	assert.deepEqual(rows.map((row) => row.id), ["lab/dynamic-unknown:free"]);
	assert.equal(rows[0].name, "Upstream lab/dynamic-unknown:free");
	assert.deepEqual(rows[0].input, ["text", "image"]);
	assert.equal(rows[0].thinkingFormat, "openrouter");
	assert.deepEqual(rows[0].thinkingLevelMap, { off: null, low: "low", high: "high", max: "max" });
});

test("two-source refresh keeps static metadata authoritative and rejects unknown cross-source collisions", async () => {
	fs.rmSync(CATALOG_CACHE_FILE, { force: true });
	const staticKilo = ALL_MODELS.find((entry) => entry.id === "liquid/lfm-3-1.7b:free");
	assert.ok(staticKilo);
	const result = await withFetch(async (url) => {
		if (String(url) === KILO_CATALOG_URL) {
			return new Response(JSON.stringify({ data: [
				kiloRow("particle-ai/particle-1:free"),
				kiloRow("collision/free"),
				kiloRow(staticKilo.id, { name: "Wrong live name", context_length: 1, top_provider: { max_completion_tokens: 1 } }),
			] }), { status: 200 });
		}
		return new Response(JSON.stringify({ data: [
			{ id: "zen-new-free", name: "Zen New" },
			{ id: "collision/free", name: "Collision" },
		] }), { status: 200 });
	}, () => refreshCatalog(true));
	assert.ok(result.some((entry) => entry.id === "particle-ai/particle-1:free" && entry.source === "kilo"));
	assert.ok(result.some((entry) => entry.id === "zen-new-free" && entry.source === "opencode"));
	assert.equal(result.some((entry) => entry.id === "collision/free"), false);
	assert.deepEqual(
		result.find((entry) => entry.id === staticKilo.id),
		{ ...staticKilo, source: "kilo" },
		"reviewed static metadata must beat the live row",
	);
	assert.equal(getActiveModelUpstream("particle-ai/particle-1:free"), "kilo");
});

test("a Kilo 200 replaces only Kilo dynamics while a Zen failure retains Zen cache", async () => {
	const stale = Date.now() - CATALOG_CACHE_TTL_MS - 1;
	const zenCached = model("zen-cached-free", 111, "opencode");
	const kiloCached = model("kilo-cached:free", 222, "kilo");
	const withdrawn = model("kilo-withdrawn:free", 333, "kilo");
	fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({
		version: 2,
		sources: {
			opencode: { timestamp: stale, etag: "zen-old", ids: [zenCached.id], models: [zenCached] },
			kilo: { timestamp: stale, etag: "kilo-old", ids: [kiloCached.id, withdrawn.id], models: [kiloCached, withdrawn] },
		},
	}));
	const result = await withFetch(async (url) => {
		if (String(url) === KILO_CATALOG_URL) {
			return new Response(JSON.stringify({ data: [kiloRow("particle-ai/particle-1:free")] }), { status: 200 });
		}
		return new Response("down", { status: 503 });
	}, () => refreshCatalog(false));
	assert.ok(result.some((entry) => entry.id === zenCached.id), "unrelated Zen failure keeps its cached row");
	assert.ok(result.some((entry) => entry.id === "particle-ai/particle-1:free"));
	assert.equal(result.some((entry) => entry.id === kiloCached.id), false, "successful Kilo listing replaces its old dynamics");
	assert.equal(result.some((entry) => entry.id === withdrawn.id), false, "withdrawn Kilo dynamics disappear");
	assert.equal(getLastCatalogRefreshStatus().opencode.outcome, "failed");
	assert.equal(getLastCatalogRefreshStatus().kilo.outcome, "updated");
});

test("Kilo admission rejects a row whose exact ID is a reviewed static alias", () => {
	const parsed = parseKiloCatalogResponse({ data: [
		kiloRow("nemotron-3-ultra-550b"),
		kiloRow("vendor/suffixless-model"),
	] });
	assert.deepEqual(parsed.map((entry) => entry.id), ["vendor/suffixless-model"]);
});

test("overlapping refreshCatalog calls serialize within one process", async () => {
	const realFetch = globalThis.fetch;
	const firstGate = Promise.withResolvers<void>();
	let calls = 0;
	globalThis.fetch = async (url) => {
		const call = calls++;
		if (call < 2) await firstGate.promise;
		return String(url) === KILO_CATALOG_URL
			? new Response(JSON.stringify({ data: [kiloRow(`vendor/serialized-${Math.floor(call / 2)}`)] }), { status: 200 })
			: new Response(JSON.stringify({ data: [{ id: `serialized-${Math.floor(call / 2)}-free` }] }), { status: 200 });
	};
	try {
		const first = refreshCatalog(true);
		const second = refreshCatalog(true);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls, 2, "the second refresh must wait while the first source pair is in flight");
		firstGate.resolve();
		await first;
		await second;
		assert.equal(calls, 4);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a cross-process source update written during refresh survives the locked commit", async () => {
	const realFetch = globalThis.fetch;
	const zenGate = Promise.withResolvers<void>();
	let calls = 0;
	globalThis.fetch = async (url) => {
		calls++;
		if (String(url) === KILO_CATALOG_URL) return new Response("down", { status: 503 });
		await zenGate.promise;
		return new Response(JSON.stringify({ data: [{ id: "host-zen-free" }] }), { status: 200 });
	};
	try {
		const pending = refreshCatalog(true);
		while (calls < 2) await new Promise<void>((resolve) => setImmediate(resolve));
		const daemonKilo = model("vendor/daemon-suffixless", 4096, "kilo");
		fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({
			version: 2,
			sources: {
				opencode: { timestamp: 0, ids: [], models: [] },
				kilo: { timestamp: Date.now(), etag: "daemon-kilo", ids: [daemonKilo.id], models: [daemonKilo] },
			},
		}));
		zenGate.resolve();
		const result = await pending;
		assert.ok(result.some((entry) => entry.id === "host-zen-free"));
		assert.ok(result.some((entry) => entry.id === daemonKilo.id && entry.source === "kilo"));
		assert.equal(getLastCatalogRefreshStatus().kilo.usedCache, true, "status reflects the concurrently persisted Kilo snapshot");
		const persisted = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, "utf8"));
		assert.ok(persisted.sources.kilo.models.some((entry: RegisteredModel) => entry.id === daemonKilo.id));
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("two failed fetches still adopt a newer catalog committed while they were in flight", async () => {
	const realFetch = globalThis.fetch;
	const fetchGate = Promise.withResolvers<void>();
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		await fetchGate.promise;
		return new Response("down", { status: 503 });
	};
	try {
		const pending = refreshCatalog(true);
		while (calls < 2) await new Promise<void>((resolve) => setImmediate(resolve));
		const daemonZen = model("daemon-zen-free", 4096, "opencode");
		const daemonKilo = model("vendor/daemon-only", 4096, "kilo");
		const committedAt = Date.now() + 1000;
		fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({
			version: 2,
			sources: {
				opencode: { timestamp: committedAt, etag: "daemon-zen", ids: [daemonZen.id], models: [daemonZen] },
				kilo: { timestamp: committedAt, etag: "daemon-kilo", ids: [daemonKilo.id], models: [daemonKilo] },
			},
		}));
		fetchGate.resolve();
		const result = await pending;
		assert.ok(result.some((entry) => entry.id === daemonZen.id));
		assert.ok(result.some((entry) => entry.id === daemonKilo.id && entry.source === "kilo"));
		const status = getLastCatalogRefreshStatus();
		assert.equal(status.opencode.outcome, "failed", "durable reconciliation is not a local fetch success");
		assert.equal(status.kilo.outcome, "failed", "durable reconciliation is not a local fetch success");
		assert.equal(status.opencode.usedCache, true);
		assert.equal(status.kilo.usedCache, true);
		assert.match(status.opencode.detail ?? "", /HTTP 503/);
		assert.match(status.kilo.detail ?? "", /HTTP 503/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a lock holder never removes a successor token after stale takeover", async () => {
	const originalRename = fs.renameSync;
	const staleAt = new Date(Date.now() - 60_000);
	const successor = "successor-owner-token";
	let acquiredOwner = "";
	fs.writeFileSync(CATALOG_CACHE_LOCK_FILE, "stale-owner-token");
	fs.utimesSync(CATALOG_CACHE_LOCK_FILE, staleAt, staleAt);
	fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
		const result = originalRename(from, to);
		if (String(to) === CATALOG_CACHE_FILE) {
			acquiredOwner = fs.readFileSync(CATALOG_CACHE_LOCK_FILE, "utf8");
			fs.writeFileSync(CATALOG_CACHE_LOCK_FILE, successor);
		}
		return result;
	}) as typeof fs.renameSync;
	try {
		await withFetch(async (url) => String(url) === KILO_CATALOG_URL
			? new Response(JSON.stringify({ data: [kiloRow("vendor/lock-owner")] }), { status: 200 })
			: new Response(JSON.stringify({ data: [{ id: "lock-owner-free" }] }), { status: 200 }),
		() => refreshCatalog(true));
		assert.notEqual(acquiredOwner, "");
		assert.notEqual(acquiredOwner, "stale-owner-token");
		assert.match(acquiredOwner, new RegExp(`^${process.pid}:[0-9a-f-]+$`));
		assert.equal(fs.readFileSync(CATALOG_CACHE_LOCK_FILE, "utf8"), successor);
	} finally {
		fs.renameSync = originalRename;
	}
});

test("an artificially old lock owned by the current live PID is never taken over", async () => {
	const owner = `${process.pid}:live-owner-test`;
	const staleAt = new Date(Date.now() - 60_000);
	fs.writeFileSync(CATALOG_CACHE_LOCK_FILE, owner);
	fs.utimesSync(CATALOG_CACHE_LOCK_FILE, staleAt, staleAt);
	const startedAt = Date.now();
	const result = await withFetch(async (url) => String(url) === KILO_CATALOG_URL
		? new Response(JSON.stringify({ data: [kiloRow("vendor/live-lock")] }), { status: 200 })
		: new Response(JSON.stringify({ data: [{ id: "live-lock-free" }] }), { status: 200 }),
	() => refreshCatalog(true));
	const elapsedMs = Date.now() - startedAt;
	assert.equal(fs.readFileSync(CATALOG_CACHE_LOCK_FILE, "utf8"), owner);
	assert.equal(result.some((entry) => entry.id === "vendor/live-lock"), false);
	assert.equal(getLastCatalogRefreshStatus().kilo.outcome, "failed");
	assert.match(getLastCatalogRefreshStatus().kilo.detail ?? "", /persistence failed/);
	assert.ok(elapsedMs < 2500, `lock acquisition must stay bounded, took ${elapsedMs}ms`);
});

test("per-source validators and freshness revalidate only the stale source", async () => {
	const zen = model("fresh-zen-free", 1000, "opencode");
	const kilo = model("stale-kilo:free", 1000, "kilo");
	const oldKiloTimestamp = Date.now() - CATALOG_CACHE_TTL_MS - 5000;
	fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({
		version: 2,
		sources: {
			opencode: { timestamp: Date.now(), etag: "zen-etag", ids: [zen.id], models: [zen] },
			kilo: { timestamp: oldKiloTimestamp, etag: "kilo-etag", ids: [kilo.id], models: [kilo] },
		},
	}));
	const requests: Array<{ url: string; etag: string | null }> = [];
	await withFetch(async (url, init) => {
		requests.push({ url: String(url), etag: new Headers(init?.headers).get("if-none-match") });
		return new Response(null, { status: 304 });
	}, () => refreshCatalog(false));
	assert.deepEqual(requests, [{ url: KILO_CATALOG_URL, etag: "kilo-etag" }]);
	const persisted = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, "utf8"));
	assert.ok(persisted.sources.kilo.timestamp > oldKiloTimestamp, "a real 304 advances only that source timestamp");
	assert.equal(persisted.sources.kilo.etag, "kilo-etag");
	assert.equal(getLastCatalogRefreshStatus().opencode.outcome, "fresh-cache");
	assert.equal(getLastCatalogRefreshStatus().kilo.outcome, "not-modified");
});

test("a successful 200 without ETag clears each source's old validator", async () => {
	const stale = Date.now() - CATALOG_CACHE_TTL_MS - 5000;
	fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({
		version: 2,
		sources: {
			opencode: { timestamp: stale, etag: "old-zen", ids: ["old-zen-free"], models: [model("old-zen-free", 1, "opencode")] },
			kilo: { timestamp: stale, etag: "old-kilo", ids: ["old-kilo:free"], models: [model("old-kilo:free", 1, "kilo")] },
		},
	}));
	await withFetch(async (url) => String(url) === KILO_CATALOG_URL
		? new Response(JSON.stringify({ data: [kiloRow("vendor/no-validator")] }), { status: 200 })
		: new Response(JSON.stringify({ data: [{ id: "zen-no-validator-free" }] }), { status: 200 }),
	() => refreshCatalog(true));
	const persisted = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, "utf8"));
	assert.equal(persisted.sources.opencode.etag, undefined);
	assert.equal(persisted.sources.kilo.etag, undefined);
});

test("refresh failures report usedCache false when no source snapshot exists", async () => {
	await withFetch(async () => new Response("down", { status: 503 }), () => refreshCatalog(true));
	const status = getLastCatalogRefreshStatus();
	assert.equal(status.opencode.outcome, "failed");
	assert.equal(status.opencode.usedCache, false);
	assert.equal(status.kilo.outcome, "failed");
	assert.equal(status.kilo.usedCache, false);
});

test("cache persistence failure rejects newly discovered dynamics and marks refresh failed", async () => {
	const originalRename = fs.renameSync;
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => String(url) === KILO_CATALOG_URL
		? new Response(JSON.stringify({ data: [kiloRow("vendor/not-durable")] }), { status: 200 })
		: new Response(JSON.stringify({ data: [{ id: "not-durable-free" }] }), { status: 200 });
	fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
		if (String(to) === CATALOG_CACHE_FILE) throw new Error("EACCES: persistence denied");
		return originalRename(from, to);
	}) as typeof fs.renameSync;
	try {
		const result = await refreshCatalog(true);
		assert.equal(result.some((entry) => entry.id === "vendor/not-durable"), false);
		assert.equal(result.some((entry) => entry.id === "not-durable-free"), false);
		assert.equal(getLastCatalogRefreshStatus().opencode.outcome, "failed");
		assert.equal(getLastCatalogRefreshStatus().kilo.outcome, "failed");
		assert.match(getLastCatalogRefreshStatus().kilo.detail ?? "", /persistence failed/);
	} finally {
		fs.renameSync = originalRename;
		globalThis.fetch = realFetch;
	}
});

test("an expired lock lease past max TTL is reclaimed even while its PID stays live", async () => {
	const owner = `${process.pid}:expired-lease-test`;
	const expiredAt = new Date(Date.now() - 130_000);
	fs.writeFileSync(CATALOG_CACHE_LOCK_FILE, owner);
	fs.utimesSync(CATALOG_CACHE_LOCK_FILE, expiredAt, expiredAt);
	const result = await withFetch(async (url) => String(url) === KILO_CATALOG_URL
		? new Response(JSON.stringify({ data: [kiloRow("vendor/expired-lease")] }), { status: 200 })
		: new Response(JSON.stringify({ data: [{ id: "expired-lease-free" }] }), { status: 200 }),
	() => refreshCatalog(true));
	assert.equal(result.some((entry) => entry.id === "vendor/expired-lease"), true);
	assert.equal(getLastCatalogRefreshStatus().kilo.outcome, "updated");
	assert.equal(fs.existsSync(CATALOG_CACHE_LOCK_FILE), false);
});

test("pid reuse with mismatched Linux process start time reclaims a stale lock", { skip: process.platform !== "linux" }, async () => {
	const owner = `${process.pid}:0-00000000-0000-4000-8000-000000000000`;
	const staleAt = new Date(Date.now() - 60_000);
	fs.writeFileSync(CATALOG_CACHE_LOCK_FILE, owner);
	fs.utimesSync(CATALOG_CACHE_LOCK_FILE, staleAt, staleAt);
	const result = await withFetch(async (url) => String(url) === KILO_CATALOG_URL
		? new Response(JSON.stringify({ data: [kiloRow("vendor/pid-reused")] }), { status: 200 })
		: new Response(JSON.stringify({ data: [{ id: "pid-reused-free" }] }), { status: 200 }),
	() => refreshCatalog(true));
	assert.equal(result.some((entry) => entry.id === "vendor/pid-reused"), true);
	assert.equal(getLastCatalogRefreshStatus().kilo.outcome, "updated");
});

test("syncAliveCatalogFromCache resets mtime tracking when cache disappears before rewrite", () => {
	const fixedTime = new Date(Date.now() - 10_000);
	const first = model("vendor/first-sync", 1000, "kilo");
	const second = model("vendor/second-sync", 1000, "kilo");
	const payload = (entry: RegisteredModel) => JSON.stringify({
		version: 2,
		sources: {
			opencode: { timestamp: Date.now(), ids: [], models: [] },
			kilo: { timestamp: Date.now(), ids: [entry.id], models: [entry] },
		},
	});
	fs.writeFileSync(CATALOG_CACHE_FILE, payload(first));
	fs.utimesSync(CATALOG_CACHE_FILE, fixedTime, fixedTime);
	assert.equal(syncAliveCatalogFromCache(), true);
	assert.equal(getAliveCatalog().some((entry) => entry.id === first.id), true);

	fs.rmSync(CATALOG_CACHE_FILE, { force: true });
	assert.equal(syncAliveCatalogFromCache(), false);

	fs.writeFileSync(CATALOG_CACHE_FILE, payload(second));
	fs.utimesSync(CATALOG_CACHE_FILE, fixedTime, fixedTime);
	assert.equal(syncAliveCatalogFromCache(), true);
	assert.equal(getAliveCatalog().some((entry) => entry.id === second.id), true);
});

test("resolveActiveModelId ignores aliases whose canonical model is inactive", () => {
	const previous = getAliveCatalog();
	try {
		setAliveCatalog([]);
		assert.equal(resolveActiveModelId("beam"), null);
	} finally {
		setAliveCatalog(previous);
	}
	assert.equal(resolveActiveModelId("beam"), "beam-free");
});
