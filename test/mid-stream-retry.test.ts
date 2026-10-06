/**
	* Mid-stream failover: a relay that closes an SSE stream without a terminal
	* marker while the client is still connected must trigger exactly one
	* re-fire on the next healthy relay, so the turn ends with a real
	* response.completed instead of a synthetic response.incomplete.
	*
	* Regression locks: a clean terminal marker and a client abort must never
	* re-fire, and the retry budget is exactly one even when every relay cuts.
	*/
import "./user-flow-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { PassThrough, Readable } from "node:stream";
import { LOG_FILE } from "../src/config.ts";
import { startProxy } from "../src/proxy.ts";
import {
	getActiveRelayState,
	getRelayHealth,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import { _resetUpstreamHealthForTest } from "../src/upstream-health.ts";
import { clearSandboxFiles, withIsolatedSandboxFiles } from "./_sandbox-helpers.ts";
import {
	isTransientModelFailureFrame,
	getMidStreamFaultStats,
	_resetMidStreamFaultStatsForTest,
	_resetSseStatsForTest,
	pipeUpstreamStream,
} from "../src/stream-pipe.ts";

const PROXY_PORT = 19380;
const RELAY_A = "http://127.0.0.1:19381";
const RELAY_B = "http://127.0.0.1:19382";
const MODEL = "muse-spark-1.3-contributor-free";

function seedPool(): void {
	setActiveRelayState(
		{
			mode: "on",
			enabled: true,
			url: RELAY_A,
			relays: [{ url: RELAY_A }, { url: RELAY_B }],
		} as unknown as RelayState,
		false,
	);
	resetAllRelayHealth();
	_resetUpstreamHealthForTest();
}

const enc = new TextEncoder();
const created = 'event: response.created\ndata: {"type":"response.created"}\n\n';
const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';

/** 200 SSE response that ends after `chunks` deltas with NO terminal marker. */
function cutStream(chunks = 60): Response {
	const parts = [created];
	for (let i = 0; i < chunks; i++) {
		parts.push(`data: {"type":"response.output_text.delta","delta":"partial-${i}"}\n\n`);
	}
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const p of parts) controller.enqueue(enc.encode(p));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** 200 SSE response with a real terminal marker. */
function fullStream(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(enc.encode(created));
				controller.enqueue(enc.encode('data: {"type":"response.output_text.delta","delta":"hello complete"}\n\n'));
				controller.enqueue(enc.encode(completed));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** 200 SSE response that starts a tool call, then is cut with no terminal. */
function cutToolStream(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(enc.encode(created));
				controller.enqueue(enc.encode('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","name":"fetch_docs","call_id":"call_abc"}}\n\n'));
				controller.enqueue(enc.encode('data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"call_abc","delta":"{\\"topic\\""}\n\n'));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function streamBody(): string {
	return JSON.stringify({ model: MODEL, stream: true, input: "mid-stream retry e2e" });
}

test("mid-stream cut on primary re-fires once on next relay; client gets response.completed", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return cutStream();
					}
					if (u.startsWith(RELAY_B)) {
						hits.B = (hits.B ?? 0) + 1;
						return fullStream();
					}
					throw new Error(`unexpected upstream fetch in test: ${u}`);
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: streamBody(),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(
					text.includes("response.completed"),
					`client must receive a real terminal marker after retry, got tail: ${text.slice(-300)}`,
				);
				assert.equal(hits.A, 1, `primary must be hit once, saw ${JSON.stringify(hits)}`);
				assert.equal(hits.B, 1, `retry must fire once on the next relay, saw ${JSON.stringify(hits)}`);
				assert.ok(
					(getRelayHealth(RELAY_A)?.consecutiveFailures ?? 0) >= 1,
					"the cutting relay must be marked failed so rotation avoids it",
				);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

test("clean terminal marker never re-fires", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return fullStream();
					}
					hits.B = (hits.B ?? 0) + 1;
					return fullStream();
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: streamBody(),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(text.includes("response.completed"));
				assert.equal(hits.A, 1);
				assert.equal(hits.B ?? 0, 0, `no retry on a clean terminal, saw ${JSON.stringify(hits)}`);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

test("client abort mid-stream never re-fires and never penalizes the relay", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return new Response(
							new ReadableStream({
								start(controller) {
									controller.enqueue(enc.encode(created));
									controller.enqueue(enc.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
									// Never closes: the client abort below is the only end.
								},
							}),
							{ status: 200, headers: { "content-type": "text/event-stream" } },
						);
					}
					hits.B = (hits.B ?? 0) + 1;
					return fullStream();
				},
			);
			try {
				const ctl = new AbortController();
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: streamBody(),
					signal: ctl.signal,
				});
				assert.equal(res.status, 200);
				const reader = res.body?.getReader();
				assert.ok(reader, "stream body must be readable");
				await reader.read();
				ctl.abort();
				await reader.read().catch(() => null);
				// Await the proxy's own abort acknowledgment in the sandbox
				// log (no exposed promise crosses the socket boundary; poll
				// exits early on the signal, the deadline is only a backstop).
				const deadline = Date.now() + 2000;
				while (Date.now() < deadline) {
					let logged = "";
					try {
						logged = fs.readFileSync(LOG_FILE, "utf8");
					} catch { }
					if (logged.includes("client aborted")) break;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.equal(hits.A, 1);
				assert.equal(hits.B ?? 0, 0, `abort must not re-fire, saw ${JSON.stringify(hits)}`);
				assert.equal(
					getRelayHealth(RELAY_A)?.consecutiveFailures ?? 0,
					0,
					"client abort must not mark the relay failed",
				);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

test("both relays cut: exactly two attempts, client still gets a terminal marker", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return cutStream();
					}
					if (u.startsWith(RELAY_B)) {
						hits.B = (hits.B ?? 0) + 1;
						return cutStream();
					}
					throw new Error(`unexpected upstream fetch in test: ${u}`);
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: streamBody(),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(
					text.includes("response.incomplete"),
					`exhausted retries must still terminate the turn, got tail: ${text.slice(-300)}`,
				);
				assert.ok(!text.includes("response.completed"), "no relay completed the turn");
				assert.equal(
					(hits.A ?? 0) + (hits.B ?? 0),
					2,
					`retry budget is exactly one re-fire, saw ${JSON.stringify(hits)}`,
				);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

test("tool-call turn cut mid-stream never re-fires: no duplicate execution", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return cutToolStream();
					}
					if (u.startsWith(RELAY_B)) {
						hits.B = (hits.B ?? 0) + 1;
						return fullStream();
					}
					throw new Error(`unexpected upstream fetch in test: ${u}`);
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					// The caller advertises fetch_docs (production-shaped): the cloak must
					// pass its calls through with markers intact so the resume veto sees
					// them. A tool-less caller would have them stripped as injected.
					body: JSON.stringify({ model: MODEL, stream: true, input: "tool turn", tools: [{ type: "function", name: "fetch_docs", description: "fetch docs", parameters: { type: "object", properties: {} } }] }),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(
					text.includes("response.incomplete"),
					`tool-call cut must keep the synthetic terminal, got tail: ${text.slice(-300)}`,
				);
				assert.equal(hits.A, 1);
				assert.equal(hits.B ?? 0, 0, `a re-fire would re-execute the forwarded call, saw ${JSON.stringify(hits)}`);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

test("isTransientModelFailureFrame only matches retriable model faults", () => {
	assert.equal(
		isTransientModelFailureFrame('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"The model failed to generate a response"}}}'),
		true,
	);
	assert.equal(
		isTransientModelFailureFrame('data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error"}}}'),
		true,
	);
	assert.equal(
		isTransientModelFailureFrame('data: {"type":"response.failed","response":{"status":"failed","error":{"code":"invalid_request","message":"previous_response_id not found"}}}'),
		false,
		"deterministic verdicts must stay terminal so retries cannot mask them",
	);
	assert.equal(
		isTransientModelFailureFrame('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}'),
		false,
	);
	assert.equal(
		isTransientModelFailureFrame('data: {"type":"response.output_text.delta","delta":"talking about server_error handling"}'),
		false,
		"a lone transient word outside a failed frame must not trigger",
	);
});

/** 200 SSE response with text deltas then an upstream-issued transient model failure frame. */
function failedModelStream(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(enc.encode(created));
				for (let i = 0; i < 10; i++) {
					controller.enqueue(enc.encode(`data: {"type":"response.output_text.delta","delta":"partial-${i}"}\n\n`));
				}
				controller.enqueue(enc.encode('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"The model failed to generate a response"}}}\n\n'));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** 200 SSE response with a caller-owned tool call then a transient model failure frame. */
function failedToolStream(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(enc.encode(created));
				controller.enqueue(enc.encode('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","name":"fetch_docs","call_id":"call_abc"}}\n\n'));
				controller.enqueue(enc.encode('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"The model failed to generate a response"}}}\n\n'));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

test("mid-stream response.failed server_error text-only re-fires once; client gets response.completed", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const faultsBefore = getMidStreamFaultStats().modelFaults;
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return failedModelStream();
					}
					if (u.startsWith(RELAY_B)) {
						hits.B = (hits.B ?? 0) + 1;
						return fullStream();
					}
					throw new Error(`unexpected upstream fetch in test: ${u}`);
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: streamBody(),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(
					text.includes("response.completed"),
					`rescued turn must end with a real terminal marker, got tail: ${text.slice(-300)}`,
				);
				assert.ok(
					!text.includes("failed to generate"),
					"the held failure frame must be dropped on rescue, not forwarded",
				);
				assert.equal(hits.A, 1, `primary must be hit once, saw ${JSON.stringify(hits)}`);
				assert.equal(hits.B, 1, `retry must fire once on the next relay, saw ${JSON.stringify(hits)}`);
				assert.equal(
					getMidStreamFaultStats().modelFaults - faultsBefore,
					1,
					"the upstream-issued failure must count as a model fault, not a relay fault",
				);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

test("mid-stream response.failed server_error after tool calls never re-fires", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const faultsBefore = getMidStreamFaultStats().modelFaults;
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return failedToolStream();
					}
					if (u.startsWith(RELAY_B)) {
						hits.B = (hits.B ?? 0) + 1;
						return fullStream();
					}
					throw new Error(`unexpected upstream fetch in test: ${u}`);
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: MODEL, stream: true, input: "tool turn", tools: [{ type: "function", name: "fetch_docs", description: "fetch docs", parameters: { type: "object", properties: {} } }] }),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(
					text.includes("response.failed"),
					`the genuine upstream verdict must reach the caller, got tail: ${text.slice(-300)}`,
				);
				assert.equal(hits.A, 1);
				assert.equal(hits.B ?? 0, 0, `a re-fire would re-execute the forwarded call, saw ${JSON.stringify(hits)}`);
				assert.equal(
					getMidStreamFaultStats().modelFaults - faultsBefore,
					0,
					"a vetoed hold must not count as a rescued model fault",
				);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

/* ------------------------------------------------------------------ */
/* Edge-case locks for the mid-stream auto-handling. Appended 2026-10-05. */
/* Each test below pins one row of the edge matrix (edges 1-8); the      */
/* pre-existing tests above are untouched. Counters are asserted as      */
/* before/after deltas so the tests stay order-independent.             */
/* ------------------------------------------------------------------ */

/** Deterministic quota verdict that also carries a transient word: only the deterministic-wins ordering keeps it terminal. */
function failedDeterministicStream(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(enc.encode(created));
				controller.enqueue(enc.encode('data: {"type":"response.output_text.delta","delta":"partial-0"}\n\n'));
				controller.enqueue(enc.encode('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"insufficient_quota","message":"quota exceeded while the model was overloaded, please retry"}}}\n\n'));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** 200 SSE response with a transient model failure and zero output deltas. */
function failedEmptyStream(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(enc.encode(created));
				controller.enqueue(enc.encode('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"The model failed to generate a response"}}}\n\n'));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** Caller-owned arguments delta (no item marker), then a transient failure. */
function failedArgsOnlyStream(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(enc.encode(created));
				controller.enqueue(enc.encode('data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"call_abc","delta":"{\\"topic\\"}"}\n\n'));
				controller.enqueue(enc.encode('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"The model failed to generate a response"}}}\n\n'));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function toolBody(): string {
	return JSON.stringify({ model: MODEL, stream: true, input: "tool turn", tools: [{ type: "function", name: "fetch_docs", description: "fetch docs", parameters: { type: "object", properties: {} } }] });
}

test("deterministic response.failed verdicts never re-fire: forwarded verbatim, one attempt", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const statsBefore = getMidStreamFaultStats();
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return failedDeterministicStream();
					}
					if (u.startsWith(RELAY_B)) {
						hits.B = (hits.B ?? 0) + 1;
						return fullStream();
					}
					throw new Error(`unexpected upstream fetch in test: ${u}`);
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: streamBody(),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(
					text.includes("response.failed"),
					`a deterministic verdict must reach the caller, got tail: ${text.slice(-300)}`,
				);
				assert.ok(
					text.includes("quota exceeded"),
					`the genuine verdict must arrive verbatim, got tail: ${text.slice(-300)}`,
				);
				assert.ok(!text.includes("response.completed"), "no relay completed the turn");
				assert.equal(hits.A, 1);
				assert.equal(hits.B ?? 0, 0, `a deterministic refusal must never re-fire, saw ${JSON.stringify(hits)}`);
				const statsAfter = getMidStreamFaultStats();
				assert.equal(
					statsAfter.modelFaults - statsBefore.modelFaults,
					0,
					"a deterministic verdict is not a rescuable model fault",
				);
				assert.equal(
					statsAfter.relayTruncations - statsBefore.relayTruncations,
					0,
					"a clean upstream verdict is not a relay truncation either",
				);
				assert.equal(
					getRelayHealth(RELAY_A)?.consecutiveFailures ?? 0,
					0,
					"a deterministic upstream verdict must not mark the relay failed",
				);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

test("deterministic failure markers never classify as transient", () => {
	const frame = (code: string, message: string): string =>
		`event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"${code}","message":"${message}"}}}`;
	const deterministic: Array<[string, string, string]> = [
		["invalid_request_error", "previous_response_id not found", "stale response id"],
		["invalid_response", "response object failed validation", "bad response shape"],
		["invalid_reasoning", "reasoning reference does not match any issuing relay", "reasoning mismatch"],
		["FreeTierError", "free-tier quota exhausted on this egress IP", "free-tier gate"],
		["rate_limit_exceeded", "Rate limit exceeded, retry later", "rate limit"],
		["insufficient_quota", "quota exceeded for this project", "quota"],
		["billing_hard_limit", "billing limit reached", "billing"],
		["authentication_error", "invalid credentials supplied", "auth"],
		["invalid_api_key", "the provided key is wrong", "bad key"],
		["permission_denied", "caller is not allowed here", "permission"],
		["moderation_blocked", "flagged by moderation", "moderation"],
	];
	for (const [code, message, label] of deterministic) {
		assert.equal(isTransientModelFailureFrame(frame(code, message)), false, `${label} must stay terminal`);
	}
	// A deterministic word wins even when a transient word rides along.
	assert.equal(
		isTransientModelFailureFrame(frame("server_error", "quota exceeded while the model was overloaded")),
		false,
		"quota beside a transient word is still a deterministic verdict",
	);
	// Transient controls still match.
	assert.equal(
		isTransientModelFailureFrame(frame("server_error", "The model is overloaded, please retry")),
		true,
		"overloaded stays retriable",
	);
});

test("failed rescue forwards the genuine upstream verdict: exactly two attempts, no loop", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const statsBefore = getMidStreamFaultStats();
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return failedModelStream();
					}
					if (u.startsWith(RELAY_B)) {
						hits.B = (hits.B ?? 0) + 1;
						return failedModelStream();
					}
					throw new Error(`unexpected upstream fetch in test: ${u}`);
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: streamBody(),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(
					text.includes("response.failed"),
					`the rescue's own failure must terminate the turn, got tail: ${text.slice(-300)}`,
				);
				assert.ok(
					text.includes("failed to generate"),
					`the genuine upstream verdict must arrive verbatim, got tail: ${text.slice(-300)}`,
				);
				assert.ok(!text.includes("response.completed"), "no relay completed the turn");
				assert.equal(hits.A, 1);
				assert.equal(hits.B, 1, `the rescue fires once and never loops, saw ${JSON.stringify(hits)}`);
				assert.equal((hits.A ?? 0) + (hits.B ?? 0), 2, "exactly two upstream attempts");
				const statsAfter = getMidStreamFaultStats();
				assert.equal(
					statsAfter.modelFaults - statsBefore.modelFaults,
					1,
					"only the first hold counts; the rescue's own failure is terminal-forwarded, never re-held",
				);
				assert.equal(
					statsAfter.relayTruncations - statsBefore.relayTruncations,
					0,
					"a model verdict never counts as a relay truncation",
				);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

test("empty-output transient frame on a text-only turn still re-fires", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const statsBefore = getMidStreamFaultStats();
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return failedEmptyStream();
					}
					if (u.startsWith(RELAY_B)) {
						hits.B = (hits.B ?? 0) + 1;
						return fullStream();
					}
					throw new Error(`unexpected upstream fetch in test: ${u}`);
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: streamBody(),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(
					text.includes("response.completed"),
					`rescued turn must end with a real terminal marker, got tail: ${text.slice(-300)}`,
				);
				assert.ok(
					!text.includes("failed to generate"),
					"the held failure frame must be dropped on rescue, not forwarded",
				);
				assert.equal(hits.A, 1, `primary must be hit once, saw ${JSON.stringify(hits)}`);
				assert.equal(hits.B, 1, `the hold needs no prior output deltas, saw ${JSON.stringify(hits)}`);
				assert.equal(
					getMidStreamFaultStats().modelFaults - statsBefore.modelFaults,
					1,
					"the upstream-issued failure must count as a model fault",
				);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

test("transient failure after an arguments-delta-only tool turn never re-fires", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const statsBefore = getMidStreamFaultStats();
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return failedArgsOnlyStream();
					}
					if (u.startsWith(RELAY_B)) {
						hits.B = (hits.B ?? 0) + 1;
						return fullStream();
					}
					throw new Error(`unexpected upstream fetch in test: ${u}`);
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: toolBody(),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(
					text.includes("response.failed"),
					`the genuine upstream verdict must reach the caller, got tail: ${text.slice(-300)}`,
				);
				assert.ok(
					text.includes("failed to generate"),
					`the verdict must arrive verbatim, got tail: ${text.slice(-300)}`,
				);
				assert.equal(hits.A, 1);
				assert.equal(hits.B ?? 0, 0, `a re-fire would re-execute the forwarded call, saw ${JSON.stringify(hits)}`);
				const statsAfter = getMidStreamFaultStats();
				assert.equal(
					statsAfter.modelFaults - statsBefore.modelFaults,
					0,
					"a vetoed hold must not count as a rescued model fault",
				);
				assert.equal(
					statsAfter.relayTruncations - statsBefore.relayTruncations,
					0,
					"a vetoed hold must not count as a relay truncation either",
				);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});

/** Minimal in-process req double: the pipe only reads .url and .on(). */
function mockPipeReq(): EventEmitter & { url: string } {
	const req = new EventEmitter() as EventEmitter & { url: string };
	req.url = "/v1/responses";
	return req;
}

/** Minimal in-process res double: captures bytes, models estimator flags. */
class MockPipeRes extends EventEmitter {
	chunks: string[] = [];
	writableEnded = false;
	destroyed = false;
	headersSent = false;
	flushHeaders(): void {
		// Mirrors node:http: once headers flush, later errors take the
		// headers-sent (refire/terminal) path instead of a bare 502.
		this.headersSent = true;
	}
	writeHead(): void {
		this.headersSent = true;
	}
	write(chunk: unknown): boolean {
		this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
		return true;
	}
	end(): void {
		this.writableEnded = true;
	}
	text(): string {
		return this.chunks.join("");
	}
}

/** Deterministic queue drain (no timers): lets stream events settle. */
function flowTicks(n = 5): Promise<void> {
	let p = Promise.resolve();
	for (let i = 0; i < n; i++) p = p.then(() => new Promise<void>((r) => { setImmediate(() => r()); }));
	return p;
}

/** Bounded flush until the refire hook fires (assertions after it fail loudly). */
async function untilRefire(calls: { n: number }): Promise<void> {
	for (let i = 0; i < 200 && calls.n === 0; i++) await flowTicks(1);
}

test("every tool-call marker shape vetoes the mid-stream re-fire", async () => {
	const shapes: Array<[string, string]> = [
		["function_call item", 'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","name":"fetch_docs","call_id":"c1"}}\n\n'],
		["custom_tool_call item", 'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"custom_tool_call","name":"fetch_docs","call_id":"c2"}}\n\n'],
		["tool_use item", 'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"tool_use","name":"glob","id":"b3"}}\n\n'],
		["arguments delta only", 'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"c1","delta":"{\\"topic\\"}"}\n\n'],
		["custom input delta only", 'data: {"type":"response.custom_tool_call_input.delta","output_index":0,"item_id":"c2","delta":"{\\"topic\\"}"}\n\n'],
		["chat tool_calls key", 'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_c9","type":"function","function":{"name":"fetch_docs"}}]}}]}\n\n'],
	];
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		_resetMidStreamFaultStatsForTest();
		_resetSseStatsForTest();
		const statsBefore = getMidStreamFaultStats();
		try {
			for (const [label, markerChunk] of shapes) {
				const upstream = new PassThrough();
				const req = mockPipeReq();
				const res = new MockPipeRes();
				const refireCalls = { n: 0 };
				pipeUpstreamStream(
					upstream,
					res as unknown as http.ServerResponse,
					req as unknown as http.IncomingMessage,
					`edge-shapes-${label}`,
					undefined,
					undefined,
					{ refire: async () => { refireCalls.n += 1; return null; } },
				);
				upstream.write(`${created}${markerChunk}`);
				await flowTicks();
				upstream.end();
				await flowTicks(10);
				assert.equal(refireCalls.n, 0, `${label}: a forwarded tool call must veto the re-fire`);
				assert.ok(res.text().includes("response.incomplete"), `${label}: a vetoed turn keeps the synthetic terminal`);
			}
			const statsAfter = getMidStreamFaultStats();
			assert.equal(statsAfter.modelFaults - statsBefore.modelFaults, 0, "vetoed turns count no model faults");
			assert.equal(statsAfter.relayTruncations - statsBefore.relayTruncations, 0, "clean FINs count no relay truncations");
		} finally {
			resetAllRelayHealth();
			_resetMidStreamFaultStatsForTest();
			_resetSseStatsForTest();
		}
	});
});

test("client abort before a held failure frame never re-fires and never penalizes the relay", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		_resetMidStreamFaultStatsForTest();
		_resetSseStatsForTest();
		const statsBefore = getMidStreamFaultStats();
		const RELAY = "http://127.0.0.1:19992";
		try {
			const upstream = new PassThrough();
			const req = mockPipeReq();
			const res = new MockPipeRes();
			const refireCalls = { n: 0 };
			pipeUpstreamStream(
				upstream,
				res as unknown as http.ServerResponse,
				req as unknown as http.IncomingMessage,
				"edge-abort-hold",
				RELAY,
				undefined,
				{ refire: async () => { refireCalls.n += 1; return null; } },
			);
			upstream.write(`${created}data: {"type":"response.output_text.delta","delta":"partial-0"}\n\n`);
			await flowTicks();
			// The client goes away before any failure frame arrives; the
			// abort handler destroys the upstream leg.
			req.emit("aborted");
			// Same-tick stimulus (no drain between): the response is still
			// open, so ONLY the abort veto can stop the hold below. A drain
			// here would let the teardown end the response first and the
			// writable-ended veto would mask the abort veto under test.
			// A transient model-failure frame racing in after the abort must
			// terminate as-is: holding it for a rescue nobody wants would
			// re-fire into the void. Emitted (not written) so the stimulus
			// does not depend on destroyed-stream write semantics.
			upstream.emit(
				"data",
				Buffer.from('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"The model failed to generate a response"}}}\n\n'),
			);
			await flowTicks();
			assert.equal(refireCalls.n, 0, "an aborted turn must never re-fire");
			const statsAfter = getMidStreamFaultStats();
			assert.equal(statsAfter.modelFaults - statsBefore.modelFaults, 0, "a vetoed hold must not count a model fault");
			assert.equal(statsAfter.relayTruncations - statsBefore.relayTruncations, 0, "a client abort must not count a relay truncation");
			assert.equal(getRelayHealth(RELAY)?.consecutiveFailures ?? 0, 0, "client abort must not mark the relay failed");
			assert.ok(res.text().includes("response.failed"), "the genuine verdict still terminates the turn");
		} finally {
			resetAllRelayHealth();
			_resetMidStreamFaultStatsForTest();
			_resetSseStatsForTest();
		}
	});
});

