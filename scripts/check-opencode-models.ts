/**
 * OpenCode Free-Tier Models Health Checker & Action Bot
 *
 * Probes all OpenCode Zen free-tier models via the local proxy and gives every
 * sample a severity:
 * - `dead` — model-level answer (400/401/403/410, or a 404 that is not an
 *   "Endpoint is unavailable" body): the catalog is wrong, so this alerts.
 * - `unavailable` — availability fault (402, 408, 429, 5xx, network errors, and
 *   the 404 "Endpoint is unavailable" answer): retried, never alerts. 402
 *   belongs here: Zen answers 402 "Endpoint is unavailable" while a model is
 *   healthy, and issue #107 was filed from exactly that blip.
 * - `timeout` — the probe's own AbortSignal cap fired: inconclusive, never alerts.
 *
 * Probes stream (chat and responses alike) so a model is healthy on a 2xx status
 * line instead of a whole generation fitting the timeout budget.
 *
 * Every probe carries the installation token: the local proxy requires
 * `Authorization: Bearer <token>` on /v1/*, and a missing header is a 401 of
 * ours, not a verdict on the model.
 *
 * CLI options:
 *   --output <file>  Write markdown report to file
 *   --json           Print structured JSON after the progress lines
 *
 * Exit codes: 0 = no dead model (healthy, unavailable, and timeout all exit 0),
 * 1 = at least one dead model, 2 = fatal/infra.
 */
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { startProxy } from "../src/proxy.ts";
import { OPENCODE_MODELS } from "../src/models.ts";
import { tokenAuthHeaders } from "../src/token.ts";
import type { ModelDef } from "../src/types.ts";

const BASE_TEST_PORT = 29680;
export const TIMEOUT_MS = 25000;
/**
 * Total attempts per model: the first probe plus two retries for transient
 * faults. A single non-2xx sample is not evidence of an outage — this runs
 * from a shared GitHub runner IP, where 402/429 ("Endpoint is unavailable",
 * "shared free-tier IP quota reached"), 5xx blips, and 404 "Endpoint is
 * unavailable" answers have all cleared on a later sample. Model-level answers
 * (410 deprecated, 401 not supported, 404 does not exist) stay single-shot, and
 * a probe-cap timeout is inconclusive rather than retryable.
 */
export const MAX_PROBE_ATTEMPTS = 3;
/** Delay before each retry, indexed by the attempt that just failed (ms). */
export const RETRY_BACKOFF_MS = [2000, 5000];

/**
 * Severity of one probe sample. Only `dead` describes a catalog defect; the
 * other two degraded verdicts are observations about availability, not models.
 */
export type ProbeVerdict = "healthy" | "dead" | "unavailable" | "timeout";

export interface ModelHealthResult {
  id: string;
  api: string;
  status: number;
  latencyMs: number;
  healthy: boolean;
  verdict: ProbeVerdict;
  error?: string;
  attempts?: number;
}

/**
 * Classify one finished sample. Pure so the alerting contract can be tested
 * without a proxy or a network.
 *
 * `dead` is the only alert-worthy verdict and must describe the model itself:
 * the upstream answered that the model is rejected, unauthorized, or missing.
 * A 404 is only model-level when its body is not the shared
 * "Endpoint is unavailable" availability answer.
 */
export function classifyProbeResult(
  result: Pick<ModelHealthResult, "healthy" | "status" | "error">,
): ProbeVerdict {
  if (result.healthy) return "healthy";
  const { status } = result;
  const error = result.error ?? "";
  if (status === 0) return /abort|timed? ?out|timeout/i.test(error) ? "timeout" : "unavailable";
  if (status === 404) return /endpoint is unavailable/i.test(error) ? "unavailable" : "dead";
  if (status === 402 || status === 408 || status === 429 || status >= 500) return "unavailable";
  // 400/401/403/410 are model-level answers. An unrecognized 4xx (405, 422, …)
  // is also model-level: surfacing it gets a human look instead of silence.
  if (status >= 400 && status < 500) return "dead";
  return "unavailable";
}

async function startOwnedProxy() {
  const candidates = [BASE_TEST_PORT, BASE_TEST_PORT + 1, BASE_TEST_PORT + 2, BASE_TEST_PORT + 3];
  for (const candidate of candidates) {
    const { server, port } = await startProxy(candidate);
    if (server) return { server, port };
  }
  throw new Error(`Could not bind an owned proxy on ports ${candidates.join(", ")}`);
}

