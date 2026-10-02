/**
 * Edge-case tests for src/relay.ts — TDD sweep
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	isRetriableStatus,
	relayFetch,
} from "../src/relay.ts";
import {
	getRelayHealth,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

const BASE_STATE: RelayState = {
	enabled: false,
	url: "",
	relays: [],
};

function makeRelayState(overrides: Partial<RelayState>): RelayState {
	return { ...BASE_STATE, ...overrides };
}

const UPSTREAM_URL = "https://opencode.ai/zen/v1/chat/completions";

// ── (1) relayFetch direct when relay disabled AND pool has relays ────

test("edges-relay: relay disabled + pool has relays → direct fetch, no x-relay headers", async (t) => {
	setActiveRelayState(
		makeRelayState({
			enabled: false,
			relays: [{ url: "https://relay1.example.com" }],
		}),
		false,
	);
	resetAllRelayHealth();

	const fetchUrl = "https://api.example.com/v1/chat/completions";
	let capturedUrl: string | undefined;
	let capturedInit: RequestInit | undefined;

	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		capturedUrl = url;
		capturedInit = init;
		return new Response("ok", { status: 200 });
	});

	const res = await relayFetch(fetchUrl, { method: "POST" }, "edge1");

	assert.equal(res.status, 200);
	assert.equal(capturedUrl, fetchUrl);
	// Direct path: no x-relay-* headers added (relayFetch passes opts.headers unchanged)
	assert.equal(capturedInit?.headers, undefined, "direct path must not add any headers");
});

// ── (2) relayFetch all-retryable-exhausted → direct fallback ─────────

test("edges-relay: all retryable codes exhausted → direct fallback, x-relay headers stripped", async (t) => {
	setActiveRelayState(
		makeRelayState({
			enabled: true,
			url: "https://relay1.example.com",
			relays: [
				{ url: "https://relay1.example.com" },
				{ url: "https://relay2.example.com" },
			],
		}),
		false,
	);
	resetAllRelayHealth();

	let callCount = 0;
	const calls: Array<{ url: string; init: RequestInit }> = [];

	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		callCount++;
		calls.push({ url, init: init ?? {} });
		if (callCount <= 2) {
			// Both relays return retriable 502
			return new Response("", { status: 502 });
		}
		// Direct fallback succeeds
		return new Response("direct ok", { status: 200 });
	});

	const res = await relayFetch(UPSTREAM_URL, { method: "POST" }, "edge2");

	assert.equal(
		callCount,
		3,
		"two relay attempts + one direct fallback",
	);
	assert.equal(res.status, 200);

	// Third call is the direct fallback: url must be the upstream
	const directCall = calls[2];
	assert.equal(directCall.url, UPSTREAM_URL, "direct call must use upstream URL");

	// Direct fallback: headers must have x-relay-* deleted, host = upstream host, x-request-id present
	const headers = directCall.init.headers as Headers;
	assert.equal(
		headers.get("x-relay-target"),
		null,
		"x-relay-target must be stripped on direct fallback",
	);
	assert.equal(
		headers.get("x-relay-path"),
		null,
		"x-relay-path must be stripped on direct fallback",
	);
	assert.equal(
		headers.get("host"),
		"opencode.ai",
		"host must be upstream host on direct fallback",
	);
	assert.ok(
		headers.get("x-request-id"),
		"x-request-id must be present on direct fallback",
	);
});

// ── (3) client abort (signal already aborted) → markRelayFailure NOT called ──

test("edges-relay: client abort must NOT mark relay failed", async (t) => {
	const relayUrl = "https://relay1.example.com";
	setActiveRelayState(
		makeRelayState({
			enabled: true,
			url: relayUrl,
			relays: [{ url: relayUrl }],
		}),
		false,
	);
	resetAllRelayHealth();

	// Relay health should be clean before the call
	assert.equal(getRelayHealth(relayUrl), undefined, "relay must start clean");

	const controller = new AbortController();
	controller.abort();

	t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
		// Real fetch rejects immediately when signal is already aborted
		if (init?.signal?.aborted) {
			throw new DOMException("The operation was aborted.", "AbortError");
		}
		return new Response("ok", { status: 200 });
	});

	await assert.rejects(
		() => relayFetch(UPSTREAM_URL, { method: "POST", signal: controller.signal }, "edge3"),
		{ name: "AbortError" },
		"relayFetch must propagate AbortError",
	);

	// markRelayFailure must NOT have been called
	assert.equal(
		getRelayHealth(relayUrl),
		undefined,
		"client abort must NOT mark relay failed",
	);
});

// ── (6) isRetriableStatus boundaries ─────────────────────────────────
// Canonical boundary coverage lives in error-matrix [1/10]; this is a
// single regression lock for the Cloudflare 52x band.

test("edges-relay: isRetriableStatus 52x band regression lock", () => {
	assert.equal(isRetriableStatus(520), true, "520 is retriable");
	assert.equal(isRetriableStatus(531), false, "531 is above the band");
});

// ── (7) targetUrl invalid → relayFetch still works (URL parse fallback) ──

	test("edges-relay: invalid relay URL falls back to opencode.ai host header", async (t) => {
		setActiveRelayState(
			makeRelayState({
				enabled: true,
				url: "://invalid",
				relays: [{ url: "://invalid" }],
			}),
			false,
		);
		resetAllRelayHealth();

		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;

		t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
			capturedUrl = url;
			capturedInit = init;
			return new Response("ok", { status: 200 });
		});

		const res = await relayFetch(UPSTREAM_URL, { method: "POST" }, "edge7");

		assert.equal(res.status, 200, "relayFetch must succeed with invalid relay URL");
		// The invalid candidate is skipped by validateRelayUrl before any fetch, so
		// the only network call is the direct fallback to the upstream.
		assert.equal(capturedUrl, UPSTREAM_URL, "invalid relay URL must fall back to direct upstream");
		const headers = capturedInit!.headers as Headers;
		assert.equal(
			headers.get("host"),
			"opencode.ai",
			"direct fallback must use upstream host",
		);
		assert.equal(
			headers.get("x-relay-target"),
			null,
			"x-relay-target must be stripped on direct fallback",
		);
	});

	test("edges-relay: Vercel edge 404 marks failure and rolls to next relay", async (t) => {
		setActiveRelayState(
			makeRelayState({
				enabled: true,
				url: "https://dead-relay.vercel.app",
				relays: [
					{ url: "https://dead-relay.vercel.app" },
					{ url: "https://healthy-relay.vercel.app" },
				],
			}),
			false,
		);
		resetAllRelayHealth();

		const calls: string[] = [];
		t.mock.method(globalThis, "fetch", async (url: string) => {
			calls.push(url);
			if (url === "https://dead-relay.vercel.app") {
				return new Response("The deployment could not be found on Vercel.", {
					status: 404,
					headers: {
						"x-vercel-error": "DEPLOYMENT_NOT_FOUND",
						"x-vercel-id": "sin1::test",
						"content-type": "text/plain",
					},
				});
			}
			return new Response("ok", { status: 200 });
		});

		const res = await relayFetch(UPSTREAM_URL, { method: "POST" }, "edge-404");
		assert.equal(res.status, 200);
		assert.deepEqual(calls, [
			"https://dead-relay.vercel.app",
			"https://healthy-relay.vercel.app",
		]);
	});

// ── (8) 504 rolls to next relay instead of breaking to direct ──

test("edges-relay: 504 rolls to next relay, marks failure, no direct call", async (t) => {
	const r1 = "https://relay1.example.com";
	const r2 = "https://relay2.example.com";
	setActiveRelayState(
		makeRelayState({
			enabled: true,
			url: r1,
			relays: [{ url: r1 }, { url: r2 }],
		}),
		false,
	);
	resetAllRelayHealth();

	const calls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		calls.push(url);
		if (url === r1) return new Response("gateway timeout", { status: 504 });
		return new Response("ok", { status: 200 });
	});

	const res = await relayFetch(UPSTREAM_URL, { method: "POST" }, "edge-504");

	assert.equal(res.status, 200);
	assert.deepEqual(calls, [r1, r2], "504 must roll to the next relay, not break to direct");
	assert.notEqual(getRelayHealth(r1), undefined, "504 must mark the relay failed");
});

// ── (9) per-attempt timeout AbortError rolls; caller abort still propagates (see test 3) ──

test("edges-relay: attempt-timeout AbortError rolls to next relay and marks failure", async (t) => {
	const r1 = "https://relay1.example.com";
	const r2 = "https://relay2.example.com";
	setActiveRelayState(
		makeRelayState({
			enabled: true,
			url: r1,
			relays: [{ url: r1 }, { url: r2 }],
		}),
		false,
	);
	resetAllRelayHealth();

	const calls: string[] = [];
	const signals: Array<AbortSignal | null | undefined> = [];
	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		calls.push(url);
		signals.push(init?.signal as AbortSignal | undefined);
		if (url === r1) throw new DOMException("The operation was aborted.", "AbortError");
		return new Response("ok", { status: 200 });
	});

	// No caller signal: the AbortError can only come from the per-attempt budget.
	const res = await relayFetch(UPSTREAM_URL, { method: "POST" }, "edge-timeout");

	assert.equal(res.status, 200);
	assert.deepEqual(calls, [r1, r2], "hung relay must roll, not veto the pool");
	assert.notEqual(getRelayHealth(r1), undefined, "timed-out relay must be marked failed");
	assert.ok(signals[0] && !signals[0].aborted, "attempt must carry a live signal");
	assert.ok(signals[0] !== signals[1], "each attempt must get its own signal");
});
