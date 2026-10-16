/**
 * Non-SSE body gate on the streaming pipe (StreamPipeOptions.upstreamContentType).
 *
 * An upstream 200 that answers a STREAMING request with a non-SSE body must
 * reach the client byte-for-byte. Pre-fix, the double-newline scanner held
 * every byte that carries no `\n\n` (a plain JSON body has none), the body was
 * dropped, the turn burned its re-fire budget on a request upstream had
 * already answered, and a synthetic `data: [DONE]` was appended while the
 * response's own content-type said application/json. Genuine SSE streams keep
 * today's scanner/terminal behavior — proven by the SSE case below.
 *
 * Harness: the relay leg runs against a REAL loopback HTTP upstream, whose
 * request count proves the re-fire budget; the direct leg uses a URL-aware
 * fetch stub. Both go through the real startProxy + relayFetch pipeline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startProxy } from "../src/proxy.ts";
import { ALLOW_UNSAFE_RELAY_ENV, RELAY_STATE_FILE } from "../src/config.ts";
import {
	getActiveRelayState,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import { _resetUpstreamHealthForTest } from "../src/upstream-health.ts";
import type { RelayState } from "../src/types.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;
// Mirrors resolveSessionPinPath() in src/config.ts, kept literal on purpose:
// isolation must hold against unpatched src too.
const PIN_FILE = path.join(path.dirname(RELAY_STATE_FILE), "pi-freeflow-session-pins.json");

const STREAM_MODEL = "big-pickle";
const STREAM_PATH = "/v1/chat/completions";

const JSON_BODY = JSON.stringify({
	id: "chatcmpl-gate",
	object: "chat.completion",
	model: STREAM_MODEL,
	choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
});
const SSE_BODY =
	'data: {"id":"chatcmpl-gate","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
	"data: [DONE]\n\n";

const count = (haystack: string, needle: string): number =>
	haystack.split(needle).length - 1;

/**
 * Isolate relay state files + the in-memory pool/health, and accept http
 * loopback relays (the unsafe-relay env is read lazily, so setting it here
 * covers relayFetch's validation on every call).
 */
async function withIsolatedRelayState(fn: () => Promise<void>): Promise<void> {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const mainBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(BAK_FILE);
	const pinBefore = read(PIN_FILE);
	const memBefore = getActiveRelayState();
	const unsafeBefore = process.env[ALLOW_UNSAFE_RELAY_ENV];
	process.env[ALLOW_UNSAFE_RELAY_ENV] = "1";
	try {
		await fn();
	} finally {
		const restore = (p: string, before: string | null): void => {
			if (before !== null) {
				fs.writeFileSync(p, before, "utf8");
			} else {
				try {
					fs.rmSync(p, { force: true });
				} catch { }
			}
		};
		restore(RELAY_STATE_FILE, mainBefore);
		restore(BAK_FILE, bakBefore);
		restore(PIN_FILE, pinBefore);
		if (unsafeBefore === undefined) {
			delete process.env[ALLOW_UNSAFE_RELAY_ENV];
		} else {
			process.env[ALLOW_UNSAFE_RELAY_ENV] = unsafeBefore;
		}
		setActiveRelayState(memBefore, false);
		resetAllRelayHealth();
		_resetUpstreamHealthForTest();
	}
}

interface LoopbackUpstream {
	port: number;
	/** Requests the proxy actually issued upstream (the re-fire counter). */
	hits: number;
	close: () => Promise<void>;
}

/** Real loopback mock upstream on an ephemeral port, counting every request. */
async function startLoopbackUpstream(handler: http.RequestListener): Promise<LoopbackUpstream> {
	const state: LoopbackUpstream = { port: 0, hits: 0, close: async () => { } };
	const server = http.createServer((req, res) => {
		state.hits += 1;
		handler(req, res);
	});
	server.on("clientError", (_err, socket) => {
		try {
			socket.destroy();
		} catch { }
	});
	state.port = await new Promise<number>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr === null || typeof addr === "string") {
				reject(new Error("loopback listen failed: no port assigned"));
				return;
			}
			resolve(addr.port);
		});
	});
	state.close = () =>
		new Promise<void>((resolve) => {
			server.close(() => resolve());
			// Undici keeps its upstream socket warm; drop it so close() settles.
			server.closeIdleConnections();
			server.closeAllConnections();
		});
	return state;
}

/** Boot the real proxy with the loopback upstream as the only relay. */
async function withRelayProxy(
	upstreamPort: number,
	fn: (proxyPort: number) => Promise<void>,
): Promise<void> {
	const relayUrl = `http://127.0.0.1:${upstreamPort}`;
	const state: RelayState = {
		mode: "auto",
		enabled: true,
		url: relayUrl,
		relays: [{ url: relayUrl }],
	};
	const { server, port } = await startProxy(0);
	try {
		setActiveRelayState(state, false);
		resetAllRelayHealth();
		_resetUpstreamHealthForTest();
		await fn(port);
	} finally {
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}
}

