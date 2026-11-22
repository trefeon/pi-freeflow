/**
 * Dynamic catalog discovery, caching, and model enrichment for pi-freeflow
 *
 * Provides 24-hour atomic disk caching with safe offline fallback to verified static definitions.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import {
 CATALOG_CACHE_FILE,
 CATALOG_CACHE_LOCK_FILE,
 CATALOG_CACHE_TTL_MS,
 CATALOG_REFRESH_TIMEOUT_MS,
 KILO_CATALOG_URL,
 OPENCODE_API_URL,
 opencodeHeaders,
} from "./config.ts";
import { logDebug, logWarn } from "./logger.ts";
import {
 ALL_MODELS,
 MODEL_MAP,
 getModelUpstream,
 resolveCanonicalModelId,
} from "./models.ts";
import type {
 CatalogCacheData,
 CatalogRefreshStatus,
 CatalogSourceCacheData,
 CatalogSourceRefreshStatus,
 DynamicCatalogSource,
 RawModelItem,
 RegisteredModel,
 Upstream,
} from "./types.ts";

/**
 * Pruned model IDs that must never re-enter the catalog via disk cache or upstream merge.
 * - jev-1.13-free: non-chat decision model, chat-incompatible — never registered.
 *   Re-confirmed 2026-10-09: 400 through the plugin while every catalog model 200s.
 * - deepseek-v4-flash-free: listed but unserved upstream (live chat 400 "Model is unavailable").
 * - nex-agi/nex-n2.5-pro:free + nex-agi/nex-n2.5-mini:free: gone 2026-09-28 — zero nex-agi
 *   IDs on the live Kilo list, keyless chat 404 "does not exist".
 * - z-ai/glm-5.2:free: gone 2026-09-28 — :free ID absent (keyless 404); only the paid
 *   z-ai/glm-5.2 remains (isFree:false, keyless 401 PAID_MODEL_AUTH_REQUIRED).
 * - inclusionai/ling-3.0-flash-vl:free: gone from the live Kilo free list — only the paid counterpart remains.
 * - ling-3.0-flash-fin-free: unserved upstream (2026-10-01) — persistent keyless 400
 *   "Error from provider (Console): Upstream request failed: Endpoint is unavailable.",
 *   reproduced across separate runs on different days while every other Zen model answers.
 * - inclusionai/ling-3.0-flash-fin:free: gone from Kilo (2026-10-01) — keyless chat 404
 *   "The requested model ... does not exist".
 * - mimo-v2.5-free: decommissioned upstream (2026-10-07) — HTTP 401 "Model mimo-v2.5-free is not supported".
 *   Re-probed 2026-10-16: 410 "Model mimo-v2.5-free has been deprecated. Use
 *   mimo-v2.6-flash-free instead." The docs still list it as free; they are stale.
 * - exo-free: dead-listed 2026-10-09 (410 "Model exo-free has been deprecated"),
 *   revived upstream on 2026-10-16, and dead again on 2026-10-22: the endpoint
 *   answers 410 "Model exo-free has been deprecated" on every path through the
 *   relay pool and the id is absent from the live Zen listing. Permanently
 *   dead-listed so no disk cache or upstream merge can put it back.
 * - fledge-alpha-free: withdrawn upstream (2026-10-09) — absent from the live
 *   Zen list, chat 401 "Model fledge-alpha-free is not supported".
 * - inclusionai/ling-3.0-flash-sante:free: demoted to paid on Kilo (2026-10-09) —
 *   :free ID gone from the live list, keyless chat 404 "does not exist";
 *   only the paid counterpart remains.
 * - stepfun/step-3.7-flash:free: demoted to paid on Kilo (2026-10-09) — same
 *   shape: :free ID gone, keyless 404; paid ID remains.
 * - meituan/longcat-2.0-free: demoted to paid on Kilo (2026-10-09) —
 *   `meituan/longcat-2.0` remains live with isFree:false; keyless chat
 *   answers 401 PAID_MODEL_AUTH_REQUIRED.
 * - stealth/space-bunny-alpha: gone from Kilo (2026-10-07) — keyless chat 404 "The requested model ... does not exist".
 * - qwen/qwen3.8-27b:free: gone from Kilo (2026-10-07) — keyless chat 404 "The requested model is currently unavailable.".
 * - nvidia/nemotron-3.5-content-safety:free: tool-less guardrail model (2026-10-08),
 *   NOT decommissioned — it answers 200 keyless chat with no tools, but every
 *   tool-bearing request 404s "No endpoints found that support tool use" (Kilo
 *   `supported_parameters` lists reasoning only, no tools). It is a 4B
 *   moderation classifier fine-tuned from Gemma-3-4B that "moderates inputs to
 *   and responses from LLMs", not a chat model. Same exclusion class as
 *   jev-1.13-free: live, wrong shape for an agentic harness, so it must never
 *   re-enter the picker via disk cache or upstream merge.
 * - cline-free/deepseek-v4.1-flash, cline-free/kimi-k3, cline-free/solar-pro4:
 *   retired upstream (2026-10-13) — probed live twice each against the real
 *   Cline pool, every attempt answered HTTP 404 `{"error":"model not found",
 *   "success":false,"hint":"Cline has no such model. Refresh the model list and
 *   retry."}`, while the sibling `z-ai/glm-5.3-flash` (and, until its own
 *   retirement below, `cline-free/muse-spark-1.3-contributor`) answered 200
 *   with the same account and request shape. The lane is healthy; these three
 *   ids are gone, so they must never re-enter the picker from disk cache or an
 *   upstream merge.
 */