async function attemptProbe(
  endpoint: string,
  payload: unknown,
  model: ModelDef,
  fetchImpl: typeof fetch,
): Promise<ModelHealthResult> {
  const api = model.api || "openai-completions";
  const start = Date.now();
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tokenAuthHeaders() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const latencyMs = Date.now() - start;
    if (res.ok) {
      // Health is the status line: drop the streaming body instead of waiting for a
      // whole generation to land inside the timeout budget.
      await res.body?.cancel().catch(() => {});
      const healthy = { id: model.id, api, status: res.status, latencyMs, healthy: true };
      return { ...healthy, verdict: classifyProbeResult(healthy) };
    }

    const text = await res.text();
    let errMessage = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text);
      errMessage = parsed.error?.message || parsed.message || errMessage;
    } catch { }

    const failed = {
      id: model.id,
      api,
      status: res.status,
      latencyMs,
      healthy: false,
      error: errMessage,
    };
    return { ...failed, verdict: classifyProbeResult(failed) };
  } catch (e) {
    const unreachable = {
      id: model.id,
      api,
      status: 0,
      latencyMs: Date.now() - start,
      healthy: false,
      error: (e as Error).message,
    };
    return { ...unreachable, verdict: classifyProbeResult(unreachable) };
  }
}

export async function probeModel(
  port: number,
  model: ModelDef,
  fetchImpl: typeof fetch = fetch,
  options: { maxAttempts?: number; backoffMs?: number[] } = {},
): Promise<ModelHealthResult> {
  const isResponses = model.api === "openai-responses";
  const endpoint = isResponses
    ? `http://127.0.0.1:${port}/v1/responses`
    : `http://127.0.0.1:${port}/v1/chat/completions`;
  const payload = isResponses
    ? {
        model: model.id,
        input: [{ role: "user", content: "ping" }],
        stream: true,
      }
    : {
        model: model.id,
        messages: [{ role: "user", content: "ping" }],
        stream: true,
        max_tokens: 10,
      };

  const start = Date.now();
  const maxAttempts = options.maxAttempts ?? MAX_PROBE_ATTEMPTS;
  const backoff = options.backoffMs ?? RETRY_BACKOFF_MS;
  let attempts = 1;
  let last = await attemptProbe(endpoint, payload, model, fetchImpl);
  // Availability blips — every `unavailable` verdict, explicitly including the
  // 402 "Endpoint is unavailable" answer (issue #107) plus 408/429/5xx,
  // non-timeout network faults and the endpoint-unavailable 404 — get two more
  // samples. A model-level answer (410/401/404 not-found) and the probe's own
  // timeout are reported as-is: neither is a blip a retry can settle.
  while (!last.healthy && attempts < maxAttempts && classifyProbeResult(last) === "unavailable") {
    const delayMs = backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 0;
    console.log(`  ↻ retry ${attempts} after ${last.status || "network"} (${last.error || "unknown"})`);
    if (delayMs > 0) {
      const sleep = Promise.withResolvers<void>();
      setTimeout(sleep.resolve, delayMs);
      await sleep.promise;
    }
    last = await attemptProbe(endpoint, payload, model, fetchImpl);
    attempts += 1;
  }

  return { ...last, latencyMs: Date.now() - start, attempts, verdict: classifyProbeResult(last) };
}

export interface ProbeSummary {
  total: number;
  healthyCount: number;
  /** Every non-healthy sample, under its original name for JSON consumers. */
  affectedCount: number;
  deadCount: number;
  /** Availability faults plus inconclusive timeouts: reported, never alerting. */
  degradedCount: number;
  dead: ModelHealthResult[];
  unavailable: ModelHealthResult[];
  timeouts: ModelHealthResult[];
  /** 1 only when a model-level failure makes the catalog wrong. */
  exitCode: 0 | 1;
}

/** Pure roll-up of probe samples into report counts and the CLI exit contract. */
export function summarizeResults(results: ModelHealthResult[]): ProbeSummary {
  const dead = results.filter((r) => r.verdict === "dead");
  const unavailable = results.filter((r) => r.verdict === "unavailable");
  const timeouts = results.filter((r) => r.verdict === "timeout");
  return {
    total: results.length,
    healthyCount: results.filter((r) => r.verdict === "healthy").length,
    affectedCount: dead.length + unavailable.length + timeouts.length,
    deadCount: dead.length,
    degradedCount: unavailable.length + timeouts.length,
    dead,
    unavailable,
    timeouts,
    exitCode: dead.length > 0 ? 1 : 0,
  };
}

const VERDICT_LABELS: Record<ProbeVerdict, string> = {
  healthy: "✅ Healthy",
  dead: "❌ Dead",
  unavailable: "🚦 Unavailable",
  timeout: "⏱ Timeout",
};

