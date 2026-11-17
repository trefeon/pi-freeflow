/**
 * Router-grounded Zen free-lane recovery (9router #5583/#5559): a session id
 * that upstream has rejected stays cached forever, so every later request
 * replays a dead `ses_*` and fails in milliseconds until restart. Dropping the
 * rejected id by VALUE lets the next turn mint a fresh one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	dropRejectedOpenCodeSession,
	opencodeHeaders,
	stableOpenCodeSessionId,
	_resetStableSessionCacheForTest,
} from "../src/opencode-identity.ts";

test("dropRejectedOpenCodeSession removes only the matching cached id", () => {
	_resetStableSessionCacheForTest();
	const a = stableOpenCodeSessionId("conv-a");
	const b = stableOpenCodeSessionId("conv-b");
	assert.equal(stableOpenCodeSessionId("conv-a"), a, "stable id reuses the cache");
	assert.ok(dropRejectedOpenCodeSession(a), "the rejected id was cached");
	assert.equal(dropRejectedOpenCodeSession(a), false, "a second drop is a no-op");
	assert.equal(dropRejectedOpenCodeSession("ses_unknownvalue"), false, "unknown ids are not cached");
	assert.equal(stableOpenCodeSessionId("conv-b"), b, "unrelated conversations are untouched");
	assert.notEqual(stableOpenCodeSessionId("conv-a"), a, "the rejected conversation mints a fresh id");
});

test("a caller-supplied native session id is never cached or dropped", () => {
	_resetStableSessionCacheForTest();
	const native = "ses_0123456789abABCDEFGHIJKLMN";
	assert.equal(opencodeHeaders(native)["x-opencode-session"], native);
	assert.equal(dropRejectedOpenCodeSession(native), false, "passthrough ids never enter the cache");
	assert.equal(stableOpenCodeSessionId(native), native, "still passes through verbatim");
});