export const DEAD_MODEL_IDS = new Set<string>([
 "jev-1.13-free",
 "deepseek-v4-flash-free",
 "x-preview-f-free",
 "hy3-free",
 "tencent/hy3:free",
 "meituan/longcat-2.0-free",
 "laguna-s-2.1-free",
 "minimax/minimax-m2.7:free",
 "minimax/minimax-m3:free",
 "thinkingmachines/inkling:free",
 "union-alpha",
 "nex-agi/nex-n2.5-pro:free",
 "nex-agi/nex-n2.5-mini:free",
 "z-ai/glm-5.2:free",
 "inclusionai/ling-3.0-flash-vl:free",
 "ling-3.0-flash-fin-free",
 "inclusionai/ling-3.0-flash-fin:free",
 "mimo-v2.5-free",
 "stealth/space-bunny-alpha",
 // space-bunny-free: deprecated on the Zen free tier (2026-10-20) — the
 // endpoint answers 410 ModelDeprecated and points at minimax-m3.1-flash-free,
 // which was itself retired on 2026-10-23 (see below).
 "space-bunny-free",
 "qwen/qwen3.8-27b:free",
 "nvidia/nemotron-3.5-content-safety:free",
 "fledge-alpha-free",
 "inclusionai/ling-3.0-flash-sante:free",
 "stepfun/step-3.7-flash:free",
 "cline-free/deepseek-v4.1-flash",
 "cline-free/kimi-k3",
 "cline-free/solar-pro4",
 // ling-3.1-flash-free: removed from upstream free docs (2026-10-15).
 "ling-3.1-flash-free",
 // inclusionai/ling-3.1-flash: demoted to paid on Kilo (2026-10-15) — answers 401 PAID_MODEL_AUTH_REQUIRED.
 "inclusionai/ling-3.1-flash",
 // ovh-free/Mistral-7B-Instruct-v0.3: removed upstream by OVH (2026-10-15) — answers 404 no route matched.
 "ovh-free/Mistral-7B-Instruct-v0.3",
 // step-5-preview-free: removed from the Zen free docs (2026-10-16 drift,
 // v1.19.2) and the endpoint answers 400 "Model is unavailable" on both the
 // chat and the responses shape — the same retirement signature as
 // deepseek-v4-flash-free.
 "step-5-preview-free",
 // stepfun/step-5-preview-free: demoted to paid on Kilo (2026-10-16) —
 // answers 401 PAID_MODEL_AUTH_REQUIRED while the sibling z-ai/glm-5.3-flash
 // answers 200 keyless with the same request shape.
 "stepfun/step-5-preview-free",
 // ll-alpha-free: decommissioned upstream (2026-10-17) — gone from live
 // Zen /v1/models list, answers HTTP 410 "Model ll-alpha-free has been deprecated".
 "ll-alpha-free",
 // muse-spark-1.3-contributor-free: decommissioned upstream (2026-10-17) — gone from
 // live Zen /v1/models list, answers HTTP 410 "Model muse-spark-1.3-contributor-free has been deprecated".
 "muse-spark-1.3-contributor-free",
 // muse-spark-1.2-contributor-free: decommissioned upstream (2026-10-18) — answers
 // HTTP 410 "Model muse-spark-1.2-contributor-free has been deprecated" while the
 // same request shape on the surviving Zen models answers 200. Retired from the
 // static catalog the same day.
 "muse-spark-1.2-contributor-free",
 // cline-free/muse-spark-1.3-contributor: gone from Cline's model inventory
 // (2026-10-22) — three live probes through the real pool, spaced over ~10
 // minutes, each answered HTTP 404 `{"error":"model not found",
 // "success":false,"hint":"Cline has no such model. Refresh the model list and
 // retry."}`, while `z-ai/glm-5.3-flash` resolved on the same account (its 402
 // insufficient_credits is raised after model resolution). The id was the last
 // entry declaring `api: "openai-responses"`; it stays retired so a stale disk
 // cache cannot put it back in the picker.
 "cline-free/muse-spark-1.3-contributor",
 // nvidia/nemotron-3-super-120b-a12b:free: dead route (2026-10-21) — Kilo answers
 // 404 "Function '<uuid>': Not found for account ..." from its Nvidia provider on
 // every attempt, from two independent egress IPs, while sibling Nvidia ids answer
 // 200 with the same request shape.
 "nvidia/nemotron-3-super-120b-a12b:free",
 // thinkingmachines/inkling-small:free: gone upstream (2026-10-21) — Kilo answers
 // HTTP 404 "The requested model is currently unavailable" (unavailable_model) on
 // every attempt, from two independent egress IPs; it is no longer served.
 "thinkingmachines/inkling-small:free",
 // exo-free: re-deprecated upstream (2026-10-22) — 410 ModelDeprecated on every
 // path and gone from the live Zen listing, four days after it was re-registered
 // from a 2026-10-16 revival. Permanently dead-listed.
 "exo-free",
 // minimax-m3.1-flash-free: the Zen free endpoint of MiniMax M3.1 Flash was
 // retired on 2026-10-23 — it answers HTTP 410 with a model-level deprecation
 // and points at deepseek-v4.1-flash-free. The KiloCode free twin of the same
 // weights died the same day (see below), so both free endpoints are gone.
 "minimax-m3.1-flash-free",
 // minimax/minimax-m3.1-flash:free: the KiloCode free endpoint was retired on
 // 2026-10-23 too — a direct gateway request answers HTTP 404 "The requested
 // model 'minimax/minimax-m3.1-flash:free' does not exist" (model_not_found)
 // on every attempt, and the live /api/gateway/models listing carries only the
 // PAID minimax/minimax-m3.1-flash. No short alias exists for it: a short name
 // must never route to a paid model.
 "minimax/minimax-m3.1-flash:free",
 // cat-jam-free: retired upstream (2026-10-24) — every request path
 // (chat non-stream, chat stream, and responses) through the relay pool answers
 // persistent HTTP 404 "Upstream request failed: Endpoint is unavailable." across
 // multiple independent runs, while sibling OpenCode models (deepseek, mimo,
 // nemotron) answer 200 on the same request shapes.
 "cat-jam-free",
 // z-ai/glm-5.3-flash: retired from the Cline free catalog (2026-10-24) — paid
 // model that drains account credits and answers HTTP 402 insufficient_credits.
 // Replaced with Cline's verified working free tier model.
 "z-ai/glm-5.3-flash",
 // longcat-2.5-preview-free: deprecated upstream (2026-10-26, issue #121) —
 // the endpoint answers HTTP 410 "Model longcat-2.5-preview-free has been
 // deprecated", and the id is absent from the live Zen free listing (watch
 // state 2026-10-24). Permanently dead-listed so no disk cache or upstream
 // merge can put it back.
 "longcat-2.5-preview-free",
 // nemotron-3-ultra-free: retired upstream (2026-10-26, issue #121) — the
 // endpoint answers HTTP 400 "Model is unavailable", and the id is absent
 // from the live Zen free listing (watch state 2026-10-24 lastChecked), the
 // same removal-plus-unavailable signature as step-5-preview-free. The
 // sibling Kilo id nvidia/nemotron-3-ultra-550b-a55b:free is a separate
 // serving route and is unaffected.
 "nemotron-3-ultra-free",
 // poolside/laguna-s-2.1:free and poolside/laguna-xs-2.1:free: discontinued
 // upstream on KiloCode (2026-11-09) — removed from live /api/gateway/models,
 // answers HTTP 404 "The requested model does not exist" across all egresses.
 "poolside/laguna-s-2.1:free",
 "poolside/laguna-xs-2.1:free",
 // liquid/lfm-2.5-2.6b:free: replaced upstream on KiloCode by liquid/lfm-3-1.7b:free
 // (2026-11-09) — answers HTTP 404 "The requested model is currently unavailable".
 "liquid/lfm-2.5-2.6b:free",
 // reflection/beam-free: discontinued upstream on KiloCode (2026-11-09) —
 // answers HTTP 404 "The requested model does not exist". The Zen beam-free
 // twin is a separate serving route and remains active.
 "reflection/beam-free",
 // recursive/flint-v1.0:free: discontinued upstream on KiloCode (2026-11-09) —
 // answers HTTP 404 "The requested model is currently unavailable". The Zen
 // flint-40b-free twin is a separate serving route and remains active.
 "recursive/flint-v1.0:free",
 // xingchen-agi/xing4.0-29b-a4b:free: discontinued upstream on KiloCode (2026-11-09) —
 // answers HTTP 404 "The requested model is currently unavailable".
 "xingchen-agi/xing4.0-29b-a4b:free",
 // crouton-alpha-free: deprecated upstream on OpenCode Zen (2026-11-10, issue #130) —
 // removed from live /inference/v1/models and answers HTTP 410 ModelDeprecated.
 "crouton-alpha-free",
 // glm-5.3-flash-free: retired upstream on OpenCode Zen (2026-11-22, issue #138) —
 // removed from live /inference/v1/models and answers HTTP 400 Model is unavailable.
 "glm-5.3-flash-free",
 // inkling-2-small-free: deprecated upstream on OpenCode Zen (2026-11-22, issue #138) —
 // removed from live /inference/v1/models and answers HTTP 410 ModelDeprecated.
 "inkling-2-small-free",
]);
/**
 * Free-tier allowlist for Zen network rows and legacy cache entries. Kilo live
 * admission deliberately does not use this suffix heuristic; parseKiloCatalogResponse
 * validates the authoritative pricing and capability metadata instead.
 */
