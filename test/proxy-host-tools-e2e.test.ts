import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.ts";
import {
	OPENCODE_FINGERPRINT_TOOLS,
	convertSseToJson,
	enforceOpencodeFingerprint,
} from "../src/opencode-fingerprint.ts";
import {
	_resetFreeTierHintForTest,
	_resetUpstreamHealthForTest,
} from "../src/upstream-health.ts";

const CHAT_MODEL = "muse-spark-1.2-contributor-free";
const RESPONSES_MODEL = "muse-spark-1.3-contributor-free";
const KILO_MODEL = "stepfun/step-3.7-flash:free";

const FIND_DESC = "Find files by name";
const FIND_PARAMS = { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] };
const ASK_DESC = "Ask the user a clarifying question";
const ASK_PARAMS = { type: "object", properties: { question: { type: "string" } }, required: ["question"] };

/**
 * Minimal inline mixed host tool array (chat shape): OMP ask + todo +
 * ast_grep, Pi find + ls + powershell, a capital-cased Bash placeholder to
 * exercise case restore, and one custom registerTool envelope. Real host
 * names with required params; strict where the host sets it (ask/todo/
 * ast_grep true, custom false).
 */
function mixedCallerTools(): Array<Record<string, unknown>> {
	return [
		{ type: "function", function: { name: "ask", description: ASK_DESC, parameters: ASK_PARAMS }, strict: true, "x-host": "omp" },
		{ type: "function", function: { name: "todo", description: "Track session tasks", parameters: { type: "object", properties: { op: { type: "string" } }, required: ["op"] } }, strict: true, "x-host": "omp" },
		{ type: "function", function: { name: "ast_grep", description: "Structural code search", parameters: { type: "object", properties: { pat: { type: "string" } }, required: ["pat"] } }, strict: true, "x-host": "omp" },
		{ type: "function", function: { name: "find", description: FIND_DESC, parameters: FIND_PARAMS }, "x-host": "pi" },
		{ type: "function", function: { name: "ls", description: "List directory entries", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }, "x-host": "pi" },
		{ type: "function", function: { name: "powershell", description: "Run PowerShell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }, "x-host": "pi" },
		{ type: "function", function: { name: "Bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }, "x-host": "pi" },
		{ type: "function", function: { name: "my_custom_tool", description: "Custom registerTool envelope", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }, strict: false, "x-custom": true },
	];
}

function upstreamToolName(t: unknown): string {
	const rec = t as Record<string, unknown>;
	const fn = rec.function as Record<string, unknown> | undefined;
	if (fn && typeof fn.name === "string") return fn.name;
	if (typeof rec.name === "string") return rec.name;
	return "";
}

function byUpstreamName(tools: unknown[], name: string): Record<string, unknown> {
	const hit = (tools as Array<unknown>).find((t) => upstreamToolName(t).toLowerCase() === name);
	assert.ok(hit, `upstream tool missing: ${name}`);
	return hit as Record<string, unknown>;
}

/** Fingerprint sextet present exactly once each (case-insensitive), no dups. */
function assertFingerprintOnce(tools: unknown[], label: string): void {
	const names = (tools as Array<unknown>).map(upstreamToolName);
	assert.equal(names.length, new Set(names.map((n) => n.toLowerCase())).size, `${label}: duplicate upstream tool names`);
	for (const fp of OPENCODE_FINGERPRINT_TOOLS) {
		const hits = names.filter((n) => n.toLowerCase() === fp);
		assert.equal(hits.length, 1, `${label}: fingerprint tool ${fp} must appear exactly once upstream`);
	}
}

function postJson(port: number, path: string, payload: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(payload);
		const req = http.request({
			hostname: "127.0.0.1",
			port,
			path,
			method: "POST",
			headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
		});
		req.on("response", (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c as Buffer));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

/**
 * Start a mock upstream capturing its request body, redirect global fetch at
 * it, start the real proxy, run the client flow, then tear everything down.
 */
async function withProxyAndMock(
	proxyPort: number,
	respond: (res: http.ServerResponse) => void,
	client: (port: number) => Promise<void>,
): Promise<Record<string, unknown> | null> {
	_resetUpstreamHealthForTest();
	_resetFreeTierHintForTest();
	let upstreamReceivedBody: Record<string, unknown> | null = null;
	const mock = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			upstreamReceivedBody = JSON.parse(Buffer.concat(chunks).toString());
			respond(res);
		});
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
	return upstreamReceivedBody;
}

function chatChunk(delta: unknown, finish?: string): string {
	return `data: ${JSON.stringify({ id: "chatcmpl-e2e", model: CHAT_MODEL, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;
}

function chatToolDelta(index: number, id: string, name: string, args: string): unknown {
	return { tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] };
}

test("proxy e2e: chat non-stream carries mixed host tools upstream and restores names on aggregate", async () => {
	const callerTools = mixedCallerTools();
	const callerChoice = { type: "function", function: { name: "ask" } };
	const rawSse = [
		chatChunk({ role: "assistant", content: "" }),
		chatChunk(chatToolDelta(0, "call_find_1", "glob", '{"pattern":"*.ts"}')),
		chatChunk(chatToolDelta(1, "call_bash_1", "bash", '{"command":"ls"}')),
		chatChunk(chatToolDelta(2, "call_ask_1", "ask", '{"question":"q?"}')),
		chatChunk(chatToolDelta(3, "call_read_1", "read", '{"path":"x"}')),
		chatChunk({}, "tool_calls"),
		"data: [DONE]\n\n",
	].join("");
	let clientBody = "";
	const upstream = await withProxyAndMock(29311, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: CHAT_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			tools: callerTools,
			tool_choice: callerChoice,
		});
		assert.equal(res.status, 200);
		assert.ok(res.headers["content-type"]?.includes("application/json"));
		clientBody = res.body;
	});
	assert.ok(upstream);
	assert.equal(upstream.stream, true, "upstream must receive stream:true");
	assert.ok(!("store" in upstream), "chat must not carry store");
	assert.deepEqual(upstream.tool_choice, callerChoice, "tool_choice must be carried, not imposed");
	assert.ok(Array.isArray(upstream.tools));
	const tools = upstream.tools as Array<unknown>;
	assert.equal(tools.length, 12, "8 caller tools translated + 4 injected placeholders");
	assertFingerprintOnce(tools, "chat");
	// Caller find arrives as glob with params/description verbatim; no raw find upstream.
	assert.ok(!tools.some((t) => upstreamToolName(t).toLowerCase() === "find"), "caller find must be renamed to glob upstream");
	const glob = byUpstreamName(tools, "glob");
	assert.equal((glob.function as Record<string, unknown>).description, FIND_DESC);
	assert.deepEqual((glob.function as Record<string, unknown>).parameters, FIND_PARAMS);
	// Caller Bash lowercased to the canonical fingerprint slot, exactly once.
	const bash = byUpstreamName(tools, "bash");
	assert.equal((bash.function as Record<string, unknown>).name, "bash");
	// Verbatim rule: description/params/strict/extra fields intact.
	const ask = byUpstreamName(tools, "ask");
	assert.equal((ask.function as Record<string, unknown>).description, ASK_DESC);
	assert.deepEqual((ask.function as Record<string, unknown>).parameters, ASK_PARAMS);
	assert.equal(ask.strict, true);
	assert.equal(ask["x-host"], "omp");
	const custom = byUpstreamName(tools, "my_custom_tool");
	assert.equal(custom.strict, false);
	assert.equal(custom["x-custom"], true);
	for (const extra of ["todo", "ast_grep", "ls", "powershell"]) byUpstreamName(tools, extra);
	// Client non-stream gets aggregated JSON via the convertSseToJson path.
	const probe: Record<string, unknown> = { tools: JSON.parse(JSON.stringify(callerTools)), stream: false };
	const fp = enforceOpencodeFingerprint(probe, "/v1/chat/completions");
	const actual = JSON.parse(clientBody) as Record<string, unknown>;
	const expected = JSON.parse(convertSseToJson(rawSse, "/v1/chat/completions", true, fp.caseRestore, fp.findGlob, fp.injected)) as Record<string, unknown>;
	// `created` is stamped from the wall clock when each body is built, so a
	// second boundary between the proxy's answer and this expectation moves it
	// by one — comparing it made this test fail about once every few hundred
	// runs (seen on CI). Compare every other field strictly, and check the
	// stamp is a real epoch-seconds value rather than pinning its digit.
	assert.ok(Number.isInteger(actual.created) && (actual.created as number) > 1_600_000_000, "created must be an epoch-seconds stamp");
	assert.equal(typeof expected.created, "number");
	delete actual.created;
	delete expected.created;
	assert.deepEqual(actual, expected);
	const msg = (JSON.parse(clientBody) as { choices: Array<{ message: { tool_calls?: Array<{ function: { name: string } }> } }> }).choices[0].message;
	const names = (msg.tool_calls ?? []).map((tc) => tc.function.name);
	assert.deepEqual(names, ["find", "Bash", "ask"], "upstream glob restores to caller find, bash restores to caller Bash, injected read cloaked");
});

test("proxy e2e: responses non-stream stores false, flat tools, function_call restore", async () => {
	const callerTools = mixedCallerTools();
	const rawCompleted = {
		id: "resp_e2e",
		object: "response",
		status: "completed",
		output: [
			{ type: "function_call", id: "fc_find", name: "glob", arguments: '{"pattern":"*.ts"}' },
			{ type: "function_call", id: "fc_bash", name: "bash", arguments: '{"command":"ls"}' },
			{ type: "function_call", id: "fc_ask", name: "ask", arguments: '{"question":"q?"}' },
			{ type: "function_call", id: "fc_read", name: "read", arguments: '{"path":"x"}' },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
		],
	};
	const rawSse = `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_e2e","status":"in_progress"}}\n\n`
		+ `event: response.completed\ndata: {"type":"response.completed","response":${JSON.stringify(rawCompleted)}}\n\n`;
	let clientBody = "";
	const upstream = await withProxyAndMock(29312, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/responses", {
			model: RESPONSES_MODEL,
			input: "hi",
			stream: false,
			tools: callerTools,
			tool_choice: "auto",
		});
		assert.equal(res.status, 200);
		assert.ok(res.headers["content-type"]?.includes("application/json"));
		clientBody = res.body;
	});
	assert.ok(upstream);
	assert.equal(upstream.stream, true, "upstream must receive stream:true");
	assert.equal(upstream.store, false, "responses must pin store:false");
	assert.equal(upstream.tool_choice, "auto", "tool_choice must be carried, not imposed");
	assert.ok(Array.isArray(upstream.tools));
	const tools = upstream.tools as Array<Record<string, unknown>>;
	assert.equal(tools.length, 12, "8 caller tools translated + 4 injected placeholders");
	assertFingerprintOnce(tools, "responses");
	for (const t of tools) {
		assert.equal(t.type, "function", "responses tools use the flat shape");
		assert.ok(typeof t.name === "string");
		assert.ok(typeof t.parameters === "object" && t.parameters !== null);
		assert.ok(!("function" in t), "no chat wrapper on the responses path");
	}
	assert.ok(!tools.some((t) => String(t.name).toLowerCase() === "find"), "caller find must be renamed to glob upstream");
	const glob = byUpstreamName(tools, "glob");
	assert.equal(glob.description, FIND_DESC);
	assert.deepEqual(glob.parameters, FIND_PARAMS);
	assert.equal(String(byUpstreamName(tools, "bash").name), "bash");
	const ask = byUpstreamName(tools, "ask");
	assert.equal(ask.strict, true);
	assert.equal(ask["x-host"], "omp");
	const custom = byUpstreamName(tools, "my_custom_tool");
	assert.equal(custom.strict, false);
	assert.equal(custom["x-custom"], true);
	const probe: Record<string, unknown> = { tools: JSON.parse(JSON.stringify(callerTools)), stream: false };
	const fp = enforceOpencodeFingerprint(probe, "/v1/responses");
	const expected = JSON.parse(convertSseToJson(rawSse, "/v1/responses", true, fp.caseRestore, fp.findGlob, fp.injected));
	assert.deepEqual(JSON.parse(clientBody), expected);
	const calls = ((JSON.parse(clientBody) as { output: Array<Record<string, unknown>> }).output ?? [])
		.filter((item) => item.type === "function_call")
		.map((item) => String(item.name));
	assert.deepEqual(calls, ["find", "Bash", "ask"], "upstream glob restores to caller find, injected read cloaked");
});

