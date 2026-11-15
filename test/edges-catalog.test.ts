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
	getAliveCatalog,
	isFreeCatalogId,
	mergeCatalog,
	sanitizeCatalogModels,
	readCatalogCache,
	refreshCatalog,
	setAliveCatalog,
	writeCatalogCache,
} from "../src/catalog.ts";
import { CATALOG_CACHE_FILE, CATALOG_CACHE_LOCK_FILE, CATALOG_CACHE_TTL_MS } from "../src/config.ts";
import { ALL_MODELS, OVH_MODELS } from "../src/models.ts";
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
	const lockExisted = fs.existsSync(CATALOG_CACHE_LOCK_FILE);
	const lockBackup = lockExisted ? fs.readFileSync(CATALOG_CACHE_LOCK_FILE, "utf8") : "";
	const catalogBefore = getAliveCatalog();
 const realFetch = globalThis.fetch;
 try {
  await fn();
 } finally {
  globalThis.fetch = realFetch;
		setAliveCatalog(catalogBefore);
  if (existed) {
   fs.writeFileSync(CATALOG_CACHE_FILE, backup, "utf8");
  } else {
   fs.rmSync(CATALOG_CACHE_FILE, { force: true });
  }
		if (lockExisted) fs.writeFileSync(CATALOG_CACHE_LOCK_FILE, lockBackup, "utf8");
		else fs.rmSync(CATALOG_CACHE_LOCK_FILE, { force: true });
 }
}

test("enrichModelDef with missing context_length falls back to sane defaults", () => {
 const def = enrichModelDef({ id: "unknown-lab/brand-new-7b" }, "opencode");
 assert.equal(def.id, "unknown-lab/brand-new-7b");
 assert.equal(def.source, "opencode");
 assert.equal(def.contextWindow, 262_144, "missing context_length must default to 262_144");
 assert.deepEqual(def.input, ["text"], "non-vision model defaults to text-only input");
});

test("enrichModelDef declared fields win over wire aliases and heuristics", () => {
 const def = enrichModelDef(
  {
   id: "deepseek-lab/custom-reasoner",
   contextWindow: 100_000,
   context_length: 200_000,
   maxTokens: 8_000,
   max_output_tokens: 16_000,
   reasoning: false,
  },
  "opencode",
 );
 assert.equal(def.contextWindow, 100_000, "declared contextWindow beats the snake_case alias");
 assert.equal(def.maxTokens, 8_000, "declared maxTokens beats the wire alias");
 assert.equal(def.reasoning, false, "declared reasoning:false beats the id heuristic");
 const aliased = enrichModelDef(
  { id: "plain-lab/plain-model", context_length: 300_000, max_output_tokens: 24_000 },
  "opencode",
 );
 assert.equal(aliased.contextWindow, 300_000, "wire alias still fills the gap");
 assert.equal(aliased.maxTokens, 24_000, "wire output alias still fills the gap");
});

