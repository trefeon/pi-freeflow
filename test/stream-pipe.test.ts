/**
 * Behavioral tests for stream-pipe relay-health discrimination:
 *
 * - Client aborts must NOT penalize relay health (host still gets a terminal).
 * - Genuine upstream truncation/errors MUST penalize relay health.
 * - Clean upstream ends must NOT penalize relay health.
 * - Terminal markers deeper than the first 2000 bytes of a coalesced final
 *   chunk must be detected (head+tail scan), avoiding penalties and duplicate
 *   synthetic injections.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import * as http from "node:http";

import {
	_resetSseStatsForTest,
	getSseStats,
	pipeUpstreamStream,
} from "../src/stream-pipe.ts";
import {
	getRelayHealth,
	isRelayHealthy,
	resetAllRelayHealth,
} from "../src/relay-state.ts";

const RELAY_URL = "https://relay-a.example.com/v1";

/** Minimal http.ServerResponse stand-in covering the surface stream-pipe uses. */
class FakeResponse extends EventEmitter {
	headersSent = false;
	writableEnded = false;
	private parts: string[] = [];

	flushHeaders(): void {
		this.headersSent = true;
	}

	writeHead(_status: number, _headers?: Record<string, string>): unknown {
		this.headersSent = true;
		return this;
	}

	write(chunk: Buffer | string): boolean {
		this.parts.push(
			typeof chunk === "string" ? chunk : chunk.toString("utf8"),
		);
		return true;
	}

	end(chunk?: Buffer | string): void {
		if (chunk !== undefined) this.write(chunk);
		this.writableEnded = true;
	}

	body(): string {
		return this.parts.join("");
	}
}

class FakeRequest extends EventEmitter {
	url: string;
	constructor(url: string) {
		super();
		this.url = url;
	}
}

function pipe(
	stream: PassThrough,
	reqUrl: string,
	relayUrl: string | undefined,
): { res: FakeResponse; req: FakeRequest } {
	const res = new FakeResponse();
	const req = new FakeRequest(reqUrl);
	pipeUpstreamStream(
		stream,
		res as unknown as http.ServerResponse,
		req as unknown as http.IncomingMessage,
		"test",
		relayUrl,
	);
	return { res, req };
}

const count = (haystack: string, needle: string): number =>
	haystack.split(needle).length - 1;

/** Chunk of `padBytes` filler followed by an SSE frame carrying `marker`. */
function lateMarkerChunk(marker: string, padBytes: number): Buffer {
	return Buffer.concat([
		Buffer.alloc(padBytes, 0x61),
		Buffer.from(`\ndata: ${marker}\n\n`, "utf8"),
	]);
}

test("client abort leaves relay health untouched (chat completions)", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res, req } = pipe(stream, "/v1/chat/completions", RELAY_URL);

	const drained = once(stream, "data");
	stream.push(Buffer.from('data: {"delta":"hi"}\n\n', "utf8"));
	await drained;
	req.emit("aborted");
	await once(stream, "close");

	assert.equal(
		isRelayHealthy(RELAY_URL),
		true,
		"client abort must not put the relay into cooldown",
	);
	assert.equal(
		getRelayHealth(RELAY_URL),
		undefined,
		"no failure record may be recorded for a client abort",
	);
	assert.equal(
		count(res.body(), "[DONE]"),
		1,
		"host must still receive a synthetic terminal [DONE]",
	);
});

test("client abort on responses API injects response.incomplete, not response.failed", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res, req } = pipe(stream, "/v1/responses", RELAY_URL);

	const drained = once(stream, "data");
	stream.push(
		Buffer.from('event: response.output_text.delta\ndata: {}\n\n', "utf8"),
	);
	await drained;
	req.emit("aborted");
	await once(stream, "close");

	assert.equal(isRelayHealthy(RELAY_URL), true);
	assert.ok(
		res.body().includes('"type":"response.incomplete"'),
		"cancelled host streams get response.incomplete",
	);
	assert.ok(
		!res.body().includes("response.failed"),
		"a client abort is not an upstream failure",
	);
});

