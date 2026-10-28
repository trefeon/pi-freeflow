/**
 * Triage-fix regressions: hedgeSkip rateLimitOnly, removeRelay sticky,
 * parseRelayState narrowing, QUOTA_MARKERS shape/quota split, atomic
 * upstream-health persist, and the broadened stale-tmp sweep.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { LOG_FILE, RELAY_STATE_FILE, resolveUpstreamHealthPath } from "../src/config.ts";
import {
	_resetRollNotifyForTest,
	_setAttemptHeaderTimeoutForTest,
	_setHedgeGraceForTest,
	relayFetch,
} from "../src/relay.ts";
import {
	getActiveRelayState,
	loadRelayState,
	removeRelay,
	resetAllRelayHealth,
	saveRelayState,
	setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import {
	_resetUpstreamHealthForTest,
	isFreeUsageShapeError,
	recordUpstreamFailure,
} from "../src/upstream-health.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

const RELAY_A = "https://hedge-a.example.com";
const RELAY_B = "https://hedge-b.example.com";
const UPSTREAM = "https://opencode.ai/inference/openai/v1/chat/completions";

function stub429(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "application/json" },
	});
}

function blankState(url: string, urls: string[]): RelayState {
	return { mode: "on", enabled: true, url, relays: urls.map((u) => ({ url: u })) };
}

// ── hedgeSkip must not clear the all-429 verdict ────────────────────────────

test("hedge loser skip keeps all-429 exhaustedByRateLimit (info, not warn)", async (t) => {
	await withIsolatedRelayFiles(async () => {
		const prior = getActiveRelayState();
		const restoreGrace = _setHedgeGraceForTest(50);
		const restoreTimeout = _setAttemptHeaderTimeoutForTest(10_000);
		_resetRollNotifyForTest();
		resetAllRelayHealth();
		setActiveRelayState(blankState(RELAY_A, [RELAY_A, RELAY_B]), false);
		const rid = `hedge429-${Date.now()}-${process.pid}`;
		const seen: string[] = [];
		// Primary hangs past the 50ms hedge grace, then answers 429: both
		// candidates are consumed by one hedge race, so the skipped loser
		// must not flip rateLimitOnly.
		// Real timers here are the point: the hedge grace lives in src as a
		// real setTimeout race, so only a genuinely slow first leg exercises
		// the hedgeSkip path — fake timers cannot drive src's clock.
		const slow429 = new Promise<Response>((resolve) => {
			setTimeout(() => resolve(stub429(429, JSON.stringify({ error: "slow relay 429" }))), 400);
		});
		try {
			t.mock.method(globalThis, "fetch", async (url: unknown) => {
				const u = String(url);
				seen.push(u);
				if (u.startsWith(RELAY_A)) return slow429;
				return stub429(429, JSON.stringify({ error: "relay 429" }));
			});
			const res = await relayFetch(
				UPSTREAM,
				{ method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
				rid,
			);
			assert.equal(res.status, 429);
			assert.ok(
				seen.some((u) => u.startsWith("https://opencode.ai")),
				"direct fallback must still be attempted after an all-429 pool",
			);
			const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter((l) => l.includes(rid));
			assert.ok(
				lines.some((l) => l.includes("all relays rate-limited")),
				`all-429 pool must log the rate-limit verdict, got: ${JSON.stringify(lines)}`,
			);
			assert.ok(
				!lines.some((l) => l.includes("relays bypassed/exhausted")),
				"all-429 pool must not log the bypassed/exhausted warning",
			);
		} finally {
			restoreGrace();
			restoreTimeout();
			_resetRollNotifyForTest();
			resetAllRelayHealth();
			setActiveRelayState(prior, false);
		}
	});
});

// ── removeRelay trims and re-points the sticky primary ──────────────────────

test("removeRelay: padded input removes the entry and re-points sticky", () => {
	const s = blankState("https://a.example.com", ["https://a.example.com", "https://b.example.com"]);
	removeRelay(s, "  https://a.example.com  ");
	assert.deepEqual(s.relays.map((r) => r.url), ["https://b.example.com"]);
	assert.equal(s.url, "https://b.example.com");
});

test("removeRelay: last remaining clears the sticky primary", () => {
	const s = blankState("https://only.example.com", ["https://only.example.com"]);
	removeRelay(s, "https://only.example.com");
	assert.deepEqual(s.relays, []);
	assert.equal(s.url, "");
});

test("removeRelay: removing a non-sticky relay keeps the sticky primary", () => {
	const s = blankState("https://a.example.com", ["https://a.example.com", "https://b.example.com"]);
	removeRelay(s, "https://b.example.com");
	assert.deepEqual(s.relays.map((r) => r.url), ["https://a.example.com"]);
	assert.equal(s.url, "https://a.example.com");
});

// ── parseRelayState narrowing (via loadRelayState) ──────────────────────────

test("loadRelayState narrows malformed entries instead of routing on them", () => {
	withIsolatedRelayFiles(() => {
		fs.writeFileSync(
			RELAY_STATE_FILE,
			JSON.stringify({
				mode: "bogus",
				enabled: "yes",
				url: 42,
				relays: [
					{ url: "  https://good.example.com  ", label: 7, auth: true, addedAt: "2026-01-01" },
					{ url: 42 },
					{ url: "   " },
					"nope",
					null,
					{ url: "https://second.example.com", label: "ok", auth: "s3cret" },
				],
				hideWidget: 1,
				autoUpdate: "true",
			}),
			"utf8",
		);
		fs.rmSync(`${RELAY_STATE_FILE}.bak`, { force: true });
		const s = loadRelayState();
		assert.deepEqual(s.relays.map((r) => r.url), ["https://good.example.com", "https://second.example.com"]);
		assert.equal(s.relays[0].label, undefined, "non-string label must be stripped");
		assert.equal(s.relays[0].auth, undefined, "non-string auth must be stripped");
		assert.equal(s.relays[1].label, "ok");
		assert.equal(s.relays[1].auth, "s3cret");
		assert.equal(s.mode, "auto", "unknown mode must fall back to auto");
		assert.equal(s.url, "https://good.example.com", "non-string sticky must fall back to first relay");
		assert.equal(s.hideWidget, false);
		assert.equal(s.autoUpdate, false);
	});
});

// ── QUOTA_MARKERS: shape/quota split without generic-word misclass ──────────

test("isFreeUsageShapeError: bare code is shape, quota words are quota", () => {
	const bare = JSON.stringify({ error: "FreeUsageLimitError" });
	assert.equal(isFreeUsageShapeError(429, bare), true, "bare code is the shape verdict");
	const quota = JSON.stringify({
		error: { code: "FreeUsageLimitError", message: "Free usage quota exceeded for today; resets at 00:00 UTC, retry after 3600s" },
	});
	assert.equal(isFreeUsageShapeError(429, quota), false, "explicit quota language is quota");
	// Generic countdown words alone must NOT read as quota (issues #117/#118:
	// shape verdicts carry the same retry-after countdown body).
	const countdownOnly = JSON.stringify({
		error: { code: "FreeUsageLimitError", message: "try again later; retry after 3600s, resets at 00:00 UTC" },
	});
	assert.equal(isFreeUsageShapeError(429, countdownOnly), true, "retry/reset countdown without quota words is shape");
	const rateLimit = JSON.stringify({
		error: { code: "FreeUsageLimitError", message: "Rate limit exceeded for free tier (100 TPM)" },
	});
	assert.equal(isFreeUsageShapeError(429, rateLimit), false, "explicit rate-limit language is quota");
	assert.equal(isFreeUsageShapeError(200, bare), false, "non-429 is never shape");
	assert.equal(isFreeUsageShapeError(429, null), false, "non-string body is never shape");
	assert.equal(isFreeUsageShapeError(429, JSON.stringify({ error: "other" })), false, "missing code is never shape");
});

// ── upstream-health persists atomically with no tmp litter ──────────────────

test("recordUpstreamFailure persists the gate atomically with no tmp litter", () => {
	_resetUpstreamHealthForTest();
	try {
		const gateBody = JSON.stringify({
			error: { code: "FreeTierError", message: "free tier can only be used from within OpenCode" },
		});
		recordUpstreamFailure("zen", 403, gateBody);
		recordUpstreamFailure("zen", 403, gateBody);
		const file = resolveUpstreamHealthPath();
		const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
			gates: { zen: { gated: boolean } };
		};
		assert.equal(data.gates.zen.gated, true, "two consecutive gate 403s must flip the gate");
		const litter = fs.readdirSync(path.dirname(file)).filter((e) => e.endsWith(".tmp"));
		assert.deepEqual(litter, [], "atomic persist must leave no tmp litter behind");
	} finally {
		_resetUpstreamHealthForTest();
	}
});

// ── broadened stale-tmp sweep covers every state file ───────────────────────

test("loadRelayState reaps stale tmp litter for any state file, keeps fresh", () => {
	withIsolatedRelayFiles(() => {
		saveRelayState(blankState("https://x.example.com", ["https://x.example.com"]));
		const dir = path.dirname(RELAY_STATE_FILE);
		const stale = path.join(dir, "pi-freeflow-upstream-health.json.stale-uuid.tmp");
		const fresh = path.join(dir, "pi-freeflow-upstream-health.json.fresh-uuid.tmp");
		fs.writeFileSync(stale, "litter", "utf8");
		fs.writeFileSync(fresh, "litter", "utf8");
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		fs.utimesSync(stale, old, old);
		try {
			loadRelayState();
			assert.equal(fs.existsSync(stale), false, "stale non-relay tmp must be removed");
			assert.equal(fs.existsSync(fresh), true, "fresh tmp must be left alone");
		} finally {
			fs.rmSync(stale, { force: true });
			fs.rmSync(fresh, { force: true });
		}
	});
});
