import test from "node:test";
import assert from "node:assert/strict";
import { probeModel } from "../scripts/check-opencode-models.ts";
import type { ModelDef } from "../src/types.ts";

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
