/**
 * Unit tests for model catalog definitions and upstream routing
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
 ALL_MODELS,
 MODEL_MAP,
 OPENCODE_MODELS,
 KILO_MODELS,
 CLINE_MODELS,
 KILO_MODEL_IDS,
 getModelDef,
 isKiloModel,
 getModelUpstream,
 resolveCanonicalModelId,
 getAllRegisteredModels,
} from "../src/models.ts";

test("catalog composition: OpenCode + Kilo + Cline lists make up the full catalog", () => {
 // Composition over hardcoded counts — resilient to catalog growth while
 // still locking the invariant that every model belongs to exactly one source.
 assert.ok(OPENCODE_MODELS.length > 0, "OpenCode list must be non-empty");
 assert.ok(KILO_MODELS.length > 0, "Kilo list must be non-empty");
 assert.ok(CLINE_MODELS.length > 0, "Cline list must be non-empty");
 assert.equal(OPENCODE_MODELS.length + KILO_MODELS.length + CLINE_MODELS.length, ALL_MODELS.length);
});

test("all model IDs are unique", () => {
 const ids = new Set(ALL_MODELS.map((m) => m.id));
 assert.equal(ids.size, ALL_MODELS.length);
});

test("all models have positive contextWindow and maxTokens", () => {
 for (const m of ALL_MODELS) {
  assert.ok(m.contextWindow > 0, `model ${m.id} has valid contextWindow`);
  assert.ok(m.maxTokens > 0, `model ${m.id} has valid maxTokens`);
  assert.ok(m.name.length > 0, `model ${m.id} has a display name`);
 }
});

test("muse-spark uses openai-responses api", () => {
 const spark = getModelDef("muse-spark-1.2-contributor-free");
 assert.ok(spark);
 assert.equal(spark?.api, "openai-responses");
 assert.equal(spark?.contextWindow, 1_048_576);
});

test("1M context window models are properly configured", () => {
 // Known 1M models must exist with a >= 1M window (spec lock), and every
 // model in the catalog advertising >= 1M must be in that known list
 // (drift guard — no unaccounted-for 1M models).
	const oneMillionModels = [
		"muse-spark-1.2-contributor-free",
		"muse-spark-1.3-contributor-free",
		"cline-free/muse-spark-1.3-contributor",
		"cline-free/deepseek-v4.1-flash",
		"cline-free/kimi-k3",
		"z-ai/glm-5.3-flash",
		"mimo-v2.6-flash-free",
		"fledge-alpha-free",
		"space-bunny-free",
		"longcat-2.5-preview-free",
		"nemotron-3.5-lightning-free",
		"nemotron-3-ultra-free",
		"nvidia/nemotron-3-ultra-550b-a55b:free",
		"nvidia/nemotron-3.5-lightning:free",
		"thinkingmachines/inkling-small:free",
	];

 for (const id of oneMillionModels) {
  const m = getModelDef(id);
  assert.ok(m, `1M model ${id} exists`);
  assert.ok(m!.contextWindow >= 1_000_000, `model ${id} context window is >= 1M`);
 }

 const knownCanonical = new Set(oneMillionModels.map((id) => resolveCanonicalModelId(id)));
 const catalogOneMillion = ALL_MODELS.filter((m) => m.contextWindow >= 1_000_000).map((m) => m.id);
 for (const id of catalogOneMillion) {
  assert.ok(
   knownCanonical.has(id),
   `catalog model ${id} has >= 1M window but is not in the known 1M list`,
  );
 }
});

test("KiloCode upstream router distinguishes Kilo vs OpenCode", () => {
 assert.equal(isKiloModel("dots-studio/dots-3-note-preview:free"), true);
 assert.equal(getModelUpstream("dots-studio/dots-3-note-preview:free"), "kilo");

 assert.equal(isKiloModel("mimo-v2.5-free"), false);
 assert.equal(getModelUpstream("mimo-v2.5-free"), "opencode");
});

test("2026-09-22 and 2026-09-28 additions route to the correct upstream with verified metadata", () => {
 // MiMo V2.6 Flash serves through OpenCode Zen chat with the shared MiMo effort mapping
 const mimo = getModelDef("mimo-v2.6-flash-free");
 assert.ok(mimo);
 assert.equal(mimo.contextWindow, 1_048_576);
 assert.equal(mimo.maxTokens, 131_072);
 assert.equal(mimo.reasoning, true);
 assert.deepEqual(mimo.input, ["text", "image"]);
 assert.equal(mimo.thinkingLevelMap?.minimal, "low");
 assert.equal(mimo.thinkingLevelMap?.xhigh, "high");
 assert.equal(getModelUpstream("mimo-v2.6-flash-free"), "opencode");
 assert.equal(getModelUpstream("mimo-v2.6-flash"), "opencode");
	// Ling 3.1 Flash is a hybrid reasoning Kilo model (added 2026-10-07)
	const lingKilo = getModelDef("inclusionai/ling-3.1-flash");
	assert.ok(lingKilo);
	assert.equal(lingKilo.contextWindow, 262_144);
	assert.equal(lingKilo.maxTokens, 32_768);
	assert.equal(lingKilo.reasoning, true);
	assert.deepEqual(lingKilo.input, ["text"]);
	assert.equal(lingKilo.thinkingFormat, "openrouter");
	assert.equal(getModelUpstream("inclusionai/ling-3.1-flash"), "kilo");
	assert.equal(getModelUpstream("ling-3.1-flash:kilo"), "kilo");
	// Step 3.7 Flash is back on the Kilo free list (resurrected 2026-09-28)
	const step = getModelDef("stepfun/step-3.7-flash:free");
	assert.ok(step);
	assert.equal(step.contextWindow, 262_144);
	assert.equal(step.maxTokens, 262_144);
	assert.equal(step.reasoning, true);
	assert.deepEqual(step.input, ["text", "image"]);
	assert.equal(step.thinkingFormat, "openrouter");
	assert.equal(getModelUpstream("stepfun/step-3.7-flash:free"), "kilo");
	assert.equal(getModelUpstream("step-3.7-flash"), "kilo");
});

test("2026-09-28 pruned models stay out of the static catalog", () => {
 // Gone from the live Kilo free list: :free IDs absent, keyless 404.
 // Only paid counterparts remain (isFree:false), so nothing registers.
	for (const id of [
		"nex-agi/nex-n2.5-pro:free",
		"nex-agi/nex-n2.5-mini:free",
		"z-ai/glm-5.2:free",
		"mimo-v2.5-free",
		"stealth/space-bunny-alpha",
		"qwen/qwen3.8-27b:free",
	]) {
		assert.equal(getModelDef(id), undefined, `${id} must not resolve`);
		assert.equal(MODEL_MAP.get(id), undefined, `${id} must not be in MODEL_MAP`);
	}
 // Pruned aliases fall through to the verbatim ID (no cross-lab residue)
 assert.equal(resolveCanonicalModelId("nex-n2.5-pro"), "nex-n2.5-pro");
 assert.equal(resolveCanonicalModelId("nex-n2.5-mini"), "nex-n2.5-mini");
 assert.equal(resolveCanonicalModelId("glm-5.2"), "glm-5.2");
});

test("model aliases resolve correctly to canonical IDs", () => {
 // clean slash-free aliases (single form, no :free duplicates)
 assert.equal(resolveCanonicalModelId("dots-3-note-preview"), "dots-studio/dots-3-note-preview:free");
 assert.equal(resolveCanonicalModelId("north-mini-code"), "cohere/north-mini-code:free");
 assert.equal(resolveCanonicalModelId("nemotron-3.5-lightning"), "nvidia/nemotron-3.5-lightning:free");
 assert.equal(resolveCanonicalModelId("nemotron-3.5-lightning:free"), "nemotron-3.5-lightning:free");
 assert.equal(resolveCanonicalModelId("space-bunny"), "space-bunny-free");
 // removed wrong cross-lab aliases must no longer resolve
 assert.equal(resolveCanonicalModelId("claude-sonnet-4.5-contributor-free"), "claude-sonnet-4.5-contributor-free");
 assert.equal(resolveCanonicalModelId("minimax-m2.1-free"), "minimax-m2.1-free");
 assert.equal(resolveCanonicalModelId("qwen3-coder-480b-free"), "qwen3-coder-480b-free");
 // removed :free duplicate aliases must not be needed (canonical passthrough)

 const dotsAlias = getModelDef("dots-3-note-preview");
 assert.ok(dotsAlias);
 assert.equal(isKiloModel("dots-3-note-preview"), true);
 assert.equal(getModelUpstream("dots-3-note-preview"), "kilo");

 const allRegistered = getAllRegisteredModels();
 assert.equal(allRegistered.length, ALL_MODELS.length);
});

test("every reasoning model declares a thinkingLevelMap so the picker is lockable", () => {
 // Without a map the host falls back to guessing effort labels. Each
 // reasoning model must declare its own map (or share the Kilo map).
 for (const m of ALL_MODELS) {
  if (!m.reasoning) continue;
  assert.ok(
   m.thinkingLevelMap,
   `${m.id} reasoning:true must declare thinkingLevelMap`,
  );
  // off must hide (null), and at least one real level must be visible
  assert.equal(m.thinkingLevelMap!.off, null, `${m.id}: off must hide`);
  const visible = Object.entries(m.thinkingLevelMap!).filter(
   ([k, v]) => v !== null && k !== "off",
  );
  assert.ok(visible.length > 0, `${m.id} must expose at least one level`);
  for (const [label, value] of visible) {
   assert.equal(typeof value, "string", `${m.id}.${label} must map to a string`);
  }
 }
});

test("every non-reasoning model stays plain (no thinkingLevelMap)", () => {
 for (const m of ALL_MODELS) {
  if (m.reasoning) continue;
  assert.equal(m.thinkingLevelMap, undefined, `${m.id} non-reasoning must not declare a map`);
 }
});
test("catalog spec lock: live-verified ctx/max/reasoning per model", () => {
 // Values locked after 2026-08-30 live probing (via relay pool + upstream
 // error messages). Change only with a fresh live verification.
 const locked: Record<string, { ctx: number; max: number; reasoning: boolean }> = {
  // OpenCode Zen
  "muse-spark-1.2-contributor-free": { ctx: 1_048_576, max: 131_072, reasoning: true },
  "muse-spark-1.3-contributor-free": { ctx: 1_048_576, max: 131_072, reasoning: true },
  // Added 2026-09-22 (live: Zen /v1/models + keyless chat 200 on mimo-v2.6-flash-free)
  "mimo-v2.6-flash-free": { ctx: 1_048_576, max: 131_072, reasoning: true },
  // Added 2026-09-23 (live: Zen listing + keyless chat 200; models.dev 1M ctx / 512K out)
  "space-bunny-free": { ctx: 1_048_576, max: 524_288, reasoning: true },
  // Added 2026-09-27 (live: Zen listing + keyless chat 200; models.dev 1M ctx / 131K out)
  "longcat-2.5-preview-free": { ctx: 1_000_000, max: 131_072, reasoning: true },
  "nemotron-3-ultra-free": { ctx: 1_000_000, max: 128_000, reasoning: true },
  "nemotron-3.5-lightning-free": { ctx: 1_000_000, max: 262_144, reasoning: true },
  "big-pickle": { ctx: 200_000, max: 32_000, reasoning: true },
  // Added 2026-10-03 (live: Zen docs endpoint table + keyless chat 200 via proxy; models.dev ctx/out)
  "fledge-alpha-free": { ctx: 1_048_576, max: 131_072, reasoning: true },
  "ling-3.1-flash-free": { ctx: 262_144, max: 32_768, reasoning: true },
  // KiloCode Gateway
  "dots-studio/dots-3-note-preview:free": { ctx: 512_000, max: 512_000, reasoning: true },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": { ctx: 256_000, max: 131_072, reasoning: true },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { ctx: 1_000_000, max: 128_000, reasoning: true },
  "nvidia/nemotron-3.5-lightning:free": { ctx: 1_000_000, max: 262_144, reasoning: true },
  "nvidia/nemotron-3-super-120b-a12b:free": { ctx: 262_144, max: 262_144, reasoning: true },
  "cohere/north-mini-code:free": { ctx: 256_000, max: 64_000, reasoning: true },
  "poolside/laguna-s-2.1:free": { ctx: 262_144, max: 32_768, reasoning: true },
  "poolside/laguna-xs-2.1:free": { ctx: 262_144, max: 32_768, reasoning: true },
  "liquid/lfm-2.5-2.6b:free": { ctx: 65_536, max: 32_768, reasoning: true },
  "kilo-auto/free": { ctx: 256_000, max: 10_000, reasoning: true },
  "openrouter/free": { ctx: 200_000, max: 65_536, reasoning: true },
  "nvidia/nemotron-3.5-content-safety:free": { ctx: 128_000, max: 8_192, reasoning: false },
  // Added 2026-08-30 (live-verified)
  "inclusionai/ling-3.0-flash-sante:free": { ctx: 262_144, max: 32_768, reasoning: true },
  "thinkingmachines/inkling-small:free": { ctx: 1_048_576, max: 262_144, reasoning: true },
  // Resurrected 2026-09-28 (live: Kilo free list isFree:true + keyless chat 200)
  "stepfun/step-3.7-flash:free": { ctx: 262_144, max: 262_144, reasoning: true },
		// Added 2026-10-07 (live: Kilo free list isFree:true + keyless chat 200; 262K ctx)
		"inclusionai/ling-3.1-flash": { ctx: 262_144, max: 32_768, reasoning: true },
  // Cline direct-only (per-user pool — https://api.cline.bot)
  "cline-free/deepseek-v4.1-flash": { ctx: 1_000_000, max: 384_000, reasoning: true },
  "cline-free/muse-spark-1.3-contributor": { ctx: 1_048_576, max: 131_072, reasoning: true },
  "z-ai/glm-5.3-flash": { ctx: 1_000_000, max: 131_072, reasoning: true },
  // Added 2026-09-22 (live: desktop-identity free list + chat probe)
  "cline-free/kimi-k3": { ctx: 1_048_576, max: 131_072, reasoning: true },
  "cline-free/solar-pro4": { ctx: 524_288, max: 131_072, reasoning: true },
 };
 for (const [id, { ctx, max, reasoning }] of Object.entries(locked)) {
  const m = getModelDef(id);
  assert.ok(m, `spec-locked model ${id} exists`);
  assert.equal(m!.contextWindow, ctx, `${id} contextWindow`);
  assert.equal(m!.maxTokens, max, `${id} maxTokens`);
  assert.equal(m!.reasoning, reasoning, `${id} reasoning`);
 }
 assert.equal(Object.keys(locked).length, ALL_MODELS.length, "every catalog model is spec-locked");
});

test("new alias map resolves to canonical kilo ids", () => {
 assert.equal(resolveCanonicalModelId("inkling-small"), "thinkingmachines/inkling-small:free");
 assert.equal(resolveCanonicalModelId("ling-3.0-flash-sante"), "inclusionai/ling-3.0-flash-sante:free");
	assert.equal(resolveCanonicalModelId("mimo-v2.6-flash"), "mimo-v2.6-flash-free");
	assert.equal(resolveCanonicalModelId("ling-3.1-flash:kilo"), "inclusionai/ling-3.1-flash");
});

test("union-alpha is pruned from the static catalog", () => {
 assert.equal(MODEL_MAP.get("union-alpha"), undefined, "union-alpha must not be in MODEL_MAP");
 assert.equal(ALL_MODELS.some((m) => m.id === "union-alpha"), false, "union-alpha must not be in ALL_MODELS");
});
