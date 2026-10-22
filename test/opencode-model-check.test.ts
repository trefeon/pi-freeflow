import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	classifyProbeResult,
	generateMarkdownReport,
	probeModel,
	summarizeResults,
	MAX_PROBE_ATTEMPTS,
	RETRY_BACKOFF_MS,
	TIMEOUT_MS,
} from "../scripts/check-opencode-models.ts";
import type { ModelHealthResult, ProbeVerdict } from "../scripts/check-opencode-models.ts";
import { DATA_DIR_ENV } from "../src/config.ts";
import { OPENCODE_MODELS } from "../src/models.ts";
import { ensureToken } from "../src/token.ts";
import type { ModelDef } from "../src/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the probe workflow timeout covers a fully hanging catalog", () => {
	// The health check is the only alarm for a mass upstream outage, so its
	// worst case (every model hanging through every attempt plus backoff) must
	// fit inside the job ceiling with room for install — a ceiling below the
	// worst case kills the job and swallows exactly the alert it exists to file.
	const workflow = fs.readFileSync(new URL("../.github/workflows/opencode-model-check.yml", import.meta.url), "utf8");
	const match = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(workflow);
	assert.ok(match, "the health-check job must declare timeout-minutes");
	const ceilingMinutes = Number(match[1]);
	const backoffMs = RETRY_BACKOFF_MS.reduce((total, delay) => total + delay, 0);
	const worstCaseMinutes = (OPENCODE_MODELS.length * (MAX_PROBE_ATTEMPTS * TIMEOUT_MS + backoffMs)) / 60_000;
	assert.ok(
		worstCaseMinutes <= ceilingMinutes - 2,
		`worst case ${worstCaseMinutes.toFixed(1)} min (${OPENCODE_MODELS.length} models x ${MAX_PROBE_ATTEMPTS} attempts x ${TIMEOUT_MS} ms + ${backoffMs} ms) must fit inside the ${ceilingMinutes}-min job timeout with 2 min margin`,
	);
});

const CHAT_MODEL: ModelDef = {
	id: "deepseek-v4.1-flash-free",
	name: "DeepSeek V4.1 Flash",
	reasoning: true,
	contextWindow: 1_000_000,
	maxTokens: 384_000,
};

const RESPONSES_MODEL: ModelDef = {
	...CHAT_MODEL,
	// A synthetic responses-flavor model: the catalog's last real one (Cline
	// Muse Spark 1.3) retired on 2026-10-22, and the probe shape must stay
	// covered for any future entry.
	id: "flavor-fixture-responses",
	api: "openai-responses",
};

// 2xx headers over a body that rejects on any read: a probe that waits for content
// fails that read instead of hanging on a stream that never ends.
function unreadableStreamingResponse(onCancel: () => void): Response {
	const body = new ReadableStream({
		pull() {
			throw new Error("probe read the streaming body");
		},
		cancel() {
			onCancel();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface CapturedCall {
	url: string;
	body: Record<string, unknown>;
}

function recordingFetch(handler: (callIndex: number) => Response | Promise<Response>) {
	const calls: CapturedCall[] = [];
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		const callIndex = calls.length;
		calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
		return handler(callIndex);
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

test("chat probes stream so a slow generation cannot trip the probe budget", async () => {
	let cancelled = false;
	const { calls, fetchImpl } = recordingFetch(() => unreadableStreamingResponse(() => { cancelled = true; }));

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl);

	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "http://127.0.0.1:41810/v1/chat/completions");
	assert.equal(calls[0]!.body.stream, true);
	assert.equal(calls[0]!.body.max_tokens, 10);
	assert.equal(result.healthy, true);
	assert.equal(result.status, 200);
	assert.equal(result.attempts, 1);
	assert.equal(cancelled, true, "the streaming body must be cancelled after a 2xx status");
});

test("responses probes keep streaming the responses payload", async () => {
	let cancelled = false;
	const { calls, fetchImpl } = recordingFetch(() => unreadableStreamingResponse(() => { cancelled = true; }));

	const result = await probeModel(41810, RESPONSES_MODEL, fetchImpl);

	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "http://127.0.0.1:41810/v1/responses");
	assert.deepEqual(calls[0]!.body, {
		model: RESPONSES_MODEL.id,
		input: [{ role: "user", content: "ping" }],
		stream: true,
	});
	assert.equal(result.healthy, true);
	assert.equal(result.status, 200);
	assert.equal(result.api, "openai-responses");
	assert.equal(cancelled, true);
});

test("an abort timeout is classified inconclusive and never retried or alerted", async () => {
	const { calls, fetchImpl } = recordingFetch(() => {
		throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
	});

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl, { backoffMs: [0, 0] });

	assert.equal(calls.length, 1, "the probe's own cap is a conclusion, not a blip a retry can settle");
	assert.equal(result.healthy, false);
	assert.equal(result.status, 0);
	assert.equal(result.verdict, "timeout");
	assert.equal(result.attempts, 1);
	assert.equal(summarizeResults([result]).exitCode, 0, "a timeout must never file an alert");
});

test("an exhausted network failure stays unavailable and never alerts", async () => {
	const { calls, fetchImpl } = recordingFetch(() => {
		throw new Error("fetch failed");
	});

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl, { backoffMs: [0, 0] });

	assert.equal(calls.length, 3, "status-0 network failures get two retries");
	assert.equal(result.healthy, false);
	assert.equal(result.status, 0);
	assert.equal(result.verdict, "unavailable");
	assert.equal(result.attempts, 3);
	assert.equal(result.error, "fetch failed");
	assert.equal(summarizeResults([result]).exitCode, 0);
});

