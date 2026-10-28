import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	OPENCODE_USER_AGENT_ENV,
	OPENCODE_VERSION_CACHE_ENV,
	OPENCODE_VERSION_FALLBACK,
	_resetLiveOpenCodeVersionForTest,
	getLiveOpenCodeVersion,
	getOpenCodeUserAgent,
	getOpenCodeVersionSource,
	parseOpenCodeBinaryVersion,
	probeInstalledOpenCodeVersion,
	refreshOpenCodeUserAgent,
} from "../src/config.ts";

test("parseOpenCodeBinaryVersion accepts the CLI output shapes", () => {
	_resetLiveOpenCodeVersionForTest();
	assert.equal(parseOpenCodeBinaryVersion("2.2.0"), "2.2.0");
	assert.equal(parseOpenCodeBinaryVersion("v2.2.0"), "2.2.0");
	assert.equal(parseOpenCodeBinaryVersion("opencode-ai 1.19.4"), "1.19.4");
	assert.equal(parseOpenCodeBinaryVersion("opencode-ai version 1.19.4 (linux-x64)\n"), "1.19.4");
	assert.equal(parseOpenCodeBinaryVersion("2.0.27"), "2.0.27");
	assert.equal(parseOpenCodeBinaryVersion("  opencode/1.99.0  "), "1.99.0");
});

test("parseOpenCodeBinaryVersion rejects below-floor and unparseable output", () => {
	_resetLiveOpenCodeVersionForTest();
	assert.equal(parseOpenCodeBinaryVersion("opencode-ai 1.0.0"), null, "below the 1.17.0 floor");
	assert.equal(parseOpenCodeBinaryVersion("1.16.9"), null, "just under the floor");
	assert.equal(parseOpenCodeBinaryVersion("not a version"), null);
	assert.equal(parseOpenCodeBinaryVersion(""), null);
	assert.equal(parseOpenCodeBinaryVersion("1.19"), null, "no patch segment");
	assert.equal(parseOpenCodeBinaryVersion(null), null);
	assert.equal(parseOpenCodeBinaryVersion(42), null);
});

test("probeInstalledOpenCodeVersion reads the stub spawn, null on failure", () => {
	_resetLiveOpenCodeVersionForTest();
	const ok = () => ({ status: 0, stdout: "opencode-ai 1.19.4\n" });
	assert.equal(probeInstalledOpenCodeVersion({ execPath: "stub-ok", spawnImpl: ok }), "1.19.4");
	_resetLiveOpenCodeVersionForTest();
	const v2 = () => ({ status: 0, stdout: "v2.2.0\n" });
	assert.equal(probeInstalledOpenCodeVersion({ execPath: "stub-v2", spawnImpl: v2 }), "2.2.0");
	_resetLiveOpenCodeVersionForTest();
	const nonzero = () => ({ status: 1, stdout: "1.19.4" });
	assert.equal(probeInstalledOpenCodeVersion({ execPath: "stub-nonzero", spawnImpl: nonzero }), null);
	_resetLiveOpenCodeVersionForTest();
	const empty = () => ({ status: 0, stdout: "" });
	assert.equal(probeInstalledOpenCodeVersion({ execPath: "stub-empty", spawnImpl: empty }), null);
	_resetLiveOpenCodeVersionForTest();
	const throwing = () => { throw new Error("spawn ENOENT"); };
	assert.equal(probeInstalledOpenCodeVersion({ execPath: "stub-throw", spawnImpl: throwing }), null);
	_resetLiveOpenCodeVersionForTest();
	const errored = () => ({ status: null, error: new Error("timed out") });
	assert.equal(probeInstalledOpenCodeVersion({ execPath: "stub-error", spawnImpl: errored }), null);
	_resetLiveOpenCodeVersionForTest();
	const stderrOnly = () => ({ status: 0, stdout: "", stderr: "opencode-ai 2.0.27\n" });
	assert.equal(probeInstalledOpenCodeVersion({ execPath: "stub-stderr", spawnImpl: stderrOnly }), "2.0.27");
});

test("probeInstalledOpenCodeVersion memoizes per execPath", () => {
	_resetLiveOpenCodeVersionForTest();
	let calls = 0;
	const counting = () => {
		calls++;
		return { status: 0, stdout: "1.19.4" };
	};
	assert.equal(probeInstalledOpenCodeVersion({ execPath: "stub-memo", spawnImpl: counting }), "1.19.4");
	assert.equal(probeInstalledOpenCodeVersion({ execPath: "stub-memo", spawnImpl: counting }), "1.19.4");
	assert.equal(calls, 1, "second probe inside the window must not respawn");
	assert.equal(
		probeInstalledOpenCodeVersion({ execPath: "stub-memo-other", spawnImpl: counting }),
		"1.19.4",
	);
	assert.equal(calls, 2, "a different execPath re-probes");
});

