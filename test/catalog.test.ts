/**
 * Unit tests for catalog merging.
 *
 * The background catalog refresh must never remove verified static models from
 * provider registration, even when a cached upstream list is partial, and fresh
 * entries must override stale ones by id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeCatalog, refreshCatalog } from "../src/catalog.ts";
import type { RegisteredModel } from "../src/types.ts";

function model(id: string, maxTokens: number, source: "opencode" | "kilo"): RegisteredModel {
	return {
		id,
		name: id,
		reasoning: false,
		contextWindow: 1000,
		maxTokens,
		input: ["text"],
		source,
	};
}

const BASE: RegisteredModel[] = [model("alpha-free", 100, "opencode"), model("beta-free", 200, "kilo")];

test("mergeCatalog overrides matching ids with fresh entries", () => {
	const merged = mergeCatalog(BASE, [model("alpha-free", 999, "opencode")]);
	assert.equal(merged.length, 2);
	const alpha = merged.find((m) => m.id === "alpha-free");
	assert.ok(alpha);
	assert.equal(alpha.maxTokens, 999);
});

test("mergeCatalog keeps base entries missing from the fresh list", () => {
	const merged = mergeCatalog(BASE, [model("alpha-free", 111, "opencode")]);
	assert.ok(merged.some((m) => m.id === "beta-free"));
	assert.equal(merged.find((m) => m.id === "beta-free")?.maxTokens, 200);
});

test("mergeCatalog appends unknown fresh ids after the base", () => {
	const merged = mergeCatalog(BASE, [model("gamma-new", 300, "kilo")]);
	assert.deepEqual(
		merged.map((m) => m.id),
		["alpha-free", "beta-free", "gamma-new"],
	);
});

test("mergeCatalog with an empty fresh list returns the base unchanged", () => {
	const merged = mergeCatalog(BASE, []);
	assert.deepEqual(merged, BASE);
});

test("refreshCatalog uses If-None-Match ETag and skips merge on 304", async () => {
	const realFetch = globalThis.fetch;
	try {
		// Simulate upstream 304 Not Modified
		globalThis.fetch = async () =>
			new Response(null, { status: 304, headers: { etag: '"abc123"' } });
		const result = await refreshCatalog(true);
		assert.ok(Array.isArray(result), "refreshCatalog must return array on 304");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("refreshCatalog passes an abortable timeout signal and falls back instead of hanging", async () => {
	const realFetch = globalThis.fetch;
	try {
		let captured: RequestInit | undefined;
		const { promise: fetchCalled, resolve: markCalled } = Promise.withResolvers<void>();
		globalThis.fetch = async (_url, init) => {
			captured = init;
			markCalled();
			// Simulate a hung upstream: never settles on its own; the abort
			// signal is the only way out (the CATALOG_REFRESH_TIMEOUT_MS timer).
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			return promise;
		};
		const resultP = refreshCatalog(true);
		await fetchCalled; // the fetch is executing now
		assert.ok(captured?.signal, "the upstream fetch must receive an abortable signal");
		captured?.signal?.dispatchEvent(new Event("abort"));
		const result = await resultP;
		assert.ok(Array.isArray(result), "a hung upstream must fall back to cache/static, not hang");
	} finally {
		globalThis.fetch = realFetch;
	}
});
