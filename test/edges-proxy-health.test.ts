/**
 * Edge-case health and proxy security tests
 *
 * Covers:
 * - Unknown path → 404 (not 403)
 * - Path traversal → 403 (locked by proxy-server.test.ts)
 * - Query-string /v1/models?foo=bar → 200
 * - POST /_health → 404 (method guard, not 403)
 * - Non-loopback /_health → 403 (regression lock)
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.ts";
import { handleHealthRequest } from "../src/health.ts";

/** Create a mock ServerResponse for direct handleHealthRequest calls. */
function makeMockRes() {
	let status = 0;
	let _headers: Record<string, string> = {};
	let body = "";
	const res: Record<string, unknown> = {
		writeHead(s: number, h: Record<string, string>) {
			status = s;
			_headers = h;
		},
		end(b?: string) {
			body = b || "";
		},
		get status() { return status; },
		get headers() { return _headers; },
		get body() { return body; },
	};
	return res as unknown as http.ServerResponse & { status: number; headers: Record<string, string>; body: string };
}

test("unknown path returns 404 (not 403)", async () => {
	const port = 29183;
	const { server } = await startProxy(port);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/some-unknown-path`);
		assert.equal(res.status, 404);
		const json = await res.json() as { error: string };
		assert.equal(json.error, "not found");
	} finally {
		await new Promise<void>((r) => server!.close(() => r()));
	}
});

test("POST /_health returns 404 (method guard)", async () => {
	const port = 29184;
	const { server } = await startProxy(port);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/_health`, { method: "POST" });
		assert.equal(res.status, 404);
	} finally {
		await new Promise<void>((r) => server!.close(() => r()));
	}
});

test("/v1/models with query string returns 200", async () => {
	const port = 29185;
	const { server } = await startProxy(port);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/models?foo=bar`);
		assert.equal(res.status, 200);
		const json = await res.json() as { object: string; data: Array<{ id: string }> };
		assert.equal(json.object, "list");
		assert.ok(Array.isArray(json.data));
		assert.ok(json.data.length > 0);
	} finally {
		await new Promise<void>((r) => server!.close(() => r()));
	}
});

test("/v1/models/../secret returns 403 (path traversal)", async () => {
	// Locked by proxy-server.test.ts: traversal → 403, never 404.
	// NOTE: fetch normalizes ".." via WHATWG URL dot-segment collapse before the
	// server sees it, so a fetch-based probe silently becomes "/v1/secret" and
	// is forwarded upstream. Use raw http.request to send the verbatim path.
	const port = 29186;
	const { server } = await startProxy(port);
	try {
		const status = await new Promise<number>((resolve, reject) => {
			const req = http.request(
				{ host: "127.0.0.1", port, path: "/v1/models/../secret", method: "GET" },
				(res) => resolve(res.statusCode ?? 0),
			);
			req.on("error", reject);
			req.end();
		});
		assert.equal(status, 403);
	} finally {
		await new Promise<void>((r) => server!.close(() => r()));
	}
});

test("GET /_health from non-loopback address returns 403", async () => {
	// Regression lock: server is loopback-bound, so real socket test is impossible.
	// Direct handleHealthRequest covers the code path.
	const req = {
		method: "GET",
		url: "/_health",
		socket: { remoteAddress: "8.8.8.8" },
	} as unknown as http.IncomingMessage;
	const res = makeMockRes();
	const handled = handleHealthRequest(req, res);
	assert.equal(handled, true);
	assert.equal(res.status, 403);

	// Positive control: loopback passes
	const req2 = {
		method: "GET",
		url: "/_health",
		socket: { remoteAddress: "127.0.0.1" },
	} as unknown as http.IncomingMessage;
	const res2 = makeMockRes();
	const handled2 = handleHealthRequest(req2, res2, 29199);
	assert.equal(handled2, true);
	assert.equal(res2.status, 200);
});