// Hermetic PATH-shim sandbox: a fake `opencode` first on PATH proves the
// offline precedence without touching the real install (CI has no binary).
async function withShimmedBinary(versionLine: string, run: () => void | Promise<void>): Promise<void> {
	const savedPath = process.env["PATH"];
	const savedAgent = process.env[OPENCODE_USER_AGENT_ENV];
	const savedCache = process.env[OPENCODE_VERSION_CACHE_ENV];
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pff-binver-"));
	const cacheFile = path.join(sandbox, "version.json");
	try {
		if (process.platform === "win32") {
			fs.writeFileSync(
				path.join(sandbox, "opencode.cmd"),
				"@echo off\r\n" + `echo ${versionLine}\r\n`,
			);
		} else {
			fs.writeFileSync(
				path.join(sandbox, "opencode"),
				"#!/bin/sh\n" + `echo '${versionLine}'\n`,
				{ mode: 0o755 },
			);
		}
		process.env["PATH"] = sandbox + path.delimiter + (savedPath ?? "");
		delete process.env[OPENCODE_USER_AGENT_ENV];
		process.env[OPENCODE_VERSION_CACHE_ENV] = cacheFile;
		_resetLiveOpenCodeVersionForTest();
		await run();
	} finally {
		if (savedPath === undefined) delete process.env["PATH"];
		else process.env["PATH"] = savedPath;
		if (savedAgent === undefined) delete process.env[OPENCODE_USER_AGENT_ENV];
		else process.env[OPENCODE_USER_AGENT_ENV] = savedAgent;
		if (savedCache === undefined) delete process.env[OPENCODE_VERSION_CACHE_ENV];
		else process.env[OPENCODE_VERSION_CACHE_ENV] = savedCache;
		_resetLiveOpenCodeVersionForTest();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
}

test("installed 1.x binary drives the UA offline with no network", async () => {
	await withShimmedBinary("opencode-ai 1.19.4", () => {
		assert.equal(
			getOpenCodeUserAgent(),
			"opencode/1.19.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4",
			"binary present offline resolves without network",
		);
		assert.equal(getLiveOpenCodeVersion(), "1.19.4");
		assert.equal(getOpenCodeVersionSource(), "binary");
	});
	// Registry refresh with a dead fetch keeps the binary-served UA.
	await withShimmedBinary("opencode-ai 1.19.4", async () => {
		const stubDown = (async () => { throw new Error("network down"); }) as typeof fetch;
		assert.equal(
			await refreshOpenCodeUserAgent(stubDown),
			"opencode/1.19.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4",
			"offline refresh keeps the binary UA",
		);
	});
});

test("installed 2.x binary never auto-switches the compat-lane shape", async () => {
	await withShimmedBinary("opencode v2.2.0", () => {
		assert.equal(
			getOpenCodeUserAgent(),
			`opencode/${OPENCODE_VERSION_FALLBACK} ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`,
			"major-2 install keeps the 1.19.4 compat UA",
		);
		assert.equal(getLiveOpenCodeVersion(), "2.2.0", "2.x surfaces for logs only");
		assert.equal(getOpenCodeVersionSource(), "binary");
	});
});

test("registry refresh records the registry source", async () => {
	const savedAgent = process.env[OPENCODE_USER_AGENT_ENV];
	const savedCache = process.env[OPENCODE_VERSION_CACHE_ENV];
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pff-binver-reg-"));
	try {
		delete process.env[OPENCODE_USER_AGENT_ENV];
		process.env[OPENCODE_VERSION_CACHE_ENV] = path.join(sandbox, "version.json");
		_resetLiveOpenCodeVersionForTest();
		const stubOk = (async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 })) as typeof fetch;
		await refreshOpenCodeUserAgent(stubOk);
		assert.equal(getOpenCodeVersionSource(), "registry");
	} finally {
		if (savedAgent === undefined) delete process.env[OPENCODE_USER_AGENT_ENV];
		else process.env[OPENCODE_USER_AGENT_ENV] = savedAgent;
		if (savedCache === undefined) delete process.env[OPENCODE_VERSION_CACHE_ENV];
		else process.env[OPENCODE_VERSION_CACHE_ENV] = savedCache;
		_resetLiveOpenCodeVersionForTest();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});