test("genuine upstream error marks relay failure and reports response.failed", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/responses", RELAY_URL);

	const drained = once(stream, "data");
	stream.push(Buffer.from("data: part\n\n", "utf8"));
	await drained;
	// Requesting "error" explicitly makes events.once treat it as a value
	// event rather than a rejection trigger; every "error" listener —
	// including the pipe's failure handling — runs before the await resumes.
	const errored = once(stream, "error");
	stream.destroy(new Error("upstream socket boom"));
	await errored;

	const health = getRelayHealth(RELAY_URL);
	assert.ok(
		!isRelayHealthy(RELAY_URL),
		"an upstream error must put the relay into cooldown",
	);
	assert.ok(health, "failure record exists");
	assert.equal(health?.lastStatus, 0);
	assert.ok(res.body().includes('"type":"response.failed"'));
});

test("premature upstream close without client signal marks relay failure", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/chat/completions", RELAY_URL);

	const drained = once(stream, "data");
	stream.push(Buffer.from("data: partial\n\n", "utf8"));
	await drained;
	stream.destroy(); // upstream socket dies mid-stream, no 'error' event
	await once(stream, "close");

	assert.ok(
		!isRelayHealthy(RELAY_URL),
		"true upstream truncation must be penalized",
	);
	assert.ok(getRelayHealth(RELAY_URL), "failure record exists");
	assert.equal(count(res.body(), "[DONE]"), 1);
});

test("clean upstream end without terminal marker keeps relay healthy", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/chat/completions", RELAY_URL);

	stream.push(Buffer.from("data: hello\n\n", "utf8"));
	stream.end();
	await once(stream, "close");

	assert.equal(
		isRelayHealthy(RELAY_URL),
		true,
		"a clean end is not a relay fault",
	);
	assert.equal(getRelayHealth(RELAY_URL), undefined);
	assert.equal(count(res.body(), "[DONE]"), 1);
});

test("[DONE] beyond the first 2000 bytes of the final chunk completes without penalty", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/chat/completions", RELAY_URL);

	// 2500 filler bytes so the marker sits entirely outside the old head window.
	stream.push(lateMarkerChunk("[DONE]", 2500));
	stream.end();
	await once(stream, "close");

	assert.equal(
		isRelayHealthy(RELAY_URL),
		true,
		"healthy completions with late markers must not be penalized",
	);
	assert.equal(getRelayHealth(RELAY_URL), undefined);
	assert.equal(
		count(res.body(), "[DONE]"),
		1,
		"chunk marker must be detected — no duplicate synthetic [DONE]",
	);
});

test("marker within the head window is still detected (head scan regression guard)", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/chat/completions", RELAY_URL);

	stream.push(Buffer.from("data: hi\n\ndata: [DONE]\n\n", "utf8"));
	stream.end();
	await once(stream, "close");

	assert.equal(isRelayHealthy(RELAY_URL), true);
	assert.equal(count(res.body(), "[DONE]"), 1);
});

test("late response.completed in a coalesced chunk avoids synthetic injection", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/responses", RELAY_URL);

	stream.push(
		Buffer.concat([
			Buffer.alloc(2500, 0x61),
			Buffer.from(
				'event: response.completed\ndata: {"type":"response.completed"}\n\n',
				"utf8",
			),
		]),
	);
	stream.end();
	await once(stream, "close");

	assert.equal(isRelayHealthy(RELAY_URL), true);
	assert.ok(res.body().includes("response.completed"));
	assert.ok(
		!res.body().includes("response.incomplete"),
		"detected completion must not be overwritten by a synthetic incomplete",
	);
});

test("[DONE] straddling three chunks is detected once with no synthetic duplicate", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/chat/completions", RELAY_URL);

	stream.push(Buffer.from('data: {"delta":"hi"}\n\n', "utf8"));
	stream.push(Buffer.from("data: [DO", "utf8"));
	stream.push(Buffer.from("NE]\n\n", "utf8"));
	stream.end();
	await once(stream, "close");

	assert.equal(isRelayHealthy(RELAY_URL), true);
	assert.equal(getRelayHealth(RELAY_URL), undefined);
	assert.equal(
		count(res.body(), "data: [DONE]"),
		1,
		"straddled marker must be recognized — no duplicate synthetic [DONE]",
	);
});

