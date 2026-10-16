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
 OVH_MODELS,
 OVH_MODEL_PREFIX,
 ovhUpstreamModelId,
 KILO_MODEL_IDS,
 isOvhModel,
 getModelDef,
 isKiloModel,
 getModelUpstream,
 resolveCanonicalModelId,
 getAllRegisteredModels,
} from "../src/models.ts";

test("catalog composition: OpenCode + Kilo + Cline + OVH lists make up the full catalog", () => {
 // Composition over hardcoded counts — resilient to catalog growth while
 // still locking the invariant that every model belongs to exactly one source.
 assert.ok(OPENCODE_MODELS.length > 0, "OpenCode list must be non-empty");
 assert.ok(KILO_MODELS.length > 0, "Kilo list must be non-empty");
 assert.ok(CLINE_MODELS.length > 0, "Cline list must be non-empty");
 assert.ok(OVH_MODELS.length > 0, "OVH list must be non-empty");
 assert.equal(OPENCODE_MODELS.length + KILO_MODELS.length + CLINE_MODELS.length + OVH_MODELS.length, ALL_MODELS.length);
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
		"z-ai/glm-5.3-flash",
		"glm-5.3-flash-free",
		"mimo-v2.6-flash-free",
		"deepseek-v4.1-flash-free",
		"space-bunny-free",
		"longcat-2.5-preview-free",
		"nemotron-3.5-lightning-free",
		"nemotron-3.5-super-vl-free",
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
 assert.deepEqual(mimo.input, ["text", "image", "video"]);
 assert.equal(mimo.thinkingLevelMap?.minimal, "low");
 assert.equal(mimo.thinkingLevelMap?.xhigh, "high");
 assert.equal(getModelUpstream("mimo-v2.6-flash-free"), "opencode");
 assert.equal(getModelUpstream("mimo-v2.6-flash"), "opencode");
	// Glyph Cluster is new on the Kilo free list (2026-10-09)
	const glyph = getModelDef("stealth/glyph-cluster");
	assert.ok(glyph);
	assert.equal(glyph.contextWindow, 256_000);
	assert.equal(glyph.maxTokens, 256_000);
	assert.equal(glyph.reasoning, true);
	assert.deepEqual(glyph.input, ["text"]);
	assert.equal(getModelUpstream("stealth/glyph-cluster"), "kilo");
	assert.equal(getModelUpstream("glyph-cluster"), "kilo");
});
	test("2026-10-16 Zen drift additions carry verified specs (issue #71)", () => {
		const glm = getModelDef("glm-5.3-flash-free");
		assert.ok(glm);
		assert.equal(glm.reasoning, true);
		assert.equal(glm.contextWindow, 1_000_000);
		assert.equal(glm.maxTokens, 32_000);
		assert.deepEqual(glm.input, ["text", "image"]);
		assert.equal(glm.thinkingLevelMap?.minimal, "minimal");
		assert.equal(glm.thinkingLevelMap?.max, "max");
		assert.equal(getModelUpstream("glm-5.3-flash-free"), "opencode");
		assert.equal(getModelUpstream("glm-5.3-flash"), "opencode");
		const alpha = getModelDef("ll-alpha-free");
		assert.ok(alpha);
		assert.equal(alpha.reasoning, true);
		assert.equal(alpha.contextWindow, 262_144);
		assert.equal(alpha.maxTokens, 65_536);
		assert.deepEqual(alpha.input, ["text"]);
		assert.equal(alpha.thinkingLevelMap?.minimal, null);
		assert.equal(alpha.thinkingLevelMap?.low, "low");
		assert.equal(alpha.thinkingLevelMap?.max, "max");
		assert.equal(getModelUpstream("ll-alpha-free"), "opencode");
		assert.equal(getModelUpstream("ll-alpha"), "opencode");
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
		"fledge-alpha-free",
		"inclusionai/ling-3.0-flash-sante:free",
		"stepfun/step-3.7-flash:free",
	]) {
		assert.equal(getModelDef(id), undefined, `${id} must not resolve`);
		assert.equal(MODEL_MAP.get(id), undefined, `${id} must not be in MODEL_MAP`);
	}
 // Pruned aliases fall through to the verbatim ID (no cross-lab residue)
	assert.equal(resolveCanonicalModelId("nex-n2.5-pro"), "nex-n2.5-pro");
	assert.equal(resolveCanonicalModelId("nex-n2.5-mini"), "nex-n2.5-mini");
	assert.equal(resolveCanonicalModelId("glm-5.2"), "glm-5.2");
	assert.equal(resolveCanonicalModelId("fledge-alpha"), "fledge-alpha");
	assert.equal(resolveCanonicalModelId("step-3.7-flash"), "step-3.7-flash");
	assert.equal(resolveCanonicalModelId("ling-3.0-flash-sante"), "ling-3.0-flash-sante");
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
  // Added 2026-10-13 (live: Zen listing + keyless chat 200; chat-only,
  // /v1/responses answers 400). Efforts re-probed 2026-10-16: low..max all
  // answer 200; minimal/none/bogus answer 400 with the supported set
  // (max/xhigh/high/medium/low) enumerated in the error.
  // Context is 262_144 — the published value, matching where recall actually
  // fails: the needle is recalled at 248,232 prompt tokens and lost at 250,272,
  // while the gateway keeps answering 200 all the way to ~1M and truncates
  // silently. Acceptance is not capability; do not raise this from a 200.
  "cat-jam-free": { ctx: 262_144, max: 131_072, reasoning: true },
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
  // Added 2026-10-16 (issue #62): live Zen /v1/models listing + chat 200 through
  // the fingerprint path; context per the models.dev opencode twin and the
  // NVIDIA family origin (declared 1,000,000, round and conservative), output
  // 131,072 per models.dev.
  "nemotron-3.5-super-vl-free": { ctx: 1_000_000, max: 131_072, reasoning: true },
  "big-pickle": { ctx: 200_000, max: 32_000, reasoning: true },
	// Added 2026-10-16 (issue #71): Zen v1.19.2 free id, chat 200 through the
	// fingerprint path; models.dev's 200,000 ctx contradicted by probe (recall
	// at ~250K words, hard 400 only above ~1M words) — 1,000,000 declared like
	// the Kilo twin (z-ai/glm-5.3-flash).
	"glm-5.3-flash-free": { ctx: 1_000_000, max: 32_000, reasoning: true },
	// Added 2026-10-16 (issue #71): pi.dev + models.dev agree on 262,144/65,536,
	// text-only; boundary probe matches (recall ~220K words, 400 at ~250K).
	"ll-alpha-free": { ctx: 262_144, max: 65_536, reasoning: true },
  // Added 2026-10-15 (live: Zen /v1/models listing + gated-lane 200 carrying the
  // full fingerprint; chat-only, /v1/responses answers 400 ModelProtocolUnsupported).
  // Context measured, NOT published: the catalog entry for this exact free id
  // claims 200,000 and the gateway carries a marker planted mid-prompt far past
  // it — recall holds through prompt_tokens=1,030,800, and an oversized request
  // is refused with an empty-bodied 400 somewhere above ~1.05M. The published
  // 200k belongs to the paid deepseek-v4-flash-free, a different model.
  // Output 384,000 per https://models.dev/models/deepseek/deepseek-v4.1-flash/ and gateway probe
  "deepseek-v4.1-flash-free": { ctx: 1_000_000, max: 384_000, reasoning: true },
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
	"thinkingmachines/inkling-small:free": { ctx: 1_048_576, max: 262_144, reasoning: true },
	// Retired 2026-10-09 (demoted to paid upstream — :free IDs 404 keyless)
	// Added 2026-10-09 (live: Kilo free list isFree:true + keyless chat served; 256K/1M ctx)
	"stealth/glyph-cluster": { ctx: 256_000, max: 256_000, reasoning: true },
  // Cline direct-only (per-user pool — https://api.cline.bot)
  "cline-free/muse-spark-1.3-contributor": { ctx: 1_048_576, max: 131_072, reasoning: true },
  "z-ai/glm-5.3-flash": { ctx: 1_048_576, max: 131_072, reasoning: true },
  // OVHcloud AI Endpoints, keyless direct-only. Added 2026-10-13: live
  // /v1/models listing + keyless chat 200 + SSE with real tool_calls. max is
  // the conservative FLOOR across twin providers (per-provider caps for the
  // same model range 4K..256K); reasoning read off a populated `reasoning`
  // field on a non-tool answer.
  "ovh-free/gpt-oss-120b": { ctx: 131_072, max: 32_768, reasoning: true },
  "ovh-free/gpt-oss-20b": { ctx: 131_072, max: 32_768, reasoning: true },
  "ovh-free/Qwen3.5-397B-A17B": { ctx: 262_144, max: 65_536, reasoning: true },
  "ovh-free/Qwen3.5-9B": { ctx: 262_144, max: 65_536, reasoning: true },
  "ovh-free/Qwen3.6-27B": { ctx: 262_144, max: 65_536, reasoning: true },
  "ovh-free/Qwen3.8-27B": { ctx: 262_144, max: 32_768, reasoning: true },
  "ovh-free/Mistral-Small-3.2-24B-Instruct-2506": { ctx: 131_072, max: 16_384, reasoning: false },
  "ovh-free/Meta-Llama-3_3-70B-Instruct": { ctx: 131_072, max: 16_384, reasoning: false },
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

