/**
	* Relay bare-500 bounded salvage: a pre-stream bare 500 (e.g. transient
	* upstream JSON server_error "The model failed to generate a response")
	* rolls exactly once to the next sibling via the existing roll loop.
	* Deliberately no markRelayFailure on the first 500 (413 precedent) so a
	* model flake never cools a healthy relay. isRetriableStatus(500) stays
	* false — the general loop never sweeps the pool on 500s.
	*/
import test from "node:test";
import assert from "node:assert/strict";
import { isRetriableStatus, relayFetch, _resetRollNotifyForTest } from "../src/relay.ts";
import {
	getActiveRelayState,
	getRelayHealth,
	isRelayHealthy,
	markRelayFailure,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

const UPSTREAM_URL = "https://opencode.ai/zen/v1/chat/completions";
const RELAY_A = "https://relay-a.example.com";
const RELAY_B = "https://relay-b.example.com";
const RELAY_C = "https://relay-c.example.com";

const SERVER_ERROR_BODY = '{"error":{"type":"server_error","message":"The model failed to generate a response"}}';
const DETERMINISTIC_500_BODY = '{"error":{"type":"invalid_request","message":"deterministic failure"}}';

function poolState(urls: string[] = [RELAY_A, RELAY_B]): RelayState {
	return {
		enabled: true,
		url: urls[0],
		relays: urls.map((url) => ({ url })),
	};
}

/** Response-like stub with cloneable text body. */
function stubResponse(
	status: number,
	cancelled: number[],
	bodyText = "",
	headers: Record<string, string> = {},
): Response {
	const stub = {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers({ "content-type": "application/json", ...headers }),
		body: {
			cancel: async () => {
				cancelled.push(status);
			},
		},
		clone() {
			return { text: async () => bodyText };
		},
		text: async () => bodyText,
	} as unknown as Response;
	return stub;
}

test("relay 500: post-cap 500 never resets the failing relay's health or cooldown", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		// B already carries a real failure history from an earlier turn.
		markRelayFailure(RELAY_B, 502, "earlier gateway error");
		const before = getRelayHealth(RELAY_B);
		assert.ok(before && before.consecutiveFailures >= 1, "B must start with a failure record");
		assert.ok(before.cooldownUntil > Date.now(), "B must start cooling");

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			return stubResponse(500, cancelled, SERVER_ERROR_BODY);
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t500noreset");

		assert.equal(out.status, 500, "the second 500 of the turn must surface");
		assert.equal(fetchMock.mock.callCount(), 2, "one roll, then the per-turn cap");
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B], "cooling B stays the second candidate");

		const after = getRelayHealth(RELAY_B);
		assert.ok(after, "B keeps its failure record");
		assert.equal(after.successCount ?? 0, 0, "a 500 must never be recorded as a success");
		assert.equal(after.ewmaSamples ?? 0, 0, "no EWMA sample may be taken from an error");
		assert.equal(after.consecutiveFailures, before.consecutiveFailures, "failure counters must not reset");
		assert.equal(after.cooldownUntil, before.cooldownUntil, "the cooldown must not be cleared");
		assert.equal(getActiveRelayState().url, RELAY_A, "the sticky primary must not follow a failing relay");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 401: an upstream-forwarded 401 surfaces without cooling the relay", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const upstream401 = JSON.stringify({
			error: { code: "invalid_api_key", message: "Incorrect API key provided" },
		});
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			return stubResponse(401, cancelled, upstream401);
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t401fwd");

		assert.equal(out.status, 401, "the upstream credential verdict must surface");
		assert.equal(await out.text(), upstream401, "the upstream body must pass through unchanged");
		assert.equal(fetchMock.mock.callCount(), 1, "a forwarded 401 must not roll");
		assert.deepEqual(seenUrls, [RELAY_A], "the first relay answers and the turn ends there");
		assert.equal(isRelayHealthy(RELAY_A), true, "a forwarded 401 must not cool the relay");
		const health = getRelayHealth(RELAY_A);
		assert.equal(health?.consecutiveFailures ?? 0, 0, "a forwarded 401 is not a relay failure");
		assert.equal(health?.lastStatus, undefined, "no failure status may be recorded");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 500: transient server_error rolls once to sibling", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			if (seenUrls.length === 1) {
				return stubResponse(500, cancelled, SERVER_ERROR_BODY);
			}
			return stubResponse(200, cancelled, "{}");
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t500a");

		assert.equal(out.status, 200, "transient server_error must roll to the sibling");
		assert.equal(fetchMock.mock.callCount(), 2, "exactly one extra attempt, not a pool sweep");
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B], "sibling must be attempted in order");
		assert.equal(isRelayHealthy(RELAY_A), true, "first 500 must not cool the relay (413 precedent: roll without health penalty)");
		assert.equal(getRelayHealth(RELAY_A)?.consecutiveFailures ?? 0, 0, "first 500 records no failure");
		assert.equal(isRetriableStatus(500), false, "bare 500 stays non-retriable in the shared predicate");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 500: bounded cap — second server_error surfaces, third sibling never tried", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState([RELAY_A, RELAY_B, RELAY_C]), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async () => {
			seenUrls.push(seenUrls.length === 0 ? RELAY_A : RELAY_B);
			return stubResponse(500, cancelled, SERVER_ERROR_BODY);
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t500b");

		assert.equal(out.status, 500, "second consecutive server_error must surface");
		assert.equal(fetchMock.mock.callCount(), 2, "cap is 1 extra attempt per turn");
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B], "third sibling must never be tried on back-to-back 500s");
		// The post-cap 500 is a terminal passthrough, never a success: the relay
		// that just failed must not be recorded healthy (no cooldown reset, no
		// EWMA sample from an error) and the sticky primary must not move to it.
		assert.equal(getRelayHealth(RELAY_B), undefined, "post-cap 500 must not create a health record");
		assert.equal(getActiveRelayState().url, RELAY_A, "post-cap 500 must not rewrite the sticky primary");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 500: predicate is status-exact — any bare 500 rolls once, never sweeps", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			if (seenUrls.length === 1) {
				return stubResponse(500, cancelled, DETERMINISTIC_500_BODY);
			}
			return stubResponse(200, cancelled, "{}");
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t500c");

		assert.equal(out.status, 200, "bare 500 rolls once regardless of body shape (pre-stream: no bytes executed)");
		assert.equal(fetchMock.mock.callCount(), 2, "exactly one extra attempt, not a pool sweep");
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B], "sibling must be attempted in order");
		assert.equal(isRelayHealthy(RELAY_A), true, "first 500 must not cool the relay");
		assert.equal(getRelayHealth(RELAY_A)?.consecutiveFailures ?? 0, 0, "first 500 records no failure");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 500: predicate stays narrow (400/401/403/404/413/500 never retriable)", () => {
	for (const s of [400, 401, 403, 404, 413, 500]) {
		assert.equal(isRetriableStatus(s), false, `Status ${s} must stay terminal`);
	}
	for (const s of [429, 408, 502, 503, 504]) {
		assert.equal(isRetriableStatus(s), true, `Status ${s} must stay retriable`);
	}
});