test("cut stream's late events after successful rescue cannot corrupt the rescued turn", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		_resetMidStreamFaultStatsForTest();
		_resetSseStatsForTest();
		const statsBefore = getMidStreamFaultStats();
		try {
			const cutStream = new PassThrough();
			const replacement = new PassThrough();
			const req = mockPipeReq();
			const res = new MockPipeRes();
			const refireCalls = { n: 0 };
			let releaseRefire: (s: Readable | null) => void = () => {};
			const refireGate = new Promise<Readable | null>((resolve) => { releaseRefire = resolve; });
			pipeUpstreamStream(
				cutStream,
				res as unknown as http.ServerResponse,
				req as unknown as http.IncomingMessage,
				"edge-late-events",
				"http://127.0.0.1:19991",
				undefined,
				{ refire: async () => { refireCalls.n += 1; return refireGate; } },
			);
			cutStream.write(`${created}data: {"type":"response.output_text.delta","delta":"partial-0"}\n\n`);
			cutStream.end();
			await untilRefire(refireCalls);
			assert.equal(refireCalls.n, 1, "the clean FIN without a terminal must offer exactly one re-fire");
			// The cut stream's trailing close fires while the rescue is in
			// flight: it must be suppressed, never synthesized into a terminal.
			await flowTicks();
			assert.ok(!res.text().includes("response.incomplete"), "no synthetic terminal may land mid-rescue");
			releaseRefire(replacement);
			await flowTicks();
			// Late events on the stale stream after the swap: the generation
			// guard must drop them even though no rescue is pending anymore.
			// (Without it, the stale close below injects response.incomplete
			// via the post-end cleanup path, and the stale bytes interleave.)
			cutStream.emit("data", Buffer.from("INTRUSION-MARKER"));
			cutStream.emit("close");
			replacement.write(`${created}data: {"type":"response.output_text.delta","delta":"rescued"}\n\n`);
			replacement.write(completed);
			replacement.end();
			await flowTicks(10);
			const text = res.text();
			assert.ok(text.includes("partial-0"), "pre-cut bytes survive the rescue");
			assert.ok(text.includes("rescued") && text.includes("response.completed"), "the rescued turn completes");
			assert.ok(!text.includes("response.incomplete"), "a stale close must not inject a synthetic terminal");
			assert.ok(!text.includes("INTRUSION-MARKER"), "stale bytes after the swap must be dropped");
			assert.equal(refireCalls.n, 1, "exactly one re-fire; the rescue never loops");
			const statsAfter = getMidStreamFaultStats();
			assert.equal(statsAfter.modelFaults - statsBefore.modelFaults, 0, "a clean transport cut is not a model fault");
			assert.equal(statsAfter.relayTruncations - statsBefore.relayTruncations, 0, "a rescued clean FIN counts no relay truncation");
		} finally {
			resetAllRelayHealth();
			_resetMidStreamFaultStatsForTest();
			_resetSseStatsForTest();
		}
	});
});

