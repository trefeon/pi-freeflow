/**
 * Ambiguous 429 settlement (issue #137).
 *
 * A bare `FreeUsageLimitError` cannot be classified from the body: #117/#118
 * measured a shape fault, #124 measured a per-egress/model quota bucket with
 * the same bytes. The dispatcher therefore probes the next candidate without
 * a health mark, and only an egress that actually serves settles the earlier
 * refusals as bucket-scoped quota.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { _resetRollNotifyForTest, relayFetch } from "../src/relay.ts";
import {
	getRelayHealth,
	getRelayQuotaState,
	isRelayHealthy,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

const UPSTREAM = "https://opencode.ai/inference/openai/v1/chat/completions";
const RELAY_A = "https://ambig-a.example.com";
const RELAY_B = "https://ambig-b.example.com";
const MODEL = "deepseek-v4.1-flash-free";

const BARE_429 = JSON.stringify({ error: { type: "FreeUsageLimitError", message: "Free usage limit reached." } });
const QUOTA_429 = JSON.stringify({
	error: { type: "FreeUsageLimitError", message: "Free usage quota exceeded for today; resets at 00:00 UTC" },
});

/** Request with the gate's <env> block, as the fingerprint layer sends it. */
const BODY_WITH_ENV = JSON.stringify({
	model: MODEL,
	messages: [{ role: "system", content: "<env>\n  Working directory: /repo\n</env>" }],
});
/** Request without the block: a bare 429 then proves a shape fault. */
const BODY_WITHOUT_ENV = JSON.stringify({ model: MODEL, messages: [{ role: "system", content: "hi" }] });

function pool(urls: string[]): RelayState {
	return { enabled: true, url: urls[0] ?? "", relays: urls.map((url) => ({ url })), mode: "auto" } as RelayState;
}

function stubResponse(status: number, body = "{}"): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers({ "content-type": "application/json" }),
		body: { cancel: async () => {} },
		clone() {
			return { text: async () => body };
		},
		text: async () => body,
	} as unknown as Response;
}

function reset(): void {
	resetAllRelayHealth();
	_resetRollNotifyForTest();
}

test("ambiguous 429 rolls and a serving egress settles it as bucket quota", async (t) => {
	await withIsolatedRelayFiles(async () => {
		reset();
		setActiveRelayState(pool([RELAY_A, RELAY_B]), false);
		const seen: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			const url = String(input);
			seen.push(url);
			if (url === RELAY_A) return stubResponse(429, BARE_429);
			return stubResponse(200, '{"id":"served"}');
		});
		try {
			const res = await relayFetch(UPSTREAM, { method: "POST", body: BODY_WITH_ENV }, "ambig-1", {}, () => {});
			assert.equal(res.status, 200, "the sibling egress serves the turn");
			assert.deepEqual(seen, [RELAY_A, RELAY_B], "one bounded roll, no direct fallback");
			assert.equal(isRelayHealthy(RELAY_A, "de"), false, "the ambiguous relay takes a bucket cooldown");
			assert.equal(isRelayHealthy(RELAY_A, "ne"), true, "unrelated buckets keep the relay");
			assert.equal(getRelayHealth(RELAY_A)?.consecutiveFailures ?? 0, 0, "no network failure was recorded");
			assert.equal(getRelayQuotaState(RELAY_A, "de")?.lastStatus, 429);
			assert.equal(getRelayQuotaState(RELAY_B, "de"), undefined, "the serving relay stays clean");
		} finally {
			fetchMock.mock.restore();
			reset();
		}
	});
});

test("every candidate ambiguous: surface the original 429 without poisoning the pool", async (t) => {
	await withIsolatedRelayFiles(async () => {
		reset();
		setActiveRelayState(pool([RELAY_A, RELAY_B]), false);
		const seen: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			const url = String(input);
			seen.push(url);
			if (url === RELAY_A || url === RELAY_B) return stubResponse(429, BARE_429);
			return stubResponse(403, JSON.stringify({ error: "FreeTierError" }));
		});
		try {
			const res = await relayFetch(UPSTREAM, { method: "POST", body: BODY_WITH_ENV }, "ambig-2", {}, () => {});
			assert.equal(res.status, 429);
			assert.deepEqual(
				seen,
				[RELAY_A, RELAY_B, UPSTREAM],
				"both candidates tested, then direct; its 403 salvages the relay verdict",
			);
			assert.equal(isRelayHealthy(RELAY_A), true);
			assert.equal(isRelayHealthy(RELAY_B), true);
			assert.equal(getRelayQuotaState(RELAY_A, "de"), undefined, "no bucket was proven exhausted");
			assert.equal(getRelayQuotaState(RELAY_B, "de"), undefined);
			assert.equal(await res.text(), BARE_429, "the caller receives the authentic upstream body");
		} finally {
			fetchMock.mock.restore();
			reset();
		}
	});
});

test("confirmed quota 429 still rolls with a bucket-scoped mark", async (t) => {
	await withIsolatedRelayFiles(async () => {
		reset();
		setActiveRelayState(pool([RELAY_A, RELAY_B]), false);
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			if (String(input) === RELAY_A) return stubResponse(429, QUOTA_429);
			return stubResponse(200, '{"id":"served"}');
		});
		try {
			const res = await relayFetch(UPSTREAM, { method: "POST", body: BODY_WITH_ENV }, "quota-1", {}, () => {});
			assert.equal(res.status, 200);
			assert.equal(isRelayHealthy(RELAY_A, "de"), false);
			assert.equal(isRelayHealthy(RELAY_A, "ne"), true);
			assert.equal(getRelayHealth(RELAY_A)?.consecutiveFailures ?? 0, 0, "429 never lands on network health");
		} finally {
			fetchMock.mock.restore();
			reset();
		}
	});
});

test("a request without the env block keeps the shape verdict terminal", async (t) => {
	await withIsolatedRelayFiles(async () => {
		reset();
		setActiveRelayState(pool([RELAY_A, RELAY_B]), false);
		const seen: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seen.push(String(input));
			return stubResponse(429, BARE_429);
		});
		try {
			const res = await relayFetch(UPSTREAM, { method: "POST", body: BODY_WITHOUT_ENV }, "shape-1", {}, () => {});
			assert.equal(res.status, 429);
			assert.deepEqual(seen, [RELAY_A], "a provable shape fault must not burn a sibling relay");
			assert.equal(getRelayHealth(RELAY_A)?.consecutiveFailures ?? 0, 0);
			assert.equal(getRelayQuotaState(RELAY_A, "de"), undefined);
		} finally {
			fetchMock.mock.restore();
			reset();
		}
	});
});
