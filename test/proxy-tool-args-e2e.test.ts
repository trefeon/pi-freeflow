/**
 * End-to-end proof that the argument repair runs inside the real proxy, not
 * just in the conversion helpers: a mock upstream answers with the malformed
 * payload a free model actually emits, and the client must receive repaired
 * arguments on every wire API and in both streaming and aggregate modes.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
	_resetFreeTierHintForTest,
	_resetUpstreamHealthForTest,
} from "../src/upstream-health.ts";
import { startProxy } from "../src/proxy.ts";

const CHAT_MODEL = "muse-spark-1.2-contributor-free";
const RESPONSES_MODEL = "muse-spark-1.3-contributor-free";

/** The malformation reproduced live from the free models (see tool-args-repair). */
const MALFORMED = '{"op":"init","phases":[{"name":"Research","tasks":["Map repo structure"]},{"name":"Synthesis","tasks":["Write summary"]}]}';

/** Real OMP todo parameters, inlined. */
const TODO_PARAMS = {
	type: "object",
	properties: {
		op: { type: "string", enum: ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"] },
		list: {
			type: "array",
			items: {
				type: "object",
				properties: {
					phase: { type: "string" },
					items: { type: "array", items: { type: "string" }, minItems: 1 },
				},
				required: ["phase", "items"],
			},
		},
		task: { type: "string" },
		phase: { type: "string" },
		items: { type: "array", items: { type: "string" } },
		reason: { type: "string" },
	},
	required: ["op"],
};

function chatTodo(): Record<string, unknown> {
	return {
		type: "function",
		function: { name: "todo", description: "apply a single todo operation", parameters: TODO_PARAMS },
	};
}

function postJson(
	port: number,
	path: string,
	payload: unknown,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(payload);
		const req = http.request(
			{ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
			},
		);
		req.on("error", reject);
		req.end(data);
	});
}

async function withProxyAndMock(
	proxyPort: number,
	respond: (res: http.ServerResponse) => void,
	client: (port: number) => Promise<void>,
): Promise<void> {
	_resetUpstreamHealthForTest();
	_resetFreeTierHintForTest();
	const mock = http.createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => respond(res));
	});
	await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
	const mockPort = (mock.address() as { port: number }).port;
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
		const targetUrl = new URL(String(url));
		return realFetch(`http://127.0.0.1:${mockPort}${targetUrl.pathname}`, init);
	}) as typeof fetch;
	const { server, port } = await startProxy(proxyPort);
	try {
		await client(port ?? proxyPort);
	} finally {
		globalThis.fetch = realFetch;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		await new Promise<void>((resolve) => mock.close(() => resolve()));
		_resetUpstreamHealthForTest();
		_resetFreeTierHintForTest();
	}
}

/** Phases the client must end up with, whatever shape the model emitted. */
function assertRepaired(args: string, label: string): void {
	const parsed = JSON.parse(args) as { list?: Array<{ phase: string; items: string[] }> };
	assert.ok(Array.isArray(parsed.list), `${label}: phases must arrive as the declared list, got ${args}`);
	assert.deepEqual(parsed.list.map((phase) => phase.phase), ["Research", "Synthesis"], label);
	assert.deepEqual(parsed.list[0].items, ["Map repo structure"], label);
}

test("proxy repairs malformed tool arguments on the chat aggregate path", async () => {
	const rawSse = [
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "todo", arguments: MALFORMED } }] } }] })}`,
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}`,
		"data: [DONE]",
	].join("\n\n");
	let clientBody = "";
	await withProxyAndMock(29471, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: CHAT_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			tools: [chatTodo()],
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	});
	const parsed = JSON.parse(clientBody) as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string; arguments: string } }> } }> };
	const call = parsed.choices[0].message.tool_calls[0];
	assert.equal(call.function.name, "todo");
	assertRepaired(call.function.arguments, "chat aggregate");
});

test("proxy repairs malformed tool arguments on the chat streaming path", async () => {
	const rawSse = [
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "todo", arguments: MALFORMED.slice(0, 40) } }] } }] })}`,
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: MALFORMED.slice(40) } }] } }] })}`,
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}`,
		"data: [DONE]",
	].join("\n\n");
	let clientBody = "";
	await withProxyAndMock(29472, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: CHAT_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			tools: [chatTodo()],
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	});
	// Reassemble the way a host does: every fragment per tool-call index.
	let args = "";
	for (const block of clientBody.split(/\r?\n\r?\n/)) {
		const line = block.split(/\r?\n/).find((candidate) => candidate.startsWith("data:"));
		if (!line) continue;
		const data = line.slice(5).trim();
		if (data === "" || data === "[DONE]") continue;
		const event = JSON.parse(data) as { choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> };
		for (const choice of event.choices ?? []) {
			for (const call of choice.delta?.tool_calls ?? []) {
				if (typeof call.function?.arguments === "string") args += call.function.arguments;
			}
		}
	}
	assert.ok(!clientBody.includes("phases"), "the invented vocabulary never reaches the host");
	assertRepaired(args, "chat stream");
});

test("proxy repairs malformed tool arguments on the responses aggregate path", async () => {
	const response = {
		id: "resp_e2e",
		object: "response",
		status: "completed",
		output: [{ type: "function_call", id: "fc_1", name: "todo", arguments: MALFORMED }],
	};
	const rawSse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
	let clientBody = "";
	await withProxyAndMock(29473, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/responses", {
			model: RESPONSES_MODEL,
			input: "hi",
			stream: false,
			tools: [{ type: "function", name: "todo", description: "apply a single todo operation", parameters: TODO_PARAMS }],
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	});
	const parsed = JSON.parse(clientBody) as { output: Array<{ name: string; arguments: string }> };
	assert.equal(parsed.output[0].name, "todo");
	assertRepaired(parsed.output[0].arguments, "responses aggregate");
});