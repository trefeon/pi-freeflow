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
import { DEAD_MODEL_IDS } from "../src/catalog.ts";

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

test("no static model declares the responses api (the last one retired 2026-10-22)", () => {
 // The Zen muse-spark contributor ids went first (1.3 on 2026-10-17, 1.2 on
 // 2026-10-18), then Cline's Muse Spark 1.3 stopped resolving upstream on
 // 2026-10-22 (404 "Cline has no such model"). The static catalog is all
 // chat-completions now; the responses plumbing stays for stale caches and
 // future ids (translation is locked in tool-translation.test.ts, the stale
 // api repair in edges-catalog.test.ts).
 assert.equal(ALL_MODELS.filter((m) => m.api === "openai-responses").length, 0);
 assert.equal(getModelDef("cline-free/muse-spark-1.3-contributor"), undefined, "the retired Cline id must not resolve");
 const clineModel = getModelDef("cline/nemotron-3.5-super-vl");
 assert.ok(clineModel, "the surviving Cline model must resolve");
 assert.equal(clineModel?.api, undefined, "the surviving Cline model is chat completions");
 assert.equal(clineModel?.contextWindow, 1_000_000);
});

test("1M context window models are properly configured", () => {
 // Known 1M models must exist with a >= 1M window (spec lock), and every
 // model in the catalog advertising >= 1M must be in that known list
 // (drift guard — no unaccounted-for 1M models).
	const oneMillionModels = [
		"cline/nemotron-3.5-super-vl",
		"glm-5.3-flash-free",
		"mimo-v2.6-flash-free",
		"beam-free",
		"deepseek-v4.1-flash-free",
		"nemotron-3.5-lightning-free",
		"nemotron-3.5-super-vl-free",
		"nvidia/nemotron-3-ultra-550b-a55b:free",
		"nvidia/nemotron-3.5-lightning:free",
		"poolside/laguna-s-2.1:free",
		// Added 2026-10-22: twin pairs at the 1M tier. Both free MiniMax M3.1
		// Flash endpoints were retired on 2026-10-23, so its ids leave this
		// list entirely.
		"nvidia/nemotron-3.5-super-vl:free",
		"reflection/beam-free",
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
	assert.deepEqual(mimo.input, ["text"]);
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
		assert.equal(glm.contextWindow, 1_048_576);
		assert.equal(glm.maxTokens, 131_072);
		assert.deepEqual(glm.input, ["text", "image"]);
		assert.equal(glm.thinkingLevelMap?.minimal, null);
		assert.equal(glm.thinkingLevelMap?.medium, null);
		assert.equal(glm.thinkingLevelMap?.max, "max");
		assert.equal(getModelUpstream("glm-5.3-flash-free"), "opencode");
		assert.equal(getModelUpstream("glm-5.3-flash"), "opencode");
		const beam = getModelDef("beam-free");
		assert.ok(beam);
		assert.equal(beam.reasoning, true);
		assert.equal(beam.contextWindow, 1_048_576);
		assert.equal(beam.maxTokens, 131_072);
		assert.deepEqual(beam.input, ["text"]);
		assert.equal(beam.thinkingLevelMap?.minimal, null);
		assert.equal(beam.thinkingLevelMap?.low, "low");
		assert.equal(beam.thinkingLevelMap?.max, "max");
		assert.equal(getModelUpstream("beam-free"), "opencode");
		assert.equal(getModelUpstream("beam"), "opencode");
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
		"ll-alpha-free",
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
	assert.equal(resolveCanonicalModelId("ll-alpha"), "ll-alpha");
});

test("model aliases resolve correctly to canonical IDs", () => {
 // clean slash-free aliases (single form, no :free duplicates)
 assert.equal(resolveCanonicalModelId("dots-3-note-preview"), "dots-studio/dots-3-note-preview:free");
 assert.equal(resolveCanonicalModelId("north-mini-code"), "cohere/north-mini-code:free");
 assert.equal(resolveCanonicalModelId("nemotron-3.5-lightning"), "nvidia/nemotron-3.5-lightning:free");
 assert.equal(resolveCanonicalModelId("nemotron-3.5-lightning:free"), "nemotron-3.5-lightning:free");
 // space-bunny-free was deprecated upstream on 2026-10-20; its alias is gone too.
 assert.equal(resolveCanonicalModelId("space-bunny"), "space-bunny");
 // removed wrong cross-lab aliases must no longer resolve
 assert.equal(resolveCanonicalModelId("claude-sonnet-4.5-contributor-free"), "claude-sonnet-4.5-contributor-free");
 assert.equal(resolveCanonicalModelId("minimax-m2.1-free"), "minimax-m2.1-free");
 assert.equal(resolveCanonicalModelId("qwen3-coder-480b-free"), "qwen3-coder-480b-free");
 // Added 2026-10-22: "flint" stays on the Zen lane, the Kilo twin is
 // "flint-kilo"; "beam" and "nemotron-3.5-super-vl" stay on Zen while their
 // Kilo twins get their own names. Both free MiniMax M3.1 Flash endpoints
 // retired on 2026-10-23, so its short alias is gone — a removed alias must
 // fall through to the verbatim id, never to the surviving paid model.
 assert.equal(resolveCanonicalModelId("minimax-m3.1-flash"), "minimax-m3.1-flash");
 assert.equal(getModelDef("minimax-m3.1-flash"), undefined);
 assert.equal(MODEL_MAP.has("minimax-m3.1-flash"), false);
 assert.equal(resolveCanonicalModelId("flint"), "flint-40b-free");
 assert.equal(resolveCanonicalModelId("flint-kilo"), "recursive/flint-v1.0:free");
 assert.equal(resolveCanonicalModelId("beam-kilo"), "reflection/beam-free");
 assert.equal(resolveCanonicalModelId("xing4.0"), "xingchen-agi/xing4.0-29b-a4b:free");
 assert.equal(resolveCanonicalModelId("beam"), "beam-free");
 assert.equal(resolveCanonicalModelId("nemotron-3.5-super-vl"), "nemotron-3.5-super-vl-free");
 // removed :free duplicate aliases must not be needed (canonical passthrough)

 const dotsAlias = getModelDef("dots-3-note-preview");
 assert.ok(dotsAlias);
 assert.equal(isKiloModel("dots-3-note-preview"), true);
 assert.equal(getModelUpstream("dots-3-note-preview"), "kilo");

 const allRegistered = getAllRegisteredModels();
 assert.equal(allRegistered.length, ALL_MODELS.length);
});

test("2026-10-22 additions: five lane-verified entries and their twins", () => {
	const zenLane: Array<[string, number, number]> = [
		["flint-40b-free", 262_144, 65_536],
	];
	for (const [id, ctx, max] of zenLane) {
		const m = getModelDef(id);
		assert.ok(m, `${id} exists`);
		assert.equal(m!.contextWindow, ctx, `${id} context`);
		assert.equal(m!.maxTokens, max, `${id} max`);
		assert.equal(m!.reasoning, true, `${id} reasoning`);
		assert.equal(m!.api, undefined, `${id} stays chat-native (no api override)`);
		assert.equal(m!.thinkingFormat, undefined, `${id} stays on the flat Zen effort shape`);
		assert.equal(getModelUpstream(id), "opencode", `${id} must route to Zen`);
		const map = m!.thinkingLevelMap!;
		assert.equal(map.off, null, `${id}.off`);
		assert.equal(map.minimal, null, `${id}.minimal`);
		assert.equal(map.low, "low", `${id}.low`);
		assert.equal(map.xhigh, "xhigh", `${id}.xhigh`);
		assert.equal(map.max, "max", `${id}.max`);
	}
	assert.deepEqual(getModelDef("flint-40b-free")!.input, ["text"]);

	const kiloLane: Array<[string, number, number, string[]]> = [
		["nvidia/nemotron-3.5-super-vl:free", 1_000_000, 131_072, ["text", "image"]],
		["reflection/beam-free", 1_048_576, 131_072, ["text"]],
		["recursive/flint-v1.0:free", 262_144, 65_536, ["text"]],
		["xingchen-agi/xing4.0-29b-a4b:free", 262_144, 235_929, ["text"]],
	];
	for (const [id, ctx, max, input] of kiloLane) {
		const m = getModelDef(id);
		assert.ok(m, `${id} exists`);
		assert.equal(m!.contextWindow, ctx, `${id} context`);
		assert.equal(m!.maxTokens, max, `${id} max`);
		assert.equal(m!.reasoning, true, `${id} reasoning`);
		assert.deepEqual(m!.input, input, `${id} input`);
		assert.equal(m!.thinkingFormat, "openrouter", `${id} uses the nested reasoning shape`);
		assert.equal(m!.api, undefined, `${id} stays chat-native (no api override)`);
		assert.equal(getModelUpstream(id), "kilo", `${id} must route to Kilo`);
		assert.equal(isKiloModel(id), true, `${id} must be recognized as a Kilo id`);
	}

	// Twin pairs must stay on their own lanes: the Zen and Kilo twins are
	// distinct catalog ids and neither may shadow the other.
	assert.notEqual(
		resolveCanonicalModelId("flint"),
		resolveCanonicalModelId("flint-kilo"),
		"Zen and Kilo flint twins must not collapse",
	);
	assert.notEqual(
		resolveCanonicalModelId("beam"),
		resolveCanonicalModelId("beam-kilo"),
		"Zen and Kilo beam twins must not collapse",
	);
	assert.equal(getModelUpstream("flint"), "opencode");
	assert.equal(getModelUpstream("flint-kilo"), "kilo");
	assert.equal(getModelUpstream("beam"), "opencode");
	assert.equal(getModelUpstream("beam-kilo"), "kilo");
	// Both free MiniMax M3.1 Flash endpoints retired on 2026-10-23, so neither
	// the canonical ids nor the short alias may resolve any more.
	assert.equal(getModelDef("minimax-m3.1-flash"), undefined);
	assert.equal(getModelDef("minimax-m3.1-flash-free"), undefined);
	assert.equal(getModelDef("minimax/minimax-m3.1-flash:free"), undefined);
	assert.equal(MODEL_MAP.has("minimax-m3.1-flash"), false);
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
test("catalog spec lock: published/served ctx/max/reasoning per model", () => {
 // Values reconciled 2026-10-20 from published datasheets (models.dev, the live
 // Kilo and OpenRouter model listings, and the OMP committed catalog): a free
 // and a non-free variant of the same underlying model are treated as ONE
 // model, and each field takes the highest published spec across those twins
 // (context = highest, maxTokens = highest published output, reasoning = OR,
 // input = union of host-representable modalities). Known artifacts are
 // discarded: OpenRouter's shared 943717/943718 output ceiling and the lazy
 // `max == ctx` echo a provider returns when a model has no real output spec.
 // Lane-owned hard caps stay authoritative where the lane refuses above them:
 // OVH's advertised windows, the 1,000,000-token Nemotron 3 Ultra cap, and
 // Dots3-Note's 393,216 served provider window. Change only with a fresh
 // datasheet check or a new boundary/recall probe.
 const locked: Record<string, { ctx: number; max: number; reasoning: boolean }> = {
  // OpenCode Zen
  // Built-in catalog spec: 1,048,576 ctx / 131,072 output. The free lane's
  // runtime cap is ~348K; the catalog follows the model's highest spec.
  "mimo-v2.6-flash-free": { ctx: 1_048_576, max: 131_072, reasoning: true },
  // Datasheet: 235,929 is the highest published output below the 1M window;
  // the 262,144 entries repeat the context as an output cap.
  "nemotron-3.5-lightning-free": { ctx: 1_000_000, max: 235_929, reasoning: true },
  // Added 2026-10-16 (issue #62): live Zen /v1/models listing + chat 200 through
  // the fingerprint path. Reconciled 2026-10-20: 1,048,576 ctx (the models.dev
  // opencode twin and the NVIDIA family origin both publish it) and 235,929
  // output, the highest published ceiling across the twins.
  "nemotron-3.5-super-vl-free": { ctx: 1_048_576, max: 235_929, reasoning: true },
  "big-pickle": { ctx: 200_000, max: 32_000, reasoning: true },
	// Built-in catalog spec: 1,048,576 context. The free lane's runtime cap is
	// ~297K; the catalog follows the model's highest spec.
	"glm-5.3-flash-free": { ctx: 1_048_576, max: 131_072, reasoning: true },
	// Added 2026-10-17: Reflection AI's Beam 501B open-weight MoE model, limited-time
	// free model on Zen (/zen/v1/models: beam-free); boundary probe up to 900k words (~1.1M tokens).
	"beam-free": { ctx: 1_048_576, max: 131_072, reasoning: true },
  // Added 2026-10-15 (live: Zen /v1/models listing + gated-lane 200 carrying the
  // full fingerprint; chat-only, /v1/responses answers 400 ModelProtocolUnsupported).
  // Reconciled 2026-10-20: 1,048,576 ctx now matches the published twin AND the
  // probe — recall holds through prompt_tokens=1,030,800, and an oversized
  // request is refused with an empty-bodied 400 somewhere above ~1.05M. The
  // 200,000 figure this entry used to reject described a different, similarly
  // named paid id. Output 393,216, the live gateway boundary (384 * 1024) and
  // the highest twin figure; models.dev rounds it to 384,000.
  "deepseek-v4.1-flash-free": { ctx: 1_048_576, max: 393_216, reasoning: true },
  // Added 2026-10-22: the gateway refuses a 323,580-token input with
  // "longer than the model's context length (262144)" and recalls a needle at
  // prompt_tokens 129,736; 65,536 output is the published figure (70,000 is
  // also accepted, so acceptance is not a cap).
  "flint-40b-free": { ctx: 262_144, max: 65_536, reasoning: true },
  // KiloCode Gateway
  // Kilo publishes 512,000 ctx / 460,800 out, but the only provider behind
  // this free id (atlas-cloud) serves a 393,216-token total window. Re-probed
  // 2026-10-20: max_tokens 393,195 answers 200 with a 20-token prompt;
  // 460,800 answers 400. The declared budget keeps prompt headroom.
  "dots-studio/dots-3-note-preview:free": { ctx: 393_216, max: 262_144, reasoning: true },
  // Reconciled 2026-10-20: 262,144 ctx (256K was a rounded-down copy) / 65,536 out.
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": { ctx: 262_144, max: 65_536, reasoning: true },
  // Reconciled 2026-10-20: the gateway caps this id at 1,000,000 (a 1.11M-token
  // request is refused with "maximum context length is 1000000 tokens").
  "nvidia/nemotron-3-ultra-550b-a55b:free": { ctx: 1_000_000, max: 182_520, reasoning: true },
  "nvidia/nemotron-3.5-lightning:free": { ctx: 1_000_000, max: 235_929, reasoning: true },
  "cohere/north-mini-code:free": { ctx: 256_000, max: 64_000, reasoning: true },
  // Built-in catalog spec: 1,048,576 context. The free gateway's runtime cap
  // is 262,144; the catalog follows the model's highest spec.
  "poolside/laguna-s-2.1:free": { ctx: 1_048_576, max: 131_072, reasoning: true },
  "poolside/laguna-xs-2.1:free": { ctx: 262_144, max: 32_768, reasoning: true },
  // Reconciled 2026-10-20: 128,000 ctx per the published twin; output stays 32,768.
  "liquid/lfm-2.5-2.6b:free": { ctx: 128_000, max: 32_768, reasoning: true },
  "kilo-auto/free": { ctx: 256_000, max: 10_000, reasoning: true },
  "openrouter/free": { ctx: 200_000, max: 65_536, reasoning: true },
	// Retired 2026-10-09 (demoted to paid upstream — :free IDs 404 keyless)
	// Added 2026-10-09 (live: Kilo free list isFree:true + keyless chat served; 256K/1M ctx)
	"stealth/glyph-cluster": { ctx: 256_000, max: 256_000, reasoning: true },
	// Added 2026-10-22: the FREE row — Kilo free listing, gateway top_provider,
  // the Kilo model page, OpenRouter and models.dev all publish 1,000,000 /
  // 131,072. The 262,144 / 235,929 pair is the PAID row behind another id.
  "nvidia/nemotron-3.5-super-vl:free": { ctx: 1_000_000, max: 131_072, reasoning: true },
  // Added 2026-10-22: Kilo twin of Zen `beam-free`; gateway, models.dev
  // (kilo/vercel/opencode rows) and the vendor docs all agree.
  "reflection/beam-free": { ctx: 1_048_576, max: 131_072, reasoning: true },
  // Added 2026-10-22: same weights as Zen `flint-40b-free`, which publishes
  // 65,536 output. Prompt and output share the 262,144 window per the vendor
  // card; the gateway's 235,929 is its 0.9x-window convention.
  "recursive/flint-v1.0:free": { ctx: 262_144, max: 65_536, reasoning: true },
  // Added 2026-10-22: lane-published gateway top_provider 262,144 / 235,929.
  // No cross-lane twin exists; both figures carry the same 0.9x-window
  // convention (prompt and output share the window).
  "xingchen-agi/xing4.0-29b-a4b:free": { ctx: 262_144, max: 235_929, reasoning: true },
  // Cline direct-only (per-user pool — https://api.cline.bot)
  "cline/nemotron-3.5-super-vl": { ctx: 1_000_000, max: 131_072, reasoning: true },
  // OVHcloud AI Endpoints, keyless direct-only. Contexts are OVH's own
  // advertised windows (the lane hard-caps there); max is the highest
  // published output below the window. OVH's max_completion_tokens echoes the
  // context, so that echo is discarded: 235,929 for the 397B and 3.8, 65,536
  // for the 9B, 3.6 and both gpt-oss models, 32,768 for Mistral and Llama.
  // reasoning comes from the lane's own rows (models.dev ovhcloud).
  "ovh-free/gpt-oss-120b": { ctx: 131_072, max: 65_536, reasoning: true },
  "ovh-free/gpt-oss-20b": { ctx: 131_072, max: 65_536, reasoning: true },
  "ovh-free/Qwen3.5-397B-A17B": { ctx: 262_144, max: 235_929, reasoning: true },
  "ovh-free/Qwen3.5-9B": { ctx: 262_144, max: 65_536, reasoning: true },
  "ovh-free/Qwen3.6-27B": { ctx: 262_144, max: 65_536, reasoning: true },
  "ovh-free/Qwen3.8-27B": { ctx: 262_144, max: 235_929, reasoning: true },
  "ovh-free/Mistral-Small-3.2-24B-Instruct-2506": { ctx: 131_072, max: 32_768, reasoning: false },
  "ovh-free/Meta-Llama-3_3-70B-Instruct": { ctx: 131_072, max: 32_768, reasoning: false },
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
 // The stale published entry for this free id claimed 200,000 context and
 // text-only input; live probes contradicted both. A static entry must
 // override the enrichment heuristic, which would guess 262K / text-only off
 // the substring rules ("deepseek" and "flash" both match). Reconciled
 // 2026-10-20 to the twin spec: 1,048,576 ctx (which the probe confirms) and
 // 393,216 output — the gateway's own boundary, 384 * 1024.
 const ds = getModelDef("deepseek-v4.1-flash-free");
 assert.ok(ds);
 assert.equal(ds.reasoning, true);
 assert.equal(ds.contextWindow, 1_048_576);
 assert.equal(ds.maxTokens, 393_216);
 assert.deepEqual(ds.input, ["text", "image"]);
 // Chat-only upstream: a Responses request is refused, so no api override.
 assert.equal(ds.api, undefined);
 // Both datasheets publish exactly low/high/max; the unlisted rungs stay null
 // so the host cannot offer an effort the vendor does not declare.
 for (const level of ["low", "high", "max"] as const) {
  assert.equal(ds.thinkingLevelMap?.[level], level, `${level} must stay selectable`);
 }
 for (const level of ["minimal", "medium", "xhigh"] as const) {
  assert.equal(ds.thinkingLevelMap?.[level], null, `${level} must stay locked off`);
 }
 assert.equal(ds.thinkingLevelMap?.off, null);
 assert.equal(getModelUpstream("deepseek-v4.1-flash-free"), "opencode");
});

test("2026-10-16 issue #62: Nemotron 3.5 Super VL is a locked static entry", () => {
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
 assert.equal(superVl.contextWindow, 1_048_576);
 assert.equal(superVl.maxTokens, 235_929);
 assert.equal(getModelUpstream("nemotron-3.5-super-vl-free"), "opencode");
 assert.equal(resolveCanonicalModelId("nemotron-3.5-super-vl"), "nemotron-3.5-super-vl-free");
 // Chat is the only native shape (/v1/responses answers 400 protocol error).
 assert.equal(superVl.api, undefined);
});

test("new alias map resolves to canonical kilo ids", () => {
 // inkling-small was retired with its model (2026-10-21): the alias is gone too.
 assert.equal(resolveCanonicalModelId("inkling-small"), "inkling-small");
	assert.equal(resolveCanonicalModelId("glyph-cluster"), "stealth/glyph-cluster");
	assert.equal(resolveCanonicalModelId("mimo-v2.6-flash"), "mimo-v2.6-flash-free");
	assert.equal(resolveCanonicalModelId("glm-5.3-flash"), "glm-5.3-flash-free");
	assert.equal(resolveCanonicalModelId("beam"), "beam-free");
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

test("ll-alpha-free is pruned from the static catalog", () => {
	assert.equal(MODEL_MAP.get("ll-alpha-free"), undefined, "ll-alpha-free must not be in MODEL_MAP");
	assert.equal(ALL_MODELS.some((m) => m.id === "ll-alpha-free"), false, "ll-alpha-free must not be in ALL_MODELS");
});

test("muse-spark-1.3-contributor-free is pruned from the static catalog", () => {
	assert.equal(MODEL_MAP.get("muse-spark-1.3-contributor-free"), undefined, "muse-spark-1.3-contributor-free must not be in MODEL_MAP");
	assert.equal(ALL_MODELS.some((m) => m.id === "muse-spark-1.3-contributor-free"), false, "muse-spark-1.3-contributor-free must not be in ALL_MODELS");
});

test("muse-spark-1.2-contributor-free is retired and cannot re-enter the catalog", () => {
	assert.equal(MODEL_MAP.get("muse-spark-1.2-contributor-free"), undefined, "muse-spark-1.2-contributor-free must not be in MODEL_MAP");
	assert.equal(ALL_MODELS.some((m) => m.id === "muse-spark-1.2-contributor-free"), false, "muse-spark-1.2-contributor-free must not be in ALL_MODELS");
	assert.ok(DEAD_MODEL_IDS.has("muse-spark-1.2-contributor-free"), "the retired id must be dead-listed so stale caches and upstream merges cannot revive it");
});

test("both free MiniMax M3.1 Flash endpoints are retired and cannot re-enter the catalog (2026-10-23)", () => {
	// Zen retired its free endpoint on 2026-10-23 (410 model-level
	// deprecation, pointing at deepseek-v4.1-flash-free); the KiloCode free
	// endpoint of the same weights died the same day (404 model_not_found, and
	// the gateway listing keeps only the paid id).
	for (const id of ["minimax-m3.1-flash-free", "minimax/minimax-m3.1-flash:free"]) {
		assert.equal(MODEL_MAP.get(id), undefined, id + " must not be in MODEL_MAP");
		assert.equal(ALL_MODELS.some((m) => m.id === id), false, id + " must not be in ALL_MODELS");
		assert.ok(DEAD_MODEL_IDS.has(id), id + " must be dead-listed so stale caches and upstream merges cannot revive it");
	}
	assert.equal(MODEL_MAP.has("minimax-m3.1-flash"), false, "the removed short alias must not resolve");
});

test("cline-free/muse-spark-1.3-contributor is retired and cannot re-enter the catalog", () => {
	assert.equal(MODEL_MAP.get("cline-free/muse-spark-1.3-contributor"), undefined, "the retired Cline id must not be in MODEL_MAP");
	assert.equal(ALL_MODELS.some((m) => m.id === "cline-free/muse-spark-1.3-contributor"), false, "the retired Cline id must not be in ALL_MODELS");
	assert.ok(DEAD_MODEL_IDS.has("cline-free/muse-spark-1.3-contributor"), "the retired id must be dead-listed so stale caches and upstream merges cannot revive it");
});

test("cat-jam-free is retired and cannot re-enter the catalog (2026-10-24)", () => {
	assert.equal(MODEL_MAP.get("cat-jam-free"), undefined, "cat-jam-free must not be in MODEL_MAP");
	assert.equal(ALL_MODELS.some((m) => m.id === "cat-jam-free"), false, "cat-jam-free must not be in ALL_MODELS");
	assert.ok(DEAD_MODEL_IDS.has("cat-jam-free"), "cat-jam-free must be dead-listed so stale caches and upstream merges cannot revive it");
});

test("z-ai/glm-5.3-flash is retired from the free catalog (2026-10-24)", () => {
	assert.equal(MODEL_MAP.get("z-ai/glm-5.3-flash"), undefined, "z-ai/glm-5.3-flash must not be in MODEL_MAP");
	assert.equal(ALL_MODELS.some((m) => m.id === "z-ai/glm-5.3-flash"), false, "z-ai/glm-5.3-flash must not be in ALL_MODELS");
	assert.ok(DEAD_MODEL_IDS.has("z-ai/glm-5.3-flash"), "z-ai/glm-5.3-flash must be dead-listed");
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
 assert.equal(isOvhModel("deepseek-v4.1-flash-free"), false);
 assert.equal(isOvhModel("dots-studio/dots-3-note-preview:free"), false);
 assert.equal(isOvhModel("z-ai/glm-5.3-flash"), false);
 assert.equal(getModelUpstream("deepseek-v4.1-flash-free"), "opencode");
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

test("2026-10-13 OVH reasoning models lock the confirmed effort ladders", () => {
	const base = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	const qwen = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	for (const m of OVH_MODELS) {
		if (!m.reasoning) {
			assert.equal(m.thinkingLevelMap, undefined, `${m.id} non-reasoning must declare no map`);
			continue;
		}
		// The 3.6/3.8 Qwens publish one extra rung (minimal); the 3.5 pairs and
		// both gpt-oss models start at low. No lane model offers xhigh or max.
		const expected = m.id.includes("Qwen3.6") || m.id.includes("Qwen3.8") ? qwen : base;
		assert.deepEqual(m.thinkingLevelMap, expected, `${m.id} effort map`);
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			assert.ok(level in m.thinkingLevelMap!, `${m.id}: ${level} must be explicit`);
		}
	}
});
