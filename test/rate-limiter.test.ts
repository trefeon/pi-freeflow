/**
 * Unit tests for sliding rate limiter
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	checkRateLimit,
	getRateLimitStatus,
	resetRateLimits,
	cleanupRateLimits,
	getRateLimitMapSize,
} from "../src/rate-limiter.ts";

test("rate limiter permits requests within quota", () => {
	resetRateLimits();
	const ip = "127.0.0.1";
	assert.equal(checkRateLimit(ip, "kilo"), true);
	assert.equal(checkRateLimit(ip, "opencode"), true);

	const status = getRateLimitStatus(ip, "kilo");
	assert.equal(status.count, 1);
	assert.ok(status.remaining > 0);
});

test("rate limiter blocks when quota is reached", () => {
	resetRateLimits();
	const ip = "192.168.1.100";
	for (let i = 0; i < 200; i++) {
		const allowed = checkRateLimit(ip, "kilo");
		assert.equal(allowed, true, `request ${i + 1} should be allowed`);
	}
	// 201st request should be rejected
	assert.equal(checkRateLimit(ip, "kilo"), false);
});

test("cleanupRateLimits purges expired entries", () => {
	resetRateLimits();
	checkRateLimit("10.0.0.1", "kilo");
	assert.ok(getRateLimitMapSize() > 0);
	cleanupRateLimits(Date.now() + 70 * 60_000);
	assert.equal(getRateLimitMapSize(), 0);
});
