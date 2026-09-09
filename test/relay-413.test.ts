/**
 * Relay 413 payload-limit regression: oversized requests must transparently
 * survive (try next relay, else direct fallback) with no relay health penalty.
 * 413 is client size, not relay health — never markRelayFailure/markRelaySuccess,
 * never isRetriableStatus.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RELAY_STATE_FILE } from "../src/config.ts";
import { isRetriableStatus, relayFetch, _resetRollNotifyForTest } from "../src/relay.ts";
import {
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
}

const UPSTREAM_URL = "https://opencode.ai/zen/v1/chat/completions";
const RELAY_A = "https://relay-a.example.com";
const RELAY_B = "https://relay-b.example.com";

function poolState(): RelayState {
	return {
		enabled: true,
		url: RELAY_A,
		relays: [{ url: RELAY_A }, { url: RELAY_B }],
	};
}

/** Response-like stub with an inspectable cancel() on body. */
function stubResponse(status: number, cancelled: number[]): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers(),
		body: {
			cancel: async () => {
				cancelled.push(status);
			},
		},
	} as unknown as Response;
}

test("relay 413: first candidate 413 then second 200 returns 200, both attempted", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			if (seenUrls.length === 1) return stubResponse(413, cancelled);
			return stubResponse(200, cancelled);
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t413a");

		assert.equal(out.status, 200);
		assert.equal(fetchMock.mock.callCount(), 2, "413 must continue to the next candidate");
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B], "both candidates must be attempted in order");
		assert.deepEqual(cancelled, [], "stored 413 kept unread for direct-fallback salvage, same as retriable/edge-404 pattern; freed only if direct runs");
	});
});

test("relay 413: all candidates 413 then direct 200 returns the direct 200", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		const seenUrls: string[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			seenUrls.push(String(input));
			if (seenUrls.length <= 2) return stubResponse(413, cancelled);
			return stubResponse(200, cancelled);
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t413b");

		assert.equal(out.status, 200);
		assert.equal(fetchMock.mock.callCount(), 3, "two 413s then direct fallback");
		assert.deepEqual(seenUrls, [RELAY_A, RELAY_B, UPSTREAM_URL], "exhausted pool must hit direct fallback");
	});
});

test("relay 413: never applies relay cooldown/penalty", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState(), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();

		const cancelled: number[] = [];
		let call = 0;
		t.mock.method(globalThis, "fetch", async () => {
			call++;
			if (call === 1) return stubResponse(413, cancelled);
			return stubResponse(200, cancelled);
		});

		const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t413c");
		assert.equal(out.status, 200);

		assert.equal(getRelayHealth(RELAY_A), undefined, "413 must not record a failure on the 413 relay");
		assert.equal(isRelayHealthy(RELAY_A), true, "413 relay must stay usable (no cooldown)");
	});
});

test("relay 413: isRetriableStatus(413) stays false (separate branch, never retriable)", () => {
	assert.equal(isRetriableStatus(413), false, "413 is client size, not a rollable relay error");
});