export function isFreeCatalogId(id: string): boolean {
 if (typeof id !== "string" || id.length === 0) return false;
 if (DEAD_MODEL_IDS.has(id)) return false;
 return id.includes("-free") || id.includes(":free") || id.includes("/free") || MODEL_MAP.has(id);
}

function staticCatalog(): RegisteredModel[] {
 return ALL_MODELS.map((m) => ({ ...m, source: getModelUpstream(m.id) }));
}

function isUsableRegisteredModel(model: unknown): model is RegisteredModel {
 if (model === null || typeof model !== "object" || Array.isArray(model)) return false;
 const row = model as Record<string, unknown>;
 return typeof row.id === "string" && row.id.length > 0 &&
  typeof row.name === "string" && row.name.length > 0 &&
  typeof row.contextWindow === "number" && Number.isFinite(row.contextWindow) && row.contextWindow > 0 &&
  typeof row.maxTokens === "number" && Number.isFinite(row.maxTokens) && row.maxTokens > 0;
}

/**
 * Purge paid/dead entries from a generic catalog list and repair known models
 * against reviewed static definitions. Versioned Kilo snapshots use their own
 * stricter network-boundary validation and are merged separately.
 */
export function sanitizeCatalogModels(models: RegisteredModel[]): RegisteredModel[] {
 const out: RegisteredModel[] = [];
 for (const model of models) {
  if (!isUsableRegisteredModel(model) || !isFreeCatalogId(model.id)) continue;
  const known = MODEL_MAP.get(model.id);
  out.push(known ? { ...known, source: getModelUpstream(model.id) } : model);
 }
 return out;
}

function sanitizeSourceSnapshot(
 models: RegisteredModel[],
 source: DynamicCatalogSource,
 legacy: boolean,
): RegisteredModel[] {
 const out: RegisteredModel[] = [];
 const seen = new Set<string>();
 for (const model of models) {
  if (!isUsableRegisteredModel(model) || DEAD_MODEL_IDS.has(model.id) || seen.has(model.id)) continue;
  if (resolveCanonicalModelId(model.id) !== model.id) continue;
  const known = MODEL_MAP.get(model.id);
  if (known) {
   if (getModelUpstream(model.id) !== source) continue;
   out.push({ ...known, source });
  } else {
   if (source === "opencode" && !isFreeCatalogId(model.id)) continue;
   if (source === "kilo" && legacy && !isFreeCatalogId(model.id)) continue;
   out.push({ ...model, source });
  }
  seen.add(model.id);
 }
 return out;
}

function mergeSourceSnapshots(
 opencode: RegisteredModel[],
 kilo: RegisteredModel[],
): RegisteredModel[] {
 const base = staticCatalog();
 const knownIds = new Set(base.map((m) => m.id));
 const zenIds = new Set(opencode.map((m) => m.id));
 const kiloIds = new Set(kilo.map((m) => m.id));
 const collisions = new Set(
  [...zenIds].filter((id) => !knownIds.has(id) && kiloIds.has(id)),
 );
 for (const id of collisions) {
  logWarn("Catalog rejected an unknown id claimed by both Zen and Kilo", { model: id });
 }
 const byId = new Map(base.map((m) => [m.id, m]));
 for (const model of [...opencode, ...kilo]) {
  if (!knownIds.has(model.id) && !collisions.has(model.id)) byId.set(model.id, model);
 }
 return [...byId.values()].filter((m) => !DEAD_MODEL_IDS.has(m.id));
}

