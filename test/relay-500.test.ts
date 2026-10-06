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
import fs from "node:fs";
import { RELAY_STATE_FILE } from "../src/config.ts";
import { isRetriableStatus, relayFetch, _resetRollNotifyForTest } from "../src/relay.ts";
import {
	getActiveRelayState,
	getRelayHealth,
	isRelayHealthy,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;

/** Isolate both main and .bak disk files (relay auto-switch writes state). */
async function withIsolatedRelayFiles(fn: () => Promise<void>): Promise<void> {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const mainBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(BAK_FILE);
	try {
		await fn();
	} finally {
		if (mainBefore === null) {
			if (fs.existsSync(RELAY_STATE_FILE)) fs.unlinkSync(RELAY_STATE_FILE);
		} else {
			fs.writeFileSync(RELAY_STATE_FILE, mainBefore);
		}
		if (bakBefore === null) {
			if (fs.existsSync(BAK_FILE)) fs.unlinkSync(BAK_FILE);
		} else {
			fs.writeFileSync(BAK_FILE, bakBefore);
		}
		resetAllRelayHealth();
	}
}

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
	});
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
	});
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
	});
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
	});
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
	});
});

test("relay terminal: 400/401/403/404-generic surface without rolling", async (t) => {
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

		for (const s of [400, 401, 403, 404]) {
			nextStatus = s;
			const before = fetchMock.mock.callCount();
			const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, `t-term-${s}`);
			assert.equal(out.status, s, `${s} must surface immediately`);
			assert.equal(fetchMock.mock.callCount(), before + 1, `${s} must not roll to a sibling`);
		}
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_A, RELAY_A, RELAY_A], "terminal statuses never touch the sibling");
	});
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
	});
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
	});
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
	});
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
	});
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
	});
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
	});
});