export function generateMarkdownReport(results: ModelHealthResult[]): string {
  const summary = summarizeResults(results);
  const headline =
    summary.deadCount > 0
      ? `🚨 ${summary.deadCount} Model(s) Dead`
      : summary.degradedCount > 0
        ? `🚦 ${summary.degradedCount} Model(s) Unavailable (no alert)`
        : "✅ All OpenCode Free Models Healthy";

  const lines: string[] = [];
  lines.push(`## 🤖 OpenCode Free Tier Model Health Check`);
  lines.push("");
  lines.push(`- **Status**: ${headline}`);
  lines.push(`- **Healthy**: ${summary.healthyCount} / ${summary.total}`);
  if (summary.deadCount > 0) lines.push(`- **Dead (model-level, alerts)**: ${summary.deadCount}`);
  if (summary.unavailable.length > 0) {
    lines.push(`- **Unavailable (availability fault, retried, no catalog action)**: ${summary.unavailable.length}`);
  }
  if (summary.timeouts.length > 0) {
    lines.push(`- **Timeout (inconclusive, probe cap)**: ${summary.timeouts.length}`);
  }
  lines.push(`- **Timestamp**: ${new Date().toISOString()}`);
  lines.push("");

  if (summary.dead.length > 0) {
    lines.push(`### ❌ Dead Models (alerting)`);
    lines.push("");
    lines.push(`| Model ID | HTTP Status | Attempts | Error Detail |`);
    lines.push(`|---|---|---|---|`);
    for (const m of summary.dead) {
      lines.push(`| \`${m.id}\` | ${m.status || "ERR"} | ${m.attempts ?? 1} | ${tableCell(m.error || "Unknown error")} |`);
    }
    lines.push("");
  }

  if (summary.unavailable.length > 0) {
    lines.push(`### 🚦 Unavailable (retried; availability fault, no catalog action)`);
    lines.push("");
    lines.push(`| Model ID | HTTP Status | Attempts | Error Detail |`);
    lines.push(`|---|---|---|---|`);
    for (const m of summary.unavailable) {
      lines.push(`| \`${m.id}\` | ${m.status || "network"} | ${m.attempts ?? 1} | ${tableCell(m.error || "Unknown error")} |`);
    }
    lines.push("");
  }

  if (summary.timeouts.length > 0) {
    lines.push(`### ⏱ Timeout (inconclusive, probe cap)`);
    lines.push("");
    lines.push(`| Model ID | HTTP Status | Attempts | Error Detail |`);
    lines.push(`|---|---|---|---|`);
    for (const m of summary.timeouts) {
      lines.push(`| \`${m.id}\` | ${m.status || "network"} | ${m.attempts ?? 1} | ${tableCell(m.error || "Unknown error")} |`);
    }
    lines.push("");
  }

  lines.push(`### 📋 Complete Model Verification Matrix`);
  lines.push("");
  lines.push(`| Model ID | Wire API | Status | Latency | Verdict |`);
  lines.push(`|---|---|---|---|---|`);
  for (const r of results) {
    lines.push(`| \`${r.id}\` | \`${r.api}\` | ${r.status} | ${r.latencyMs}ms | ${VERDICT_LABELS[r.verdict]} |`);
  }
  lines.push("");

  return lines.join("\n");
}

/** Table cells must not smuggle pipes or newlines into the markdown table. */
function tableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

async function main() {
  const args = process.argv.slice(2);
  const outputIdx = args.indexOf("--output");
  const outputFile = outputIdx !== -1 ? args[outputIdx + 1] : null;
  const isJson = args.includes("--json");

  const { server, port } = await startOwnedProxy();
  console.log(`[check-opencode] Proxy started on port ${port}, probing ${OPENCODE_MODELS.length} models...`);

  const results: ModelHealthResult[] = [];
  for (const model of OPENCODE_MODELS) {
    process.stdout.write(`  Probing ${model.id}... `);
    const result = await probeModel(port, model);
    results.push(result);
    console.log(
      result.healthy
        ? `✅ OK (${result.latencyMs}ms)`
        : `${VERDICT_LABELS[result.verdict]} ${result.status || "network"}: ${result.error}`,
    );
  }

  server.close();

  const summary = summarizeResults(results);
  const report = generateMarkdownReport(results);

  if (outputFile) {
    await fs.writeFile(outputFile, report, "utf8");
    console.log(`[check-opencode] Report written to ${outputFile}`);
  }

  if (isJson) {
    console.log(
      JSON.stringify(
        {
          affectedCount: summary.affectedCount,
          deadCount: summary.deadCount,
          degradedCount: summary.degradedCount,
          results,
        },
        null,
        2,
      ),
    );
  }

  if (summary.exitCode === 1) {
    console.error(`[check-opencode] ${summary.deadCount} OpenCode model(s) dead (model-level failure).`);
    process.exit(1);
  }

  // Availability faults and probe timeouts exit 0: they are reported, never
  // alerted on, so a shared-runner blip can never file an issue.
  for (const result of [...summary.unavailable, ...summary.timeouts]) {
    console.log(
      `[check-opencode] ${VERDICT_LABELS[result.verdict]}: ${result.id} — HTTP ${result.status || "network"} ${result.error ?? ""}`.trimEnd(),
    );
  }
  if (summary.degradedCount > 0) {
    console.log(
      `[check-opencode] ${summary.degradedCount} model(s) degraded by availability or probe timeout — no dead model, no alert.`,
    );
  } else {
    console.log(`[check-opencode] All ${results.length} models healthy.`);
  }
  process.exit(0);
}

// Run the CLI only when this file is the process entry point; tests import
// probeModel directly and must not boot a proxy.
const isDirectRun = !!(process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error("[check-opencode] Fatal error:", err);
    process.exit(2);
  });
}