test("[DONE] buried between the former head/tail windows of one large chunk is detected", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/chat/completions", RELAY_URL);

	// 6044-byte chunk carrying the marker around offset 3040 — the exact
	// gap the old 2000/2000 head/tail windows left uncovered.
	stream.push(
		Buffer.concat([
			Buffer.alloc(3040, 0x61),
			Buffer.from("\ndata: [DONE]\n\n", "utf8"),
			Buffer.alloc(2989, 0x61),
		]),
	);
	stream.end();
	await once(stream, "close");

	assert.equal(isRelayHealthy(RELAY_URL), true);
	assert.equal(getRelayHealth(RELAY_URL), undefined);
	assert.equal(count(res.body(), "[DONE]"), 1);
});

test("response.completed split across chunks suppresses synthetic response.incomplete", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/responses", RELAY_URL);

	// Every occurrence of the marker straddles a chunk boundary, so no
	// single chunk ever contains a scannable "response.completed".
	stream.push(
		Buffer.from(
			'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n',
			"utf8",
		),
	);
	stream.push(Buffer.from("event: response.comple", "utf8"));
	stream.push(Buffer.from('ted\ndata: {"type":"response.comple', "utf8"));
	stream.push(Buffer.from('ted"}\n\n', "utf8"));
	stream.end();
	await once(stream, "close");

	assert.equal(isRelayHealthy(RELAY_URL), true);
	assert.ok(res.body().includes("event: response.completed"));
	assert.ok(
		!res.body().includes('"type":"response.incomplete"'),
		"a genuinely completed stream must not be rewritten as cancelled",
	);
});

test("internal abort (FF_INTERNAL_ABORT) leaves relay health untouched and injects a terminal", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/responses", RELAY_URL);

	const drained = once(stream, "data");
	stream.push(Buffer.from('event: response.output_text.delta\ndata: {}\n\n', "utf8"));
	await drained;

	// The proxy's header-wait timeout aborts with an AbortError tagged
	// FF_INTERNAL_ABORT (never a relay fault — the relay is not at fault).
	const abortErr = new Error("upstream header timeout") as Error & { code?: string };
	abortErr.name = "AbortError";
	abortErr.code = "FF_INTERNAL_ABORT";
	const errored = once(stream, "error");
	stream.destroy(abortErr);
	await errored;

	assert.equal(
		isRelayHealthy(RELAY_URL),
		true,
		"an internal abort must not put the relay into cooldown",
	);
	assert.equal(getRelayHealth(RELAY_URL), undefined);
	assert.ok(
		res.body().includes('"type":"response.incomplete"'),
		"the host must still get a terminal event",
	);
	assert.ok(
		!res.body().includes("response.failed"),
		"an internal abort is not an upstream failure",
	);
});

test("plain AbortError mid-stream is treated as our abort, not a relay fault", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const { res } = pipe(stream, "/v1/chat/completions", RELAY_URL);

	const drained = once(stream, "data");
	stream.push(Buffer.from("data: part\n\n", "utf8"));
	await drained;

	const abortErr = new Error("The operation was aborted");
	abortErr.name = "AbortError";
	const errored = once(stream, "error");
	stream.destroy(abortErr);
	await errored;

	assert.equal(isRelayHealthy(RELAY_URL), true);
	assert.equal(getRelayHealth(RELAY_URL), undefined);
	assert.equal(count(res.body(), "[DONE]"), 1);
});

/** FakeResponse whose write() returns callee-controlled backpressure. */
class DrainingResponse extends FakeResponse {
	drained = true;
	write(chunk: Buffer | string): boolean {
		return super.write(chunk) && this.drained;
	}
}

test("backpressure: upstream pauses when res.write returns false and resumes on drain", async () => {
	resetAllRelayHealth();
	const stream = new PassThrough();
	const res = new DrainingResponse();
	const req = new FakeRequest("/v1/chat/completions");
	pipeUpstreamStream(
		stream,
		res as unknown as http.ServerResponse,
		req as unknown as http.IncomingMessage,
		"test",
		RELAY_URL,
	);

	res.drained = false; // next write() reports backpressure
	const dataP = once(stream, "data");
	stream.push(Buffer.from("data: part\n\n", "utf8"));
	await dataP;
	assert.equal(
		stream.isPaused(),
		true,
		"upstream source must pause while the client socket is backed up",
	);

	res.drained = true;
	res.emit("drain");
	assert.equal(
		stream.isPaused(),
		false,
		"upstream source must resume once the client drains",
	);

	stream.end();
	await once(stream, "close");
	assert.equal(isRelayHealthy(RELAY_URL), true);
});