test("proxy e2e: messages non-stream uses anthropic shape and restores tool_use names", async () => {
	const callerTools = mixedCallerTools();
	const ev = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
	const rawSse = [
		ev({ type: "message_start", message: { id: "msg_e2e", model: RESPONSES_MODEL } }),
		ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_find", name: "glob" } }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pattern":' } }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"*.ts"}' } }),
		ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_bash", name: "bash" } }),
		ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
		ev({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_ask", name: "ask" } }),
		ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"question":"q?"}' } }),
		ev({ type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "tu_grep", name: "grep" } }),
		ev({ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"pat":"x"}' } }),
		ev({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
	].join("");
	let clientBody = "";
	const upstream = await withProxyAndMock(29313, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/messages", {
			model: RESPONSES_MODEL,
			max_tokens: 64,
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			tools: callerTools,
		});
		assert.equal(res.status, 200);
		assert.ok(res.headers["content-type"]?.includes("application/json"));
		clientBody = res.body;
	});
	assert.ok(upstream);
	assert.equal(upstream.stream, true, "upstream must receive stream:true");
	assert.ok(!("store" in upstream), "messages must not carry store");
	assert.ok(!("tool_choice" in upstream), "tool_choice must not be imposed when the caller sends none");
	assert.ok(Array.isArray(upstream.tools));
	const tools = upstream.tools as Array<Record<string, unknown>>;
	assert.equal(tools.length, 12, "8 caller tools translated + 4 injected placeholders");
	assertFingerprintOnce(tools, "messages");
	for (const t of tools) {
		assert.ok(typeof t.name === "string", "anthropic tools carry a flat name");
		assert.ok(typeof t.input_schema === "object" && t.input_schema !== null, "anthropic tools use input_schema");
		assert.ok(!("function" in t) && !("parameters" in t), "no chat/responses keys on the messages path");
	}
	assert.ok(!tools.some((t) => String(t.name).toLowerCase() === "find"), "caller find must be renamed to glob upstream");
	const glob = byUpstreamName(tools, "glob");
	assert.equal(glob.description, FIND_DESC);
	assert.deepEqual(glob.input_schema, FIND_PARAMS);
	assert.equal(String(byUpstreamName(tools, "bash").name), "bash");
	const probe: Record<string, unknown> = { tools: JSON.parse(JSON.stringify(callerTools)), stream: false };
	const fp = enforceOpencodeFingerprint(probe, "/v1/messages");
	const expected = JSON.parse(convertSseToJson(rawSse, "/v1/messages", true, fp.caseRestore, fp.findGlob, fp.injected));
	assert.deepEqual(JSON.parse(clientBody), expected);
	const blocks = ((JSON.parse(clientBody) as { content: Array<Record<string, unknown>> }).content ?? [])
		.filter((b) => b.type === "tool_use")
		.map((b) => String(b.name));
	assert.deepEqual(blocks, ["find", "Bash", "ask"], "upstream glob restores to caller find, injected grep cloaked");
});

