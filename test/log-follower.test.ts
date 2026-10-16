/**
 * Unit tests for the incremental follow-mode log reader (createLogFollower).
 *
 * LOG_FILE resolves inside the per-process sandbox created by test/setup.mjs,
 * so these tests own their log file and never touch real user logs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LOG_FILE } from "../src/config.ts";
import { createLogFollower } from "../src/logger.ts";

const INFO_LINE = "[2026-01-01T00:00:00.000Z] [INFO] [abc123] first append";
const WARN_LINE = "[2026-01-01T00:00:01.000Z] [WARN] [def456] second append";

function resetLog(content = ""): void {
	fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
	fs.writeFileSync(LOG_FILE, content, "utf8");
}

function appendLog(content: string): void {
	fs.appendFileSync(LOG_FILE, content, "utf8");
}

test("createLogFollower reports only bytes appended after creation", () => {
	resetLog(`${INFO_LINE}\n`);
	const follower = createLogFollower();
	// The pre-existing line is the one-shot tail's job, not the follower's.
	assert.deepEqual(follower.next(), []);
	appendLog(`${WARN_LINE}\n`);
	assert.deepEqual(follower.next(), [WARN_LINE]);
	// No new bytes since the previous tick → no repeated tail.
	assert.deepEqual(follower.next(), []);
});

test("createLogFollower carries a partial line until its newline arrives", () => {
	resetLog("");
	const follower = createLogFollower();
	const line = "[2026-01-01T00:00:02.000Z] [INFO] split across two appends";
	const cut = 20;
	appendLog(line.slice(0, cut));
	assert.deepEqual(follower.next(), [], "unterminated line must not be reported");
	appendLog(`${line.slice(cut)}\n`);
	assert.deepEqual(follower.next(), [line]);
});

test("createLogFollower resets its offset when the file is truncated", () => {
	resetLog(`${INFO_LINE}\n${WARN_LINE}\n`);
	const follower = createLogFollower();
	assert.deepEqual(follower.next(), []);
	// Rotation/truncation: the live file is now shorter than our offset.
	resetLog("");
	appendLog(`${INFO_LINE}\n`);
	assert.deepEqual(follower.next(), [INFO_LINE]);
});

test("createLogFollower drops the stale partial-line carry on truncation", () => {
	resetLog("");
	const follower = createLogFollower();
	appendLog("x".repeat(120));
	assert.deepEqual(follower.next(), []);
	resetLog(`${INFO_LINE}\n`);
	assert.deepEqual(
		follower.next(),
		[INFO_LINE],
		"the new file's first line must not be glued to the discarded prefix",
	);
});

test("createLogFollower applies the level, reqId and text filters", () => {
	resetLog("");
	const levelFollower = createLogFollower({ level: "warn" });
	const reqFollower = createLogFollower({ reqId: "req=abc123" });
	const textFollower = createLogFollower({ text: "SECOND" });
	appendLog(`${INFO_LINE}\n${WARN_LINE}\n`);
	assert.deepEqual(levelFollower.next(), [WARN_LINE]);
	assert.deepEqual(reqFollower.next(), [INFO_LINE]);
	assert.deepEqual(textFollower.next(), [WARN_LINE]);
});

test("createLogFollower caps a tick at maxLines, keeping the newest", () => {
	resetLog("");
	const follower = createLogFollower({ maxLines: 2 });
	const lines = ["a", "b", "c", "d"].map(
		(name, i) => `[2026-01-01T00:00:0${i}.000Z] [INFO] line ${name}`,
	);
	appendLog(`${lines.join("\n")}\n`);
	assert.deepEqual(follower.next(), lines.slice(-2));
});

test("createLogFollower returns [] when the log file is missing", () => {
	fs.rmSync(LOG_FILE, { force: true });
	const follower = createLogFollower();
	assert.deepEqual(follower.next(), []);
	appendLog(`${INFO_LINE}\n`);
	assert.deepEqual(follower.next(), [INFO_LINE]);
});

test("createLogFollower never reads rotated archives", () => {
	resetLog(`${INFO_LINE}\n`);
	const follower = createLogFollower();
	try {
		fs.writeFileSync(`${LOG_FILE}.1`, `${WARN_LINE}\n`, "utf8");
		assert.deepEqual(follower.next(), []);
	} finally {
		fs.rmSync(`${LOG_FILE}.1`, { force: true });
	}
});

test("createLogFollower keeps a codepoint split across two reads intact", () => {
	resetLog("");
	const follower = createLogFollower();
	const bytes = Buffer.from("héllo\n", "utf8");
	// The first append stops inside the two-byte é (0xC3 0xA9).
	fs.appendFileSync(LOG_FILE, bytes.subarray(0, 2));
	assert.deepEqual(follower.next(), [], "an incomplete codepoint must not surface");
	fs.appendFileSync(LOG_FILE, bytes.subarray(2));
	const lines = follower.next();
	assert.deepEqual(lines, ["héllo"], "a split codepoint must decode, not become U+FFFD");
	assert.ok(!lines[0].includes(String.fromCharCode(0xfffd)));
});
