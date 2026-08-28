/**
 * Unit tests for the relay reachability probe (src/probe.ts).
 *
 * globalThis.fetch is stubbed per test and restored in a finally block, so
 * no real network traffic leaves the machine. Covers success, non-2xx
 * status, network rejection, an abort (AbortError), and URL normalization.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { probeRelay } from "../src/probe.ts";

/** Minimal stand-in Response: probeRelay only reads ok and status. */
function fakeResponse(ok: boolean, status: number): Response {
	return { ok, status } as Response;
}

/** Resolve the URL string from whatever RequestInfo fetch receives. */
function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

test("probeRelay reports ok + latency for a 200 and sends the expected request", async () => {
	const realFetch = globalThis.fetch;
	try {
		let calledUrl = "";
		let calledInit: RequestInit | undefined;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calledUrl = requestUrl(input);
			calledInit = init;
			return fakeResponse(true, 200);
		}) as typeof fetch;

		const result = await probeRelay("https://relay.example.com/");

		assert.equal(result.ok, true);
		assert.equal(result.status, 200);
		assert.ok(result.latencyMs >= 0);
		assert.equal(result.error, undefined);
		// URL is <relay>/v1/models with trailing slash stripped
		assert.equal(calledUrl, "https://relay.example.com/v1/models");
		const headers = (calledInit?.headers ?? {}) as Record<string, string>;
		assert.equal(headers["x-relay-target"], "https://opencode.ai");
		assert.equal(headers["x-relay-path"], "/zen/v1/models");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("probeRelay reports a non-2xx status as not ok", async () => {
	const realFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () =>
			fakeResponse(false, 403)) as typeof fetch;

		const result = await probeRelay("https://relay.example.com");

		assert.equal(result.ok, false);
		assert.equal(result.status, 403);
		assert.ok(result.latencyMs >= 0);
		assert.equal(result.error, undefined);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("probeRelay reports ok:false with an error when fetch rejects (network error)", async () => {
	const realFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as typeof fetch;

		const result = await probeRelay("https://relay.example.com");

		assert.equal(result.ok, false);
		assert.equal(result.status, 0);
		assert.equal(result.error, "network down");
		assert.ok(result.latencyMs >= 0);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("probeRelay reports ok:false with an error when the request aborts (AbortError)", async () => {
	const realFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () => {
			throw Object.assign(new Error("The operation was aborted."), {
				name: "AbortError",
			});
		}) as typeof fetch;

		const result = await probeRelay("https://relay.example.com");

		assert.equal(result.ok, false);
		assert.equal(result.status, 0);
		assert.equal(result.error, "The operation was aborted.");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("probeRelay trims whitespace and strips trailing slashes from the URL", async () => {
	const realFetch = globalThis.fetch;
	try {
		let calledUrl = "";
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calledUrl = requestUrl(input);
			return fakeResponse(true, 200);
		}) as typeof fetch;

		const result = await probeRelay("  https://relay.example.com///  ");

		assert.equal(result.ok, true);
		assert.equal(calledUrl, "https://relay.example.com/v1/models");
	} finally {
		globalThis.fetch = realFetch;
	}
});