/**
 * Overlay a refreshed model list onto a base list without dropping base entries.
 * Reviewed static definitions remain authoritative for known IDs; unknown free
 * entries are appended after the base.
 */
export function mergeCatalog(
 base: RegisteredModel[],
 fresh: RegisteredModel[],
): RegisteredModel[] {
 const byId = new Map(base.map((m) => [m.id, m]));
 for (const model of sanitizeCatalogModels(fresh)) byId.set(model.id, model);
 return sanitizeCatalogModels([...byId.values()]);
}

let aliveCatalog: RegisteredModel[] = staticCatalog();
let activeSourceById = new Map(aliveCatalog.map((m) => [m.id, m.source]));
let lastCatalogCacheMtimeMs = -1;

/** Return the current in-memory active catalog. */
export function getAliveCatalog(): RegisteredModel[] {
 return aliveCatalog;
}

/** Replace the active catalog and rebuild its runtime ID-to-source routing map. */
export function setAliveCatalog(catalog: RegisteredModel[]): void {
 aliveCatalog = catalog;
 activeSourceById = new Map(catalog.map((m) => [m.id, m.source]));
}

/**
 * Resolve a requested model against active catalog provenance. Static aliases
 * are canonicalized first; only IDs absent from the active map fall back to the
 * reviewed static routing table.
 */
export function getActiveModelUpstream(id: string): Upstream {
 const clean = typeof id === "string" ? id.trim() : "";
 const canonical = resolveCanonicalModelId(clean);
 return activeSourceById.get(canonical) ?? getModelUpstream(canonical);
}

/**
 * Resolve a request to an active canonical ID. Dynamic IDs must match exactly;
 * only reviewed static aliases may rewrite to a different wire ID.
 */
export function resolveActiveModelId(id: string): string | null {
 const clean = typeof id === "string" ? id.trim() : "";
 if (!clean) return null;
 if (activeSourceById.has(clean)) return clean;
 const canonical = resolveCanonicalModelId(clean);
 return canonical !== clean && MODEL_MAP.has(canonical) && activeSourceById.has(canonical) ? canonical : null;
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
function validPosNum(n: unknown): number | undefined {
 return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Inherit higher published context/output limits from a non-free twin in the
 * same Zen `/models` payload when the `-free` row omits or caps them.
 */
function resolveTwinLimits(
 raw: RawModelItem,
 twinCatalog?: readonly unknown[],
): { contextWindow?: number; maxTokens?: number } {
 if (!Array.isArray(twinCatalog) || twinCatalog.length === 0) return {};
 const selfId = raw.id;
 const baseId = selfId.replace(/-free$/i, "");
 const selfFamily = typeof raw.family === "string" ? raw.family.replace(/-free$/i, "") : "";
 let bestContext: number | undefined;
 let bestOutput: number | undefined;
 for (const item of twinCatalog) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
  const row = item as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === selfId || /-free$/i.test(row.id)) continue;
  const rowFamily = typeof row.family === "string" ? row.family.replace(/-free$/i, "") : "";
  const idMatch = baseId !== selfId && row.id === baseId;
  const familyMatch = selfFamily.length > 0 && rowFamily === selfFamily;
  if (!idMatch && !familyMatch) continue;
  const limit = row.limit !== null && typeof row.limit === "object" && !Array.isArray(row.limit)
   ? row.limit as Record<string, unknown>
   : null;
  const ctx = validPosNum(limit?.context) ?? validPosNum(row.contextWindow) ?? validPosNum(row.context_length);
  const out = validPosNum(limit?.output) ?? validPosNum(row.maxTokens) ?? validPosNum(row.max_output_tokens) ?? validPosNum(row.max_tokens);
  if (ctx !== undefined && (bestContext === undefined || ctx > bestContext || (ctx === bestContext && (out ?? 0) > (bestOutput ?? 0)))) {
   bestContext = ctx;
   bestOutput = out;
  } else if (out !== undefined && bestOutput === undefined) {
   bestOutput = out;
  }
 }
 return { contextWindow: bestContext, maxTokens: bestOutput };
}

