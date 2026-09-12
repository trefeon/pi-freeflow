/**
 * Edge-case sweep for the catalog module.
 *
 * Each test targets a distinct boundary of enrichModelDef / mergeCatalog /
 * readCatalogCache / writeCatalogCache / refreshCatalog. Disk writes to the
 * real CATALOG_CACHE_FILE are backed up and restored so the suite stays
 * hermetic (tests run with --test-concurrency=1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
	enrichModelDef,
	isFreeCatalogId,
	mergeCatalog,
	readCatalogCache,
	refreshCatalog,
	setAliveCatalog,
	writeCatalogCache,
} from "../src/catalog.ts";
import { CATALOG_CACHE_FILE, CATALOG_CACHE_TTL_MS } from "../src/config.ts";
import { ALL_MODELS } from "../src/models.ts";
import type { RegisteredModel } from "../src/types.ts";

/** Baseline static models as RegisteredModel entries. */
function baselineModels(): RegisteredModel[] {
	return ALL_MODELS.map((m) => ({ ...m, source: "opencode" as const }));
}

/**
 * Run fn with a backup/restore around CATALOG_CACHE_FILE and globalThis.fetch,
 * restoring both afterwards regardless of outcome.
 */
async function withCacheFileIsolation(
	fn: () => Promise<void> | void,
): Promise<void> {
	const existed = fs.existsSync(CATALOG_CACHE_FILE);
	const backup = existed ? fs.readFileSync(CATALOG_CACHE_FILE, "utf8") : "";
	const realFetch = globalThis.fetch;
	try {
		await fn();
	} finally {
		globalThis.fetch = realFetch;
		if (existed) {
			fs.writeFileSync(CATALOG_CACHE_FILE, backup, "utf8");
		} else {
			fs.rmSync(CATALOG_CACHE_FILE, { force: true });
		}
	}
}

test("enrichModelDef with missing context_length falls back to sane defaults", () => {
	const def = enrichModelDef({ id: "unknown-lab/brand-new-7b" }, "opencode");
	assert.equal(def.id, "unknown-lab/brand-new-7b");
	assert.equal(def.source, "opencode");
	assert.equal(def.contextWindow, 262_144, "missing context_length must default to 262_144");
	assert.deepEqual(def.input, ["text"], "non-vision model defaults to text-only input");
});

test("enrichModelDef kilocode source keeps :free suffix id and tags thinkingFormat", () => {
	const known = enrichModelDef(
		{ id: "stepfun/step-3.7-flash:free" },
		"kilo",
	);
	assert.equal(known.id, "stepfun/step-3.7-flash:free");
	assert.equal(known.source, "kilo");
	assert.equal(known.thinkingFormat, "openrouter");
	// Unknown kilo model with :free suffix — display name must not leak the suffix
	const unknown = enrichModelDef({ id: "newlab/new-cool-model:free" }, "kilo");
	assert.equal(unknown.id, "newlab/new-cool-model:free");
	assert.equal(unknown.source, "kilo");
	assert.ok(!unknown.name.includes(":free"), `name leaked suffix: ${unknown.name}`);
});

// mergeCatalog with dead model ids in the fresh list is already covered by
// error-matrix.test.ts "Error Matrix [4/10] catalog gracefully strips dead model
// IDs on cache read and merge" — skipping duplicate here.

test("readCatalogCache with missing models field returns null", async () => {
	await withCacheFileIsolation(async () => {
		fs.writeFileSync(
			CATALOG_CACHE_FILE,
			JSON.stringify({ timestamp: Date.now(), opencode: [], kilo: [] }),
			"utf8",
		);
		const result = readCatalogCache();
		assert.equal(result, null, "cache without a models array must be treated as invalid");
	});
});

test("refreshCatalog network error falls back to stale disk cache", async () => {
	await withCacheFileIsolation(async () => {
		const stale = baselineModels();
		fs.writeFileSync(
			CATALOG_CACHE_FILE,
			JSON.stringify({
				timestamp: Date.now() - 2 * CATALOG_CACHE_TTL_MS,
				etag: '"stale-etag"',
				opencode: stale.map((m) => m.id),
				kilo: [],
				models: stale,
			}),
			"utf8",
		);
		setAliveCatalog([]);
		globalThis.fetch = async () => {
			throw new Error("network down");
		};
		const result = await refreshCatalog();
		assert.ok(result.length >= 21, "must serve ≥21 models from stale cache on network error");
		assert.equal(result[0].id, stale[0].id);
	});
});

test("refreshCatalog 200 with empty data is a no-op returning the alive catalog", async () => {
	await withCacheFileIsolation(async () => {
		fs.rmSync(CATALOG_CACHE_FILE, { force: true });
		const baseline = baselineModels();
		setAliveCatalog(baseline);
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		const result = await refreshCatalog(true);
		assert.equal(result.length, baseline.length);
		assert.deepEqual(
			result.map((m) => m.id),
			baseline.map((m) => m.id),
		);
	});
});

