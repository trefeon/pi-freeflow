/**
 * Opencode-lane version-drift auto-repair: isStaleOpenCodeVersionError
 * classifies only version-naming refusals (426, or 400/403 with explicit
 * upgrade/version language) and never the FreeTier gate, quota 429s, or
 * lane-shape 404/405s. Offline-safe: pure classifier, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isStaleOpenCodeVersionError } from "../src/proxy.ts";

test("stale version: 426 qualifies even with an empty body", () => {
	assert.equal(isStaleOpenCodeVersionError(426, ""), true);
	assert.equal(isStaleOpenCodeVersionError(426, "Upgrade Required"), true);
});

test("stale version: 400/403 with version language qualify", () => {
	assert.equal(isStaleOpenCodeVersionError(400, "client version too old, please upgrade"), true);
	assert.equal(isStaleOpenCodeVersionError(403, "opencode/1.17.0 is no longer supported"), true);
	assert.equal(isStaleOpenCodeVersionError(400, "update your CLI to a newer version"), true);
	assert.equal(isStaleOpenCodeVersionError(400, "outdated client, minimum version 1.18.0 required"), true);
});

test("stale version: FreeTier gate bodies never qualify", () => {
	const gate = JSON.stringify({ error: { code: "FreeTierError", message: "only be used from within OpenCode" } });
	assert.equal(isStaleOpenCodeVersionError(403, gate), false);
	const abusive = JSON.stringify({ error: { code: "FreeTierError", message: "blocked for abusive traffic" } });
	assert.equal(isStaleOpenCodeVersionError(403, abusive), false);
});

test("stale version: quota, lane-shape, and unrelated verdicts never qualify", () => {
	assert.equal(isStaleOpenCodeVersionError(429, "Free usage limit reached"), false);
	assert.equal(isStaleOpenCodeVersionError(404, "not found"), false);
	assert.equal(isStaleOpenCodeVersionError(405, "method not allowed"), false);
	assert.equal(isStaleOpenCodeVersionError(400, "invalid request: bad tool schema"), false);
	assert.equal(isStaleOpenCodeVersionError(403, "forbidden"), false);
	assert.equal(isStaleOpenCodeVersionError(500, "upgrade your plan"), false);
	assert.equal(isStaleOpenCodeVersionError(400, "please upgrade your plan to continue"), false);
});
