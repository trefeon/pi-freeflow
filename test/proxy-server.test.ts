/**
 * Integration tests for local proxy server and routing
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy, isProxyAlive } from "../src/proxy.ts";
import { ALL_MODELS } from "../src/models.ts";

test("proxy starts, responds to /v1/models, and shuts down cleanly", async () => {
	const testPort = 19180;
	const { server, port } = await startProxy(testPort);
	assert.ok(server);
	assert.equal(port, testPort);

	try {
		// Probe /v1/models
		const isAlive = await isProxyAlive(testPort);
		assert.equal(isAlive, true);

		// Fetch catalog from proxy
		const res = await fetch(`http://127.0.0.1:${testPort}/v1/models`);
		assert.equal(res.status, 200);
		const json = await res.json() as { object: string; data: Array<{ id: string }> };
		assert.equal(json.object, "list");
		assert.ok(Array.isArray(json.data));
		assert.ok(json.data.length > 0);

		// Test 405 on disallowed method
		const putRes = await fetch(`http://127.0.0.1:${testPort}/v1/models`, {
			method: "PUT",
		});
		assert.equal(putRes.status, 405);

		// Test 403 on path traversal
		const trapRes = await fetch(`http://127.0.0.1:${testPort}/v1/../admin`);
		assert.equal(trapRes.status, 403);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
