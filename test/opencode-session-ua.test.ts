import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import {
	OPENCODE_VERSION_CACHE_ENV,
	OPENCODE_VERSION_FALLBACK,
	buildOpenCodeUserAgent,
	getLiveOpenCodeVersion,
	getOpenCodeUserAgent,
	refreshOpenCodeUserAgent,
	stableOpenCodeSessionId,
	_resetLiveOpenCodeVersionForTest,
	_resetStableSessionCacheForTest,
	_stableSessionCacheSizeForTest,
	_stableSessionHasKeyForTest,
} from "../src/config.ts";

const SES_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

test("getLiveOpenCodeVersion returns fallback without network", () => {
	_resetLiveOpenCodeVersionForTest();
	assert.equal(getLiveOpenCodeVersion(), OPENCODE_VERSION_FALLBACK);
});

test("buildOpenCodeUserAgent emits the verbatim full CLI shape", () => {
	assert.equal(
		buildOpenCodeUserAgent("1.19.0"),
		"opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4",
	);
	assert.equal(
		getOpenCodeUserAgent(),
		`opencode/${OPENCODE_VERSION_FALLBACK} ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`,
		"single getter serves the full shape off the fallback",
	);
});

test("stableOpenCodeSessionId passes valid ses_* through verbatim", () => {
	_resetStableSessionCacheForTest();
	const valid = "ses_abcdef012345AbCDeF01234X9z";
	assert.match(valid, SES_RE);
	assert.equal(stableOpenCodeSessionId(valid), valid);
});

test("stableOpenCodeSessionId is deterministic across now values and well-formed", () => {
	_resetStableSessionCacheForTest();
	const a = stableOpenCodeSessionId("conv-1", 1000);
	const b = stableOpenCodeSessionId("conv-1", 999999999);
	assert.equal(a, b);
	assert.match(a, SES_RE);
	const c = stableOpenCodeSessionId("conv-2");
	assert.match(c, SES_RE);
	assert.notEqual(a, c);
});

test("stableOpenCodeSessionId pins counter at 1 in the time field", () => {
	_resetStableSessionCacheForTest();
	const id = stableOpenCodeSessionId("counter-pin-check");
	const timeHex = id.slice(4, 16);
	const digest = createHash("sha256").update("pi-freeflow\0counter-pin-check").digest();
	let time48 = 0n;
	for (let i = 0; i < 6; i++) time48 = (time48 << 8n) | BigInt(digest[i]!);
	const expected = ((~(time48 * 0x1000n + 1n)) & ((1n << 48n) - 1n)).toString(16).padStart(12, "0");
	assert.equal(timeHex, expected);
});

test("stableOpenCodeSessionId empty key allocates a fresh valid id", () => {
	_resetStableSessionCacheForTest();
	const a = stableOpenCodeSessionId("");
	assert.match(a, SES_RE);
});

test("stableOpenCodeSessionId LRU evicts oldest past cap", () => {
	_resetStableSessionCacheForTest();
	const first = "evict-key-0";
	stableOpenCodeSessionId(first);
	for (let i = 1; i <= 1000; i++) stableOpenCodeSessionId(`evict-key-${i}`);
	assert.equal(_stableSessionCacheSizeForTest(), 1000);
	assert.equal(_stableSessionHasKeyForTest(first), false);
});

test("refresh populates the live version behind the single full-shape UA", async () => {
	const cacheEnv = OPENCODE_VERSION_CACHE_ENV;
	const prevCache = process.env[cacheEnv];
	const tmpCache = path.join(os.tmpdir(), `pff-v2-version-test-${process.pid}.json`);
	process.env[cacheEnv] = tmpCache;
	try {
		_resetLiveOpenCodeVersionForTest();
		const fetch2x = (async () => ({
			ok: true,
			json: async () => ({ version: "2.0.99" }),
		})) as unknown as typeof fetch;
		assert.equal(await refreshOpenCodeUserAgent(fetch2x), "opencode/2.0.99 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4");
		assert.equal(getLiveOpenCodeVersion(), "2.0.99");

		const fetch1x = (async () => ({
			ok: true,
			json: async () => ({ version: "1.99.0" }),
		})) as unknown as typeof fetch;
		assert.equal(await refreshOpenCodeUserAgent(fetch1x), "opencode/1.99.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4");
		assert.equal(getLiveOpenCodeVersion(), "1.99.0");
	} finally {
		_resetLiveOpenCodeVersionForTest();
		if (prevCache === undefined) delete process.env[cacheEnv];
		else process.env[cacheEnv] = prevCache;
		try { rmSync(tmpCache, { force: true }); } catch { }
	}
});
