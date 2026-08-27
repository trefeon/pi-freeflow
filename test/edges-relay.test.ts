/**
 * Edge-case tests for src/relay.ts — TDD sweep
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	clampMaxTokens,
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

// ── (4) clampMaxTokens model-not-found → default 32k-1024 ────────────

test("edges-relay: clampMaxTokens model-not-found defaults to 32768 - 1024 = 30976", () => {
	assert.equal(
		clampMaxTokens("nonexistent-model", 50_000),
		32_000 - 1024,
		"model-not-found must clamp to 30976",
	);
	assert.equal(
		clampMaxTokens("nonexistent-model", 1_000),
		1_000,
		"model-not-found with request < max must pass through",
	);
});

// ── (5) clampMaxTokens requested 0 → returns 0 ──────────────────────

test("edges-relay: clampMaxTokens requested 0 returns 0", () => {
	assert.equal(
		clampMaxTokens("nonexistent-model", 0),
		0,
		"requested 0 with model-not-found must return 0",
	);
	assert.equal(
		clampMaxTokens("big-pickle", 0),
		0,
		"requested 0 with known model must return 0",
	);
});

// ── (6) isRetriableStatus boundaries ─────────────────────────────────
// Already covered by thin-provider-lock.test.ts — included as regression lock

test("edges-relay: isRetriableStatus boundary values (regression lock)", () => {
	// True: Cloudflare 52x band
	assert.equal(isRetriableStatus(520), true, "520 is retriable");
	assert.equal(isRetriableStatus(521), true, "521 is retriable");
	assert.equal(isRetriableStatus(530), true, "530 is retriable");
	// False: just below and above band
	assert.equal(isRetriableStatus(519), false, "519 is not retriable");
	assert.equal(isRetriableStatus(531), false, "531 is not retriable");
	// Standard retriable codes
	assert.equal(isRetriableStatus(429), true, "429 is retriable");
	assert.equal(isRetriableStatus(408), true, "408 is retriable");
	assert.equal(isRetriableStatus(502), true, "502 is retriable");
	assert.equal(isRetriableStatus(503), true, "503 is retriable");
	assert.equal(isRetriableStatus(504), true, "504 is retriable");
	// Non-retriable
	assert.equal(isRetriableStatus(500), false, "500 is not retriable");
	assert.equal(isRetriableStatus(400), false, "400 is not retriable");
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

	let capturedInit: RequestInit | undefined;

	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		capturedInit = init;
		return new Response("ok", { status: 200 });
	});

	const res = await relayFetch(UPSTREAM_URL, { method: "POST" }, "edge7");

	assert.equal(res.status, 200, "relayFetch must succeed with invalid relay URL");
	const headers = capturedInit!.headers as Headers;
	assert.equal(
		headers.get("host"),
		"opencode.ai",
		"invalid relay URL must fall back to opencode.ai host",
	);
	assert.equal(
		headers.get("x-relay-target"),
		"https://opencode.ai",
		"x-relay-target must be set from upstream host despite invalid relay URL",
	);
});