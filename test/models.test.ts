/**
 * Unit tests for model catalog definitions and upstream routing
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	ALL_MODELS,
	OPENCODE_MODELS,
	KILO_MODELS,
	KILO_MODEL_IDS,
	getModelDef,
	isKiloModel,
	getModelUpstream,
	resolveCanonicalModelId,
	getAllRegisteredModels,
} from "../src/models.ts";

test("catalog composition: OpenCode + Kilo lists make up the full catalog", () => {
	// Composition over hardcoded counts — resilient to catalog growth while
	// still locking the invariant that every model belongs to exactly one source.
	assert.ok(OPENCODE_MODELS.length > 0, "OpenCode list must be non-empty");
	assert.ok(KILO_MODELS.length > 0, "Kilo list must be non-empty");
	assert.equal(OPENCODE_MODELS.length + KILO_MODELS.length, ALL_MODELS.length);
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
		"mimo-v2.5-free",
		"laguna-s-2.1-free",
		"poolside/laguna-s-2.1:free",
		"nemotron-3.5-lightning-free",
		"nemotron-3-ultra-free",
		"nvidia/nemotron-3-ultra-550b-a55b:free",
		"nvidia/nemotron-3.5-lightning:free",
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
	assert.equal(isKiloModel("stepfun/step-3.7-flash:free"), true);
	assert.equal(getModelUpstream("stepfun/step-3.7-flash:free"), "kilo");

	assert.equal(isKiloModel("mimo-v2.5-free"), false);
	assert.equal(getModelUpstream("mimo-v2.5-free"), "opencode");
});

test("model aliases resolve correctly to canonical IDs", () => {
	// clean slash-free aliases (single form, no :free duplicates)
	assert.equal(resolveCanonicalModelId("step-3.7-flash"), "stepfun/step-3.7-flash:free");
	assert.equal(resolveCanonicalModelId("dots-3-note-preview"), "dots-studio/dots-3-note-preview:free");
	assert.equal(resolveCanonicalModelId("north-mini-code"), "cohere/north-mini-code:free");
	assert.equal(resolveCanonicalModelId("nemotron-3.5-lightning"), "nvidia/nemotron-3.5-lightning:free");
	assert.equal(resolveCanonicalModelId("nemotron-3.5-lightning:free"), "nemotron-3.5-lightning:free");
	// removed wrong cross-lab aliases must no longer resolve
	assert.equal(resolveCanonicalModelId("claude-sonnet-4.5-contributor-free"), "claude-sonnet-4.5-contributor-free");
	assert.equal(resolveCanonicalModelId("minimax-m2.1-free"), "minimax-m2.1-free");
	assert.equal(resolveCanonicalModelId("qwen3-coder-480b-free"), "qwen3-coder-480b-free");
	// removed :free duplicate aliases must not be needed (canonical passthrough)
	assert.equal(resolveCanonicalModelId("dots-3-note-preview:free"), "dots-3-note-preview:free");
	assert.equal(resolveCanonicalModelId("step-3.7-flash:free"), "step-3.7-flash:free");

	const stepAlias = getModelDef("step-3.7-flash");
	assert.ok(stepAlias);
	assert.equal(isKiloModel("step-3.7-flash"), true);
	assert.equal(getModelUpstream("step-3.7-flash"), "kilo");

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
