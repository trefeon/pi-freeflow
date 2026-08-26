/**
 * Memory-safe sliding rate limiter for pi-freeflow
 * Enforces:
 *  - OpenCode Zen: 200 requests per UTC day per IP
 *  - KiloCode Gateway: 200 requests per 1-hour window per IP
 */

import { RATE_LIMIT_MAX } from "./config.ts";
import type { RateLimitEntry, RateLimitStatus, Upstream } from "./types.ts";

const rateLimitMap = new Map<string, RateLimitEntry>();
let lastCleanupAt = 0;
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute
const MAX_MAP_SIZE_BEFORE_CLEANUP = 500;

/**
 * Calculate the next reset timestamp in epoch milliseconds.
 */
export function rateLimitResetAt(upstream: Upstream, now: number): number {
	if (upstream === "kilo") {
		return now + 60 * 60_000; // 1 hour sliding window
	}
	// OpenCode resets at 00:00:00.000 UTC of next day
	const nextUtcDay = new Date(now);
	nextUtcDay.setUTCHours(24, 0, 0, 0);
	return nextUtcDay.getTime();
}

/**
 * Construct a cache key for an upstream + client IP.
 */
export function rateLimitKey(
	upstream: Upstream,
	ip: string,
	now: number = Date.now(),
): string {
	const safeIp = ip.trim() || "127.0.0.1";
	if (upstream === "kilo") {
		return `kilo:${safeIp}`;
	}
	const utcDate = new Date(now).toISOString().slice(0, 10);
	return `opencode:${utcDate}:${safeIp}`;
}

/**
 * Purge expired rate limit buckets to guarantee bounded memory usage.
 * Returns the number of evicted entries.
 */
export function cleanupRateLimits(now: number = Date.now()): number {
	let evicted = 0;
	for (const [key, entry] of rateLimitMap.entries()) {
		if (entry.resetAt <= now) {
			rateLimitMap.delete(key);
			evicted++;
		}
	}
	lastCleanupAt = now;
	return evicted;
}

/**
 * Trigger cleanup if interval elapsed or map has grown past the high watermark.
 */
function maybeCleanup(now: number): void {
	if (
		now - lastCleanupAt > CLEANUP_INTERVAL_MS ||
		rateLimitMap.size > MAX_MAP_SIZE_BEFORE_CLEANUP
	) {
		cleanupRateLimits(now);
	}
}

/**
 * Check and consume a quota token for the given IP and upstream.
 * Returns true if request is permitted, false if rate limit exceeded.
 */
export function checkRateLimit(
	ip: string,
	upstream: Upstream,
	now: number = Date.now(),
): boolean {
	maybeCleanup(now);

	const key = rateLimitKey(upstream, ip, now);
	const entry = rateLimitMap.get(key);
	const maxLimit = RATE_LIMIT_MAX[upstream] ?? 200;

	if (!entry || entry.resetAt <= now) {
		rateLimitMap.set(key, {
			count: 1,
			resetAt: rateLimitResetAt(upstream, now),
		});
		return true;
	}

	if (entry.count >= maxLimit) {
		return false;
	}

	entry.count++;
	return true;
}

/**
 * Query current rate limit quota and remaining requests without mutating count.
 */
export function getRateLimitStatus(
	ip: string,
	upstream: Upstream,
	now: number = Date.now(),
): RateLimitStatus {
	const key = rateLimitKey(upstream, ip, now);
	const entry = rateLimitMap.get(key);
	const limit = RATE_LIMIT_MAX[upstream] ?? 200;

	if (!entry || entry.resetAt <= now) {
		return {
			allowed: true,
			remaining: limit,
			resetAt: rateLimitResetAt(upstream, now),
			limit,
			count: 0,
		};
	}

	const remaining = Math.max(0, limit - entry.count);
	return {
		allowed: remaining > 0,
		remaining,
		resetAt: entry.resetAt,
		limit,
		count: entry.count,
	};
}
/**
 * Clear all rate limit records (primarily for testing and reset commands).
 */
export function resetRateLimits(): void {
	rateLimitMap.clear();
	lastCleanupAt = Date.now();
}

/**
 * Get active count of entries in the rate limit table.
 */
export function getRateLimitMapSize(): number {
	return rateLimitMap.size;
}