test("2026-10-15 Zen DeepSeek V4.1 Flash carries probe-measured specs", () => {
 // The published entry for this exact free id claims 200,000 context and
 // text-only input; live probes contradicted both. A static entry must
 // override the enrichment heuristic, which would guess 262K / text-only off
 // the substring rules ("deepseek" and "flash" both match).
 const ds = getModelDef("deepseek-v4.1-flash-free");
 assert.ok(ds);
 assert.equal(ds.reasoning, true);
 assert.equal(ds.contextWindow, 1_000_000);
 assert.equal(ds.maxTokens, 384_000);
 assert.deepEqual(ds.input, ["text", "image"]);
 // Chat-only upstream: a Responses request is refused, so no api override.
 assert.equal(ds.api, undefined);
 // Every effort level is accepted live, so none may be locked off.
 for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
  assert.equal(ds.thinkingLevelMap?.[level], level, `${level} must stay selectable`);
 }
 assert.equal(ds.thinkingLevelMap?.off, null);
 assert.equal(getModelUpstream("deepseek-v4.1-flash-free"), "opencode");
});

test("2026-10-16 issue #62: cat-jam exposes the live max effort; Nemotron 3.5 Super VL is a locked static entry", () => {
 // (a) cat-jam-free: the gateway accepts reasoning_effort "max" (200 with a
 // populated reasoning stream) and rejects minimal/none/bogus with a 400 that
 // enumerates max/xhigh/high/medium/low as the supported set. A null `max`
 // in the map hid a real, selectable level from the picker.
 const catJam = getModelDef("cat-jam-free");
 assert.ok(catJam);
 assert.equal(catJam.thinkingLevelMap?.max, "max", "max is accepted upstream and must be selectable");
 assert.equal(catJam.thinkingLevelMap?.xhigh, "xhigh");
 assert.equal(catJam.thinkingLevelMap?.minimal, null, "minimal 400s upstream and must stay hidden");

 // (b) nemotron-3.5-super-vl-free: on the live Zen free list but absent from
 // the static catalog, so the dynamic merge registered it through the
 // enrichModelDef heuristic — reasoning:false, no effort map, no picker levels.
 const superVl = getModelDef("nemotron-3.5-super-vl-free");
 assert.ok(superVl, "nemotron-3.5-super-vl-free must be a static catalog entry");
 assert.equal(superVl.reasoning, true);
 assert.deepEqual(superVl.input, ["text", "image"]);
 assert.deepEqual(superVl.thinkingLevelMap, {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null,
 });
 assert.equal(superVl.contextWindow, 1_000_000);
 assert.equal(superVl.maxTokens, 131_072);
 assert.equal(getModelUpstream("nemotron-3.5-super-vl-free"), "opencode");
 assert.equal(resolveCanonicalModelId("nemotron-3.5-super-vl"), "nemotron-3.5-super-vl-free");
 // Chat is the only native shape (/v1/responses answers 400 protocol error).
 assert.equal(superVl.api, undefined);
});