/** One streaming chat request through the loopback proxy. */
function streamChatRequest(proxyPort: number): Promise<Response> {
	return fetch(`http://127.0.0.1:${proxyPort}${STREAM_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: STREAM_MODEL,
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		}),
	});
}

test(
	"relay leg: JSON 200 on a stream request reaches the client byte-exact — no terminal, no re-fire",
	{ timeout: 15000 },
	async () => {
		await withIsolatedRelayState(async () => {
			const upstream = await startLoopbackUpstream((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON_BODY);
			});
			try {
				await withRelayProxy(upstream.port, async (proxyPort) => {
					const res = await streamChatRequest(proxyPort);
					assert.equal(res.status, 200);
					assert.match(
						res.headers.get("content-type") ?? "",
						/application\/json/,
						"the streaming leg must pass the upstream content-type through",
					);
					const text = await res.text();
					assert.equal(text, JSON_BODY, "the exact upstream bytes must reach the client");
					assert.equal(
						count(text, "[DONE]"),
						0,
						"no synthetic terminal may be appended to a non-SSE body",
					);
					assert.equal(
						upstream.hits,
						1,
						"the re-fire budget must not be spent on a body upstream already completed",
					);
				});
			} finally {
				await upstream.close();
			}
		});
	},
);

test(
	"relay leg: no content-type + JSON body takes the first-block sniff into raw passthrough",
	{ timeout: 15000 },
	async () => {
		await withIsolatedRelayState(async () => {
			const upstream = await startLoopbackUpstream((_req, res) => {
				// Deliberately no content-type: the pipe must classify the body
				// itself instead of guessing SSE and dropping it.
				res.writeHead(200);
				res.end(JSON_BODY);
			});
			try {
				await withRelayProxy(upstream.port, async (proxyPort) => {
					const res = await streamChatRequest(proxyPort);
					assert.equal(res.status, 200);
					const text = await res.text();
					assert.equal(text, JSON_BODY, "the exact upstream bytes must reach the client");
					assert.equal(count(text, "[DONE]"), 0, "no synthetic terminal on a sniffed non-SSE body");
					assert.equal(upstream.hits, 1, "no re-fire for a body upstream already completed");
				});
			} finally {
				await upstream.close();
			}
		});
	},
);

test(
	"relay leg: a genuine SSE stream is unchanged (frames + single terminal)",
	{ timeout: 15000 },
	async () => {
		await withIsolatedRelayState(async () => {
			const upstream = await startLoopbackUpstream((_req, res) => {
				res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
				res.end(SSE_BODY);
			});
			try {
				await withRelayProxy(upstream.port, async (proxyPort) => {
					const res = await streamChatRequest(proxyPort);
					assert.equal(res.status, 200);
					assert.match(
						res.headers.get("content-type") ?? "",
						/text\/event-stream/,
						"SSE content-type must keep flowing to the client",
					);
					const text = await res.text();
					assert.ok(text.includes('"content":"hi"'), "SSE frames must reach the client");
					assert.equal(
						count(text, "[DONE]"),
						1,
						"exactly one terminal — upstream's, never a synthetic duplicate",
					);
					assert.equal(upstream.hits, 1, "a completed SSE turn is never re-fired");
				});
			} finally {
				await upstream.close();
			}
		});
	},
);

test(
	"direct leg: JSON 200 on a stream request is forwarded verbatim, not dropped",
	{ timeout: 15000 },
	async (t) => {
		await withIsolatedRelayState(async () => {
			const realFetch = globalThis.fetch.bind(globalThis);
			const { server, port } = await startProxy(0);
			const localPrefix = `http://127.0.0.1:${port}`;
			let upstreamCalls = 0;
			const fetchMock = t.mock.method(
				globalThis,
				"fetch",
				async (input: unknown, init?: RequestInit) => {
					const u = String(input);
					if (u.startsWith(localPrefix)) return realFetch(input as RequestInfo, init);
					upstreamCalls += 1;
					const encoder = new TextEncoder();
					return {
						status: 200,
						ok: true,
						headers: new Headers({ "content-type": "application/json" }),
						body: new ReadableStream({
							start(controller) {
								controller.enqueue(encoder.encode(JSON_BODY));
								controller.close();
							},
						}),
					} as unknown as Response;
				},
			);
			try {
				setActiveRelayState({ mode: "auto", enabled: false, url: "", relays: [] }, false);
				resetAllRelayHealth();
				_resetUpstreamHealthForTest();
				const res = await fetch(`${localPrefix}${STREAM_PATH}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: STREAM_MODEL,
						stream: true,
						messages: [{ role: "user", content: "hi" }],
					}),
				});
				assert.equal(res.status, 200);
				const text = await res.text();
				assert.equal(text, JSON_BODY, "the direct leg must hand the JSON body over untouched");
				assert.equal(count(text, "[DONE]"), 0, "no synthetic terminal may be injected");
				assert.equal(upstreamCalls, 1, "a complete body is answered once, never retried");
			} finally {
				fetchMock.mock.restore();
				if (server) {
					await new Promise<void>((resolve) => server.close(() => resolve()));
				}
			}
		});
	},
);
