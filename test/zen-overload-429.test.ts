/**
 * 9router #5583: an overload 429 is transient and must not be treated as a
 * spent session or a cooldown-worthy quota verdict. pi-freeflow's relay path
 * rolls any 429 without a FreeUsage marker to the next candidate; this test
 * pins the classifier contract that makes that roll happen.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { classifyFreeUsage429 } from "../src/upstream-health.ts";

const OVERLOAD = JSON.stringify({
	type: "error",
	error: { type: "server_error", message: "The inference service is overloaded. Please try again later." },
});

test("an overload 429 is not a FreeUsage verdict, so the relay rolls it", () => {
	assert.equal(classifyFreeUsage429(429, OVERLOAD), null, "overload has no FreeUsageLimitError marker");
	assert.notEqual(classifyFreeUsage429(429, OVERLOAD), "quota", "never cools a model bucket");
	assert.notEqual(classifyFreeUsage429(429, OVERLOAD), "shape", "never terminates as a fingerprint fault");
});

test("a genuine quota 429 still classifies as quota", () => {
	assert.equal(classifyFreeUsage429(429, JSON.stringify({
		error: { type: "FreeUsageLimitError", message: "quota exceeded" },
	})), "quota");
});
