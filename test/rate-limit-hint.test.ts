/**
 * P0-2 429 Rate-Limit Guidance Hint Test Suite
 *
 * Validates that the direct-mode (no relay) 429 response includes a relay-egress
 * guidance hint, throttled to at most once per 10 minutes per process.
 * Deterministic by design: no proxy server is spun up — the throttle reset is
 * exercised through the exported hook and the branch wiring is guarded at the
 * source level, consistent with how error-matrix.test.ts validates relay workers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { _reset429HintForTest } from "../src/proxy.ts";

const PROXY_SRC = fs.readFileSync(
	new URL("../src/proxy.ts", import.meta.url),
	"utf8",
);

// The exact hint string clients receive in a direct-mode 429 body.
const HINT_TEXT =
	"Shared free-tier IP quota reached. Add your own relay egress: /freeflow deploy (Vercel 1M/mo recommended)";

// ── 1. Exported Test Reset ──────────────────────────────────────────────────

test("Rate-Limit Hint [1/4] _reset429HintForTest is exported and idempotent", () => {
	assert.equal(typeof _reset429HintForTest, "function");
	// Safe to call when the throttle is cold — must not throw or corrupt state.
	_reset429HintForTest();
	_reset429HintForTest();
});

// ── 2. Hint Text Presence ────────────────────────────────────────────────────

test("Rate-Limit Hint [2/4] hint text appears exactly once in proxy source", () => {
	const occurrences = PROXY_SRC.split(HINT_TEXT).length - 1;
	assert.equal(occurrences, 1, "hint must be emitted from exactly one code path");
});

// ── 3. Throttle Semantics (10-minute window, per-process) ────────────────────

test("Rate-Limit Hint [3/4] source enforces a 10-minute per-process throttle", () => {
	// Module-level state, mirroring the last429Warn pattern in relay-state.ts.
	assert.ok(PROXY_SRC.includes("let last429HintAt = 0;"), "throttle state must start cold");
	assert.ok(PROXY_SRC.includes("function shouldShow429Hint(): boolean {"), "throttle helper must exist");
	// Guard: suppress the hint until the 10-minute window elapses.
	assert.ok(
		PROXY_SRC.includes("if (now - last429HintAt < 10 * 60 * 1000) return false;"),
		"hint must be suppressed within the 10-minute window",
	);
	// On fire: stamp the current time so subsequent calls are suppressed.
	assert.ok(PROXY_SRC.includes("last429HintAt = now;"), "fired hint must stamp the throttle");
	// Reset hook rewinds the throttle for tests.
	assert.ok(
		PROXY_SRC.includes("export function _reset429HintForTest(): void { last429HintAt = 0; }"),
		"test reset must rewind the throttle",
	);
});

// ── 4. Hint Confined to the Direct-Mode Branch ───────────────────────────────

test("Rate-Limit Hint [4/4] hint is wired only into the !willUseRelay 429 branch", () => {
	const branchStart = PROXY_SRC.indexOf("if (!willUseRelay && !checkRateLimit(clientIP, upstream)) {");
	assert.ok(branchStart >= 0, "direct-mode rate-limit branch must exist");

	// The branch ends at the next top-level statement after its closing brace.
	const tryStart = PROXY_SRC.indexOf("\n\t\t\ttry {", branchStart);
	assert.ok(tryStart > branchStart, "expected the relay-fetch try block after the branch");
	const branchSrc = PROXY_SRC.slice(branchStart, tryStart);

	// The 429 body keeps the existing error contract and adds the hint.
	assert.ok(branchSrc.includes('error: "rate limit exceeded"'), "429 body must keep the error field");
	assert.ok(branchSrc.includes("if (shouldShow429Hint()) {"), "hint must be gated by the throttle");
	assert.ok(branchSrc.includes(`body.hint = "${HINT_TEXT}";`), "hint must be attached to the 429 body");
	// Whole-file count of 1 (asserted in test 2/4) already proves the hint
	// appears nowhere else; this test pins it to this branch region.
	assert.ok(
		PROXY_SRC.slice(0, branchStart).includes(HINT_TEXT) === false &&
			PROXY_SRC.slice(tryStart).includes(HINT_TEXT) === false,
		"hint must not appear outside the direct-mode rate-limit branch",
	);
});
