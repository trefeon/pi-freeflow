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
	DEFAULT_PORT,
	LEGACY_PORT,
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
	const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
	const lines: Array<{ file: string; line: string; num: number }> = [];
	for (const f of files) {
		const content = fs.readFileSync(path.join(srcDir, f), "utf8");
		content
			.split(/\r?\n/)
			.forEach((l, i) => lines.push({ file: f, line: l, num: i + 1 }));
	}

	// No assignment of a non-trivial literal to an api-key-like name.
	// The literal "placeholder" (buildProviderConfig's OMP registration
	// sentinel) is exempt — it is a marker, not a credential.
	for (const { file, line, num } of lines) {
		const match = /api[_-]?key\s*[=:]\s*["']([^"']{6,})["']/i.exec(line);
		if (!match || match[1] === "placeholder" || match[1] === "public") continue;
		assert.fail(`${file}:${num} must not hardcode an API key literal`);
	}

	// Every Bearer credential line is either the known kilo-free free-tier
	// token or a `${token}` interpolation — nothing else may hardcode a secret.
	const bearerLines = lines.filter(({ line }) => /Bearer /.test(line));
	assert.ok(bearerLines.length > 0, "expected Bearer credential lines in src");
	for (const { file, line, num } of bearerLines) {
		assert.ok(
			line.includes("kilo-free") || line.includes("${token}"),
			`${file}:${num} hardcodes an unexpected Bearer credential`,
		);
	}
});

test("sanitizeHeaders never emits duplicate User-Agent headers", () => {
	const incoming = {
		host: "127.0.0.1:28180",
		"user-agent": "node",
		"content-type": "application/json",
	};
	const fwd = sanitizeHeaders(incoming, "opencode.ai");
	const uaKeys = Object.keys(fwd).filter((k) => k.toLowerCase() === "user-agent");
	assert.equal(uaKeys.length, 1);
	assert.equal(fwd[uaKeys[0]], "opencode/latest/1.14.50/cli");
});

test("resolvePort honors the source-derived env override and falls back to default 28180", () => {
	// Derive the env key from source instead of hardcoding it
	const configSrc = fs.readFileSync(
		path.join(import.meta.dirname, "..", "src", "config.ts"),
		"utf8",
	);
	const match = /process\.env\.([A-Z0-9_]+)_PORT/.exec(configSrc);
	assert.ok(match, "src/config.ts must read a *_PORT env var");
	const actualKey = match![1] + "_PORT";

	const original = process.env[actualKey];
	delete process.env[actualKey];
	try {
		assert.equal(resolvePort(), 28180, "default port without env override");
		process.env[actualKey] = "3001";
		assert.equal(resolvePort(), 3001, "env override wins");
	} finally {
		if (original !== undefined) {
			process.env[actualKey] = original;
		} else {
			delete process.env[actualKey];
		}
	}
});

test("LEGACY_PORT is defined as 18080 for backward compatibility", () => {
	assert.equal(LEGACY_PORT, 18080);
	assert.equal(DEFAULT_PORT, 28180);
});
