/**
 * Hedged-failover tests (offline, mocked fetch).
 *
 * A stalled first attempt fires the next candidate after HEDGE_GRACE_MS;
 * first headers wins, the loser is aborted and left unmarked.
 *
 * Deterministic by construction: the grace override is 0ms and every mock
 * resolves via test-held gates — no wall-clock waits anywhere in this file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { relayFetch, _setHedgeGraceForTest } from "../src/relay.ts";
import {
	setActiveRelayState,
	resetAllRelayHealth,
	getRelayHealth,
} from "../src/relay-state.ts";

const UPSTREAM = "https://opencode.ai/zen/v1/chat/completions";
const R1 = "https://hedge1.example.com";
const R2 = "https://hedge2.example.com";

function usePool(urls: string[]): void {
	setActiveRelayState({
		enabled: true,
		url: urls[0] ?? "",
		relays: urls.map((u) => ({ url: u })),
		mode: "auto",
	} as unknown as Parameters<typeof setActiveRelayState>[0], false);
	resetAllRelayHealth();
}

function restorePool(): void {
	try {
		setActiveRelayState({ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0], false);
	} catch { }
	resetAllRelayHealth();
}

function abortError(): Error {
	const err = new Error("aborted");
	err.name = "AbortError";
	return err;
}

test("hedge fires after grace: first headers wins, loser aborted and unmarked", async (t) => {
	const restoreGrace = _setHedgeGraceForTest(0);
	try {
		usePool([R1, R2]);
		const calls: string[] = [];
		const signals: Array<{ url: string; signal?: AbortSignal }> = [];
		let served: string | null | undefined;
		t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
			calls.push(url);
			const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
			signals.push({ url, signal });
			if (url === R1) {
				const gate = Promise.withResolvers<Response>();
				signal?.addEventListener("abort", () => gate.reject(abortError()), { once: true });
				return await gate.promise;
			}
			if (url === R2) {
				return new Response("hedged-ok", { status: 200 });
			}
			return new Response("unexpected-direct", { status: 500 });
		});

		const res = await relayFetch(UPSTREAM, { method: "POST" }, "hedge1", { onServed: (r) => { served = r; } });
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "hedged-ok");
		assert.equal(served, R2);
		assert.ok(calls.includes(R1) && calls.includes(R2), "both relay attempts must fire");
		assert.ok(!calls.includes(UPSTREAM), "hedge-loser cancel must not trigger direct fallback");
		assert.equal(signals.find((s) => s.url === R1)?.signal?.aborted, true, "hedge loser must be aborted");
		assert.equal(getRelayHealth(R1), undefined, "cancelled loser stays unmarked");
		const winnerHealth = getRelayHealth(R2);
		assert.ok(winnerHealth && (winnerHealth.successCount ?? 0) >= 1, "winner records the EWMA sample");
	} finally {
		restoreGrace();
		restorePool();
	}
});

test("single candidate never hedges", async (t) => {
	const restoreGrace = _setHedgeGraceForTest(0);
	try {
		usePool([R1]);
		const calls: string[] = [];
		const gate = Promise.withResolvers<Response>();
		t.mock.method(globalThis, "fetch", async (url: string) => {
			calls.push(url);
			return await gate.promise;
		});

		const pending = relayFetch(UPSTREAM, { method: "POST" }, "hedge2");
		gate.resolve(new Response("solo-ok", { status: 200 }));
		const res = await pending;
		assert.equal(res.status, 200);
		assert.equal(calls.length, 1, "lone relay must be attempted exactly once");
		assert.equal(calls[0], R1);
	} finally {
		restoreGrace();
		restorePool();
	}
});

test("client abort kills both hedged attempts without marking either", async (t) => {
	const restoreGrace = _setHedgeGraceForTest(0);
	try {
		usePool([R1, R2]);
		const calls: string[] = [];
		const signals: AbortSignal[] = [];
		const bothFired = Promise.withResolvers<void>();
		t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		calls.push(url);
		const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
		if (signal) signals.push(signal);
		if (calls.length === 2) bothFired.resolve();
		const gate = Promise.withResolvers<Response>();
		signal?.addEventListener("abort", () => gate.reject(abortError()), { once: true });
		return await gate.promise;
	});

	const ctl = new AbortController();
	const pending = relayFetch(UPSTREAM, { method: "POST", signal: ctl.signal }, "hedge3");
	// Gate on the real signal: the second fetch firing IS the hedge.
	await bothFired.promise;
	ctl.abort();
	await assert.rejects(pending, { name: "AbortError" });
		assert.deepEqual(calls, [R1, R2]);
		assert.ok(signals.length >= 2 && signals.every((s) => s.aborted), "both attempts die with the caller");
		assert.equal(getRelayHealth(R1), undefined);
		assert.equal(getRelayHealth(R2), undefined);
	} finally {
		restoreGrace();
		restorePool();
	}
});