export function enrichModelDef(
 raw: RawModelItem,
 source: Upstream,
 twinCatalog?: readonly unknown[],
): RegisteredModel {
 const known = MODEL_MAP.get(raw.id);
 if (known) {
  return { ...known, source };
 }

 const idLower = raw.id.toLowerCase();
 const modalities = raw.modalities !== null && typeof raw.modalities === "object" && !Array.isArray(raw.modalities)
  ? raw.modalities as Record<string, unknown>
  : null;
 const inputModalities = Array.isArray(modalities?.input) ? modalities.input : null;
 const hasDeclaredVision =
  inputModalities !== null &&
  inputModalities.some((m) => typeof m === "string" && (m === "image" || m.startsWith("image/")));
 const hasVision =
  hasDeclaredVision ||
  (inputModalities === null && (
   idLower.includes("vision") ||
   idLower.includes("vl") ||
   idLower.includes("omni") ||
   idLower.includes("note") ||
   idLower.includes("image")
  ));
 const capabilities = raw.capabilities !== null && typeof raw.capabilities === "object" && !Array.isArray(raw.capabilities)
  ? raw.capabilities as Record<string, unknown>
  : null;
 const capReasoning = capabilities?.reasoning !== null && typeof capabilities?.reasoning === "object" && !Array.isArray(capabilities.reasoning)
  ? capabilities.reasoning as Record<string, unknown>
  : null;
 const effortList = Array.isArray(capReasoning?.effort)
  ? capReasoning.effort.filter((e): e is string => typeof e === "string")
  : [];
 const hasReasoning =
  typeof raw.reasoning === "boolean" ? raw.reasoning
  : typeof capReasoning?.supported === "boolean" ? capReasoning.supported
  : (
   idLower.includes("reasoning") ||
   idLower.includes("r1") ||
   idLower.includes("o1") ||
   idLower.includes("think") ||
   idLower.includes("spark") ||
   idLower.includes("flash") ||
   idLower.includes("deepseek") ||
   idLower.includes("glm") ||
   idLower.includes("solar")
  );

 const limit = raw.limit !== null && typeof raw.limit === "object" && !Array.isArray(raw.limit)
  ? raw.limit as Record<string, unknown>
  : null;
 // Declared fields win over nested Zen `limit.*` and wire aliases; twin lookup
 // and id heuristics fill remaining gaps only when limits are absent.
 const directContext =
  validPosNum(raw.contextWindow)
  ?? validPosNum(raw.context_length)
  ?? validPosNum(limit?.context);
 const directMaxTokens =
  validPosNum(raw.maxTokens)
  ?? validPosNum(raw.max_output_tokens)
  ?? validPosNum(raw.max_tokens)
  ?? validPosNum(limit?.output);
 const twin = directContext === undefined || directMaxTokens === undefined
  ? resolveTwinLimits(raw, twinCatalog)
  : {};
 const declaredContext = directContext ?? twin.contextWindow;
 let contextWindow = declaredContext ?? 262_144;
 if (
  declaredContext === undefined && (
   idLower.includes("1m") ||
   idLower.includes("ultra") ||
   idLower.includes("lightning") ||
   idLower.includes("mimo-v2.5") ||
   idLower.includes("muse-spark")
  )
 ) {
  contextWindow = 1_048_576;
 }

 const declaredMaxTokens = directMaxTokens ?? twin.maxTokens;
 let maxTokens = declaredMaxTokens ?? 65_536;
 if (declaredMaxTokens === undefined && (idLower.includes("ultra") || idLower.includes("lightning"))) {
  maxTokens = 131_072;
 }

 // Muse Spark was served on the responses API upstream: the Cline entry
 // declared it until 2026-10-22, and the Zen 1.2/1.3 contributor ids retired
 // before that. Every known id short-circuits above, so this only decides for
 // ids Zen lists dynamically — matching the family keeps a future muse-spark
 // id off the chat endpoint it would 500 on.
 const isResponses = idLower.includes("muse-spark") || raw.recommended_api === "responses";

 let thinkingLevelMap: RegisteredModel["thinkingLevelMap"];
 if (effortList.length > 0) {
  const advertised = new Set(effortList);
  const map: NonNullable<RegisteredModel["thinkingLevelMap"]> = { off: null };
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
   map[level] = advertised.has(level) ? level : null;
  }
  thinkingLevelMap = map;
 }

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
  ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
 };
}

function rawCatalogList(body: unknown): unknown[] {
 if (Array.isArray(body)) return body;
 if (body !== null && typeof body === "object" && !Array.isArray(body) && "data" in body) {
  const data = (body as Record<string, unknown>).data;
  return Array.isArray(data) ? data : [];
 }
 return [];
}

function positiveNumber(value: unknown): number | null {
 return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function zeroPrice(value: unknown): boolean {
 if (typeof value === "number") return Number.isFinite(value) && value === 0;
 if (typeof value !== "string" || value.trim() === "") return false;
 const parsed = Number(value);
 return Number.isFinite(parsed) && parsed === 0;
}

/**
 * Parse the authoritative Kilo listing. Unknown rows enter only when Kilo
 * explicitly marks them free, prices both directions at zero, advertises text
 * output and tool use, and supplies positive context/output limits.
 */
export function parseKiloCatalogResponse(body: unknown): RegisteredModel[] {
 const parsed: RegisteredModel[] = [];
 for (const item of rawCatalogList(body)) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
  const row = item as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!id || !name || DEAD_MODEL_IDS.has(id) || row.isFree !== true) continue;
  const pricing = row.pricing !== null && typeof row.pricing === "object" && !Array.isArray(row.pricing)
   ? row.pricing as Record<string, unknown>
   : null;
  if (!pricing || !zeroPrice(pricing.prompt) || !zeroPrice(pricing.completion)) continue;
  const architecture = row.architecture !== null && typeof row.architecture === "object" && !Array.isArray(row.architecture)
   ? row.architecture as Record<string, unknown>
   : null;
  const outputModalities = architecture && Array.isArray(architecture.output_modalities)
   ? architecture.output_modalities
   : [];
  if (!outputModalities.includes("text")) continue;
  const supported = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
  if (!supported.includes("tools")) continue;
  const topProvider = row.top_provider !== null && typeof row.top_provider === "object" && !Array.isArray(row.top_provider)
   ? row.top_provider as Record<string, unknown>
   : null;
  const contextWindow = positiveNumber(row.context_length) ?? positiveNumber(topProvider?.context_length);
  const maxTokens = positiveNumber(topProvider?.max_completion_tokens);
  if (contextWindow === null || maxTokens === null) continue;

  const inputModalities = architecture && Array.isArray(architecture.input_modalities)
   ? architecture.input_modalities.filter((v): v is "text" | "image" => v === "text" || v === "image")
   : [];
  const opencode = row.opencode !== null && typeof row.opencode === "object" && !Array.isArray(row.opencode)
   ? row.opencode as Record<string, unknown>
   : null;
  const reasoningOptions = opencode && Array.isArray(opencode.reasoning_options)
   ? opencode.reasoning_options
   : [];
  const advertised = new Set<string>();
  for (const option of reasoningOptions) {
   if (option === null || typeof option !== "object" || Array.isArray(option)) continue;
   const rec = option as Record<string, unknown>;
   if (rec.type !== "effort" || !Array.isArray(rec.values)) continue;
   for (const value of rec.values) if (typeof value === "string") advertised.add(value);
  }
  const thinkingLevelMap: NonNullable<RegisteredModel["thinkingLevelMap"]> = { off: null };
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
   if (advertised.has(level)) thinkingLevelMap[level] = level;
  }
  const reasoning = advertised.size > 0 || supported.includes("reasoning") || supported.includes("reasoning_effort");
  const known = MODEL_MAP.get(id);
  parsed.push(known ? { ...known, source: "kilo" } : {
   id,
   name,
   source: "kilo",
   reasoning,
   contextWindow,
   maxTokens,
   input: inputModalities.length > 0 ? inputModalities : ["text"],
   thinkingFormat: "openrouter",
   thinkingLevelMap: Object.keys(thinkingLevelMap).length > 1 ? thinkingLevelMap : undefined,
  });
 }
 return sanitizeSourceSnapshot(parsed, "kilo", false);
}