test("proxy e2e: chat stream:true still fingerprints upstream and streams to the client", async () => {
	const callerTools = mixedCallerTools();
	const rawSse = chatChunk({ role: "assistant", content: "live" }) + chatChunk({}, "stop") + "data: [DONE]\n\n";
	let clientHeaders: http.IncomingHttpHeaders = {};
	let clientBody = "";
	const upstream = await withProxyAndMock(29314, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: CHAT_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			tools: callerTools,
			tool_choice: "auto",
		});
		assert.equal(res.status, 200);
		clientHeaders = res.headers;
		clientBody = res.body;
	});
	assert.ok(upstream);
	assert.equal(upstream.stream, true, "caller stream:true stays true upstream");
	assert.equal(upstream.tool_choice, "auto");
	assert.ok(Array.isArray(upstream.tools));
	const tools = upstream.tools as Array<unknown>;
	assert.equal(tools.length, 12);
	assertFingerprintOnce(tools, "chat-stream");
	assert.ok(!tools.some((t) => upstreamToolName(t).toLowerCase() === "find"), "caller find must be renamed to glob upstream");
	assert.ok(clientHeaders["content-type"]?.includes("text/event-stream"), "streaming caller receives the SSE stream");
	assert.ok(clientBody.includes("data:"), "streamed body carries SSE events");
});

test("proxy e2e: kilo path bypass leaves caller tools untouched", async () => {
	const callerTools = mixedCallerTools();
	const kiloJson = JSON.stringify({ id: "kilo-ok", object: "chat.completion", choices: [] });
	let clientBody = "";
	const upstream = await withProxyAndMock(29315, (res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(kiloJson);
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: KILO_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			tools: callerTools,
			tool_choice: "auto",
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	});
	assert.ok(upstream);
	assert.equal(upstream.stream, false, "kilo bypass must not force stream:true");
	assert.ok(!("store" in upstream), "kilo bypass must not add store");
	assert.equal(upstream.tool_choice, "auto");
	assert.ok(Array.isArray(upstream.tools));
	assert.deepEqual(upstream.tools, callerTools, "kilo tools pass through verbatim: find stays find, Bash keeps casing, no fingerprint injected");
	assert.deepEqual(JSON.parse(clientBody), JSON.parse(kiloJson));
});