test("relay 500: non-JSON content-type still rolls once", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			if (seenUrls.length === 1) {
				return stubResponse(500, cancelled, "Internal Server Error", { "content-type": "text/plain" });
			}
			return stubResponse(200, cancelled, "{}");
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t500ct");

		assert.equal(out.status, 200, "bare 500 must roll regardless of content-type");
		assert.equal(fetchMock.mock.callCount(), 2, "exactly one extra attempt");
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B], "sibling must be attempted in order");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 500-variants: 501/505 surface immediately without rolling", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		assert.equal(isRetriableStatus(501), false, "501 must stay terminal");
		assert.equal(isRetriableStatus(505), false, "505 must stay terminal");

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		let nextStatus = 501;
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			return stubResponse(nextStatus, cancelled, `{"error":"s${nextStatus}"}`);
		});

		for (const s of [501, 505]) {
			nextStatus = s;
			const before = fetchMock.mock.callCount();
			const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, `t500v-${s}`);
			assert.equal(out.status, s, `${s} must surface immediately`);
			assert.equal(fetchMock.mock.callCount(), before + 1, `${s} must not roll to a sibling`);
		}
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_A], "no sibling may be attempted for 500-variants");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay terminal: 400/404-generic surface without rolling", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		let nextStatus = 400;
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			return stubResponse(nextStatus, cancelled, `{"error":"s${nextStatus}"}`);
		});

		// 403 is deliberately out of this set: a relay-forwarded 403 is a
		// relay-host fault (blocked egress fingerprint) and relayFetch rolls it
		// like a 401 — the roll contract lives in relay.test.ts.
		for (const s of [400, 404]) {
			nextStatus = s;
			const before = fetchMock.mock.callCount();
			const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, `t-term-${s}`);
			assert.equal(out.status, s, `${s} must surface immediately`);
			assert.equal(fetchMock.mock.callCount(), before + 1, `${s} must not roll to a sibling`);
		}
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_A], "terminal statuses never touch the sibling");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 401: a relay auth rejection rolls once and cools the rejecting relay", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const served: Array<string | null> = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			// What the deployed worker answers before forwarding when the pool entry's
			// x-relay-auth no longer matches its RELAY_AUTH secret.
			if (seenUrls.length === 1) return stubResponse(401, cancelled, '{"error":"unauthorized"}');
			return stubResponse(200, cancelled, "{}");
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t401", {
			onServed: (relay) => {
				served.push(relay);
			},
		});

		assert.equal(out.status, 200, "the sibling must serve after a relay auth rejection");
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B], "401 must roll exactly once, to the sibling");
		assert.deepEqual(served, [RELAY_B], "the sibling is the relay that served");
		assert.equal(fetchMock.mock.callCount(), 2, "two relay legs, no direct fallback");

		// A 401 is a relay fault: cooled, and never recorded as a success.
		const health = getRelayHealth(RELAY_A);
		assert.ok(health, "the 401-ing relay must carry a health record");
		assert.equal(health.lastStatus, 401, "the failure must record the 401");
		assert.equal(health.consecutiveFailures, 1, "401 counts as one relay failure");
		assert.equal(health.successCount ?? 0, 0, "the 401-ing relay must not be marked successful");
		assert.equal(isRelayHealthy(RELAY_A), false, "the 401-ing relay must be cooling");
		assert.equal(isRelayHealthy(RELAY_B), true, "the serving sibling stays healthy");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 413: rolls to next path without health penalty (413 precedent)", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		assert.equal(isRetriableStatus(413), false, "413 stays non-retriable in the shared predicate");

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			if (seenUrls.length === 1) {
				return stubResponse(413, cancelled, "payload too large", { "content-type": "text/plain" });
			}
			return stubResponse(200, cancelled, "{}");
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t413");

		assert.equal(out.status, 200, "413 must advance to the next path");
		assert.equal(fetchMock.mock.callCount(), 2, "one extra attempt on the next path");
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B]);
		assert.equal(isRelayHealthy(RELAY_A), true, "413 records no failure");
		const h = getRelayHealth(RELAY_A);
		assert.equal(h?.consecutiveFailures ?? 0, 0, "413 is mark-free");
		assert.equal(h?.failureCount ?? 0, 0, "413 counts no failure");
		if (h !== undefined) assert.ok(Date.now() >= h.cooldownUntil, "413 sets no cooldown");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 500: first 500 leaves no cooldown or failure count", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			if (seenUrls.length === 1) {
				return stubResponse(500, cancelled, SERVER_ERROR_BODY);
			}
			return stubResponse(200, cancelled, "{}");
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t500mark");

		assert.equal(out.status, 200);
		assert.equal(fetchMock.mock.callCount(), 2);
		assert.equal(isRelayHealthy(RELAY_A), true, "first 500 keeps the relay healthy");
		const h = getRelayHealth(RELAY_A);
		assert.equal(h?.consecutiveFailures ?? 0, 0, "consecutiveFailures unchanged");
		assert.equal(h?.failureCount ?? 0, 0, "no failure counted");
		if (h !== undefined) assert.ok(Date.now() >= h.cooldownUntil, "no active cooldown");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 500: onServed reports the serving sibling and sticky primary follows the roll", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			if (seenUrls.length === 1) {
				return stubResponse(500, cancelled, SERVER_ERROR_BODY);
			}
			return stubResponse(200, cancelled, "{}");
		});

		let served: string | null | undefined;
		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t500aff", {
			onServed: (r) => { served = r; },
		});

		assert.equal(out.status, 200);
		assert.equal(fetchMock.mock.callCount(), 2);
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B]);
		assert.equal(served, RELAY_B, "onServed must report the relay that produced the response");
		assert.equal(getActiveRelayState().url, RELAY_B, "sticky primary follows the roll (existing roll semantics)");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 500: single-candidate pool falls through to direct fetch", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState([RELAY_A]), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			if (seenUrls.length === 1) {
				return stubResponse(500, cancelled, SERVER_ERROR_BODY);
			}
			return stubResponse(200, cancelled, "{}");
		});

		let served: string | null | undefined;
		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t500single", {
			onServed: (r) => { served = r; },
		});

		assert.equal(out.status, 200, "direct fallback must salvage the turn");
		assert.equal(fetchMock.mock.callCount(), 2, "one relay attempt plus the direct fallback, no extra relay attempt");
		assert.deepEqual(seenUrls, [RELAY_A, UPSTREAM_URL], "second attempt is the direct fallback, not another relay");
		assert.equal(served, null, "direct fallback reports a null issuer");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 500: preferred-relay 500 re-sends a byte-identical body to the sibling", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const BODY = JSON.stringify({ model: "muse-spark", stream: true, reasoning: { encrypted_content: "sealed-bytes" }, messages: [{ role: "user", content: "hi" }] });
		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const seenBodies: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
			seenUrls.push(String(input));
			seenBodies.push(String(init?.body ?? ""));
			if (seenUrls.length === 1) {
				return stubResponse(500, cancelled, SERVER_ERROR_BODY);
			}
			return stubResponse(200, cancelled, "{}");
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST", body: BODY }, "t500body", { preferred: RELAY_B });

		assert.equal(out.status, 200);
		assert.equal(fetchMock.mock.callCount(), 2);
		assert.deepEqual(seenUrls, [RELAY_B, RELAY_A], "preferred relay is tried first");
		assert.equal(seenBodies.length, 2, "both attempts must carry a body");
		assert.equal(seenBodies[0], BODY, "first attempt carries the reasoning body");
		assert.equal(seenBodies[1], BODY, "sibling retry carries the identical body");
	}, { onRestore: () => resetAllRelayHealth() });
});

test("relay 500: roll-once flag resets on the next turn", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			const transient = seenUrls.length % 2 === 1;
			return stubResponse(transient ? 500 : 200, cancelled, transient ? SERVER_ERROR_BODY : "{}");
		});

		const first = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t500r1");
		assert.equal(first.status, 200, "first turn rolls once");
		assert.equal(fetchMock.mock.callCount(), 2);

		// Re-establish the same pool order for the second turn (the sticky
		// switch after turn one is covered by the affinity test above, and a
		// CAS switch would otherwise rebase onto the on-disk pool here).
		setActiveRelayState(poolState(), false);

		const second = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t500r2");
		assert.equal(second.status, 200, "second turn rolls again — the cap is per-turn");
		assert.equal(fetchMock.mock.callCount(), 4, "second turn also spends exactly one extra attempt");
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B, RELAY_A, RELAY_B], "each turn rolls once from the same pool order");
	}, { onRestore: () => resetAllRelayHealth() });
});
