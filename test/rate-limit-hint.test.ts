/**
 * P0-2 429 Rate-Limit Guidance Hint Test Suite
 *
 * Behavioral coverage: spins up the real in-process proxy in direct mode
 * (empty relay pool) and drives 201 sequential POSTs against it with the
 * upstream fetch stubbed. The 201st request trips the local per-IP quota
 * (RATE_LIMIT_MAX.opencode = 200) and must return a 429 whose JSON body
 * carries the relay-egress guidance hint. The hint is throttled to at most
 * once per 10 minutes per process and returns after _reset429HintForTest().
 *
 * One minimal source guard ([2/4]) keeps the hint text pinned to exactly one
 * code path; all other source-string assertions were replaced by the
 * behavioral test above.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { startProxy, _reset429HintForTest } from "../src/proxy.ts";
import { resetRateLimits } from "../src/rate-limiter.ts";
import {
	getActiveRelayState,
	resetAllRelayHealth,
	setActiveRelayState,
} from "../src/relay-state.ts";
import { RELAY_STATE_FILE } from "../src/config.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;

/** The exact hint string clients receive in a direct-mode 429 body. */
const HINT_TEXT =
	"Shared free-tier IP quota reached. Add your own relay egress: /freeflow deploy (Vercel 1M/mo recommended)";

const TEST_PORT = 19183;
const LOCAL_QUOTA = 200; // RATE_LIMIT_MAX.opencode: requests per UTC day per IP
const MODEL = "muse-spark-1.2-contributor-free";

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

/** Response-like stub for the upstream: a plain 200 JSON, no stream body. */
function stubResponse(status: number): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers(),
		text: async () => "{}",
		body: null,
	} as unknown as Response;
}

// ── Behavioral: hint on direct-mode 429, throttled 10 min, resettable ────────

test("429 hint: direct-mode 429 carries guidance, throttled 10 min, resettable", async (t) => {
	await withIsolatedRelayFiles(async () => {
		// Direct mode with an empty relay pool => willUseRelay false => hint branch live.
		const priorState = getActiveRelayState();
		setActiveRelayState({ enabled: true, url: "", relays: [] }, false);
		resetAllRelayHealth();
		resetRateLimits();
		_reset429HintForTest();

		const { server, port } = await startProxy(TEST_PORT);
		const effectivePort = port ?? TEST_PORT;
		const localPrefix = `http://127.0.0.1:${effectivePort}`;
		const realFetch = globalThis.fetch.bind(globalThis);

		try {
			// Stub upstream: passthrough local proxy traffic, fabricate 200 elsewhere.
			t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
				const u = String(url);
				if (u.startsWith(localPrefix)) return realFetch(u, init);
				return stubResponse(200);
			});

			const postChat = (): Promise<Response> =>
				fetch(`${localPrefix}/v1/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: MODEL, stream: false }),
				});

			// 200 sequential requests consume the per-IP opencode quota; each is allowed.
			for (let i = 0; i < LOCAL_QUOTA; i++) {
				const res = await postChat();
				assert.equal(res.status, 200, `request ${i + 1} within quota must be allowed`);
				await res.arrayBuffer(); // drain so the pooled connection is reusable
			}

			// 201st request trips the local quota -> 429 WITH the guidance hint.
			const limited = await postChat();
			assert.equal(limited.status, 429, "201st request must exceed the local quota");
			const limitedBody = (await limited.json()) as Record<string, unknown>;
			assert.equal(limitedBody.error, "rate limit exceeded");
			assert.equal(
				typeof limitedBody.hint,
				"string",
				"first 429 must carry the guidance hint",
			);
			assert.ok(
				(limitedBody.hint as string).includes("free-tier IP quota"),
				"hint must point at the shared free-tier IP quota",
			);

			// Immediate follow-up is still 429 but the 10-minute throttle suppresses the hint.
			const throttled = await postChat();
			assert.equal(throttled.status, 429);
			const throttledBody = (await throttled.json()) as Record<string, unknown>;
			assert.equal(throttledBody.error, "rate limit exceeded");
			assert.equal(throttledBody.hint, undefined, "hint must be throttled for 10 minutes");

			// Test-only reset rewinds the throttle: the hint returns on the next 429.
			_reset429HintForTest();
			const resumed = await postChat();
			assert.equal(resumed.status, 429);
			const resumedBody = (await resumed.json()) as Record<string, unknown>;
			assert.ok(
				(resumedBody.hint as string).includes("free-tier IP quota"),
				"hint must reappear after _reset429HintForTest()",
			);
		} finally {
			_reset429HintForTest();
			resetRateLimits();
			setActiveRelayState(priorState, false);
			if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

// ── Minimal source guard ────────────────────────────────────────────────────

test("Rate-Limit Hint [2/4] hint text appears exactly once in proxy source", () => {
	const PROXY_SRC = fs.readFileSync(
		new URL("../src/proxy.ts", import.meta.url),
		"utf8",
	);
	const occurrences = PROXY_SRC.split(HINT_TEXT).length - 1;
	assert.equal(occurrences, 1, "hint must be emitted from exactly one code path");
});