test("new alias map resolves to canonical kilo ids", () => {
 assert.equal(resolveCanonicalModelId("inkling-small"), "thinkingmachines/inkling-small:free");
	assert.equal(resolveCanonicalModelId("glyph-cluster"), "stealth/glyph-cluster");
	assert.equal(resolveCanonicalModelId("mimo-v2.6-flash"), "mimo-v2.6-flash-free");
	assert.equal(resolveCanonicalModelId("glm-5.3-flash"), "glm-5.3-flash-free");
	assert.equal(resolveCanonicalModelId("ll-alpha"), "ll-alpha-free");
});

test("union-alpha is pruned from the static catalog", () => {
 assert.equal(MODEL_MAP.get("union-alpha"), undefined, "union-alpha must not be in MODEL_MAP");
 assert.equal(ALL_MODELS.some((m) => m.id === "union-alpha"), false, "union-alpha must not be in ALL_MODELS");
});

test("ling-3.1-flash-free is pruned from the static catalog", () => {
	assert.equal(MODEL_MAP.get("ling-3.1-flash-free"), undefined, "ling-3.1-flash-free must not be in MODEL_MAP");
	assert.equal(ALL_MODELS.some((m) => m.id === "ling-3.1-flash-free"), false, "ling-3.1-flash-free must not be in ALL_MODELS");
});