test("a 503 endpoint-unavailable blip is retried and can recover", async () => {
	// The 2026-10-18 exo-free sample: one 503 from the shared runner cleared on
	// the next probe minutes later, so a single sample must not alert.
	const { calls, fetchImpl } = recordingFetch((callIndex) => {
		if (callIndex === 0) {
			return new Response(JSON.stringify({ error: { message: "Endpoint is unavailable" } }), {
				status: 503,
				headers: { "content-type": "application/json" },
			});
		}
		return unreadableStreamingResponse(() => {});
	});

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl, { backoffMs: [0, 0] });

	assert.equal(calls.length, 2);
	assert.equal(result.healthy, true);
	assert.equal(result.verdict, "healthy");
	assert.equal(result.attempts, 2);
});

test("an exhausted 503 is unavailable, not a dead model", async () => {
	const { calls, fetchImpl } = recordingFetch(
		() =>
			new Response(JSON.stringify({ error: { message: "Upstream request failed: Endpoint is unavailable." } }), {
				status: 503,
				headers: { "content-type": "application/json" },
			}),
	);

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl, { backoffMs: [0, 0] });

	assert.equal(calls.length, MAX_PROBE_ATTEMPTS);
	assert.equal(result.verdict, "unavailable");
	assert.equal(result.attempts, MAX_PROBE_ATTEMPTS);
	assert.equal(summarizeResults([result]).exitCode, 0);
});

test("a 402 endpoint-unavailable answer is retried and never alert-worthy", async () => {
	// The exact issue #107 sample: Zen's shared pool answers 402 with the
	// availability body while the model itself is fine.
	const { calls, fetchImpl } = recordingFetch(
		() =>
			new Response(JSON.stringify({ error: { message: "Upstream request failed: Endpoint is unavailable." } }), {
				status: 402,
				headers: { "content-type": "application/json" },
			}),
	);

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl, { backoffMs: [0, 0] });

	assert.equal(calls.length, MAX_PROBE_ATTEMPTS, "every 402 sample must be retried");
	assert.equal(result.status, 402);
	assert.equal(result.healthy, false);
	assert.equal(result.verdict, "unavailable");
	assert.equal(result.attempts, MAX_PROBE_ATTEMPTS);
	assert.equal(summarizeResults([result]).exitCode, 0, "402 is availability, never a catalog verdict");
});