// ── Real-socket client-abort discrimination ───────────────────────────────
// The FakeResponse tests above drive "aborted" by hand, so they cannot prove
// the production detection path: a real kernel socket teardown surfacing as
// req/res "close" with no explicit signal. These tests run a stub upstream
// SSE server plus a minimal proxy that pipes through pipeUpstreamStream over
// REAL loopback sockets, then destroy the CLIENT socket and assert the relay
// is not penalized. An upstream-side abort is the control: it MUST penalize.

function createLoopbackSignal(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/**
 * Await a harness signal with a watchdog that only fires when the signal
 * never arrives (suite backstop, never pacing): the timer clears itself the
 * moment the signal settles, so passing runs pay no delay.
 */
async function awaitLoopback(signal: Promise<void>, what: string, ms = 5000): Promise<void> {
	const watchdog = new Promise<never>((_resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
		void signal.then(
			() => clearTimeout(timer),
			() => clearTimeout(timer),
		);
	});
	await Promise.race([signal, watchdog]);
}

function listenLoopback(server: http.Server): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr === null || typeof addr === "string") {
				reject(new Error("loopback listen failed: no port assigned"));
				return;
			}
			resolve(addr.port);
		});
	});
}

function closeLoopback(server: http.Server): Promise<void> {
	return new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
}

interface LoopbackStreamProxy {
	proxyPort: number;
	/** Resolves after the pipe's own upstream "close" listener has run. */
	upstreamClosed: Promise<void>;
	/** Resolves once the server observes the client socket go away. */
	clientGone: Promise<void>;
	close: () => Promise<void>;
}

/**
 * Minimal production-shaped proxy: waits for upstream headers, sends SSE
 * headers, then hands the live upstream socket to pipeUpstreamStream.
 */
async function startLoopbackStreamProxy(
	relayUrl: string,
	upstreamPort: number,
): Promise<LoopbackStreamProxy> {
	const upstreamClosed = createLoopbackSignal();
	const clientGone = createLoopbackSignal();
	const state: LoopbackStreamProxy = {
		proxyPort: 0,
		upstreamClosed: upstreamClosed.promise,
		clientGone: clientGone.promise,
		close: async () => { },
	};
	const proxy = http.createServer((clientReq, clientRes) => {
		const upReq = http.get(
			{ host: "127.0.0.1", port: upstreamPort, path: "/upstream" },
			(upRes) => {
				clientRes.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				pipeUpstreamStream(upRes, clientRes, clientReq, "loopback", relayUrl);
				// Attached after the pipe's own "close" listener, so this
				// resolves only after its relay-health decision has run.
				upRes.on("close", () => {
					upstreamClosed.resolve();
				});
			},
		);
		upReq.on("error", () => {
			try {
				if (!clientRes.headersSent) {
					clientRes.writeHead(502, { "content-type": "application/json" });
				}
			} catch {
				// Client socket already gone; nothing to report to.
			}
			try {
				if (!clientRes.writableEnded) clientRes.end("{}");
			} catch {
				// Client socket already gone; nothing to report to.
			}
		});
		clientReq.on("close", () => {
			clientGone.resolve();
			// Client vanished before upstream answered: cancel the pending
			// fetch so no socket leaks past the test.
			if (!upReq.destroyed) upReq.destroy();
		});
		clientRes.on("close", () => {
			clientGone.resolve();
		});
	});
	state.proxyPort = await listenLoopback(proxy);
	state.close = () => closeLoopback(proxy);
	return state;
}

/** Read one proxied stream to its natural end over a real client socket. */
function getLoopbackBody(port: number, path: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			res.on("error", reject);
		});
		req.on("error", reject);
	});
}