test("step-5-preview-free and its Kilo lane are pruned from the static catalog", () => {
	for (const id of ["step-5-preview-free", "stepfun/step-5-preview-free"]) {
		assert.equal(MODEL_MAP.get(id), undefined, id + " must not be in MODEL_MAP");
		assert.equal(ALL_MODELS.some((m) => m.id === id), false, id + " must not be in ALL_MODELS");
	}
});

test("2026-10-13 OVH lane: every id routes to the ovh upstream, never Zen", () => {
 // Lane resolution is the load-bearing assertion: a miss here sends the
 // request into the Zen branch, where the free-tier fingerprint and the
 // relay pool would both be applied to a keyless OVH endpoint.
 for (const m of OVH_MODELS) {
  assert.equal(getModelUpstream(m.id), "ovh", `${m.id} must resolve to the ovh upstream`);
  assert.equal(isOvhModel(m.id), true, `${m.id} must be recognized as an OVH id`);
  assert.equal(isOvhModel(resolveCanonicalModelId(m.id)), true, `${m.id} must be recognized through alias resolution`);
  assert.equal(isKiloModel(m.id), false, `${m.id} must never resolve to Kilo`);
 }
 // A Zen/Kilo/Cline id must never leak into the OVH lane.
 assert.equal(isOvhModel("muse-spark-1.3-contributor-free"), false);
 assert.equal(isOvhModel("dots-studio/dots-3-note-preview:free"), false);
 assert.equal(isOvhModel("z-ai/glm-5.3-flash"), false);
 assert.equal(getModelUpstream("muse-spark-1.3-contributor-free"), "opencode");
});
test("2026-10-13 OVH aliases resolve to the ovh-free catalog ids", () => {
 const aliases: Record<string, string> = {
  "gpt-oss-120b": "ovh-free/gpt-oss-120b",
  "gpt-oss-20b": "ovh-free/gpt-oss-20b",
  "qwen3.5-397b": "ovh-free/Qwen3.5-397B-A17B",
  "qwen3.5-9b": "ovh-free/Qwen3.5-9B",
  "qwen3.6-27b": "ovh-free/Qwen3.6-27B",
  "qwen3.8-27b": "ovh-free/Qwen3.8-27B",
  "mistral-small-3.2": "ovh-free/Mistral-Small-3.2-24B-Instruct-2506",
  "llama-3.3-70b": "ovh-free/Meta-Llama-3_3-70B-Instruct",
 };
 for (const [alias, canonical] of Object.entries(aliases)) {
  assert.equal(resolveCanonicalModelId(alias), canonical, `${alias} alias`);
  assert.ok(getModelDef(alias), `${alias} must resolve to a model definition`);
  assert.equal(getModelUpstream(alias), "ovh", `${alias} must route to OVH`);
 }
});