test("enrichModelDef kilocode source keeps :free suffix id and tags thinkingFormat", () => {
 const known = enrichModelDef(
  { id: "dots-studio/dots-3-note-preview:free" },
  "kilo",
 );
 assert.equal(known.id, "dots-studio/dots-3-note-preview:free");
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

test("refreshCatalog 200 maps the /inference/v1/models free list onto catalog flags, dropping paid and dead", async () => {
 await withCacheFileIsolation(async () => {
  fs.rmSync(CATALOG_CACHE_FILE, { force: true });
  const baseline = baselineModels();
  setAliveCatalog(baseline);
  globalThis.fetch = async () =>
   new Response(
    JSON.stringify({
     data: [
      { id: "newlab/new-cool-model-free" },
      { id: "claude-fable-5-1" },
      { id: "deepseek-v4-flash-free" },
     ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
   );
  const result = await refreshCatalog(true);
  const ids = result.map((m) => m.id);
  assert.ok(ids.includes("newlab/new-cool-model-free"), "fresh free id enters the catalog");
  assert.ok(!ids.includes("claude-fable-5-1"), "paid upstream id never enters the catalog");
  assert.ok(!ids.includes("deepseek-v4-flash-free"), "pruned dead id never re-enters via refresh");
  for (const m of baseline) {
   assert.ok(ids.includes(m.id), `static entry survives refresh: ${m.id}`);
  }
 });
});

test("stale cache without etag drops the retired Cline Muse Spark entry (issue #6 shape)", async () => {
 await withCacheFileIsolation(async () => {
  // Reporter's exact file shape: 3-day-old cache, no etag, an entry written
  // before enrichment knew it (api missing), paid ids present — plus the
  // Cline Muse Spark entry, which was still in the catalog when those caches
  // were written and is now retired (2026-10-22). The stale row must be
  // dropped, not served: a dead-listed id never re-enters the picker.
  const staleSpark = {
   id: "cline-free/muse-spark-1.3-contributor",
   name: "Muse Spark 1.2 (1M)",
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
   ...baselineModels().filter((m) => m.id !== "cline-free/muse-spark-1.3-contributor"),
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
   assert.equal(calls, 2, "etagless stale cache must revalidate Zen and Kilo independently");
  const spark = result.find((m) => m.id === "cline-free/muse-spark-1.3-contributor");
  assert.equal(spark, undefined, "the retired Cline entry must not survive a stale cache");
  assert.ok(
   result.some((m) => m.id === "cline/nemotron-3.5-super-vl"),
   "the surviving Cline model must still come from the static base",
  );
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
	assert.equal(isFreeCatalogId("mimo-v2.6-flash-free"), true);
	assert.equal(isFreeCatalogId("mimo-v2.5-free"), false);
	assert.equal(isFreeCatalogId("thinkingmachines/inkling-small:free"), false);
	// Retired 2026-10-21: Kilo answers 404 unavailable_model for inkling-small and
	// 404 "Function not found" for nemotron-3-super-120b-a12b.
	assert.equal(isFreeCatalogId("nvidia/nemotron-3-super-120b-a12b:free"), false);
	// stepfun/step-5-preview-free was demoted to paid on Kilo (2026-10-16).
	assert.equal(isFreeCatalogId("stepfun/step-5-preview-free"), false);
	assert.equal(isFreeCatalogId("lab/new-model/free"), true);
	assert.equal(isFreeCatalogId("big-pickle"), true);
	assert.equal(isFreeCatalogId("inclusionai/ling-3.1-flash"), false);
	assert.equal(isFreeCatalogId("stealth/space-bunny-alpha"), false);
 assert.equal(isFreeCatalogId("claude-fable-5-1"), false);
 assert.equal(isFreeCatalogId("nex-agi/nex-n2.5-pro:free"), false);
 assert.equal(isFreeCatalogId("z-ai/glm-5.2:free"), false);
 assert.equal(isFreeCatalogId("hy3-free"), false);
 assert.equal(isFreeCatalogId("thinkingmachines/inkling:free"), false);
	assert.equal(isFreeCatalogId("cline-free/deepseek-v4.1-flash"), false);
	assert.equal(isFreeCatalogId("cline-free/kimi-k3"), false);
	assert.equal(isFreeCatalogId("cline-free/solar-pro4"), false);
	// OVH lane: the `ovh-free/` prefix carries `-free`, so every namespaced
	// id stays allowed while an unnamespaced OVH id that is not in the
	// catalog does not (otherwise a paid OVH id could ride the picker).
	assert.equal(isFreeCatalogId("ovh-free/gpt-oss-120b"), true);
	assert.equal(isFreeCatalogId("ovh-free/gpt-oss-20b"), true);
	assert.equal(isFreeCatalogId("ovh-free/Qwen3.5-397B-A17B"), true);
	assert.equal(isFreeCatalogId("ovh-free/Qwen3.5-9B"), true);
	assert.equal(isFreeCatalogId("ovh-free/Qwen3.6-27B"), true);
	assert.equal(isFreeCatalogId("ovh-free/Qwen3.8-27B"), true);
	assert.equal(isFreeCatalogId("ovh-free/Mistral-Small-3.2-24B-Instruct-2506"), true);
	assert.equal(isFreeCatalogId("ovh-free/Mistral-7B-Instruct-v0.3"), false);
	assert.equal(isFreeCatalogId("ovh-free/Meta-Llama-3_3-70B-Instruct"), true);
	assert.equal(isFreeCatalogId("ovh/Mistral-Nemo-Instruct-2407"), false, "an unnamespaced OVH id is not in the catalog");
	// Added 2026-10-22: a Zen free id relies on the static catalog for
	// recognition, and the Kilo ids carry `:free`. Both free MiniMax M3.1
	// Flash endpoints retired on 2026-10-23, so both are dead now.
	assert.equal(isFreeCatalogId("minimax-m3.1-flash-free"), false);
	assert.equal(isFreeCatalogId("flint-40b-free"), true);
	assert.equal(isFreeCatalogId("minimax/minimax-m3.1-flash:free"), false);
	assert.equal(isFreeCatalogId("nvidia/nemotron-3.5-super-vl:free"), true);
	assert.equal(isFreeCatalogId("reflection/beam-free"), false, "discontinued 2026-11-09");
	assert.equal(isFreeCatalogId("recursive/flint-v1.0:free"), false, "discontinued 2026-11-09");
	assert.equal(isFreeCatalogId("xingchen-agi/xing4.0-29b-a4b:free"), false, "discontinued 2026-11-09");
	assert.equal(isFreeCatalogId("poolside/laguna-s-2.1:free"), false, "discontinued 2026-11-09");
	assert.equal(isFreeCatalogId("liquid/lfm-3-1.7b:free"), true, "active Kilo free model");
 assert.equal(isFreeCatalogId(""), false);
});

test("sanitizeCatalogModels keeps every OVH id and repairs its source", () => {
	// A stale disk cache carries a `source` label; sanitize must re-derive it
	// from the static definition so an OVH model can never register as a
	// Zen model, and must never drop one of the eight.
	const seeded: RegisteredModel[] = OVH_MODELS.map((m) => ({
		...m,
		source: "opencode" as const,
	}));
	const merged = sanitizeCatalogModels(seeded);
	assert.equal(merged.length, OVH_MODELS.length);
	for (const m of merged) {
		assert.equal(m.source, "ovh", `${m.id}: source must be re-derived as ovh`);
		assert.equal(m.contextWindow > 0, true, `${m.id}: specs survive sanitize`);
	}
	assert.deepEqual(merged.map((m) => m.id).sort(), OVH_MODELS.map((m) => m.id).sort());
});

test("sanitizeCatalogModels repairs a stale Cline row against its static definition (issue #6)", () => {
 // A cache written while the Cline Muse Spark entry was still catalogued can
 // carry a wrong api on the surviving Cline model. The static definition is
 // authoritative: the stale `openai-responses` label must be replaced by the
 // static chat row, and a retired id must never be repaired back into life.
 const staleNemotron = {
  id: "cline/nemotron-3.5-super-vl",
  name: "Nemotron 3.5 Super VL (1M)",
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 4_096,
  api: "openai-responses" as const,
  input: ["text"] as ["text"],
  source: "opencode" as const,
 };
 const retiredSpark = {
  id: "cline-free/muse-spark-1.3-contributor",
  name: "Muse Spark 1.3 (1M)",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  api: "openai-responses" as const,
  input: ["text", "image"] as ["text", "image"],
  source: "cline" as const,
 };
 const merged = mergeCatalog([], [staleNemotron, retiredSpark]);
 assert.deepEqual(merged.map((m) => m.id), ["cline/nemotron-3.5-super-vl"], "the retired Cline id must be purged");
 assert.equal(merged[0].api, undefined, "the stale responses label must not survive the static chat definition");
 assert.equal(merged[0].name, "Nemotron 3.5 Super VL [Cline]", "the static display name wins");
 assert.equal(merged[0].contextWindow, 1_000_000);
 assert.equal(merged[0].maxTokens, 131_072);
 assert.equal(merged[0].reasoning, true);
 assert.equal(merged[0].source, "cline");
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

test("a successful refresh migrates the legacy cache to per-source version 2 snapshots", async () => {
 await withCacheFileIsolation(async () => {
  const zen = {
   id: "legacy-zen-free",
   name: "Legacy Zen",
   reasoning: false,
   contextWindow: 64_000,
   maxTokens: 8_000,
   source: "opencode" as const,
  };
  const kilo = { ...zen, id: "legacy-kilo:free", name: "Legacy Kilo", source: "kilo" as const };
  fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({
   timestamp: Date.now() - 2 * CATALOG_CACHE_TTL_MS,
   etag: "legacy-zen-etag",
   opencode: [zen.id],
   kilo: [kilo.id],
   models: [zen, kilo],
  }));
  globalThis.fetch = async (url) => {
   if (String(url).includes("api.kilo.ai")) {
    return new Response(JSON.stringify({ data: [{
     id: "particle-ai/particle-1:free",
     name: "Particle AI: Particle-1 (free)",
     isFree: true,
     pricing: { prompt: "0", completion: "0" },
     architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
     context_length: 1_048_576,
     top_provider: { max_completion_tokens: 131_072 },
     supported_parameters: ["tools", "reasoning"],
    }] }), { status: 200, headers: { etag: "kilo-new" } });
   }
   return new Response(null, { status: 304 });
  };
  const result = await refreshCatalog(true);
  assert.ok(result.some((entry) => entry.id === zen.id), "Zen 304 retains its classified legacy row");
  assert.ok(result.some((entry) => entry.id === "particle-ai/particle-1:free"));
  const persisted = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.version, 2);
  assert.ok(persisted.sources && typeof persisted.sources === "object");
  assert.equal("models" in persisted, false, "the rewritten disk schema no longer uses a merged top-level snapshot");
 });
});

test("malformed and suspiciously empty listings preserve each source snapshot", async () => {
 await withCacheFileIsolation(async () => {
  const timestamp = Date.now() - 2 * CATALOG_CACHE_TTL_MS;
  const zen = {
   id: "cached-zen-free",
   name: "Cached Zen",
   reasoning: false,
   contextWindow: 64_000,
   maxTokens: 8_000,
   source: "opencode" as const,
  };
  const kilo = { ...zen, id: "cached-kilo:free", name: "Cached Kilo", source: "kilo" as const };
  fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({
   version: 2,
   sources: {
    opencode: { timestamp, ids: [zen.id], models: [zen] },
    kilo: { timestamp, ids: [kilo.id], models: [kilo] },
   },
  }));
  globalThis.fetch = async (url) => String(url).includes("api.kilo.ai")
   ? new Response(JSON.stringify({ data: [] }), { status: 200 })
   : new Response("not json", { status: 200 });
  const result = await refreshCatalog(true);
  assert.ok(result.some((entry) => entry.id === zen.id));
  assert.ok(result.some((entry) => entry.id === kilo.id));
 });
});

test("legacy cache rejects unknown rows with ambiguous or conflicting source provenance", async () => {
 await withCacheFileIsolation(() => {
  const conflicting = {
   id: "legacy-conflict-free",
   name: "Legacy Conflict",
   reasoning: false,
   contextWindow: 64_000,
   maxTokens: 8_000,
   source: "opencode",
  };
  const ambiguous = { ...conflicting, id: "legacy-ambiguous-free", source: undefined };
  fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({
   timestamp: Date.now(),
   opencode: [ambiguous.id],
   kilo: [conflicting.id, ambiguous.id],
   models: [conflicting, ambiguous],
  }));
  const cached = readCatalogCache();
  assert.ok(cached);
  assert.equal(cached.models?.some((entry) => entry.id === conflicting.id), false);
  assert.equal(cached.models?.some((entry) => entry.id === ambiguous.id), false);
 });
});