function isChatCompatibleZenRow(row: RawModelItem): boolean {
 const recApi = typeof row.recommended_api === "string" ? row.recommended_api.trim().toLowerCase() : "";
 if (recApi.length > 0 && recApi !== "chat-completions" && recApi !== "responses" && recApi !== "messages") {
  return false;
 }
 const modalities = row.modalities !== null && typeof row.modalities === "object" && !Array.isArray(row.modalities)
  ? row.modalities as Record<string, unknown>
  : null;
 const output = Array.isArray(modalities?.output) ? modalities.output : null;
 if (output !== null && !output.includes("text")) {
  return false;
 }
 const capabilities = row.capabilities !== null && typeof row.capabilities === "object" && !Array.isArray(row.capabilities)
  ? row.capabilities as Record<string, unknown>
  : null;
 const tools = capabilities?.tools !== null && typeof capabilities?.tools === "object" && !Array.isArray(capabilities.tools)
  ? capabilities.tools as Record<string, unknown>
  : null;
 if (tools && tools.supported === false) {
  return false;
 }
 return true;
}

function parseZenCatalogResponse(body: unknown): RegisteredModel[] {
 const rows = rawCatalogList(body).filter((item): item is RawModelItem =>
  item !== null && typeof item === "object" && !Array.isArray(item) &&
  typeof (item as Record<string, unknown>).id === "string"
 );
 return sanitizeSourceSnapshot(
  rows
   .filter((row) => isFreeCatalogId(row.id) && isChatCompatibleZenRow(row))
   .map((row) => enrichModelDef(row, "opencode", rows)),
  "opencode",
  false,
 );
}

interface LoadedCatalogCache {
 data: CatalogCacheData;
 opencode: CatalogSourceCacheData;
 kilo: CatalogSourceCacheData;
}

function emptySourceCache(): CatalogSourceCacheData {
 return { timestamp: 0, ids: [], models: [] };
}

function normalizeSourceCache(
 raw: unknown,
 source: DynamicCatalogSource,
 legacy: boolean,
): CatalogSourceCacheData {
 if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return emptySourceCache();
 const rec = raw as Record<string, unknown>;
 const models = Array.isArray(rec.models)
  ? sanitizeSourceSnapshot(rec.models as RegisteredModel[], source, legacy)
  : [];
 return {
  timestamp: typeof rec.timestamp === "number" && Number.isFinite(rec.timestamp) ? rec.timestamp : 0,
  ids: models.map((m) => m.id),
  models,
  etag: typeof rec.etag === "string" && rec.etag ? rec.etag : undefined,
 };
}

function normalizeCatalogCache(raw: unknown): LoadedCatalogCache | null {
 if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
 const cache = raw as CatalogCacheData;
 let opencode: CatalogSourceCacheData;
 let kilo: CatalogSourceCacheData;
 const legacy = cache.version !== 2 || cache.sources === undefined;
 if (!legacy) {
  opencode = normalizeSourceCache(cache.sources?.opencode, "opencode", false);
  kilo = normalizeSourceCache(cache.sources?.kilo, "kilo", false);
 } else {
  if (!Array.isArray(cache.models)) return null;
  const timestamp = typeof cache.timestamp === "number" && Number.isFinite(cache.timestamp) ? cache.timestamp : 0;
  const zenIds = new Set(Array.isArray(cache.opencode) ? cache.opencode : []);
  const kiloIds = new Set(Array.isArray(cache.kilo) ? cache.kilo : []);
  const zenRows: RegisteredModel[] = [];
  const kiloRows: RegisteredModel[] = [];
  for (const model of cache.models) {
   if (!isUsableRegisteredModel(model) || DEAD_MODEL_IDS.has(model.id)) continue;
   const knownSource = MODEL_MAP.has(model.id) ? getModelUpstream(model.id) : undefined;
   const claims = new Set<DynamicCatalogSource>();
   if (model.source === "opencode" || model.source === "kilo") claims.add(model.source);
   if (zenIds.has(model.id)) claims.add("opencode");
   if (kiloIds.has(model.id)) claims.add("kilo");
   const source = knownSource === "opencode" || knownSource === "kilo"
    ? knownSource
    : claims.size === 1
     ? [...claims][0]
     : undefined;
   if (source === "opencode") zenRows.push(model);
   if (source === "kilo") kiloRows.push(model);
  }
  opencode = {
   timestamp,
   ids: [],
   models: sanitizeSourceSnapshot(zenRows, "opencode", true),
   etag: typeof cache.etag === "string" && cache.etag ? cache.etag : undefined,
  };
  kilo = {
   timestamp,
   ids: [],
   models: sanitizeSourceSnapshot(kiloRows, "kilo", true),
  };
  opencode.ids = opencode.models.map((m) => m.id);
  kilo.ids = kilo.models.map((m) => m.id);
 }
 const models = mergeSourceSnapshots(opencode.models, kilo.models);
 const timestamp = Math.max(opencode.timestamp, kilo.timestamp);
 return {
  data: {
   version: 2,
   sources: { opencode, kilo },
   timestamp,
   opencode: opencode.ids,
   kilo: kilo.ids,
   models,
   etag: opencode.etag,
  },
  opencode,
  kilo,
 };
}

function readAnyCatalogCache(): LoadedCatalogCache | null {
 try {
  if (!fs.existsSync(CATALOG_CACHE_FILE)) return null;
  return normalizeCatalogCache(JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, "utf8")));
 } catch (err) {
  logDebug("Failed reading catalog cache", { error: String(err) });
  return null;
 }
}

/** Read the versioned catalog cache when at least one source snapshot is fresh. */
export function readCatalogCache(): CatalogCacheData | null {
 const loaded = readAnyCatalogCache();
 if (!loaded) return null;
 const freshest = Math.max(loaded.opencode.timestamp, loaded.kilo.timestamp);
 return Date.now() - freshest < CATALOG_CACHE_TTL_MS ? loaded.data : null;
}