test("stale cache without etag serves spark-1.3 with repaired responses api (issue #6)", async () => {
	await withCacheFileIsolation(async () => {
		// Reporter's exact file shape: 3-day-old cache, no etag, 1.3 entry
		// written before enrichment knew it (api missing), paid ids present.
		const staleSpark = {
			id: "muse-spark-1.3-contributor-free",
			name: "Muse Spark 1.3 (1M)",
			reasoning: true,
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			input: ["text", "image"] as ["text", "image"],
			source: "opencode" as const,
		};
		const paid = {
			id: "claude-fable-5-1",
			name: "Claude Fable 5-1",
			reasoning: false,
			contextWindow: 1000,
			maxTokens: 1000,
			input: ["text"] as ["text"],
			source: "opencode" as const,
		};
		const models = [
			...baselineModels().filter((m) => m.id !== "muse-spark-1.3-contributor-free"),
			staleSpark,
			paid,
		];
		fs.writeFileSync(
			CATALOG_CACHE_FILE,
			JSON.stringify({
				timestamp: Date.now() - 3 * CATALOG_CACHE_TTL_MS,
				opencode: models.map((m) => m.id),
				kilo: [],
				models,
			}),
			"utf8",
		);
		setAliveCatalog([]);
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			throw new Error("offline fallback");
		};
		const result = await refreshCatalog(false);
		assert.equal(calls, 1, "etagless stale cache must attempt one plain revalidation fetch");
		const spark = result.find((m) => m.id === "muse-spark-1.3-contributor-free");
		assert.ok(spark, "stale 1.3 entry must survive");
		assert.equal(spark.api, "openai-responses", "stale 1.3 api must be backfilled, not undefined");
		assert.equal(result.some((m) => m.id === "claude-fable-5-1"), false, "paid ids must be purged");
	});
});

test("writeCatalogCache does not throw when the disk write fails", () => {
	const origWriteFileSync = fs.writeFileSync;
	const origRenameSync = fs.renameSync;
	fs.writeFileSync = (() => {
		throw new Error("EACCES: permission denied");
	}) as unknown as typeof fs.writeFileSync;
	fs.renameSync = (() => {
		throw new Error("EACCES: permission denied");
	}) as unknown as typeof fs.renameSync;
	try {
		writeCatalogCache({ timestamp: Date.now(), opencode: [], kilo: [], models: [] });
	} finally {
		fs.writeFileSync = origWriteFileSync;
		fs.renameSync = origRenameSync;
	}
});

test("mergeCatalog drops paid upstream ids like claude-fable-5-1 (issue #6)", () => {
	const base = baselineModels().slice(0, 2);
	const paid = {
		id: "claude-fable-5-1",
		name: "Claude Fable 5-1",
		reasoning: false,
		contextWindow: 1000,
		maxTokens: 1000,
		input: ["text"] as ["text"],
		source: "opencode" as const,
	};
	const merged = mergeCatalog(base, [paid]);
	assert.equal(merged.some((m) => m.id === "claude-fable-5-1"), false);
	assert.deepEqual(merged.map((m) => m.id), base.map((m) => m.id));
});

test("isFreeCatalogId accepts -free, :free, /free and known ids, rejects paid and dead", () => {
	assert.equal(isFreeCatalogId("mimo-v2.5-free"), true);
	assert.equal(isFreeCatalogId("thinkingmachines/inkling-small:free"), true);
	assert.equal(isFreeCatalogId("nex-agi/nex-n2.5-pro:free"), true);
	assert.equal(isFreeCatalogId("lab/new-model/free"), true);
	assert.equal(isFreeCatalogId("big-pickle"), true);
	assert.equal(isFreeCatalogId("claude-fable-5-1"), false);
	assert.equal(isFreeCatalogId("hy3-free"), false);
	assert.equal(isFreeCatalogId("thinkingmachines/inkling:free"), false);
	assert.equal(isFreeCatalogId(""), false);
});

test("sanitizeCatalogModels repairs stale spark api to openai-responses (issue #6)", () => {
	const staleSpark = {
		id: "muse-spark-1.3-contributor-free",
		name: "Muse Spark 1.3 (1M)",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		api: "openai-completions" as const,
		input: ["text", "image"] as ["text", "image"],
		source: "opencode" as const,
	};
	const merged = mergeCatalog([], [staleSpark]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].api, "openai-responses");
});

test("readCatalogCache purges paid ids persisted by pre-fix refreshes (issue #6)", async () => {
	await withCacheFileIsolation(async () => {
		const paid = {
			id: "claude-fable-5-1",
			name: "Claude Fable 5-1",
			reasoning: false,
			contextWindow: 1000,
			maxTokens: 1000,
			input: ["text"] as ["text"],
			source: "opencode" as const,
		};
		fs.writeFileSync(
			CATALOG_CACHE_FILE,
			JSON.stringify({
				timestamp: Date.now(),
				etag: '"paid-cache"',
				opencode: [paid.id],
				kilo: [],
				models: [...baselineModels().slice(0, 1), paid],
			}),
			"utf8",
		);
		const cached = readCatalogCache();
		assert.ok(cached);
		assert.equal((cached.models ?? []).some((m) => m.id === "claude-fable-5-1"), false);
	});
});