test("a 429 rate limit is retried as an availability fault", async () => {
	const { calls, fetchImpl } = recordingFetch((callIndex) => {
		if (callIndex === 0) {
			return new Response(JSON.stringify({ error: { message: "Shared free-tier IP quota reached" } }), {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		}
		return unreadableStreamingResponse(() => {});
	});

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl, { backoffMs: [0, 0] });

	assert.equal(calls.length, 2);
	assert.equal(result.healthy, true);
});

test("a 404 endpoint-unavailable answer is retried, a model-level 404 is not", async () => {
	const blip = recordingFetch((callIndex) =>
		callIndex === 0
			? new Response(JSON.stringify({ error: { message: "Upstream request failed: Endpoint is unavailable." } }), {
					status: 404,
					headers: { "content-type": "application/json" },
				})
			: unreadableStreamingResponse(() => {}),
	);
	const recovered = await probeModel(41810, CHAT_MODEL, blip.fetchImpl, { backoffMs: [0, 0] });
	assert.equal(blip.calls.length, 2);
	assert.equal(recovered.healthy, true);
	assert.equal(recovered.verdict, "healthy");

	const missing = recordingFetch(
		() =>
			new Response(JSON.stringify({ error: { message: "The requested model does not exist" } }), {
				status: 404,
				headers: { "content-type": "application/json" },
			}),
	);
	const gone = await probeModel(41810, CHAT_MODEL, missing.fetchImpl, { backoffMs: [0, 0] });
	assert.equal(missing.calls.length, 1, "a model-not-found 404 is the upstream's final answer");
	assert.equal(gone.healthy, false);
	assert.equal(gone.status, 404);
	assert.equal(gone.verdict, "dead");
	assert.equal(summarizeResults([gone]).exitCode, 1);
});

test("an HTTP failure status is never retried and keeps its upstream detail", async () => {
	const { calls, fetchImpl } = recordingFetch(
		() =>
			new Response(JSON.stringify({ error: { message: "FreeTierError" } }), {
				status: 403,
				headers: { "content-type": "application/json" },
			}),
	);

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl, { backoffMs: [0, 0] });

	assert.equal(calls.length, 1);
	assert.equal(result.healthy, false);
	assert.equal(result.status, 403);
	assert.equal(result.verdict, "dead");
	assert.equal(result.attempts, 1);
	assert.equal(result.error, "FreeTierError");
	assert.equal(summarizeResults([result]).exitCode, 1);
});

test("a 410 deprecated answer is terminal and single-shot", async () => {
	const { calls, fetchImpl } = recordingFetch(
		() =>
			new Response(JSON.stringify({ error: { message: "Model muse-spark-1.2-contributor-free has been deprecated." } }), {
				status: 410,
				headers: { "content-type": "application/json" },
			}),
	);

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl, { backoffMs: [0, 0] });

	assert.equal(calls.length, 1);
	assert.equal(result.healthy, false);
	assert.equal(result.status, 410);
	assert.equal(result.verdict, "dead");
	assert.equal(result.attempts, 1);
	assert.equal(summarizeResults([result]).exitCode, 1, "a deprecated model is the one case that alerts");
});

// ── severity classification, summary, and report (no network) ───────────────

/** A finished sample, shaped exactly as probeModel returns one. */
function sampleResult(id: string, verdict: ProbeVerdict, status: number, error?: string): ModelHealthResult {
	return {
		id,
		api: "openai-completions",
		status,
		latencyMs: 5,
		healthy: verdict === "healthy",
		verdict,
		attempts: verdict === "dead" ? 1 : MAX_PROBE_ATTEMPTS,
		error,
	};
}

test("classifies each status into the verdict that decides alerting", () => {
	const verdictOf = (status: number, error?: string): ProbeVerdict =>
		classifyProbeResult({ healthy: status >= 200 && status < 300, status, error });
	const expectations: Array<[string, number, string | undefined, ProbeVerdict]> = [
		["success", 200, undefined, "healthy"],
		["bad request", 400, "invalid request", "dead"],
		["unauthorized", 401, "unauthorized", "dead"],
		["free-tier gate", 403, "FreeTierError", "dead"],
		["model not found", 404, "The requested model does not exist", "dead"],
		["deprecated", 410, "Model x has been deprecated.", "dead"],
		["payment availability", 402, "Upstream request failed: Endpoint is unavailable.", "unavailable"],
		["endpoint-unavailable 404", 404, "Upstream request failed: Endpoint is unavailable.", "unavailable"],
		["request timeout", 408, "request timeout", "unavailable"],
		["rate limit", 429, "Shared free-tier IP quota reached", "unavailable"],
		["server fault", 503, "Endpoint is unavailable", "unavailable"],
		["network fault", 0, "fetch failed", "unavailable"],
		["probe cap (aborted)", 0, "The operation was aborted due to timeout", "timeout"],
		["probe cap (timed out)", 0, "request timed out", "timeout"],
	];
	for (const [label, status, error, expected] of expectations) {
		assert.equal(verdictOf(status, error), expected, `${label} (HTTP ${status})`);
	}
});

test("only a dead model exits nonzero; availability and timeouts exit 0", () => {
	const healthy = sampleResult("healthy-model", "healthy", 200);
	const unavailable = sampleResult(
		"unavailable-model",
		"unavailable",
		402,
		"Upstream request failed: Endpoint is unavailable.",
	);
	const timeout = sampleResult("timeout-model", "timeout", 0, "The operation was aborted due to timeout");
	const dead = sampleResult("dead-model", "dead", 410, "Model dead-model has been deprecated.");

	const degraded = summarizeResults([healthy, unavailable, timeout]);
	assert.equal(degraded.total, 3);
	assert.equal(degraded.healthyCount, 1);
	assert.equal(degraded.affectedCount, 2, "affectedCount still counts every non-healthy sample");
	assert.equal(degraded.deadCount, 0);
	assert.equal(degraded.degradedCount, 2);
	assert.equal(degraded.exitCode, 0, "availability faults and timeouts must never file an issue");

	const mixed = summarizeResults([healthy, unavailable, timeout, dead]);
	assert.equal(mixed.exitCode, 1);
	assert.equal(mixed.deadCount, 1);
	assert.deepEqual(mixed.dead.map((result) => result.id), ["dead-model"]);
	assert.equal(summarizeResults([]).exitCode, 0);
});

