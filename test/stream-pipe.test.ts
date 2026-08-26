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
import type * as http from "node:http";

import { pipeUpstreamStream } from "../src/stream-pipe.ts";
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
