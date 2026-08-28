/**
 * P2-1 readRecentLogs filterText (text-substring filter) test suite
 *
 * readRecentLogs reads from the real LOG_FILE, which is not redirectable in
 * this build, so the suite asserts only filter behavior that is independent of
 * actual log content: a marker string that cannot exist in the log matches
 * nothing, and the unfiltered call returns a well-formed result without
 * crashing. Content-free by design.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { readRecentLogs } from "../src/logger.ts";

test("readRecentLogs with non-matching filterText returns zero matches", () => {
	const result = readRecentLogs(undefined, undefined, 5, "nonexistent-marker-zxy123");
	assert.equal(result.totalMatched, 0);
	assert.equal(result.lines.length, 0);
});

test("readRecentLogs without filter returns a well-formed result", () => {
	const result = readRecentLogs();
	assert.ok(result.logFile);
	assert.ok(Array.isArray(result.lines));
	assert.equal(typeof result.totalMatched, "number");
	assert.equal(typeof result.totalLines, "number");
});
