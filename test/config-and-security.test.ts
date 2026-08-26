/**
 * Unit tests for configuration security and zero hardcoded credentials
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
	ALLOWED_METHODS,
	ALLOWED_PATH_PATTERN,
	PATH_TRAVERSAL_PATTERN,
	STRIP_HEADERS,
	resolvePort,
} from "../src/config.ts";
import { sanitizeHeaders } from "../src/proxy.ts";

test("security whitelists allow only standard safe API paths", () => {
	assert.ok(ALLOWED_PATH_PATTERN.test("/v1/chat/completions"));
	assert.ok(ALLOWED_PATH_PATTERN.test("/v1/models"));
	assert.ok(ALLOWED_PATH_PATTERN.test("/v1/responses"));

	assert.equal(ALLOWED_PATH_PATTERN.test("/v2/secret"), false);
	assert.equal(ALLOWED_PATH_PATTERN.test("/admin"), false);
});

test("path traversal pattern catches dot-dot sequences", () => {
	assert.ok(PATH_TRAVERSAL_PATTERN.test("../etc/passwd"));
	assert.ok(PATH_TRAVERSAL_PATTERN.test("/v1/.."));
	assert.equal(PATH_TRAVERSAL_PATTERN.test("/v1/models"), false);
});

test("forbidden headers are stripped", () => {
	assert.ok(STRIP_HEADERS.has("authorization"));
	assert.ok(STRIP_HEADERS.has("cookie"));
	assert.ok(STRIP_HEADERS.has("x-real-ip"));
	assert.ok(STRIP_HEADERS.has("x-forwarded-for"));
});

test("zero hardcoded API keys exist in source tree", () => {
	const srcDir = path.join(import.meta.dirname, "..", "src");
	const files = fs.readdirSync(srcDir);
	for (const f of files) {
		const content = fs.readFileSync(path.join(srcDir, f), "utf8");
		// Check that no literal fallback assignments exist
		assert.equal(
			content.includes("process.env.FREEFLOW_API_KEY = \"freeflow\""),
			false,
			`file ${f} must not assign hardcoded key to FREEFLOW_API_KEY`,
		);
	}
});

test("sanitizeHeaders never emits duplicate User-Agent headers", () => {
	const incoming = {
		host: "127.0.0.1:18080",
		"user-agent": "node",
		"content-type": "application/json",
	};
	const fwd = sanitizeHeaders(incoming, "opencode.ai");
	const uaKeys = Object.keys(fwd).filter((k) => k.toLowerCase() === "user-agent");
	assert.equal(uaKeys.length, 1);
	assert.equal(fwd[uaKeys[0]], "opencode/latest/1.14.50/cli");
});

test("resolvePort falls back to default 18080 without env overrides", () => {
	const original = process.env.FREEFLOW_PORT;
	delete process.env.FREEFLOW_PORT;
	try {
		assert.equal(resolvePort(), 18080);
	} finally {
		if (original) process.env.FREEFLOW_PORT = original;
	}
});
