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

test("catalog contains exactly 23 verified models (9 OpenCode + 14 Kilo)", () => {
	assert.equal(OPENCODE_MODELS.length, 9);
	assert.equal(KILO_MODELS.length, 14);
	assert.equal(ALL_MODELS.length, 23);
});

test("all model IDs are unique", () => {
	const ids = new Set(ALL_MODELS.map((m) => m.id));
	assert.equal(ids.size, 23);
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
	const oneMillionModels = [
		"x-preview-f-free",
		"muse-spark-1.2-contributor-free",
		"mimo-v2.5-free",
		"laguna-s-2.1-free",
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
});

test("KiloCode upstream router distinguishes Kilo vs OpenCode", () => {
	assert.equal(isKiloModel("stepfun/step-3.7-flash:free"), true);
	assert.equal(getModelUpstream("stepfun/step-3.7-flash:free"), "kilo");

	assert.equal(isKiloModel("mimo-v2.5-free"), false);
	assert.equal(getModelUpstream("mimo-v2.5-free"), "opencode");
});

test("model aliases resolve correctly to canonical IDs", () => {
	assert.equal(resolveCanonicalModelId("claude-sonnet-4.5-contributor-free"), "muse-spark-1.2-contributor-free");
	assert.equal(resolveCanonicalModelId("step-3.7-flash"), "stepfun/step-3.7-flash:free");
	assert.equal(resolveCanonicalModelId("dots-3-note-preview"), "dots-studio/dots-3-note-preview:free");
	assert.equal(resolveCanonicalModelId("north-mini-code"), "cohere/north-mini-code:free");

	const stepAlias = getModelDef("step-3.7-flash");
	assert.ok(stepAlias);
	assert.equal(isKiloModel("step-3.7-flash"), true);
	assert.equal(getModelUpstream("step-3.7-flash"), "kilo");

	const allRegistered = getAllRegisteredModels();
	assert.equal(allRegistered.length, 23);
	assert.equal(allRegistered.length, ALL_MODELS.length);
});
