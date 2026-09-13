/**
 * Upstream binds each reasoning `encrypted_content` blob to the service
 * instance that issued it, so a replayed history can come back as
 * "reasoning `encrypted_content` was not issued to this caller". The host then
 * re-sends the same rejected history until the session dies. These tests cover
 * the daemon-side recovery: strip on that exact 400, retry, remember which
 * blobs were rejected, and drop only those on later turns.
 *
 * The 400 text is the verbatim production error captured from
 * ~/.omp/logs/http-400-requests (muse-spark via the Zen Responses endpoint).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startProxy } from "../src/proxy.ts";
import { getActiveRelayState, resetAllRelayHealth, setActiveRelayState } from "../src/relay-state.ts";
import { withIsolatedSandboxFiles } from "./_sandbox-helpers.ts";
import {
	_resetReasoningStateForTest,
	isReasoningCallerMismatch,
	rejectedReasoningCount,
	rememberIssuerRelay,
	rememberRejectedReasoning,
	responsesConversationKey,
	stripRejectedReasoning,
	stripReasoningEncryption,
} from "../src/responses.ts";
import type { RelayState } from "../src/types.ts";

const CALLER_MISMATCH_400 =
	'{"status":400,"message":"400 Error from provider (Console): Upstream request failed: [invalid_request_error] reasoning `encrypted_content` was not issued to this caller\\nError from provider (Console): Upstream request failed"}';

const CONVERSATION_A = "01a0916c-4ea5-7724-a7f4-287405a5c38b";
const CONVERSATION_B = "01a087d3-1935-7366-b07e-61083dd1c190";
const BLOB_REJECTED = "Q-PaDgGZsZwYwucXWKWXkBWujf6p3Ko_oNq57dMu";
const BLOB_REJECTED_2 = "Q-PaDgGsF-NLgFTFKwFhoSUiF4ejrEgP18UUMGZf";
const BLOB_FRESH = "Q-PaDgFU3NeYxt1RtWEUuGCrTruFZl_hcMSmQNtOyAsv";

/** Reasoning item as captured in production: no id, only summary + blob. */
function reasoning(blob: string, summary = ""): Record<string, unknown> {
	const item: Record<string, unknown> = { type: "reasoning", summary: summary ? [summary] : [] };
	if (blob) item.encrypted_content = blob;
	return item;
}

/** Responses body shaped like the captured production payload. */
function responsesBody(key: string, blobs: string[]): string {
	return JSON.stringify({
		model: "muse-spark-1.3-contributor-free",
		store: false,
		stream: false,
		prompt_cache_key: key,
		include: ["reasoning.encrypted_content"],
		input: [
			{ type: "message", id: "msg_1", role: "user", content: "hi" },
			...blobs.map((blob) => reasoning(blob)),
			{ type: "function_call", id: "fc_1", name: "read", arguments: "{}" },
			{ type: "function_call_output", id: "fco_1", call_id: "fc_1", output: "ok" },
		],
	});
}

function blobsIn(body: string | Buffer): string[] {
	const text = typeof body === "string" ? body : body.toString("utf8");
	const parsed = JSON.parse(text) as { input?: Array<Record<string, unknown>> };
	return (parsed.input ?? [])
		.filter((i) => typeof i.encrypted_content === "string")
		.map((i) => String(i.encrypted_content));
}

/** Response stub that also supports the clone() the recovery path inspects. */
function stubResponse(status: number, body: string): Response {
	const make = (): Response =>
		({
			status,
			ok: status >= 200 && status < 300,
			headers: new Headers({ "content-type": "application/json" }),
			text: async () => body,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(body));
					controller.close();
				},
			}),
		}) as unknown as Response;
	const response = make();
	// The proxy inspects 400 bodies through clone(); a hand-built stub omits it.
	const withClone = response as Response & { clone: () => Response };
	withClone.clone = make;
	return response;
}

function relayState(relays: string[]): RelayState {
	return {
		mode: "auto",
		enabled: true,
		url: relays[0] ?? "",
		relays: relays.map((url) => ({ url }) as RelayState["relays"][number]),
	};
}

/**
 * Start the proxy with upstream fetch stubbed; requests to the local port pass
 * through to the real fetch so the full HTTP path is exercised.
 */