test("relayTruncations counts only genuine transport cuts", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		_resetMidStreamFaultStatsForTest();
		_resetSseStatsForTest();
		const statsBefore = getMidStreamFaultStats();
		const RELAY_CLOSE = "http://127.0.0.1:19993";
		const RELAY_ERROR = "http://127.0.0.1:19994";
		try {
			// Case 1: socket death with no FIN and no error event.
			{
				const upstream = new PassThrough();
				const req = mockPipeReq();
				const res = new MockPipeRes();
				pipeUpstreamStream(
					upstream,
					res as unknown as http.ServerResponse,
					req as unknown as http.IncomingMessage,
					"edge-trunc-close",
					RELAY_CLOSE,
					undefined,
					{ refire: async () => null },
				);
				upstream.write(`${created}data: {"type":"response.output_text.delta","delta":"partial-0"}\n\n`);
				await flowTicks();
				upstream.destroy();
				await flowTicks(10);
				assert.ok(
					res.text().includes("response.failed") || res.text().includes("response.incomplete"),
					"a socket death must still terminate the turn",
				);
				const mid = getMidStreamFaultStats();
				assert.equal(mid.relayTruncations - statsBefore.relayTruncations, 1, "a genuine transport cut counts a relay truncation");
				assert.equal(mid.modelFaults - statsBefore.modelFaults, 0, "a transport cut is not a model fault");
				assert.ok(
					(getRelayHealth(RELAY_CLOSE)?.consecutiveFailures ?? 0) >= 1,
					"a socket death marks the relay so rotation avoids it",
				);
			}
			// Case 2: genuine stream error.
			{
				const upstream = new PassThrough();
				const req = mockPipeReq();
				const res = new MockPipeRes();
				pipeUpstreamStream(
					upstream,
					res as unknown as http.ServerResponse,
					req as unknown as http.IncomingMessage,
					"edge-trunc-error",
					RELAY_ERROR,
					undefined,
					{ refire: async () => null },
				);
				upstream.write(`${created}data: {"type":"response.output_text.delta","delta":"partial-0"}\n\n`);
				await flowTicks();
				upstream.destroy(new Error("socket hang up"));
				await flowTicks(10);
				assert.ok(res.text().includes("response.failed"), "a stream error terminates the turn");
				const after = getMidStreamFaultStats();
				assert.equal(after.relayTruncations - statsBefore.relayTruncations, 2, "both genuine cuts count, exactly once each");
				assert.equal(after.modelFaults - statsBefore.modelFaults, 0, "transport cuts never count as model faults");
				assert.ok(
					(getRelayHealth(RELAY_ERROR)?.consecutiveFailures ?? 0) >= 1,
					"a stream error marks the relay so rotation avoids it",
				);
			}
		} finally {
			resetAllRelayHealth();
			_resetMidStreamFaultStatsForTest();
			_resetSseStatsForTest();
		}
	});
});


