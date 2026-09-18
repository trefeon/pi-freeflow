import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.ts";
import { OPENCODE_FINGERPRINT_TOOLS } from "../src/opencode-fingerprint.ts";
import { _resetUpstreamHealthForTest } from "../src/upstream-health.ts";
import { _resetFreeTierHintForTest } from "../src/upstream-health.ts";

/** Test-only loopback port for the proxy under test. */
const TEST_PORT = 29195;

test("proxy: OpenCode chat request without tools receives injected fingerprint and converts SSE to JSON", async () => {
	_resetUpstreamHealthForTest();
	_resetFreeTierHintForTest();

	let upstreamReceivedBody: Record<string, unknown> | null = null;
	const mockUpstream = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			upstreamReceivedBody = JSON.parse(Buffer.concat(chunks).toString());
			// Upstream returns SSE
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				'data: {"id":"chatcmpl-123","model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","content":"hello world"}}]}\n\n',
			);
			res.write('data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
			res.end("data: [DONE]\n\n");
		});
	});

	await new Promise<void>((resolve) => mockUpstream.listen(0, "127.0.0.1", () => resolve()));
	const mockPort = (mockUpstream.address() as { port: number }).port;

	// Stub globalThis.fetch to redirect to mockUpstream
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
		const targetUrl = new URL(String(url));
		const redirectUrl = `http://127.0.0.1:${mockPort}${targetUrl.pathname}`;
		return realFetch(redirectUrl, init);
	}) as typeof fetch;

	const { server, port } = await startProxy(TEST_PORT);
	const effectivePort = port ?? TEST_PORT;

	try {
		const clientReq = http.request({
			hostname: "127.0.0.1",
			port: effectivePort,
			path: "/v1/chat/completions",
			method: "POST",
			headers: { "content-type": "application/json" },
		});

		const clientResPromise = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
			(resolve, reject) => {
				clientReq.on("response", (res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => {
						resolve({
							status: res.statusCode ?? 0,
							headers: res.headers,
							body: Buffer.concat(chunks).toString(),
						});
					});
				});
				clientReq.on("error", reject);
			},
		);

		// Client sends a tool-less, non-streaming request
		clientReq.write(
			JSON.stringify({
				model: "big-pickle",
				messages: [{ role: "user", content: "hi" }],
				stream: false,
			}),
		);
		clientReq.end();

		const clientRes = await clientResPromise;
		assert.equal(clientRes.status, 200);
		assert.ok(clientRes.headers["content-type"]?.includes("application/json"));

		// 1. Upstream received fingerprinted body: stream: true and full tool quartet
		assert.ok(upstreamReceivedBody);
		const body1 = upstreamReceivedBody as Record<string, unknown>;
		assert.equal(body1.stream, true, "upstream must receive stream: true");
		assert.ok(Array.isArray(body1.tools), "tools must be present");
		const receivedTools = (body1.tools as Array<{ function: { name: string } }>).map(
			(t) => t.function.name,
		);
		for (const tool of OPENCODE_FINGERPRINT_TOOLS) {
			assert.ok(receivedTools.includes(tool), `missing fingerprint tool ${tool}`);
		}

		// 2. Non-streaming client received clean parsed JSON
		const parsedClientJson = JSON.parse(clientRes.body) as {
			choices: Array<{ message: { content: string; role: string } }>;
		};
		assert.equal(parsedClientJson.choices[0].message.role, "assistant");
		assert.equal(parsedClientJson.choices[0].message.content, "hello world");
	} finally {
		globalThis.fetch = realFetch;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
		_resetUpstreamHealthForTest();
		_resetFreeTierHintForTest();
	}
});

test("proxy: OpenCode Responses request without tools (like advisor watchdog) receives tools and converts SSE to JSON", async () => {
	_resetUpstreamHealthForTest();
	_resetFreeTierHintForTest();

	let upstreamReceivedBody: Record<string, unknown> | null = null;
	const expectedResponseObj = {
		id: "resp_watchdog_123",
		object: "response",
		status: "completed",
		output: [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "all clear" }],
			},
		],
	};

	const mockUpstream = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			upstreamReceivedBody = JSON.parse(Buffer.concat(chunks).toString());
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				`event: response.created\ndata: {"type":"response.created","response":{"id":"resp_watchdog_123","status":"in_progress"}}\n\n`,
			);
			res.write(
				`event: response.completed\ndata: {"type":"response.completed","response":${JSON.stringify(expectedResponseObj)}}\n\n`,
			);
			res.end();
		});
	});

	await new Promise<void>((resolve) => mockUpstream.listen(0, "127.0.0.1", () => resolve()));
	const mockPort = (mockUpstream.address() as { port: number }).port;

	const realFetch = globalThis.fetch;
	globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
		const targetUrl = new URL(String(url));
		const redirectUrl = `http://127.0.0.1:${mockPort}${targetUrl.pathname}`;
		return realFetch(redirectUrl, init);
	}) as typeof fetch;

	const { server, port } = await startProxy(TEST_PORT + 1);
	const effectivePort = port ?? TEST_PORT + 1;

	try {
		const clientReq = http.request({
			hostname: "127.0.0.1",
			port: effectivePort,
			path: "/v1/responses",
			method: "POST",
			headers: { "content-type": "application/json" },
		});

		const clientResPromise = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
			(resolve, reject) => {
				clientReq.on("response", (res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => {
						resolve({
							status: res.statusCode ?? 0,
							headers: res.headers,
							body: Buffer.concat(chunks).toString(),
						});
					});
				});
				clientReq.on("error", reject);
			},
		);

		// Advisor sends minimal prompt without tools and stream: false
		clientReq.write(
			JSON.stringify({
				model: "muse-spark-1.3-contributor-free",
				input: "watchdog inspection",
				stream: false,
			}),
		);
		clientReq.end();

		const clientRes = await clientResPromise;
		assert.equal(clientRes.status, 200);
		assert.ok(clientRes.headers["content-type"]?.includes("application/json"));

		// 1. Upstream received fingerprinted body: stream: true, store: false, flat tools quartet
		assert.ok(upstreamReceivedBody);
		const body2 = upstreamReceivedBody as Record<string, unknown>;
		assert.equal(body2.stream, true);
		assert.equal(body2.store, false);
		assert.ok(Array.isArray(body2.tools));
		const receivedToolNames = (body2.tools as Array<{ name: string }>).map((t) => t.name);
		for (const tool of OPENCODE_FINGERPRINT_TOOLS) {
			assert.ok(receivedToolNames.includes(tool), `missing fingerprint tool ${tool}`);
		}

		// 2. Client received clean completed response object
		const parsed = JSON.parse(clientRes.body) as typeof expectedResponseObj;
		assert.deepEqual(parsed, expectedResponseObj);
	} finally {
		globalThis.fetch = realFetch;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
		_resetUpstreamHealthForTest();
		_resetFreeTierHintForTest();
	}
});