test(
	"loopback: clean full stream records success and keeps relay healthy",
	{ timeout: 10000 },
	async () => {
		resetAllRelayHealth();
		_resetSseStatsForTest();
		const frames = [
			'data: {"delta":"one"}\n\n',
			'data: {"delta":"two"}\n\n',
			'data: {"delta":"three"}\n\n',
		];
		const upstream = http.createServer((_req, res) => {
			res.on("error", () => { });
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const frame of frames) res.write(frame);
			res.end("data: [DONE]\n\n");
		});
		const upstreamPort = await listenLoopback(upstream);
		const proxy = await startLoopbackStreamProxy(RELAY_URL, upstreamPort);
		try {
			const statsBefore = getSseStats();
			const body = await getLoopbackBody(proxy.proxyPort, "/v1/chat/completions");
			await awaitLoopback(proxy.upstreamClosed, "proxy-side upstream close");
			for (const frame of frames) {
				assert.ok(body.includes(frame.trim()), `client must receive ${frame.trim()}`);
			}
			assert.equal(count(body, "[DONE]"), 1, "exactly one terminal, no synthetic duplicate");
			assert.equal(isRelayHealthy(RELAY_URL), true);
			assert.equal(getRelayHealth(RELAY_URL), undefined);
			const statsAfter = getSseStats();
			assert.equal(statsAfter.total, statsBefore.total + 1, "clean stream records one watchdog outcome");
			assert.equal(statsAfter.failures, statsBefore.failures, "no failure recorded for a clean stream");
		} finally {
			await proxy.close();
			await closeLoopback(upstream);
		}
	},
);

test(
	"loopback: client destroy before first byte leaves relay healthy",
	{ timeout: 10000 },
	async () => {
		resetAllRelayHealth();
		_resetSseStatsForTest();
		const statsBefore = getSseStats();
		const upstreamDone = createLoopbackSignal();
		const upstream = http.createServer((req, res) => {
			res.on("error", () => { });
			// Real-timer exception: the first byte must land after the client
			// is already gone, and only the platform clock separates "before"
			// from "after" across two live sockets — fake time cannot drive
			// socket I/O, and every assertion below stays event-driven.
			const timer = setTimeout(() => {
				if (!res.destroyed) {
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.end("data: late\n\ndata: [DONE]\n\n");
				}
			}, 200);
			req.on("close", () => {
				clearTimeout(timer);
				upstreamDone.resolve();
			});
		});
		const upstreamPort = await listenLoopback(upstream);
		const proxy = await startLoopbackStreamProxy(RELAY_URL, upstreamPort);
		try {
			let receivedBytes = 0;
			const clientClosed = createLoopbackSignal();
			const req = http.get(
				{ host: "127.0.0.1", port: proxy.proxyPort, path: "/v1/chat/completions" },
				(res) => {
					res.on("data", (c: Buffer) => {
						receivedBytes += c.length;
					});
					res.on("error", () => { });
				},
			);
			req.on("error", () => { });
			req.on("close", () => clientClosed.resolve());
			// Real-timer exception: sequencing a teardown across live sockets
			// needs a real beat so the kernel handshake lands first; 50ms is
			// far ahead of the upstream's 200ms first byte by construction.
			setTimeout(() => req.destroy(), 50);
			await awaitLoopback(clientClosed.promise, "client socket close");
			assert.equal(receivedBytes, 0, "client must be gone before the first upstream byte");
			// Both teardowns observed: the proxy saw the client go and the
			// upstream saw the proxy go, so no relay-health decision is still
			// in flight — assert directly instead of sleeping a guessed span.
			await awaitLoopback(proxy.clientGone, "proxy-side client teardown");
			await awaitLoopback(upstreamDone.promise, "upstream-side teardown");
			assert.equal(isRelayHealthy(RELAY_URL), true, "pre-first-byte abort must not cool the relay down");
			assert.equal(getRelayHealth(RELAY_URL), undefined, "no failure record for a pre-first-byte abort");
			assert.equal(getSseStats().total, statsBefore.total, "pre-first-byte abort records no watchdog outcome");
		} finally {
			await proxy.close();
			await closeLoopback(upstream);
		}
	},
);