test("held failure with a dead rescue relay still forwards the genuine verdict", async () => {
	await withIsolatedSandboxFiles(async () => {
		clearSandboxFiles();
		const priorState = getActiveRelayState();
		seedPool();
		const statsBefore = getMidStreamFaultStats();
		const { server, port } = await startProxy(PROXY_PORT);
		const effectivePort = port ?? PROXY_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);
		const hits: Record<string, number> = {};
		try {
			const fetchMock = test.mock.method(
				globalThis,
				"fetch",
				async (url: unknown, init?: RequestInit) => {
					const u = String(url);
					if (u.startsWith(localPrefix)) return realFetch(u, init);
					if (u.startsWith(RELAY_A)) {
						hits.A = (hits.A ?? 0) + 1;
						return failedModelStream();
					}
					if (u.startsWith(RELAY_B)) {
						hits.B = (hits.B ?? 0) + 1;
						// Non-retriable refusal (a rollable status would exercise the
						// pre-stream roll loop inside the rescue instead of the
						// refire budget this test isolates).
						return new Response("relay down", { status: 400, headers: { "content-type": "text/plain" } });
					}
					throw new Error(`unexpected upstream fetch in test: ${u}`);
				},
			);
			try {
				const res = await fetch(`${localPrefix}/v1/responses`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: streamBody(),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.ok(
					text.includes("response.failed"),
					`the held verdict must terminate the turn, got tail: ${text.slice(-300)}`,
				);
				assert.ok(
					text.includes("failed to generate"),
					`the genuine upstream verdict must arrive verbatim, got tail: ${text.slice(-300)}`,
				);
				assert.ok(!text.includes("response.completed"), "no relay completed the turn");
				assert.equal(hits.A, 1);
				assert.equal(hits.B, 1, `the rescue is attempted once and never loops, saw ${JSON.stringify(hits)}`);
				const statsAfter = getMidStreamFaultStats();
				assert.equal(
					statsAfter.modelFaults - statsBefore.modelFaults,
					1,
					"the held failure still counts as a model fault",
				);
				assert.equal(
					statsAfter.relayTruncations - statsBefore.relayTruncations,
					0,
					"a failed rescue of a model fault never counts as a relay truncation",
				);
			} finally {
				fetchMock.mock.restore();
			}
		} finally {
			_resetUpstreamHealthForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) {
				const { promise, resolve } = Promise.withResolvers<void>();
				server.close(() => resolve());
				await promise;
			}
		}
	});
});
