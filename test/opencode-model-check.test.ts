import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeModel, MAX_PROBE_ATTEMPTS, RETRY_BACKOFF_MS, TIMEOUT_MS } from "../scripts/check-opencode-models.ts";
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
	id: "cline-free/muse-spark-1.3-contributor",
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

test("a status-0 timeout is retried and can recover", async () => {
	const { calls, fetchImpl } = recordingFetch((callIndex) => {
		if (callIndex === 0) {
			throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
		}
		return unreadableStreamingResponse(() => {});
	});

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl, { backoffMs: [0, 0] });

	assert.equal(calls.length, 2);
	assert.equal(result.healthy, true);
	assert.equal(result.status, 200);
	assert.equal(result.attempts, 2);
});

test("an exhausted retry reports status 0 with the last error", async () => {
	const { calls, fetchImpl } = recordingFetch(() => {
		throw new Error("fetch failed");
	});

	const result = await probeModel(41810, CHAT_MODEL, fetchImpl, { backoffMs: [0, 0] });

	assert.equal(calls.length, 3, "status-0 failures get two retries");
	assert.equal(result.healthy, false);
	assert.equal(result.status, 0);
	assert.equal(result.attempts, 3);
	assert.equal(result.error, "fetch failed");
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
	assert.equal(result.attempts, 2);
});

test("a 429 rate limit is retried before the model is called affected", async () => {
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
	assert.equal(result.attempts, 1);
	assert.equal(result.error, "FreeTierError");
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
	assert.equal(result.attempts, 1);
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
	return new Response('data: {"id":"chatcmpl-stub","choices":[{"delta":{"content":"pong"}}]}\\n\\ndata: [DONE]\\n\\n', {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
};
`;

/**
 * CLI-level check: the script boots its own daemon and probes it over
 * loopback, so it passes the real gate (not a stub of it) and reports the
 * whole catalog healthy. Exit 1 with "model(s) affected" is exactly what the
 * model-health workflow would file as an alert.
 */
test("the health-check CLI exits 0 through the real daemon gate", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ff-model-check-"));
	const preload = path.join(scratch, "stub-fetch.mjs");
	fs.writeFileSync(preload, UPSTREAM_STUB_SOURCE, "utf8");
	// Fresh data dir: the CLI's daemon writes its own token there and the CLI
	// reads it back, while the empty relay state keeps the run on the direct
	// (stubbed) upstream path.
	const dataDir = path.join(scratch, "data");
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--import", pathToFileURL(preload).href, path.join(ROOT, "scripts", "check-opencode-models.ts")],
		{
			cwd: ROOT,
			env: { ...process.env, [DATA_DIR_ENV]: dataDir },
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
		const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
		assert.equal(
			code,
			0,
			`CLI must exit 0 against a healthy catalog; stdout=${stdout.slice(-300)} stderr=${stderr.slice(-300)}`,
		);
		assert.match(stdout, /All \d+ models healthy/);
		assert.ok(!/affected/.test(stderr), `no model may be reported affected: ${stderr.slice(-300)}`);
		assert.ok(
			fs.existsSync(path.join(dataDir, "token")),
			"the CLI's daemon wrote the token the CLI authenticated with",
		);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});
