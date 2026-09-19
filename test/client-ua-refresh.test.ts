/**
	* Background OpenCode UA refresh wiring (client lane).
	*
	* maybeRefreshOpenCodeUserAgent() is kicked once at attach/startup and
	* re-armed on the heartbeat cadence. These tests pin:
	*  1. Overlapping kicks (attach + immediate heartbeat) fetch exactly once.
	*  2. The storm-guard holds across further kicks; a reset re-arms.
	*  3. A refresh rejection never surfaces and the pinned fallback serves.
	*/
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
	getOpenCodeUserAgent,
} from "../src/config.ts";
import {
	_resetClientForTest,
	_resetUaRefreshForTest,
	_setUaRefreshFetchForTest,
	maybeRefreshOpenCodeUserAgent,
} from "../src/client.ts";

function withIsolatedUaCache(run: (cacheFile: string) => Promise<void>): Promise<void> {
	const savedAgent = process.env[OPENCODE_USER_AGENT_ENV];
	const savedCache = process.env[OPENCODE_VERSION_CACHE_ENV];
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-freeflow-client-ua-"));
	const cacheFile = path.join(sandbox, "version.json");
	return (async () => {
		try {
			delete process.env[OPENCODE_USER_AGENT_ENV];
			process.env[OPENCODE_VERSION_CACHE_ENV] = cacheFile;
			_resetClientForTest();
			await run(cacheFile);
		} finally {
			if (savedAgent === undefined) delete process.env[OPENCODE_USER_AGENT_ENV];
			else process.env[OPENCODE_USER_AGENT_ENV] = savedAgent;
			if (savedCache === undefined) delete process.env[OPENCODE_VERSION_CACHE_ENV];
			else process.env[OPENCODE_VERSION_CACHE_ENV] = savedCache;
			_resetClientForTest();
			_resetLiveOpenCodeVersionForTest();
			fs.rmSync(sandbox, { recursive: true, force: true });
		}
	})();
}

// Deterministic drain: the background refresh chain is microtasks only
// (stub fetch, json parse, sync disk write), so one macrotask checkpoint
// flushes it with no wall-clock wait. setImmediate is not a duration timer.
const flush = () => new Promise<void>((r) => setImmediate(r));

function countingStub(version: string, counter: { calls: number }): typeof fetch {
	return (async () => {
		counter.calls++;
		return new Response(JSON.stringify({ version }), { status: 200 });
	}) as typeof fetch;
}

test("attach + heartbeat kicks fetch exactly once (storm-guard)", async () => {
	await withIsolatedUaCache(async () => {
		const counter = { calls: 0 };
		_setUaRefreshFetchForTest(countingStub("9.9.9", counter));
		// Simulate attach-time kick plus an immediate heartbeat re-arm.
		maybeRefreshOpenCodeUserAgent();
		maybeRefreshOpenCodeUserAgent();
		await flush();
		assert.equal(counter.calls, 1, "overlapping kicks must stampede npm only once");
		assert.equal(getOpenCodeUserAgent(), "opencode/9.9.9", "live version populates when online");
	});
});

test("further kicks respect the guard; reset re-arms", async () => {
	await withIsolatedUaCache(async () => {
		const counter = { calls: 0 };
		_setUaRefreshFetchForTest(countingStub("9.9.9", counter));
		maybeRefreshOpenCodeUserAgent();
		await flush();
		assert.equal(counter.calls, 1);
		// Heartbeat cadence re-arms stay silent while the guard holds.
		maybeRefreshOpenCodeUserAgent();
		maybeRefreshOpenCodeUserAgent();
		await flush();
		assert.equal(counter.calls, 1, "guard must hold across heartbeat ticks");
		_resetUaRefreshForTest();
		_setUaRefreshFetchForTest(countingStub("9.9.9", counter));
		maybeRefreshOpenCodeUserAgent();
		await flush();
		assert.equal(counter.calls, 2, "reset must re-arm the next refresh");
	});
});

test("refresh rejection never surfaces; pinned fallback carries traffic", async () => {
	await withIsolatedUaCache(async () => {
		const failing = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		_setUaRefreshFetchForTest(failing);
		// Must not throw synchronously; the rejection is swallowed in background.
		maybeRefreshOpenCodeUserAgent();
		await flush();
		assert.equal(
			getOpenCodeUserAgent(),
			`opencode/${OPENCODE_VERSION_FALLBACK}`,
			"offline refresh keeps the pinned fallback",
		);
	});
});
