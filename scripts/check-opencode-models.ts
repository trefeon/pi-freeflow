/**
 * OpenCode Free-Tier Models Health Checker & Action Bot
 *
 * Probes all OpenCode Zen free-tier models via the local proxy to detect:
 * - 403 FreeTierError
 * - 410 ModelDeprecated
 * - 404 ModelNotFound
 * - Upstream failures / regressions
 *
 * Probes stream (chat and responses alike) so a model is healthy on a 2xx status
 * line instead of a whole generation fitting the timeout budget; transient
 * failures (network/timeout, 429, 5xx, endpoint-unavailable 404) are retried
 * twice with backoff before a model is reported affected, so one bad sample
 * from the shared runner IP cannot file a false alert.
 *
 * CLI options:
 *   --output <file>  Write markdown report to file
 *   --json           Print structured JSON to stdout
 */
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { startProxy } from "../src/proxy.ts";
import { OPENCODE_MODELS } from "../src/models.ts";
import type { ModelDef } from "../src/types.ts";

const BASE_TEST_PORT = 29680;
const TIMEOUT_MS = 25000;
/**
 * Total attempts per model: the first probe plus two retries for transient
 * faults. A single non-2xx sample is not evidence of an outage — this runs
 * from a shared GitHub runner IP, where 429s ("shared free-tier IP quota
 * reached"), 5xx blips, and 404 "Endpoint is unavailable" answers have all
 * cleared on a later sample. Model-level answers (410 deprecated, 401 not
 * supported, 404 does not exist) stay single-shot.
 */
const MAX_PROBE_ATTEMPTS = 3;
/** Delay before each retry, indexed by the attempt that just failed (ms). */
const RETRY_BACKOFF_MS = [2000, 5000];

export interface ModelHealthResult {
  id: string;
  api: string;
  status: number;
  latencyMs: number;
  healthy: boolean;
  error?: string;
  attempts?: number;
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const latencyMs = Date.now() - start;
    if (res.ok) {
      // Health is the status line: drop the streaming body instead of waiting for a
      // whole generation to land inside the timeout budget.
      await res.body?.cancel().catch(() => {});
      return { id: model.id, api, status: res.status, latencyMs, healthy: true };
    }

    const text = await res.text();
    let errMessage = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text);
      errMessage = parsed.error?.message || parsed.message || errMessage;
    } catch { }

    return {
      id: model.id,
      api,
      status: res.status,
      latencyMs,
      healthy: false,
      error: errMessage,
    };
  } catch (e) {
    return {
      id: model.id,
      api,
      status: 0,
      latencyMs: Date.now() - start,
      healthy: false,
      error: (e as Error).message,
    };
  }
}

/**
 * True when a failed sample is worth retrying before the model is reported
 * affected: network/timeout (status 0), rate limits, server faults, and the
 * 404 that carries an "Endpoint is unavailable" body rather than a
 * model-not-found verdict.
 */
function isTransientProbeResult(result: ModelHealthResult): boolean {
  if (result.status === 0 || result.status === 408 || result.status === 429) return true;
  if (result.status >= 500) return true;
  if (result.status === 404 && /endpoint is unavailable/i.test(result.error ?? "")) return true;
  return false;
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
  // Transient faults (network, 429, 5xx, endpoint-unavailable 404) get two more
  // samples; a model-level answer (410/401/404 not-found) is reported as-is.
  while (!last.healthy && attempts < maxAttempts && isTransientProbeResult(last)) {
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

  return { ...last, latencyMs: Date.now() - start, attempts };
}

function generateMarkdownReport(results: ModelHealthResult[]): string {
  const affected = results.filter((r) => !r.healthy);
  const total = results.length;
  const healthyCount = total - affected.length;

  const lines: string[] = [];
  lines.push(`## 🤖 OpenCode Free Tier Model Health Check`);
  lines.push("");
  lines.push(`- **Status**: ${affected.length === 0 ? "✅ All OpenCode Free Models Healthy" : `🚨 ${affected.length} Model(s) Affected`}`);
  lines.push(`- **Healthy**: ${healthyCount} / ${total}`);
  lines.push(`- **Timestamp**: ${new Date().toISOString()}`);
  lines.push("");

  if (affected.length > 0) {
    lines.push(`### ⚠️ Affected Models`);
    lines.push("");
    lines.push(`| Model ID | HTTP Status | Error Detail |`);
    lines.push(`|---|---|---|`);
    for (const m of affected) {
      lines.push(`| \`${m.id}\` | ${m.status || "ERR"} | ${m.error || "Unknown error"} |`);
    }
    lines.push("");
  }

  lines.push(`### 📋 Complete Model Verification Matrix`);
  lines.push("");
  lines.push(`| Model ID | Wire API | Status | Latency | Verdict |`);
  lines.push(`|---|---|---|---|---|`);
  for (const r of results) {
    const verdict = r.healthy ? "✅ Healthy" : "❌ Affected";
    lines.push(`| \`${r.id}\` | \`${r.api}\` | ${r.status} | ${r.latencyMs}ms | ${verdict} |`);
  }
  lines.push("");

  return lines.join("\n");
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
    console.log(result.healthy ? `✅ OK (${result.latencyMs}ms)` : `❌ ${result.status}: ${result.error}`);
  }

  server.close();

  const report = generateMarkdownReport(results);
  const affected = results.filter((r) => !r.healthy);

  if (outputFile) {
    await fs.writeFile(outputFile, report, "utf8");
    console.log(`[check-opencode] Report written to ${outputFile}`);
  }

  if (isJson) {
    console.log(JSON.stringify({ affectedCount: affected.length, results }, null, 2));
  }

  if (affected.length > 0) {
    console.error(`[check-opencode] ${affected.length} OpenCode model(s) affected!`);
    process.exit(1);
  } else {
    console.log(`[check-opencode] All ${results.length} models healthy.`);
    process.exit(0);
  }
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