test("the report separates dead from availability and never calls it affected", () => {
	const report = generateMarkdownReport([
		sampleResult("healthy-model", "healthy", 200),
		sampleResult("unavailable-model", "unavailable", 402, "Upstream request failed: Endpoint is unavailable."),
		sampleResult("timeout-model", "timeout", 0, "The operation was aborted due to timeout"),
		sampleResult("dead-model", "dead", 410, "Model dead-model has been deprecated."),
	]);

	assert.match(report, /- \*\*Status\*\*: 🚨 1 Model\(s\) Dead/);
	assert.match(report, /### ❌ Dead Models \(alerting\)/);
	assert.match(report, /### 🚦 Unavailable \(retried; availability fault, no catalog action\)/);
	assert.match(report, /### ⏱ Timeout \(inconclusive, probe cap\)/);
	assert.match(report, /^\| `dead-model` \|.*\| ❌ Dead \|$/m);
	assert.match(report, /^\| `unavailable-model` \|.*\| 🚦 Unavailable \|$/m);
	assert.match(report, /^\| `timeout-model` \|.*\| ⏱ Timeout \|$/m);
	assert.ok(!/Affected|Disruption/.test(report), "availability must never be reported as affected or a disruption");
});

test("the report header distinguishes degraded-only from all-healthy", () => {
	const degraded = generateMarkdownReport([
		sampleResult("healthy-model", "healthy", 200),
		sampleResult("unavailable-model", "unavailable", 402, "Upstream request failed: Endpoint is unavailable."),
		sampleResult("timeout-model", "timeout", 0, "The operation was aborted due to timeout"),
	]);
	assert.match(degraded, /- \*\*Status\*\*: 🚦 2 Model\(s\) Unavailable \(no alert\)/);
	assert.ok(!/### ❌ Dead Models/.test(degraded), "a degraded run has no dead-model section");

	const clean = generateMarkdownReport([sampleResult("healthy-model", "healthy", 200)]);
	assert.match(clean, /- \*\*Status\*\*: ✅ All OpenCode Free Models Healthy/);
});

// ── local-proxy authorization gate ──────────────────────────────────────────

/**
 * The probe runs through the loopback proxy, whose /v1/* routes require the
 * per-installation token. A probe that forgets it collects our own 401 and the
 * health check then files an alert about a healthy catalog, so this stub
 * answers exactly like the daemon gate: 401 without `Authorization: Bearer
 * <token>`, 200 with it.
 */
test("probeModel carries the installation token through the daemon gate", async () => {
	const token = ensureToken();
	const seen: Array<string | undefined> = [];
	const gate = http.createServer((req, res) => {
		seen.push(req.headers.authorization);
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", () => resolve()));
	const address = gate.address();
	const port = typeof address === "object" && address ? address.port : 0;
	try {
		const result = await probeModel(port, CHAT_MODEL, fetch, { maxAttempts: 1, backoffMs: [0] });
		assert.equal(
			result.healthy,
			true,
			`the probe must pass the gate: HTTP ${result.status} ${result.error ?? ""}`,
		);
		assert.equal(result.status, 200);
		assert.deepEqual(seen, [`Bearer ${token}`], "every probe request carries the proxy token");

		// The same stub without the header is a 401 — that is the failure the
		// assertion above catches if probeModel stops sending the token.
		const denied = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: CHAT_MODEL.id, messages: [], stream: true }),
		});
		assert.equal(denied.status, 401);
		await denied.body?.cancel().catch(() => {});
		assert.equal(seen.length, 2);
		assert.equal(seen[1], undefined);
	} finally {
		await new Promise<void>((resolve) => gate.close(() => resolve()));
	}
});

/** Preload for the CLI child: only the loopback proxy is reached for real,
 * every upstream answer comes from here, so the run stays offline. */
const UPSTREAM_STUB_SOURCE = `const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
	const url = String(typeof input === "string" ? input : (input?.url ?? input));
	if (url.includes("127.0.0.1") || url.includes("localhost") || url.includes("[::1]")) {
		return realFetch(input, init);
	}
	const status = Number(process.env.UPSTREAM_STUB_STATUS || 200);
	if (status >= 400) {
		return new Response(JSON.stringify({ error: { message: process.env.UPSTREAM_STUB_MESSAGE || "stub upstream failure" } }), {
			status,
			headers: { "content-type": "application/json" },
		});
	}
	return new Response('data: {"id":"chatcmpl-stub","choices":[{"delta":{"content":"pong"}}]}\\n\\ndata: [DONE]\\n\\n', {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
};
`;

/**
 * CLI-level check: the script boots its own daemon and probes it over
 * loopback, so it passes the real gate (not a stub of it). Every upstream
 * answer is stubbed, which makes the exit-code contract observable offline.
 */
async function runHealthCheckCli(upstream: { status: number; message?: string; args?: string[] }) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ff-model-check-"));
	const preload = path.join(scratch, "stub-fetch.mjs");
	const jsonOut = path.join(scratch, "health.json");
	fs.writeFileSync(preload, UPSTREAM_STUB_SOURCE, "utf8");
	// Fresh data dir: the CLI's daemon writes its own token there and the CLI
	// reads it back, while the empty relay state keeps the run on the direct
	// (stubbed) upstream path.
	const dataDir = path.join(scratch, "data");
	const args = [
		"--experimental-strip-types",
		"--import",
		pathToFileURL(preload).href,
		path.join(ROOT, "scripts", "check-opencode-models.ts"),
		...(upstream.args ?? []).map((arg) => (arg === "<json-output>" ? jsonOut : arg)),
	];
	const child = spawn(
		process.execPath,
		args,
		{
			cwd: ROOT,
			env: {
				...process.env,
				[DATA_DIR_ENV]: dataDir,
				UPSTREAM_STUB_STATUS: String(upstream.status),
				UPSTREAM_STUB_MESSAGE: upstream.message ?? "",
			},
			windowsHide: true,
			// Watchdog, not pacing: the run ends on the child's exit. Without it a
			// wedged CLI would hang the test file instead of failing it.
			timeout: 120_000,
			killSignal: "SIGKILL",
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => { stdout += String(chunk); });
	child.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk); });
	try {
		const exited = Promise.withResolvers<number | null>();
		child.on("exit", (code) => exited.resolve(code));
		const code = await exited.promise;
		return {
			code,
			stdout,
			stderr,
			jsonReport: fs.existsSync(jsonOut) ? fs.readFileSync(jsonOut, "utf8") : null,
			tokenWritten: fs.existsSync(path.join(dataDir, "token")),
		};
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

test("the health-check CLI exits 0 through the real daemon gate", async () => {
	const run = await runHealthCheckCli({ status: 200 });
	assert.equal(
		run.code,
		0,
		`CLI must exit 0 against a healthy catalog; stdout=${run.stdout.slice(-300)} stderr=${run.stderr.slice(-300)}`,
	);
	assert.match(run.stdout, /All \d+ models healthy/);
	assert.ok(!/affected/.test(run.stderr), `no model may be reported affected: ${run.stderr.slice(-300)}`);
	assert.ok(run.tokenWritten, "the CLI's daemon wrote the token the CLI authenticated with");
});

test("the health-check CLI writes a bare JSON file the workflow can parse", async () => {
	const run = await runHealthCheckCli({ status: 200, args: ["--json-output", "<json-output>"] });
	assert.equal(
		run.code,
		0,
		`CLI must exit 0 against a healthy catalog; stdout=${run.stdout.slice(-300)} stderr=${run.stderr.slice(-300)}`,
	);
	assert.ok(run.jsonReport, "the CLI must write the file named by --json-output");
	const report = JSON.parse(run.jsonReport as string) as { deadCount: number; degradedCount: number; affectedCount: number };
	assert.equal(report.deadCount, 0);
	assert.equal(report.degradedCount, 0);
	assert.equal(report.affectedCount, 0);
});

test("the health-check CLI exits 1 only when a model is dead", async () => {
	const run = await runHealthCheckCli({ status: 410, message: "The model has been deprecated." });
	assert.equal(
		run.code,
		1,
		`a deprecated model must exit 1; stdout=${run.stdout.slice(-300)} stderr=${run.stderr.slice(-300)}`,
	);
	assert.match(run.stdout, /❌ Dead/);
	assert.match(run.stderr, /dead \(model-level failure\)/);
	assert.ok(run.tokenWritten, "the CLI's daemon wrote the token the CLI authenticated with");
});