function tryWriteCatalogCache(data: CatalogCacheData): boolean {
 try {
  const dir = path.dirname(CATALOG_CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(CATALOG_CACHE_FILE, JSON.stringify(data, null, 2));
  return true;
 } catch (err) {
  logWarn("Could not persist catalog cache to disk", { error: String(err) });
  return false;
 }
}

/** Atomically write catalog cache data to disk without surfacing disk errors. */
export function writeCatalogCache(data: CatalogCacheData): void {
 tryWriteCatalogCache(data);
}

const CATALOG_LOCK_STALE_MS = 30_000;
const CATALOG_LOCK_MAX_LEASE_MS = 120_000;
const CATALOG_LOCK_ATTEMPTS = 100;

function readProcessStartToken(pid: number): string | null {
 if (process.platform !== "linux") return null;
 try {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = raw.lastIndexOf(")");
  if (close === -1) return null;
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  // Field 22 (starttime) is index 19 after field 2 `(comm)`.
  const ticks = fields[19];
  return ticks && /^\d+$/.test(ticks) ? BigInt(ticks).toString(16) : null;
 } catch {
  return null;
 }
}

function createLockOwner(): string {
 const startToken = readProcessStartToken(process.pid);
 return startToken ? `${process.pid}:${startToken}-${randomUUID()}` : `${process.pid}:${randomUUID()}`;
}

function removeCatalogLock(owner: string): boolean {
 try {
  if (fs.readFileSync(CATALOG_CACHE_LOCK_FILE, "utf8") !== owner) return false;
  fs.rmSync(CATALOG_CACHE_LOCK_FILE);
  return true;
 } catch {
  return false;
 }
}

function hasLiveOwner(owner: string): boolean {
 const match = /^([1-9]\d*):(?:([0-9a-f]+)-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(owner);
 const legacy = match ? null : /^([1-9]\d*):/.exec(owner);
 const pidText = match ? match[1] : legacy?.[1];
 if (!pidText) return false;
 const pid = Number(pidText);
 if (!Number.isSafeInteger(pid)) return false;
 if (match?.[2]) {
  const currentStart = readProcessStartToken(pid);
  if (currentStart !== null && currentStart !== match[2]) return false;
 }
 try {
  process.kill(pid, 0);
  return true;
 } catch (err) {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
 }
}

async function acquireCatalogLock(): Promise<string | null> {
 const dir = path.dirname(CATALOG_CACHE_LOCK_FILE);
 try {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
 } catch {
  return null;
 }
 for (let attempt = 0; attempt < CATALOG_LOCK_ATTEMPTS; attempt++) {
  const owner = createLockOwner();
  try {
   fs.writeFileSync(CATALOG_CACHE_LOCK_FILE, owner, { flag: "wx" });
   return owner;
  } catch (err) {
   if ((err as NodeJS.ErrnoException | null)?.code !== "EEXIST") return null;
   try {
    const staleOwner = fs.readFileSync(CATALOG_CACHE_LOCK_FILE, "utf8");
    const ageMs = Date.now() - fs.statSync(CATALOG_CACHE_LOCK_FILE).mtimeMs;
    const stale = ageMs > CATALOG_LOCK_MAX_LEASE_MS || (ageMs > CATALOG_LOCK_STALE_MS && !hasLiveOwner(staleOwner));
    if (stale) {
     removeCatalogLock(staleOwner);
     continue;
    }
   } catch {
    continue;
   }
   await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
 }
 return null;
}

function newestSource(
 current: CatalogSourceCacheData,
 latest: CatalogSourceCacheData,
 status: CatalogSourceRefreshStatus,
): CatalogSourceCacheData {
 if (status.outcome === "updated" || status.outcome === "not-modified") {
  return latest.timestamp > current.timestamp ? latest : current;
 }
 return latest.models.length > 0 || latest.timestamp > current.timestamp ? latest : current;
}

async function persistSourceCaches(
 opencode: CatalogSourceCacheData,
 kilo: CatalogSourceCacheData,
 zenStatus: CatalogSourceRefreshStatus,
 kiloStatus: CatalogSourceRefreshStatus,
): Promise<{ opencode: CatalogSourceCacheData; kilo: CatalogSourceCacheData } | null> {
 const owner = await acquireCatalogLock();
 if (owner === null) {
  logWarn("Could not acquire catalog cache lock; retaining durable catalog");
  return null;
 }
 try {
  const latest = readAnyCatalogCache();
  const committed = {
   opencode: newestSource(opencode, latest?.opencode ?? emptySourceCache(), zenStatus),
   kilo: newestSource(kilo, latest?.kilo ?? emptySourceCache(), kiloStatus),
  };
  return tryWriteCatalogCache({ version: 2, sources: committed }) ? committed : null;
 } finally {
  removeCatalogLock(owner);
 }
}

/**
 * Pull a newer cache written by the host process into the detached proxy. The
 * mtime guard keeps steady-state requests to one stat and rebuilds provenance
 * only after a successful catalog write.
 */
export function syncAliveCatalogFromCache(): boolean {
 try {
  const mtimeMs = fs.statSync(CATALOG_CACHE_FILE).mtimeMs;
  if (mtimeMs === lastCatalogCacheMtimeMs) return false;
  const loaded = readAnyCatalogCache();
  if (!loaded) return false;
  lastCatalogCacheMtimeMs = mtimeMs;
  setAliveCatalog(mergeSourceSnapshots(loaded.opencode.models, loaded.kilo.models));
  return true;
 } catch {
  lastCatalogCacheMtimeMs = -1;
  return false;
 }
}

const emptyRefreshSourceStatus = (snapshot = emptySourceCache()): CatalogSourceRefreshStatus => ({
 outcome: "fresh-cache",
 usedCache: snapshot.models.length > 0,
});

let lastRefreshStatus: CatalogRefreshStatus = {
 timestamp: 0,
 forced: false,
 opencode: emptyRefreshSourceStatus(),
 kilo: emptyRefreshSourceStatus(),
};

/** Return a copy of the most recent per-source catalog refresh result. */
export function getLastCatalogRefreshStatus(): CatalogRefreshStatus {
 return {
  ...lastRefreshStatus,
  opencode: { ...lastRefreshStatus.opencode },
  kilo: { ...lastRefreshStatus.kilo },
 };
}

interface SourceRefreshResult {
 snapshot: CatalogSourceCacheData;
 status: CatalogSourceRefreshStatus;
}

async function refreshSource(
 source: DynamicCatalogSource,
 previous: CatalogSourceCacheData,
): Promise<SourceRefreshResult> {
 const headers: Record<string, string> = source === "opencode"
  ? { ...opencodeHeaders() }
  : { Accept: "application/json" };
 if (previous.etag) headers["If-None-Match"] = previous.etag;
 const url = source === "opencode" ? `${OPENCODE_API_URL}/models` : KILO_CATALOG_URL;
 try {
  const response = await fetch(url, {
   headers,
   signal: AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS),
  });
  if (response.status === 304) {
   if (previous.models.length === 0) {
    return {
     snapshot: previous,
     status: { outcome: "failed", usedCache: false, detail: "304 without a cached snapshot" },
    };
   }
   const etag = response.headers.get("etag") ?? previous.etag;
   return {
    snapshot: { ...previous, timestamp: Date.now(), etag },
    status: { outcome: "not-modified", usedCache: true },
   };
  }
  if (!response.ok) {
   return {
    snapshot: previous,
    status: { outcome: "failed", usedCache: previous.models.length > 0, detail: `HTTP ${response.status}` },
   };
  }
  const body: unknown = await response.json();
  const models = source === "opencode" ? parseZenCatalogResponse(body) : parseKiloCatalogResponse(body);
  if (models.length === 0) {
   return {
    snapshot: previous,
    status: { outcome: "failed", usedCache: previous.models.length > 0, detail: "empty or malformed listing" },
   };
  }
  const etag = response.headers.get("etag") ?? undefined;
  return {
   snapshot: {
    timestamp: Date.now(),
    ids: models.map((m) => m.id),
    models,
    etag: etag ?? undefined,
   },
   status: { outcome: "updated", usedCache: false },
  };
 } catch (err) {
  const name = (err as Error)?.name;
  const timedOut = name === "AbortError" || name === "TimeoutError";
  return {
   snapshot: previous,
   status: {
    outcome: "failed",
    usedCache: previous.models.length > 0,
    detail: timedOut ? `timeout after ${CATALOG_REFRESH_TIMEOUT_MS}ms` : String(err),
   },
  };
 }
}

/**
 * Refresh Zen and Kilo independently. Fresh snapshots short-circuit by source;
 * stale sources fetch concurrently, and any failed source retains only its own
 * cached rows while the other can update normally.
 */
async function refreshCatalogOnce(force: boolean): Promise<RegisteredModel[]> {
 const loaded = readAnyCatalogCache();
 let opencode = loaded?.opencode ?? emptySourceCache();
 let kilo = loaded?.kilo ?? emptySourceCache();
 const durableCatalog = mergeSourceSnapshots(opencode.models, kilo.models);
 setAliveCatalog(durableCatalog);

 const now = Date.now();
 const zenFresh = now - opencode.timestamp < CATALOG_CACHE_TTL_MS;
 const kiloFresh = now - kilo.timestamp < CATALOG_CACHE_TTL_MS;
 const work: Promise<void>[] = [];
 let zenStatus = emptyRefreshSourceStatus(opencode);
 let kiloStatus = emptyRefreshSourceStatus(kilo);
 if (force || !zenFresh) {
  work.push(refreshSource("opencode", opencode).then((result) => {
   opencode = result.snapshot;
   zenStatus = result.status;
  }));
 }
 if (force || !kiloFresh) {
  work.push(refreshSource("kilo", kilo).then((result) => {
   kilo = result.snapshot;
   kiloStatus = result.status;
  }));
 }
 await Promise.all(work);

 const succeeded = [zenStatus, kiloStatus].some((status) =>
  status.outcome === "updated" || status.outcome === "not-modified"
 );
 if (succeeded) {
  const committed = await persistSourceCaches(opencode, kilo, zenStatus, kiloStatus);
  if (committed) {
   opencode = committed.opencode;
   kilo = committed.kilo;
   if (zenStatus.outcome === "failed" || zenStatus.outcome === "fresh-cache") {
    zenStatus = { ...zenStatus, usedCache: opencode.models.length > 0 };
   }
   if (kiloStatus.outcome === "failed" || kiloStatus.outcome === "fresh-cache") {
    kiloStatus = { ...kiloStatus, usedCache: kilo.models.length > 0 };
   }
   setAliveCatalog(mergeSourceSnapshots(opencode.models, kilo.models));
  } else {
   const persistenceFailure = (status: CatalogSourceRefreshStatus, cached: CatalogSourceCacheData): CatalogSourceRefreshStatus =>
    status.outcome === "updated" || status.outcome === "not-modified"
     ? { outcome: "failed", usedCache: cached.models.length > 0, detail: "catalog cache persistence failed" }
     : status;
   zenStatus = persistenceFailure(zenStatus, loaded?.opencode ?? emptySourceCache());
   kiloStatus = persistenceFailure(kiloStatus, loaded?.kilo ?? emptySourceCache());
    setAliveCatalog(durableCatalog);
   }
  } else {
   const latest = readAnyCatalogCache();
   if (latest) {
    if (latest.opencode.timestamp > opencode.timestamp) opencode = latest.opencode;
    if (latest.kilo.timestamp > kilo.timestamp) kilo = latest.kilo;
    zenStatus = { ...zenStatus, usedCache: opencode.models.length > 0 };
    kiloStatus = { ...kiloStatus, usedCache: kilo.models.length > 0 };
    setAliveCatalog(mergeSourceSnapshots(opencode.models, kilo.models));
   }
  }
 lastRefreshStatus = {
  timestamp: Date.now(),
  forced: force,
  opencode: zenStatus,
  kilo: kiloStatus,
 };
 for (const [source, status] of [["Zen", zenStatus], ["Kilo", kiloStatus]] as const) {
  if (status.outcome === "failed") {
   logWarn(`${source} catalog refresh failed; retaining its cached/static rows`, { detail: status.detail });
  }
 }
 return aliveCatalog;
}

let refreshQueue: Promise<void> = Promise.resolve();

/**
 * Refresh the catalog without allowing overlapping callers in this process to
 * race. Cross-process commits are separately locked and merged from disk.
 */
export function refreshCatalog(force = false): Promise<RegisteredModel[]> {
 const result = refreshQueue.then(() => refreshCatalogOnce(force));
 refreshQueue = result.then(() => undefined, () => undefined);
 return result;
}