test(
	"loopback: client destroy mid-stream after N chunks leaves relay healthy",
	{ timeout: 10000 },
	async () => {
		resetAllRelayHealth();
		_resetSseStatsForTest();
		const statsBefore = getSseStats();
		const upstream = http.createServer((_req, res) => {
			res.on("error", () => { });
			res.writeHead(200, { "content-type": "text/event-stream" });
			let n = 0;
			// Real-timer exception: the client aborts between live chunk
			// arrivals, and only the platform clock can interleave two event
			// loops mid-stream — the abort trigger and every assertion below
			// stay event-driven, so the interval length is never asserted on.
			const timer = setInterval(() => {
				if (res.destroyed) {
					clearInterval(timer);
					return;
				}
				n++;
				if (n <= 10) {
					res.write(`data: {"seq":${n}}\n\n`);
				} else {
					clearInterval(timer);
					res.end("data: [DONE]\n\n");
				}
			}, 15);
		});
		const upstreamPort = await listenLoopback(upstream);
		const proxy = await startLoopbackStreamProxy(RELAY_URL, upstreamPort);
		try {
			let receivedChunks = 0;
			const clientClosed = createLoopbackSignal();
			const req = http.get(
				{ host: "127.0.0.1", port: proxy.proxyPort, path: "/v1/chat/completions" },
				(res) => {
					res.on("data", () => {
						receivedChunks++;
						if (receivedChunks === 2) req.destroy();
					});
					res.on("error", () => { });
				},
			);
			req.on("error", () => { });
			req.on("close", () => clientClosed.resolve());
			await awaitLoopback(clientClosed.promise, "client socket close after 2 chunks");
			assert.ok(receivedChunks >= 2, "client must have seen stream data before aborting");
			// The harness resolves after the pipe's own close listener, so the
			// relay-health decision below is already final — no sleep needed.
			await awaitLoopback(proxy.upstreamClosed, "proxy-side upstream close");
			assert.equal(isRelayHealthy(RELAY_URL), true, "mid-stream client abort must not cool the relay down");
			assert.equal(getRelayHealth(RELAY_URL), undefined, "no failure record for a mid-stream client abort");
			assert.equal(getSseStats().total, statsBefore.total, "mid-stream abort records no watchdog outcome");
		} finally {
			await proxy.close();
			await closeLoopback(upstream);
		}
	},
);

test(
	"loopback: upstream abort mid-stream marks relay failed (control)",
	{ timeout: 10000 },
	async () => {
		resetAllRelayHealth();
		_resetSseStatsForTest();
		const statsBefore = getSseStats();
		const upstream = http.createServer((_req, res) => {
			res.on("error", () => { });
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('data: {"seq":1}\n\n');
			// Event-driven abort: the socket dies after both frames reach the
			// kernel, so no wall-clock guess decides what "mid-stream" means.
			setImmediate(() => {
				if (!res.destroyed) res.write('data: {"seq":2}\n\n');
				setImmediate(() => res.destroy());
			});
		});
		const upstreamPort = await listenLoopback(upstream);
		const proxy = await startLoopbackStreamProxy(RELAY_URL, upstreamPort);
		try {
			const body = await getLoopbackBody(proxy.proxyPort, "/v1/chat/completions");
			// The harness resolves after the pipe's own close listener, so the
			// penalty below is already recorded — assert it directly, no polling.
			await awaitLoopback(proxy.upstreamClosed, "proxy-side upstream close");
			assert.ok(body.includes('"seq":1') && body.includes('"seq":2'), "client must receive the pre-abort frames");
			assert.equal(count(body, "[DONE]"), 1, "truncated host stream still gets one synthetic terminal");
			assert.equal(isRelayHealthy(RELAY_URL), false, "a genuine upstream abort must cool the relay down");
			assert.equal(getRelayHealth(RELAY_URL)?.lastStatus, 0, "failure record keeps the socket-error status");
			const statsAfter = getSseStats();
			assert.equal(statsAfter.total, statsBefore.total + 1, "upstream abort records one watchdog outcome");
			assert.equal(statsAfter.failures, statsBefore.failures + 1, "upstream abort records a watchdog failure");
		} finally {
			await proxy.close();
			await closeLoopback(upstream);
		}
	},
);