test("2026-10-13 OVH ids resolve to the bare wire id, prefix stripped after canonicalisation", () => {
 // OVH rejects the namespaced id with 404 model_not_found (live 2026-10-13),
 // and the suffix is case-sensitive on the wire, so the strip must be
 // exact-prefix-only and must not lowercase anything.
 for (const m of OVH_MODELS) {
  assert.ok(m.id.startsWith(OVH_MODEL_PREFIX), `${m.id} must carry the lane prefix`);
  const upstream = ovhUpstreamModelId(m.id);
  assert.ok(upstream.length > 0, `${m.id} must yield a non-empty upstream id`);
  assert.equal(upstream, upstream.replace(OVH_MODEL_PREFIX, ""), `${m.id}: prefix removed exactly once`);
  assert.equal(upstream, upstream.trim(), `${m.id}: no whitespace around the upstream id`);
  assert.ok(!upstream.includes("/"), `${m.id}: the wire id must carry no path separator`);
 }
 assert.equal(ovhUpstreamModelId("ovh-free/Qwen3.5-397B-A17B"), "Qwen3.5-397B-A17B");
 assert.equal(ovhUpstreamModelId("ovh-free/Meta-Llama-3_3-70B-Instruct"), "Meta-Llama-3_3-70B-Instruct");
 // Regression: a short alias must resolve BEFORE the prefix comes off. The
 // rewrite used to run on the raw body value, so `llama-3.3-70b` reached OVH
 // unrecognised and answered 404 model_not_found, even though lane detection
 // had already routed it correctly.
 assert.equal(ovhUpstreamModelId("llama-3.3-70b"), "Meta-Llama-3_3-70B-Instruct");
 assert.equal(ovhUpstreamModelId("gpt-oss-120b"), "gpt-oss-120b");
 assert.equal(ovhUpstreamModelId("qwen3.5-397b"), "Qwen3.5-397B-A17B");
 assert.equal(ovhUpstreamModelId("mistral-small-3.2"), "Mistral-Small-3.2-24B-Instruct-2506");
 // Every catalog id and every alias must produce a bare, prefix-free id.
 for (const m of OVH_MODELS) {
  for (const candidate of [m.id, resolveCanonicalModelId(m.id)]) {
   assert.equal(ovhUpstreamModelId(candidate), ovhUpstreamModelId(m.id), `${candidate} must resolve to the same wire id`);
  }
 }
});
test("2026-10-13 OVH spec-drift guard: context windows change only with a deliberate edit", () => {
 // OVH publishes one advertised context per model; a silent change upstream
 // must fail here so the catalog is edited on purpose instead of drifting.
 const lockedCtx: Record<string, number> = {
  "ovh-free/gpt-oss-120b": 131_072,
  "ovh-free/gpt-oss-20b": 131_072,
  "ovh-free/Qwen3.5-397B-A17B": 262_144,
  "ovh-free/Qwen3.5-9B": 262_144,
  "ovh-free/Qwen3.6-27B": 262_144,
  "ovh-free/Qwen3.8-27B": 262_144,
  "ovh-free/Mistral-Small-3.2-24B-Instruct-2506": 131_072,
  "ovh-free/Meta-Llama-3_3-70B-Instruct": 131_072,
 };
 for (const [id, ctx] of Object.entries(lockedCtx)) {
  const m = getModelDef(id);
  assert.ok(m, `drift-guard model ${id} exists`);
  assert.equal(m!.contextWindow, ctx, `${id}: context window drifted — re-probe OVH and edit the catalog deliberately`);
  // A window that silently grew to the 1M tier would let the host build a
  // prompt OVH refuses; that is the failure mode this guard exists to stop.
  assert.ok(m!.contextWindow < 1_000_000, `${id}: no OVH model may claim the 1M tier`);
 }
 assert.equal(Object.keys(lockedCtx).length, OVH_MODELS.length, "every OVH model is drift-guarded");
});

test("2026-10-13 OVH reasoning models lock the two confirmed effort levels", () => {
 for (const m of OVH_MODELS) {
  if (!m.reasoning) {
   assert.equal(m.thinkingLevelMap, undefined, `${m.id} non-reasoning must declare no map`);
   continue;
  }
  const map = m.thinkingLevelMap!;
  assert.deepEqual(map, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null }, `${m.id} effort map`);
  // An omitted key leaves the level selectable in the host, so every level
  // must be present explicitly — minimal included.
  assert.ok("minimal" in map, `${m.id}: minimal must be an explicit null, not omitted`);
  assert.ok("medium" in map && "xhigh" in map && "max" in map, `${m.id}: unconfirmed levels must be explicit nulls`);
 }
});
