/**
 * Natural-429 guidance hint test suite.
 *
 * Behavioral coverage: spins up the real in-process proxy and stubs the
 * upstream fetch to return 429. No local quota gate exists anymore — the
 * deploy hint is attached to a genuine upstream 429 passthrough, which by
 * construction means every relay plus direct is rate-limited (relayFetch
 * exhausts all candidates and the direct fallback before a 429 surfaces).
 * The hint is throttled to at most once per 10 minutes per process and
 * returns after _reset429HintForTest().
 *
 * One minimal source guard keeps the hint text pinned to exactly one
 * code path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { startProxy, _reset429HintForTest } from "../src/proxy.ts";
import {
	getActiveRelayState,
	getRelayHealth,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import { RELAY_STATE_FILE } from "../src/config.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;

/** The exact hint string clients receive in a natural-429 body. */
const HINT_TEXT =
	"Shared free-tier IP quota reached. Add your own relay egress: /freeflow deploy (Vercel 1M/mo recommended)";

const TEST_PORT = 19183;
const TEST_PORT_RELAY = 19184;
const MODEL = "muse-spark-1.2-contributor-free";
const FAKE_RELAY = "https://dead-relay-999.example.com";

/** Isolate both main and .bak disk files for the duration of an async test. */
function withIsolatedRelayFiles(fn: () => Promise<void>): Promise<void> {
	const read = (p: string): string | null =>
		fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
	const mainBefore = read(RELAY_STATE_FILE);
	const bakBefore = read(BAK_FILE);
	return (async () => {
		try {
			await fn();
		} finally {
			const restore = (p: string, before: string | null): void => {
				if (before !== null) {
					fs.writeFileSync(p, before, "utf8");
				} else {
					try {
						fs.rmSync(p, { force: true });
					} catch {}
				}
			};
			restore(RELAY_STATE_FILE, mainBefore);
			restore(BAK_FILE, bakBefore);
		}
	})();
}

/** Response-like stub: a JSON error with the given status, no stream body. */
function stubResponse(status: number, body: string): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers({ "content-type": "application/json" }),
		text: async () => body,
		body: null,
	} as unknown as Response;
}

const UPSTREAM_429 = JSON.stringify({ error: "FreeUsageLimitError" });

// ── Behavioral: hint on natural direct-path 429 ─────────────────────────────

test("429 hint: natural direct 429 carries guidance, throttled 10 min, resettable", async (t) => {
	await withIsolatedRelayFiles(async () => {
		// Direct mode with an empty relay pool.
		const priorState = getActiveRelayState();
		setActiveRelayState({ enabled: true, url: "", relays: [] }, false);
		resetAllRelayHealth();
		_reset429HintForTest();

		const { server, port } = await startProxy(TEST_PORT);
		const effectivePort = port ?? TEST_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);

		try {
			// Stub upstream: passthrough local proxy traffic, 429 elsewhere.
			t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
				const u = String(url);
				if (u.startsWith(localPrefix)) return realFetch(u, init);
				return stubResponse(429, UPSTREAM_429);
			});

			const postChat = (stream: boolean): Promise<Response> =>
				fetch(`${localPrefix}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: MODEL, stream }),
				});

			// First natural 429 carries the guidance hint alongside the upstream error.
			const limited = await postChat(false);
			assert.equal(limited.status, 429);
			const limitedBody = (await limited.json()) as Record<string, unknown>;
			assert.equal(limitedBody.error, "FreeUsageLimitError");
			assert.equal(
				typeof limitedBody.hint,
				"string",
				"first natural 429 must carry the guidance hint",
			);
			assert.ok(
				(limitedBody.hint as string).includes("free-tier IP quota"),
				"hint must point at the shared free-tier IP quota",
			);

			// Immediate follow-up is still 429 but the 10-minute throttle suppresses the hint.
			const throttled = await postChat(false);
			assert.equal(throttled.status, 429);
			const throttledBody = (await throttled.json()) as Record<string, unknown>;
			assert.equal(throttledBody.error, "FreeUsageLimitError");
			assert.equal(throttledBody.hint, undefined, "hint must be throttled for 10 minutes");

			// Test-only reset rewinds the throttle: a stream-requested 429 also
			// gets the hint as buffered JSON instead of a piped stream body.
			_reset429HintForTest();
			const resumed = await postChat(true);
			assert.equal(resumed.status, 429);
			const resumedBody = (await resumed.json()) as Record<string, unknown>;
			assert.ok(
				(resumedBody.hint as string).includes("free-tier IP quota"),
				"hint must reappear after _reset429HintForTest()",
			);
		} finally {
			_reset429HintForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

// ── Behavioral: hint when the whole relay pool plus direct is 429 ───────────

test("429 hint: exhausted relay pool 429 carries guidance", async (t) => {
	await withIsolatedRelayFiles(async () => {
		const priorState = getActiveRelayState();
		setActiveRelayState(
			{ enabled: true, url: FAKE_RELAY, relays: [{ url: FAKE_RELAY, label: "dead" }] },
			false,
		);
		resetAllRelayHealth();
		_reset429HintForTest();

		const { server, port } = await startProxy(TEST_PORT_RELAY);
		const effectivePort = port ?? TEST_PORT_RELAY;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);

		try {
			// Both the relay candidate and the direct fallback are rate-limited.
			t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
				const u = String(url);
				if (u.startsWith(localPrefix)) return realFetch(u, init);
				if (u.includes("dead-relay-999")) return stubResponse(429, JSON.stringify({ error: "relay 429" }));
				return stubResponse(429, UPSTREAM_429);
			});

			const res = await fetch(`${localPrefix}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: MODEL, stream: false }),
			});
			assert.equal(res.status, 429);
			const body = (await res.json()) as Record<string, unknown>;
			assert.equal(body.error, "FreeUsageLimitError");
			assert.ok(
				(body.hint as string).includes("free-tier IP quota"),
				"exhausted-pool 429 must carry the guidance hint",
			);
			assert.ok(
				(getRelayHealth(FAKE_RELAY)?.consecutiveFailures ?? 0) >= 1,
				"the 429 relay must have been tried and marked failed before direct",
			);
		} finally {
			_reset429HintForTest();
			resetAllRelayHealth();
			setActiveRelayState(priorState, false);
			if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

// ── Minimal source guard ────────────────────────────────────────────────────

test("Rate-Limit Hint hint text appears exactly once in proxy source", () => {
	const PROXY_SRC = fs.readFileSync(
		new URL("../src/proxy.ts", import.meta.url),
		"utf8",
	);
	const occurrences = PROXY_SRC.split(HINT_TEXT).length - 1;
	assert.equal(occurrences, 1, "hint must be emitted from exactly one code path");
});
