/**
 * P2-1 readRecentLogs filterText (text-substring filter) test suite
 *
 * Uses the injectable `files` parameter to point readRecentLogs at a temp
 * log file with known content, so filter behavior is asserted on the
 * positive path instead of only a can-never-match negative.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readRecentLogs } from "../src/logger.ts";

const KNOWN_LINES = [
	"[INFO] request starting -> https://opencode.ai/zen/v1/models",
	"[WARN] relay https://relay1.example.com returned HTTP 429 in 1.2s — rolling",
	"[ERROR] relay https://relay2.example.com fetch error in 0.5s",
	"[INFO] relay https://relay1.example.com succeeded (HTTP 200 in 0.9s)",
];

function withTempLogFile(fn: (logFile: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-log-"));
	try {
		const logFile = path.join(dir, "app.log");
		fs.writeFileSync(logFile, KNOWN_LINES.join("\n") + "\n", "utf8");
		fn(logFile);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("filterText matches only the lines containing the substring", () => {
	withTempLogFile((logFile) => {
		const result = readRecentLogs(undefined, undefined, 25, "relay1", [logFile]);
		assert.equal(result.totalMatched, 2);
		assert.equal(result.lines.length, 2);
		for (const line of result.lines) {
			assert.ok(line.includes("relay1"));
		}
	});
});

test("filterText is case-insensitive", () => {
	withTempLogFile((logFile) => {
		const result = readRecentLogs(undefined, undefined, 25, "RELAY1", [logFile]);
		assert.equal(result.totalMatched, 2);
		assert.equal(result.lines.length, 2);
		for (const line of result.lines) {
			assert.ok(line.toLowerCase().includes("relay1"));
		}
	});
});

test("filterText with no matches returns zero", () => {
	withTempLogFile((logFile) => {
		const result = readRecentLogs(undefined, undefined, 25, "nonexistent", [logFile]);
		assert.equal(result.totalMatched, 0);
		assert.equal(result.lines.length, 0);
	});
});

test("filterLevel composes with filterText", () => {
	withTempLogFile((logFile) => {
		const result = readRecentLogs("warn", undefined, 25, "relay1", [logFile]);
		assert.equal(result.totalMatched, 1);
		assert.equal(result.lines.length, 1);
		assert.ok(result.lines[0].includes("[WARN]"));
		assert.ok(result.lines[0].includes("429"));
	});
});

test("count clamp still applies when filterText is set", () => {
	withTempLogFile((logFile) => {
		const result = readRecentLogs(undefined, undefined, 1, "relay", [logFile]);
		assert.equal(result.totalMatched, 3);
		assert.equal(result.lines.length, 1);
		assert.ok(result.lines[0].includes("relay1.example.com succeeded"));
	});
});

test("readRecentLogs without filter returns a well-formed result", () => {
	const result = readRecentLogs();
	assert.ok(result.logFile);
	assert.ok(Array.isArray(result.lines));
	assert.equal(typeof result.totalMatched, "number");
	assert.equal(typeof result.totalLines, "number");
});