async function withProxy(
	port: number,
	relays: string[],
	upstream: (url: string, body: string) => Response,
	fn: (port: number, calls: Array<{ url: string; body: string }>) => Promise<void>,
): Promise<void> {
	const { server, port: bound } = await startProxy(port);
	const effectivePort = bound ?? port;
	const localPrefix = `http://127.0.0.1:${effectivePort}`;
	const realFetch = globalThis.fetch.bind(globalThis);
	const calls: Array<{ url: string; body: string }> = [];
	try {
		setActiveRelayState(relayState(relays), false);
		resetAllRelayHealth();
		const fetchMock = test.mock.method(
			globalThis,
			"fetch",
			async (url: unknown, init?: RequestInit) => {
				const u = String(url);
				if (u.startsWith(localPrefix)) return realFetch(u, init);
				const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
				calls.push({ url: u, body });
				return upstream(u, body);
			},
		);
		try {
			await fn(effectivePort, calls);
		} finally {
			fetchMock.mock.restore();
		}
	} finally {
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

async function postResponses(port: number, body: string): Promise<Response> {
	return await fetch(`http://127.0.0.1:${port}/v1/responses`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
}

// ── Unit: signature, strip, rejection memory ────────────────────────────────

test("reasoning portability: recognizes only the caller-binding rejection", () => {
	assert.equal(isReasoningCallerMismatch(CALLER_MISMATCH_400), true);
	assert.equal(
		isReasoningCallerMismatch('{"message":"[invalid_request_error] context length exceeded"}'),
		false,
	);
	assert.equal(isReasoningCallerMismatch("rate limit reached"), false);
});

test("reasoning portability: conversation key comes from prompt_cache_key only", () => {
	assert.equal(responsesConversationKey({ prompt_cache_key: CONVERSATION_A }), CONVERSATION_A);
	assert.equal(responsesConversationKey({ prompt_cache_key: "" }), null);
	assert.equal(responsesConversationKey({}), null);
	assert.equal(responsesConversationKey(null), null);
});

test("reasoning portability: full strip keeps items, ids and include", () => {
	const raw = Buffer.from(responsesBody(CONVERSATION_A, [BLOB_REJECTED, BLOB_REJECTED_2]), "utf8");
	const stripped = stripReasoningEncryption(raw);
	assert.ok(stripped, "a body with blobs must be rewritten");
	const parsed = JSON.parse(stripped.toString("utf8")) as {
		input: Array<Record<string, unknown>>;
		include: string[];
	};
	assert.equal(blobsIn(stripped).length, 0, "no blob may survive");
	assert.equal(parsed.input.length, 5, "items must survive, not be dropped");
	assert.deepEqual(parsed.input[1], { type: "reasoning", summary: [] });
	assert.equal(parsed.input[3].id, "fc_1", "tool calls keep their ids");
	assert.deepEqual(parsed.include, ["reasoning.encrypted_content"], "include stays so the caller re-issues blobs");
});

test("reasoning portability: leaves bodies without blobs untouched", () => {
	assert.equal(stripReasoningEncryption(Buffer.from(responsesBody(CONVERSATION_A, []))), null);
	assert.equal(stripReasoningEncryption(Buffer.from('{"model":"x","messages":[]}')), null);
	assert.equal(stripReasoningEncryption(Buffer.from("not json")), null);
	_resetReasoningStateForTest();
	assert.equal(stripRejectedReasoning(Buffer.from(responsesBody(CONVERSATION_A, [BLOB_REJECTED])), null), null);
	assert.equal(stripRejectedReasoning(Buffer.from(responsesBody(CONVERSATION_A, [BLOB_REJECTED])), CONVERSATION_A), null, "unknown conversation has nothing to strip");
});

test("reasoning portability: selective strip drops only remembered blobs", () => {
	_resetReasoningStateForTest();
	const rejected = Buffer.from(responsesBody(CONVERSATION_A, [BLOB_REJECTED, BLOB_REJECTED_2]), "utf8");
	assert.equal(rememberRejectedReasoning(rejected, CONVERSATION_A), 2);
	assert.equal(rejectedReasoningCount(CONVERSATION_A), 2);
	assert.equal(rejectedReasoningCount(CONVERSATION_B), 0, "other conversations stay untouched");

	const nextTurn = responsesBody(CONVERSATION_A, [BLOB_REJECTED, BLOB_FRESH]);
	const stripped = stripRejectedReasoning(Buffer.from(nextTurn), CONVERSATION_A);
	assert.ok(stripped, "a remembered blob present in the body must be stripped");
	assert.deepEqual(
		blobsIn(stripped),
		[BLOB_FRESH],
		"the blob the current instance issued must survive, only the rejected one is dropped",
	);
	_resetReasoningStateForTest();
});

// ── End to end through the proxy ────────────────────────────────────────────

test("proxy recovers a rejected reasoning replay and keeps the session alive", async () => {
	_resetReasoningStateForTest();
	await withIsolatedSandboxFiles(async () => {
		await withProxy(
			19287,
			["https://relay1.example.com"],
			(_url, body) =>
				blobsIn(body).length > 0
					? stubResponse(400, CALLER_MISMATCH_400)
					: stubResponse(200, '{"id":"resp_ok","status":"completed"}'),
			async (port, calls) => {
				const res = await postResponses(
					port,
					responsesBody(CONVERSATION_A, [BLOB_REJECTED, BLOB_REJECTED_2]),
				);
				assert.equal(res.status, 200, "the host must never see the caller-mismatch 400");
				const json = (await res.json()) as { id?: string };
				assert.equal(json.id, "resp_ok");

				assert.equal(calls.length, 2, "one rejected attempt, one stripped retry");
				assert.deepEqual(blobsIn(calls[0].body), [BLOB_REJECTED, BLOB_REJECTED_2], "first attempt replays the history verbatim");
				assert.equal(blobsIn(calls[1].body).length, 0, "retry drops every blob it cannot attribute");
				assert.equal(rejectedReasoningCount(CONVERSATION_A), 2, "the rejected blobs are remembered");
			},
		);
	});
	_resetReasoningStateForTest();
});

test("later turns keep blobs issued after the rejection", async () => {
	_resetReasoningStateForTest();
	await withIsolatedSandboxFiles(async () => {
		await withProxy(
			19290,
			["https://relay1.example.com"],
			(_url, body) =>
				blobsIn(body).includes(BLOB_REJECTED)
					? stubResponse(400, CALLER_MISMATCH_400)
					: stubResponse(200, '{"id":"resp_ok","status":"completed"}'),
			async (port, calls) => {
				// Turn 1: rejected, recovered, blobs remembered.
				assert.equal((await postResponses(port, responsesBody(CONVERSATION_A, [BLOB_REJECTED]))).status, 200);
				assert.equal(calls.length, 2);
				assert.equal(rejectedReasoningCount(CONVERSATION_A), 1);

				// Turn 2: the rejected blob is gone from the wire, the fresh one is sent.
				assert.equal(
					(await postResponses(port, responsesBody(CONVERSATION_A, [BLOB_REJECTED, BLOB_FRESH]))).status,
					200,
				);
				assert.equal(calls.length, 3, "a remembered conversation needs no extra upstream attempt");
				assert.deepEqual(blobsIn(calls[2].body), [BLOB_FRESH], "only the rejected blob is dropped");

				// A different conversation is never touched: its first attempt still
				// carries the blob and only its own retry strips it.
				assert.equal((await postResponses(port, responsesBody(CONVERSATION_B, [BLOB_REJECTED]))).status, 200);
				assert.deepEqual(blobsIn(calls[3].body), [BLOB_REJECTED], "other conversations stay verbatim on the first attempt");
				assert.equal(blobsIn(calls[4].body).length, 0, "B's own rejection strips its retry");
				assert.equal(rejectedReasoningCount(CONVERSATION_B), 1, "B remembers its own rejected blobs");
			},
		);
	});
	_resetReasoningStateForTest();
});

test("a second burst still recovers when the fresh blob is also unreadable", async () => {
	_resetReasoningStateForTest();
	await withIsolatedSandboxFiles(async () => {
		// Both blobs are unreadable to the instance serving this test: B1 from the
		// first burst, B_FRESH from the instance that served the turn after it.
		const unreadable = [BLOB_REJECTED, BLOB_FRESH];
		await withProxy(
			19291,
			["https://relay1.example.com"],
			(_url, body) =>
				blobsIn(body).some((b) => unreadable.includes(b))
					? stubResponse(400, CALLER_MISMATCH_400)
					: stubResponse(200, '{"id":"resp_ok","status":"completed"}'),
			async (port, calls) => {
				// Burst 1: rejected, recovered, B1 remembered.
				assert.equal((await postResponses(port, responsesBody(CONVERSATION_A, [BLOB_REJECTED]))).status, 200);
				assert.equal(calls.length, 2);
				assert.equal(rejectedReasoningCount(CONVERSATION_A), 1);

				// Burst 2: B1 is stripped up front, but the blob issued afterwards is
				// unreadable too. The retry must still fire or the session dies on 400.
				assert.equal(
					(await postResponses(port, responsesBody(CONVERSATION_A, [BLOB_REJECTED, BLOB_FRESH]))).status,
					200,
					"a second burst must not surface the 400 to the host",
				);
				assert.equal(calls.length, 4, "selective strip, rejection, full-strip retry expect three extra calls");
				assert.equal(blobsIn(calls[2].body).length, 1, "proactive strip keeps the blob the current instance issued");
				assert.equal(blobsIn(calls[3].body).length, 0, "the retry drops every blob");
				assert.equal(rejectedReasoningCount(CONVERSATION_A), 2, "the second burst is remembered too");
			},
		);
	});
	_resetReasoningStateForTest();
});

test("affinity keeps the conversation on its issuing relay, blobs intact", async () => {
	_resetReasoningStateForTest();
	await withIsolatedSandboxFiles(async () => {
		await withProxy(
			19292,
			["https://relay1.example.com", "https://relay2.example.com"],
			() => stubResponse(200, '{"id":"resp_ok","status":"completed"}'),
			async (port, calls) => {
				rememberIssuerRelay(CONVERSATION_A, "https://relay2.example.com");
				const res = await postResponses(port, responsesBody(CONVERSATION_A, [BLOB_FRESH]));
				assert.equal(res.status, 200);
				assert.ok(
					calls[0].url.startsWith("https://relay2.example.com"),
					`must prefer the issuing relay, used: ${calls[0].url}`,
				);
				assert.deepEqual(blobsIn(calls[0].body), [BLOB_FRESH], "same backend: history stays verbatim");
				assert.equal(calls.length, 1);
			},
		);
	});
	_resetReasoningStateForTest();
});

test("issuer unavailable ships a portable history in one attempt, no 400", async () => {
	_resetReasoningStateForTest();
	await withIsolatedSandboxFiles(async () => {
		let rejections = 0;
		await withProxy(
			19293,
			["https://relay1.example.com"],
			(_url, body) => {
				if (blobsIn(body).length > 0) {
					rejections += 1;
					return stubResponse(400, CALLER_MISMATCH_400);
				}
				return stubResponse(200, '{"id":"resp_ok","status":"completed"}');
			},
			async (port, calls) => {
				// The conversation was issued by a relay that is no longer in the pool.
				rememberIssuerRelay(CONVERSATION_A, "https://relay-retired.example.com");
				const res = await postResponses(port, responsesBody(CONVERSATION_A, [BLOB_REJECTED, BLOB_FRESH]));
				assert.equal(res.status, 200);
				assert.equal(calls.length, 1, "the switch must not cost a rejected attempt");
				assert.equal(rejections, 0, "upstream must never see the unusable blobs");
				assert.equal(blobsIn(calls[0].body).length, 0, "history goes out portable");
				assert.equal(rejectedReasoningCount(CONVERSATION_A), 2, "the abandoned blobs are never replayed");
			},
		);
	});
	_resetReasoningStateForTest();
});

test("relay to direct also ships a portable history", async () => {
	_resetReasoningStateForTest();
	await withIsolatedSandboxFiles(async () => {
		const { server, port } = await startProxy(19298);
		const effectivePort = port ?? 19298;
		const realFetch = globalThis.fetch.bind(globalThis);
		const calls: Array<{ url: string; body: string }> = [];
		try {
			setActiveRelayState(relayState(["https://relay1.example.com"]), false);
			resetAllRelayHealth();
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(`http://127.0.0.1:${effectivePort}`)) return realFetch(u, init);
					const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
					calls.push({ url: u, body });
					return stubResponse(200, '{"id":"direct_ok"}');
				},
			);
			try {
				rememberIssuerRelay(CONVERSATION_A, "https://relay1.example.com");
				setActiveRelayState({ mode: "off", enabled: false, url: "", relays: [] }, false);
				const res = await postResponses(effectivePort, responsesBody(CONVERSATION_A, [BLOB_FRESH]));
				assert.equal(res.status, 200);
				assert.ok(calls[0].url.includes("opencode.ai"), `direct route expected, used: ${calls[0].url}`);
				assert.equal(blobsIn(calls[0].body).length, 0, "direct is a different backend: history goes out portable");
				assert.equal(calls.length, 1);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
	_resetReasoningStateForTest();
});

test("pinned conversations do not flip the machine-wide sticky relay", async () => {
	_resetReasoningStateForTest();
	await withIsolatedSandboxFiles(async () => {
		const relays = ["https://relay1.example.com", "https://relay2.example.com"];
		await withProxy(
			19294,
			relays,
			() => stubResponse(200, '{"id":"resp_ok","status":"completed"}'),
			async (port, calls) => {
				// Persist the pool so the mtime-driven disk reload in
				// getOrderedRelayUrls() cannot pick up a previous test's state.
				setActiveRelayState(relayState(relays), true);
				rememberIssuerRelay(CONVERSATION_A, "https://relay2.example.com");
				rememberIssuerRelay(CONVERSATION_B, "https://relay1.example.com");
				const activeBefore = getActiveRelayState().url;

				// Conversation A is pinned to relay2, B to relay1: alternating turns
				// must each reach their own issuer without rewriting the sticky primary.
				for (const key of [CONVERSATION_A, CONVERSATION_B, CONVERSATION_A]) {
					assert.equal((await postResponses(port, responsesBody(key, [BLOB_FRESH]))).status, 200);
				}
				assert.ok(calls[0].url.startsWith("https://relay2.example.com"), calls[0].url);
				assert.ok(calls[1].url.startsWith("https://relay1.example.com"), calls[1].url);
				assert.ok(calls[2].url.startsWith("https://relay2.example.com"), calls[2].url);
				assert.equal(
					getActiveRelayState().url,
					activeBefore,
					"affinity must not churn the machine-wide primary",
				);
			},
		);
	});
	_resetReasoningStateForTest();
});

test("a real roll still updates the sticky relay", async () => {
	_resetReasoningStateForTest();
	await withIsolatedSandboxFiles(async () => {
		await withProxy(
			19295,
			["https://relay1.example.com", "https://relay2.example.com"],
			(url) =>
				url.startsWith("https://relay1.example.com")
					? stubResponse(503, '{"error":"relay down"}')
					: stubResponse(200, '{"id":"resp_ok","status":"completed"}'),
			async (port, calls) => {
				setActiveRelayState(relayState(["https://relay1.example.com", "https://relay2.example.com"]), true);
				// No affinity recorded: the primary fails and the winner must become
				// the sticky relay, exactly as before affinity existed.
				assert.equal((await postResponses(port, responsesBody(CONVERSATION_A, [BLOB_FRESH]))).status, 200);
				assert.ok(calls[1].url.startsWith("https://relay2.example.com"), calls[1].url);
				assert.equal(getActiveRelayState().url, "https://relay2.example.com");
			},
		);
	});
	_resetReasoningStateForTest();
});

test("unrelated upstream 400s pass through without a retry", async () => {
	_resetReasoningStateForTest();
	await withIsolatedSandboxFiles(async () => {
		const otherError = '{"error":{"type":"invalid_request_error","message":"context length exceeded"}}';
		await withProxy(
			19296,
			["https://relay1.example.com"],
			() => stubResponse(400, otherError),
			async (port, calls) => {
				const res = await postResponses(port, responsesBody(CONVERSATION_A, [BLOB_REJECTED]));
				assert.equal(res.status, 400);
				assert.equal(calls.length, 1, "a non-caller-mismatch 400 must not be retried");
				assert.equal((await res.text()).includes("context length exceeded"), true, "the upstream error reaches the host");
			},
		);
	});
	_resetReasoningStateForTest();
});

test("direct mode recovers the same rejection", async () => {
	_resetReasoningStateForTest();
	await withIsolatedSandboxFiles(async () => {
		const { server, port } = await startProxy(19297);
		const effectivePort = port ?? 19297;
		const realFetch = globalThis.fetch.bind(globalThis);
		const calls: Array<{ body: string }> = [];
		try {
			setActiveRelayState({ mode: "off", enabled: false, url: "", relays: [] }, false);
			resetAllRelayHealth();
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(`http://127.0.0.1:${effectivePort}`)) return realFetch(u, init);
					const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
					calls.push({ body });
					return blobsIn(body).length > 0
						? stubResponse(400, CALLER_MISMATCH_400)
						: stubResponse(200, '{"id":"direct_ok"}');
				},
			);
			try {
				const res = await postResponses(effectivePort, responsesBody(CONVERSATION_A, [BLOB_REJECTED]));
				assert.equal(res.status, 200);
				assert.equal(calls.length, 2);
				assert.equal(blobsIn(calls[1].body).length, 0);
				assert.equal(rejectedReasoningCount(CONVERSATION_A), 1);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
	_resetReasoningStateForTest();
});
