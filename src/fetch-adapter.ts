/**
 * Fetch adapter — abstracts the fetch implementation for dual runtime support.
 *
 * Node.js (undici): global fetch uses undici, which has a different TLS/HTTP stack
 * fingerprint than Bun's native fetch. OpenCode's gateway fingerprints the exact
 * bytes on the wire — Bun's fetch matches OpenCode CLI; undici does not.
 *
 * This module lets the proxy run on either runtime while exposing a consistent
 * fetch interface. On Bun, it uses Bun's native `fetch`. On Node, it uses the
 * global `fetch` (undici).
 */

type FetchImpl = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

let _fetchImpl: FetchImpl | null = null;

/**
 * Get the active fetch implementation. Initializes on first call.
 * - On Bun: uses Bun's native `fetch`
 * - On Node: uses global `fetch` (undici)
 */
export function getFetchImpl(): FetchImpl {
	if (_fetchImpl !== null) {
		return _fetchImpl;
	}

	const isBun = typeof Bun !== "undefined" && typeof Bun.fetch === "function";

	_fetchImpl = isBun ? Bun.fetch.bind(Bun) : globalThis.fetch.bind(globalThis);
	return _fetchImpl;
}

/**
 * Override the fetch implementation (for tests or forced runtime).
 * Call before any fetch operations.
 */
export function setFetchImpl(impl: typeof fetch | null): void {
	_fetchImpl = impl;
}

/**
 * Check if running on Bun runtime.
 */
export function isBunRuntime(): boolean {
	return typeof Bun !== "undefined" && typeof Bun.fetch === "function";
}

/**
 * Get the runtime name for logging/debugging.
 */
export function getRuntimeName(): string {
	return isBunRuntime() ? "bun" : "node";
}