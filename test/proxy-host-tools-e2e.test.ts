import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import {
	CLINE_POOL_BACKUP_FILE,
	CLINE_POOL_FILE,
	_resetClinePoolCacheForTest,
	savePool,
} from "../src/cline-accounts.ts";
import http from "node:http";
import { startProxy } from "../src/proxy.ts";
import { authHeaders } from "./_auth.ts";
import { FULL11_TOOL_NAMES } from "../src/tool-translation.ts";
import {
	_resetFreeTierHintForTest,
	_resetUpstreamHealthForTest,
} from "../src/upstream-health.ts";

const CHAT_MODEL = "mimo-v2.6-flash-free";
const RESPONSES_MODEL = "nemotron-3.5-super-vl-free";
const KILO_MODEL = "dots-studio/dots-3-note-preview:free";

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

/** Fingerprint 11 roster present exactly once each (case-insensitive), no dups. */
function assertFingerprintOnce(tools: unknown[], label: string): void {
	const names = (tools as Array<unknown>).map(upstreamToolName);
	assert.equal(names.length, new Set(names.map((n) => n.toLowerCase())).size, `${label}: duplicate upstream tool names`);
	for (const fp of FULL11_TOOL_NAMES) {
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
			headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...authHeaders() },
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
 * `capture.path` (optional) receives the upstream pathname, for assertions
 * about which endpoint a lane actually called; `capture.bodies` receives every
 * upstream request body in order, so a test can prove a retry happened (or
 * never happened) and which model each attempt asked for.
 */
async function withProxyAndMock(
	proxyPort: number,
	respond: (res: http.ServerResponse) => void,
	client: (port: number) => Promise<void>,
	capture?: { path?: string; bodies?: Array<Record<string, unknown>> },
): Promise<Record<string, unknown> | null> {
	_resetUpstreamHealthForTest();
	_resetFreeTierHintForTest();
	let upstreamReceivedBody: Record<string, unknown> | null = null;
	const mock = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			if (capture) capture.path = req.url ?? "";
			const received = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
			upstreamReceivedBody = received;
			capture?.bodies?.push(received);
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

/**
 * Frozen accepted answer for the chat `rawSse` below: the exact aggregated body
 * a non-streaming caller must receive — upstream ids/arguments verbatim, the
 * upstream `glob` restored to the caller's `find`, the caller's `Bash` casing
 * back, one choice with finish_reason "tool_calls". The injected `read` call
 * is cloaked (not the caller's tool), so it never reaches the client.
 *
 * This is a literal on purpose. Deriving the expectation by re-running the
 * aggregator (`convertSseToJson`) over the same bytes lets both sides of the
 * assertion move together, so the test could not fail for the real contract
 * (that is what it did before). Change this literal only when the wire contract
 * itself changes, and say why in the commit.
 */
const FROZEN_CHAT_AGGREGATE: Record<string, unknown> = {
	id: "chatcmpl-e2e",
	object: "chat.completion",
	// Wall clock at capture; normalized away before the comparison below.
	created: 1_792_406_084,
	model: CHAT_MODEL,
	choices: [
		{
			index: 0,
			message: {
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "call_find_1", type: "function", function: { name: "find", arguments: '{"pattern":"*.ts"}' } },
					{ id: "call_bash_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
					{ id: "call_ask_1", type: "function", function: { name: "ask", arguments: '{"question":"q?"}' } },
				],
			},
			finish_reason: "tool_calls",
		},
	],
};

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
	// Zen free tier accepts only "auto", so a named caller choice is dropped
	// rather than carried: it cannot reach upstream in any form.
	assert.ok(!("tool_choice" in upstream), "an unsupported tool_choice never reaches upstream");
	assert.ok(Array.isArray(upstream.tools));
	const tools = upstream.tools as Array<unknown>;
	assert.equal(tools.length, 17, "8 caller tools translated + 9 injected verbatim roster slots");
	assertFingerprintOnce(tools, "chat");
	// Every injected slot carries the verbatim CLI definition (never a COMPAT
	// placeholder): bash {command, timeout, workdir}, read {filePath, offset,
	// limit}, edit {filePath, oldString, newString}. All of them stay in the
	// cloak list, so model calls to non-caller tools never execute downstream.
	for (const n of ["bash", "edit", "grep", "read", "write", "skill", "task", "todowrite", "webfetch", "websearch"]) {
		const t = byUpstreamName(tools, n) as Record<string, unknown>;
		assert.ok(t.function && typeof t.function === "object", `injected ${n} has a function wrapper`);
		const fn = t.function as { description?: unknown; parameters?: unknown };
		assert.ok(!String(fn.description).includes("never be invoked"), `injected ${n} is a verbatim definition`);
		const params = fn.parameters;
		assert.ok(params && typeof params === "object" && "properties" in params, `injected ${n} has executable params`);
		assert.ok(Object.keys(params.properties as Record<string, unknown>).length > 0, `injected ${n} has non-empty properties`);
	}
	const injectedEdit = byUpstreamName(tools, "edit") as Record<string, unknown>;
	const editFn = injectedEdit.function;
	assert.ok(editFn && typeof editFn === "object" && "parameters" in editFn, "edit carries parameters");
	const editParams = editFn.parameters;
	assert.ok(editParams && typeof editParams === "object", "edit parameters are an object");
	assert.deepEqual(editParams, { type: "object", properties: { filePath: { type: "string", description: "The absolute path to the file to edit" }, oldString: { type: "string", description: "The exact string to replace" }, newString: { type: "string", description: "The replacement string" }, replaceAll: { type: "boolean", description: "Replace all occurrences of oldString (default false)" } }, required: ["filePath", "oldString", "newString"] }, "injected edit rides real-or-drop: the real schema");
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
	// Client non-stream gets aggregated JSON: compare against the frozen body,
	// never against a second aggregation of the same bytes.
	const actual = JSON.parse(clientBody) as Record<string, unknown>;
	// `created` is stamped from the wall clock when each body is built, so a
	// second boundary between the proxy's answer and this expectation moved it
	// by one — comparing it made this test fail about once every few hundred
	// runs (seen on CI). Pin the stamp on both sides, and check it is a real
	// epoch-seconds value rather than pinning its digit.
	assert.ok(Number.isInteger(actual.created) && (actual.created as number) > 1_600_000_000, "created must be an epoch-seconds stamp");
	assert.deepEqual({ ...actual, created: 0 }, { ...FROZEN_CHAT_AGGREGATE, created: 0 });
	const msg = (JSON.parse(clientBody) as { choices: Array<{ message: { tool_calls?: Array<{ function: { name: string } }> } }> }).choices[0].message;
	const names = (msg.tool_calls ?? []).map((tc) => tc.function.name);
	assert.deepEqual(names, ["find", "Bash", "ask"], "upstream glob restores to caller find, bash restores to caller Bash, injected read is cloaked like every other injected slot");
});

/**
 * Frozen accepted answer for the responses `rawSse` below: the
 * `response.completed` payload, with upstream `glob`/`bash` restored to the
 * caller's `find`/`Bash` and every id/argument/other output item verbatim.
 * The injected `read` call is cloaked (not the caller's tool).
 * Literal on purpose; see FROZEN_CHAT_AGGREGATE.
 */
const FROZEN_RESPONSES_AGGREGATE: Record<string, unknown> = {
	id: "resp_e2e",
	object: "response",
	status: "completed",
	output: [
		{ type: "function_call", id: "fc_find", name: "find", arguments: '{"pattern":"*.ts"}' },
		{ type: "function_call", id: "fc_bash", name: "Bash", arguments: '{"command":"ls"}' },
		{ type: "function_call", id: "fc_ask", name: "ask", arguments: '{"question":"q?"}' },
		{ type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] },
	],
};

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
			{ type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] },
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
	assert.equal(tools.length, 17, "8 caller tools translated + 9 injected verbatim roster slots");
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
	// Frozen accepted answer: the response.completed object with the upstream
	// `glob`/`bash` restored to the caller's `find`/`Bash`, ids and arguments
	// verbatim, every non-call output item untouched. A literal, not a second
	// aggregation of rawSse — see FROZEN_CHAT_AGGREGATE for why.
	assert.deepEqual(JSON.parse(clientBody), FROZEN_RESPONSES_AGGREGATE);
	const calls = ((JSON.parse(clientBody) as { output: Array<Record<string, unknown>> }).output ?? [])
		.filter((item) => item.type === "function_call")
		.map((item) => String(item.name));
	assert.deepEqual(calls, ["find", "Bash", "ask"], "upstream glob restores to caller find, injected read is cloaked like every other injected slot");
});

/**
 * Frozen accepted answer for the messages `rawSse` below: the aggregated
 * Anthropic message — one tool_use block per streamed caller call, upstream
 * `glob` restored to the caller's `find` and `bash` to the caller's `Bash`,
 * the injected `grep` call cloaked, stop_reason from message_delta,
 * no usage (the stream carried none). Literal on purpose; see
 * FROZEN_CHAT_AGGREGATE.
 */
const FROZEN_MESSAGES_AGGREGATE: Record<string, unknown> = {
	id: "msg_e2e",
	type: "message",
	role: "assistant",
	model: RESPONSES_MODEL,
	content: [
		{ type: "tool_use", id: "tu_find", name: "find", input: { pattern: "*.ts" } },
		{ type: "tool_use", id: "tu_bash", name: "Bash", input: { command: "ls" } },
		{ type: "tool_use", id: "tu_ask", name: "ask", input: { question: "q?" } },
	],
	stop_reason: "tool_use",
};

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
	assert.equal(tools.length, 17, "8 caller tools translated + 9 injected verbatim roster slots");
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
	// Frozen accepted answer; never a second aggregation of rawSse.
	assert.deepEqual(JSON.parse(clientBody), FROZEN_MESSAGES_AGGREGATE);
	const blocks = ((JSON.parse(clientBody) as { content: Array<Record<string, unknown>> }).content ?? [])
		.filter((b) => b.type === "tool_use")
		.map((b) => String(b.name));
	assert.deepEqual(blocks, ["find", "Bash", "ask"], "upstream glob restores to caller find, injected grep is cloaked like every other injected slot");
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
	assert.equal(tools.length, 17, "8 caller tools translated + 9 injected verbatim roster slots");
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

const CLINE_MODEL = "cline/nemotron-3.5-super-vl";

test("proxy e2e: cline responses path reshapes tools with zero fingerprint", async () => {
	// Cline bypass (observable contract): a Cline-model request never carries
	// the OpenCode fingerprint — tools are only reshaped responses->chat
	// (caller find keeps its name), nothing is injected, and no store policy is
	// added. (Cline upstream always streams for aggregation; that is transport,
	// not fingerprint.) Fails if the enforcement call-site ever fingerprints
	// Cline bodies (upstream would see 6 extra tools).
	const read = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
	const mainBefore = read(CLINE_POOL_FILE);
	const bakBefore = read(CLINE_POOL_BACKUP_FILE);
	try {
		fs.rmSync(CLINE_POOL_FILE, { force: true });
		fs.rmSync(CLINE_POOL_BACKUP_FILE, { force: true });
		_resetClinePoolCacheForTest();
		savePool({ accounts: [{ slot: "main", token: "workos:test-key-aaa111", addedAt: new Date().toISOString() }] });
		_resetClinePoolCacheForTest();
		const callerTools = mixedCallerTools().filter((t) => ["ask", "find"].includes(String((t.function as Record<string, unknown>).name)));
		const chatJson = JSON.stringify({
			id: "chatcmpl-cline",
			object: "chat.completion",
			model: CLINE_MODEL,
			choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
		});
		let clientBody = "";
		const upstream = await withProxyAndMock(29321, (res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(chatJson);
		}, async (port) => {
			const res = await postJson(port, "/v1/responses", {
				model: CLINE_MODEL,
				input: "hi",
				stream: false,
				tools: callerTools,
				tool_choice: "auto",
			});
			assert.equal(res.status, 200);
			clientBody = res.body;
		});
		assert.ok(upstream);
		assert.ok(Array.isArray(upstream.messages), "cline upstream speaks chat completions");
		assert.ok(Array.isArray(upstream.tools));
		assert.equal((upstream.tools as unknown[]).length, 2, "cline adds zero fingerprint tools");
		const names = (upstream.tools as Array<unknown>).map(upstreamToolName);
		assert.ok(names.includes("ask"), "cline keeps caller ask");
		assert.ok(names.includes("find"), "cline carries the caller name through untouched");
		assert.equal(upstream.stream, true, "cline upstream always streams for aggregation (transport, not fingerprint)");
		assert.ok(!("store" in upstream), "cline never adds store");
		assert.equal(upstream.tool_choice, "auto", "cline carries tool_choice verbatim");
		const client = JSON.parse(clientBody) as Record<string, unknown>;
		assert.equal(client.object, "response", "cline chat answer maps back to a responses object");
	} finally {
		_resetClinePoolCacheForTest();
		if (mainBefore !== null) fs.writeFileSync(CLINE_POOL_FILE, mainBefore, "utf8");
		else fs.rmSync(CLINE_POOL_FILE, { force: true });
		if (bakBefore !== null) fs.writeFileSync(CLINE_POOL_BACKUP_FILE, bakBefore, "utf8");
		else fs.rmSync(CLINE_POOL_BACKUP_FILE, { force: true });
		_resetClinePoolCacheForTest();
	}
});

const OVH_MODEL = "ovh-free/gpt-oss-20b";

/** Chat SSE the OVH mock answers with (upstream always streams). */
function ovhChatSse(model: string, text: string): string {
	const chunk = (delta: unknown, finish?: string): string =>
		`data: ${JSON.stringify({ id: "chatcmpl-ovh", object: "chat.completion", model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;
	return chunk({ role: "assistant", content: "" }) + chunk({ content: text }) + chunk({}, "stop") + "data: [DONE]\n\n";
}

test("proxy e2e: ovh chat bypass has zero fingerprint, forces upstream stream, and aggregates", async () => {
	// OVH bypass (observable contract), same shape as the Cline bypass: zero
	// injected fingerprint tools, no store, and the lane's own transforms —
	// the `ovh-free/` prefix stripped for the wire (OVH knows only the bare
	// id) and caller tools reshaped to the chat shape, Pi `find` -> `glob`.
	// Upstream always streams; a non-streaming caller gets the aggregated
	// object back. Fails if the fingerprint call-site ever covers OVH bodies.
	const callerTools = mixedCallerTools();
	const rawSse = ovhChatSse("gpt-oss-20b", "hello");
	let clientBody = "";
	const capture: { path?: string } = {};
	const upstream = await withProxyAndMock(29322, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: OVH_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			tools: callerTools,
			tool_choice: "auto",
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	}, capture);
	assert.ok(upstream);
	assert.equal(capture.path, "/v1/chat/completions", "an ovh chat request goes to the chat endpoint");
	assert.equal(upstream.model, "gpt-oss-20b", "the ovh-free/ prefix must be stripped for the wire");
	assert.equal(upstream.stream, true, "ovh upstream always streams for aggregation (transport, not fingerprint)");
	assert.ok(!("store" in upstream), "ovh never adds store");
	assert.equal(upstream.tool_choice, "auto", "ovh carries tool_choice verbatim");
	assert.ok(Array.isArray(upstream.tools));
	const tools = upstream.tools as unknown[];
	assert.equal(tools.length, callerTools.length, "ovh adds zero fingerprint tools");
	const names = tools.map(upstreamToolName);
	assert.ok(names.includes("find"), "ovh carries the caller find name through untouched");
	assert.ok(names.includes("find"), "ovh carries the caller find name through untouched");
	assert.ok(names.includes("Bash"), "ovh keeps the caller's Bash casing (no fingerprint canonicalization)");
	const client = JSON.parse(clientBody) as Record<string, unknown>;
	assert.equal(client.object, "chat.completion", "a non-streaming chat caller gets the aggregated object");
	assert.equal((client.choices as Array<Record<string, unknown>>)[0].message !== undefined, true);
});

test("proxy e2e: ovh streamed chat request pipes the upstream SSE straight through", async () => {
	// A streaming chat caller must not pay an aggregate-and-re-emit round
	// trip: the upstream stream is the client stream, still fingerprint-free.
	const callerTools = mixedCallerTools();
	const rawSse = ovhChatSse("gpt-oss-20b", "streamed");
	let clientBody = "";
	let clientContentType = "";
	const upstream = await withProxyAndMock(29325, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: OVH_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			tools: callerTools,
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
		clientContentType = res.headers["content-type"] ?? "";
	});
	assert.ok(upstream);
	assert.equal(upstream.stream, true);
	assert.ok((upstream.tools as unknown[]).length === callerTools.length, "ovh adds zero fingerprint tools");
	assert.ok(clientContentType.includes("text/event-stream"), "a streaming caller receives the SSE stream");
	assert.ok(clientBody.includes("streamed"), "the streamed body carries the upstream answer");
});

test("proxy e2e: an ovh short alias reaches the bare upstream id", async () => {
	// Regression: lane detection resolves the alias, but the on-wire rewrite
	// used to run on the raw body value, so `llama-3.3-70b` reached OVH
	// unrecognised and answered 404 model_not_found. Canonicalisation must
	// happen BEFORE the prefix strip, not only in lane detection.
	const rawSse = ovhChatSse("Meta-Llama-3_3-70B-Instruct", "hi");
	const capture: { path?: string } = {};
	const upstream = await withProxyAndMock(29326, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: "llama-3.3-70b",
			messages: [{ role: "user", content: "hi" }],
			stream: false,
		});
		assert.equal(res.status, 200);
	}, capture);
	assert.ok(upstream);
	assert.equal(capture.path, "/v1/chat/completions", "an aliased ovh request is routed to ovh, not zen");
	assert.equal(upstream.model, "Meta-Llama-3_3-70B-Instruct", "an alias must resolve to the bare upstream id, casing intact");
});

test("proxy e2e: ovh responses path translates to chat upstream and answers a Responses object", async () => {
	// OVH's responses endpoint rejects every array `input` shape with 422
	// "input: data did not match any variant of untagged enum ResponseInput"
	// and accepts only a bare string, so the lane is chat-only upstream: the
	// caller's input array must be mapped to chat messages, and /v1/responses
	// must never be called. Zero fingerprint either way.
	const callerTools = mixedCallerTools().filter((t) => ["ask", "find"].includes(String((t.function as Record<string, unknown>).name)));
	const rawSse = ovhChatSse("Qwen3.8-27B", "mapped");
	let clientBody = "";
	const capture: { path?: string } = {};
	const upstream = await withProxyAndMock(29323, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/responses", {
			model: "ovh-free/Qwen3.8-27B",
			input: [{ role: "user", content: [{ type: "input_text", text: "Say OK" }] }],
			stream: false,
			tools: callerTools,
			tool_choice: "auto",
			max_output_tokens: 32,
		});
		clientBody = res.body;
	}, capture);
	assert.ok(upstream);
	assert.equal(capture.path, "/v1/chat/completions", "/v1/responses must never be sent upstream for an ovh model");
	assert.equal(upstream.model, "Qwen3.8-27B", "the ovh-free/ prefix must be stripped for the wire");
	assert.equal(upstream.stream, true, "ovh upstream always streams for aggregation");
	assert.ok(!("store" in upstream), "ovh never adds store");
	assert.ok(!("input" in upstream), "the responses-only input field never reaches the chat endpoint");
	assert.ok(!("max_output_tokens" in upstream), "max_output_tokens must be stripped so OVH does not reject it as an extra argument");
	assert.ok(Array.isArray(upstream.messages), "the caller's input array became chat messages");
	assert.deepEqual(upstream.messages, [{ role: "user", content: "Say OK" }], "the caller's input text survives the mapping");
	assert.ok(Array.isArray(upstream.tools));
	assert.equal((upstream.tools as unknown[]).length, 2, "ovh adds zero fingerprint tools");
	const names = (upstream.tools as unknown[]).map(upstreamToolName);
	assert.ok(names.includes("ask"), "ovh keeps caller ask");
	assert.ok(names.includes("find"), "ovh carries the caller find name through untouched");
	assert.equal(upstream.tool_choice, "auto", "ovh carries tool_choice verbatim");
	const client = JSON.parse(clientBody) as Record<string, unknown>;
	assert.equal(client.object, "response", "the chat answer maps back to a Responses object");
	assert.equal(client.status, "completed");
	const output = client.output as Array<Record<string, unknown>>;
	assert.equal(output[0].type, "message");
	assert.deepEqual(output[0].content, [{ type: "output_text", text: "mapped" }]);
});

test("proxy e2e: ovh responses streaming caller gets Responses SSE re-emitted", async () => {
	// A streamed responses caller must still receive a valid Responses event
	// sequence, because upstream only ever speaks chat SSE.
	const rawSse = ovhChatSse("Qwen3.8-27B", "streamed-response");
	let clientBody = "";
	let clientContentType = "";
	const capture: { path?: string } = {};
	const upstream = await withProxyAndMock(29327, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(rawSse);
	}, async (port) => {
		const res = await postJson(port, "/v1/responses", {
			model: "ovh-free/Qwen3.8-27B",
			input: [{ role: "user", content: [{ type: "input_text", text: "Say OK" }] }],
			stream: true,
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
		clientContentType = res.headers["content-type"] ?? "";
	}, capture);
	assert.ok(upstream);
	assert.equal(capture.path, "/v1/chat/completions", "/v1/responses must never be sent upstream for an ovh model");
	assert.ok(Array.isArray(upstream.messages), "upstream spoke chat, never responses");
	assert.ok(!("input" in upstream), "the responses-only input field never reaches the chat endpoint");
	assert.ok(clientContentType.includes("text/event-stream"), "a streaming responses caller receives SSE");
	assert.ok(clientBody.includes("response.completed"), "the SSE sequence carries a completed Responses event");
	assert.ok(clientBody.includes("streamed-response"), "the upstream answer survives the round trip");
	assert.ok(clientBody.includes("[DONE]"), "the stream terminates cleanly");
});

const GLUED_BASH = 'reelane-proxy"}{"i": "Confirming the files", "command": "git status --short", "cwd": "D:/repo"}';
const BASH_PARAMS = { type: "object", properties: { i: { type: "string" }, command: { type: "string" }, timeout: { type: "number" }, cwd: { type: "string" } }, required: ["command"] };

function piCallerTools(): Array<Record<string, unknown>> {
	return [
		{ type: "function", function: { name: "find", description: FIND_DESC, parameters: FIND_PARAMS } },
		{ type: "function", function: { name: "bash", description: "Run a shell command", parameters: BASH_PARAMS } },
];
}

/** Chat SSE answering with the renamed `glob` and a glued bash payload. */
function chatSseWithCalls(model: string): string {
	const chunk = (delta: unknown, finish?: string): string =>
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion", model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;
	return (
		chunk({ role: "assistant", content: "" }) +
		chunk({ tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } }] }) +
		chunk({ tool_calls: [{ index: 1, id: "c1", type: "function", function: { name: "bash", arguments: GLUED_BASH } }] }) +
		chunk({}, "tool_calls") +
		"data: [DONE]\n\n"
	);
}

test("proxy e2e: ovh chat returns the caller's own tool names and repaired arguments", async () => {
	// Translation sends Pi `find` upstream as `glob`; the answer must come back
	// as `find`, or the host has no tool by that name. The glued bash payload
	// must be repaired on this lane too, since it carries the caller's schema.
	let clientBody = "";
	await withProxyAndMock(29328, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(chatSseWithCalls("gpt-oss-20b"));
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: "ovh-free/gpt-oss-20b",
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			tools: piCallerTools(),
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	});
	const client = JSON.parse(clientBody) as Record<string, unknown>;
	const message = (client.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
	const calls = message.tool_calls as Array<Record<string, unknown>>;
	assert.deepEqual(calls.map((c) => (c.function as Record<string, unknown>).name), ["find", "bash"]);
	const bashArgs = JSON.parse((calls[1].function as Record<string, unknown>).arguments as string) as { command: string };
	assert.equal(bashArgs.command, "git status --short", "the glued bash payload is repaired on the ovh lane");
});

test("proxy e2e: ovh chat streaming restores the caller's tool names", async () => {
	let clientBody = "";
	await withProxyAndMock(29329, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(chatSseWithCalls("gpt-oss-20b"));
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: "ovh-free/gpt-oss-20b",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			tools: piCallerTools(),
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	});
	assert.ok(clientBody.includes('"name":"find"'), "streamed callers get their own tool name back");
	assert.ok(!clientBody.includes('"name":"glob"'), "the upstream rename never reaches the client");
	assert.ok(clientBody.includes("git status --short"), "the glued bash payload is repaired on the streamed ovh lane too");
});

test("proxy e2e: ovh qwen3.8 drops reasoning_effort before the wire", async () => {
	// Measured 2026-10-22: Qwen3.8-27B on OVH answers HTTP 200 whose body is a
	// bare `data: [DONE]` whenever `reasoning_effort` is present (max_tokens
	// 4000 and 32000 alike); without the field it streams its own reasoning.
	// The lane strips the field for this model only.
	let clientBody = "";
	const upstream = await withProxyAndMock(29330, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(ovhChatSse("Qwen3.8-27B", "answered"));
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: "ovh-free/Qwen3.8-27B",
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			reasoning_effort: "high",
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	});
	assert.ok(upstream);
	assert.ok(!("reasoning_effort" in upstream), "qwen3.8 must never receive reasoning_effort upstream");
	const client = JSON.parse(clientBody) as Record<string, unknown>;
	const message = (client.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
	assert.equal(message.content, "answered", "the model answers normally once the field is gone");
});

test("proxy e2e: ovh gpt-oss-20b keeps reasoning_effort verbatim", async () => {
	// The strip above is model-scoped: every other OVH model tolerates the
	// field, so the lane must not silently rewrite their sampling knobs.
	const upstream = await withProxyAndMock(29331, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(ovhChatSse("gpt-oss-20b", "kept"));
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: OVH_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			reasoning_effort: "high",
		});
		assert.equal(res.status, 200);
	});
	assert.ok(upstream);
	assert.equal(upstream.reasoning_effort, "high", "the qwen-only strip must not touch another ovh model");
});

test("proxy e2e: ovh mistral small normalizes non-conforming tool-call ids", async () => {
	// Upstream rejects any replayed id that is not 9 alphanumerics: 400
	// "Tool call id was ll_loop_1 but must be a-z, A-Z, 0-9, with a length of 9"
	// when not streaming, and the same silent `[DONE]`-only 200 when it is. A
	// host history id such as `call_loop_1` must be rewritten consistently on
	// the assistant call and the tool message that answers it.
	let clientBody = "";
	const upstream = await withProxyAndMock(29332, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(ovhChatSse("Mistral-Small-3.2-24B-Instruct-2506", "done"));
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: "ovh-free/Mistral-Small-3.2-24B-Instruct-2506",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: null, tool_calls: [{ id: "call_loop_1", type: "function", function: { name: "find", arguments: '{"pattern":"*.ts"}' } }] },
				{ role: "tool", tool_call_id: "call_loop_1", content: "a.ts" },
			],
			stream: false,
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	});
	assert.ok(upstream);
	const messages = upstream.messages as Array<Record<string, unknown>>;
	const assistantId = String((messages[1].tool_calls as Array<Record<string, unknown>>)[0].id);
	assert.match(assistantId, /^[A-Za-z0-9]{9}$/, "the replayed id must satisfy upstream's 9-alphanumeric rule");
	assert.equal(messages[2].tool_call_id, assistantId, "the tool message must carry the same rewritten id");
	assert.ok(!JSON.stringify(upstream.messages).includes("call_loop_1"), "no non-conforming id may survive upstream");
	const client = JSON.parse(clientBody) as Record<string, unknown>;
	const message = (client.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
	assert.equal(message.content, "done", "the turn passes through once the ids conform");
});

test("proxy e2e: an empty ovh upstream stream surfaces as a 502, never a fabricated turn", async () => {
	// Starved OVH requests (defects above) close with a bare `data: [DONE]`.
	// Aggregating that used to yield `chatcmpl-freeflow` with `content: null`
	// and `finish_reason: "stop"` — a fabricated 200 completion that hid the
	// upstream failure. It must surface as an error.
	let clientBody = "";
	let clientType = "";
	await withProxyAndMock(29333, (res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end("data: [DONE]\n\n");
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: "ovh-free/Qwen3.8-27B",
			messages: [{ role: "user", content: "hi" }],
			stream: false,
		});
		assert.equal(res.status, 502, "an upstream that returns nothing is an upstream error");
		clientType = String(res.headers["content-type"] ?? "");
		clientBody = res.body;
	});
	assert.ok(clientType.includes("application/json"), "the error is JSON, not an SSE stream");
	assert.ok(clientBody.includes("upstream returned an empty stream"), "the error names the emptiness");
	assert.ok(!clientBody.includes("chatcmpl-freeflow"), "never emit the fabricated empty completion");
});

test("proxy e2e: cline responses returns the caller's own tool name", async () => {
	const read = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
	const mainBefore = read(CLINE_POOL_FILE);
	const bakBefore = read(CLINE_POOL_BACKUP_FILE);
	try {
		fs.rmSync(CLINE_POOL_FILE, { force: true });
		fs.rmSync(CLINE_POOL_BACKUP_FILE, { force: true });
		_resetClinePoolCacheForTest();
		savePool({ accounts: [{ slot: "main", token: "workos:test-key-aaa111", addedAt: new Date().toISOString() }] });
		_resetClinePoolCacheForTest();
		let clientBody = "";
		await withProxyAndMock(29330, (res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(chatSseWithCalls("glm-5.3-flash"));
		}, async (port) => {
			const res = await postJson(port, "/v1/responses", {
				model: CLINE_MODEL,
				input: "hi",
				stream: false,
				tools: piCallerTools(),
			});
			assert.equal(res.status, 200);
			clientBody = res.body;
		});
		const client = JSON.parse(clientBody) as Record<string, unknown>;
		const output = client.output as Array<Record<string, unknown>>;
		assert.deepEqual(output.filter((o) => o.type === "function_call").map((o) => o.name), ["find", "bash"]);
		const bashArgs = JSON.parse(output[1].arguments as string) as { command: string };
		assert.equal(bashArgs.command, "git status --short");
	} finally {
		_resetClinePoolCacheForTest();
		if (mainBefore !== null) fs.writeFileSync(CLINE_POOL_FILE, mainBefore, "utf8");
		else fs.rmSync(CLINE_POOL_FILE, { force: true });
		if (bakBefore !== null) fs.writeFileSync(CLINE_POOL_BACKUP_FILE, bakBefore, "utf8");
		else fs.rmSync(CLINE_POOL_BACKUP_FILE, { force: true });
		_resetClinePoolCacheForTest();
	}
});

test("proxy e2e: kilo repairs a non-stream JSON answer", async () => {
	// Kilo passes the caller's `stream` through verbatim, so a non-streaming
	// caller gets a plain JSON body. The SSE aggregator is a no-op on it, so the
	// repair has to run on the JSON itself.
	const answer = {
		id: "chatcmpl-k",
		object: "chat.completion",
		model: "dots-3",
		choices: [{
			index: 0,
			message: {
				role: "assistant",
				tool_calls: [
					{ id: "c0", type: "function", function: { name: "find", arguments: '{"pattern":"*.ts"}' } },
					{ id: "c1", type: "function", function: { name: "bash", arguments: GLUED_BASH } },
				],
			},
			finish_reason: "tool_calls",
		}],
	};
	let clientBody = "";
	await withProxyAndMock(29331, (res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(answer));
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: KILO_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			tools: piCallerTools(),
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	});
	const client = JSON.parse(clientBody) as Record<string, unknown>;
	const message = (client.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
	const calls = message.tool_calls as Array<Record<string, unknown>>;
	const bashArgs = JSON.parse((calls[1].function as Record<string, unknown>).arguments as string) as { command: string };
	assert.equal(bashArgs.command, "git status --short", "a non-streaming kilo answer is repaired too");
});

test("proxy e2e: a plain-JSON answer that merely mentions data: passes through byte-identical", async () => {
	// Reproduced live: the Kilo lane forwards `stream:false` untouched, so a
	// non-streaming caller gets plain JSON. The aggregator guard tested
	// `includes("data:")`, which this bash command triggers — the JSON body was
	// fed to the SSE parser and replaced by an empty synthesized completion
	// (content null, tool call gone, HTTP 200). The guard is line-anchored now:
	// a body with no `data:`/`event:` field line is not an event stream.
	const answer = {
		id: "chatcmpl-data",
		object: "chat.completion",
		model: "dots-3",
		choices: [{
			index: 0,
			message: {
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "c0", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: 'grep -n "data:" src/stream-pipe.ts' }) } },
				],
			},
			finish_reason: "tool_calls",
		}],
	};
	const upstreamJson = JSON.stringify(answer);
	let clientBody = "";
	const upstream = await withProxyAndMock(29332, (res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(upstreamJson);
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: KILO_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			tools: piCallerTools(),
		});
		assert.equal(res.status, 200);
		assert.ok(res.headers["content-type"]?.includes("application/json"));
		clientBody = res.body;
	});
	assert.ok(upstream);
	assert.equal(clientBody, upstreamJson, "a non-SSE 200 must reach the client exactly as upstream wrote it");
	const client = JSON.parse(clientBody) as { choices: Array<{ message: { content: unknown; tool_calls: Array<{ function: { arguments: string } }> } }> };
	assert.equal(client.choices[0].message.tool_calls.length, 1, "the tool call must not be swallowed by an SSE aggregation");
	const bashArgs = JSON.parse(client.choices[0].message.tool_calls[0].function.arguments) as { command: string };
	assert.equal(bashArgs.command, 'grep -n "data:" src/stream-pipe.ts', "the arguments survive verbatim");
});

test("proxy e2e: a kilo 400 surfaces upstream's verdict for the requested model — one call, no substitution", async () => {
	// The 400 recovery used to rewrite `dots-studio/dots-3-note-preview:free`
	// to `nvidia/nemotron-3.5-lightning:free` and retry, so the caller could be
	// handed another model's answer (or another model's error body) with only
	// the `model` field as a trace. The upstream verdict must surface as-is.
	const upstreamError = JSON.stringify({ error: { message: "dots-3-note-preview is not available right now" } });
	const capture: { bodies: Array<Record<string, unknown>> } = { bodies: [] };
	await withProxyAndMock(29333, (res) => {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(upstreamError);
	}, async (port) => {
		const res = await postJson(port, "/v1/chat/completions", {
			model: KILO_MODEL,
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			tools: piCallerTools(),
		});
		assert.equal(res.status, 400);
		assert.equal(res.body, upstreamError, "the authentic upstream 400 body must reach the caller");
	}, capture);
	assert.equal(capture.bodies.length, 1, "a named-model 400 must never be retried on another model");
	assert.equal(capture.bodies[0].model, KILO_MODEL, "upstream saw the model the caller asked for");
});

test("proxy e2e: a client that abandons a cline turn aborts the upstream roll", async () => {
	// The cline lane aborted only on `res.writableEnded`, which stays false for
	// a socket the caller destroyed: an abandoned turn left the upstream body
	// paused forever and the handler never finished. The roll now carries an
	// AbortController wired to the response's close.
	const read = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
	const mainBefore = read(CLINE_POOL_FILE);
	const bakBefore = read(CLINE_POOL_BACKUP_FILE);
	try {
		fs.rmSync(CLINE_POOL_FILE, { force: true });
		fs.rmSync(CLINE_POOL_BACKUP_FILE, { force: true });
		_resetClinePoolCacheForTest();
		savePool({ accounts: [{ slot: "main", token: "workos:test-key-aaa111", addedAt: new Date().toISOString() }] });
		_resetClinePoolCacheForTest();
		// The mock has the upstream request; the roll's socket was closed;
		// the safety valve released the held turn itself.
		const upstreamSeen = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const releasedByValve = Promise.withResolvers<void>();
		let valveFired = false;
		await withProxyAndMock(29334, (res) => {
			upstreamSeen.resolve();
			res.req.once("close", () => {
				(valveFired ? releasedByValve : aborted).resolve();
			});
			// The held turn must not wedge the harness when no abort ever
			// arrives (the pre-fix behaviour this test locks out). A real
			// socket cannot be released by fake timers.
			setTimeout(() => {
				valveFired = true;
				try { res.destroy(); } catch { }
			}, 3000).unref();
		}, async (port) => {
			const data = JSON.stringify({ model: CLINE_MODEL, input: "hi", stream: false });
			const clientReq = http.request({
				hostname: "127.0.0.1",
				port,
				path: "/v1/responses",
				method: "POST",
				headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...authHeaders() },
			});
			clientReq.on("error", () => { });
			clientReq.write(data);
			// The roll is in flight once upstream has the request; walk away.
			await upstreamSeen.promise;
			clientReq.destroy();
			const verdict = await Promise.race([
				aborted.promise.then(() => "aborted" as const),
				releasedByValve.promise.then(() => "held" as const),
			]);
			assert.equal(verdict, "aborted", "abandoning the caller must abort the in-flight upstream roll");
		});
	} finally {
		_resetClinePoolCacheForTest();
		if (mainBefore !== null) fs.writeFileSync(CLINE_POOL_FILE, mainBefore, "utf8");
		else fs.rmSync(CLINE_POOL_FILE, { force: true });
		if (bakBefore !== null) fs.writeFileSync(CLINE_POOL_BACKUP_FILE, bakBefore, "utf8");
		else fs.rmSync(CLINE_POOL_BACKUP_FILE, { force: true });
		_resetClinePoolCacheForTest();
	}
});

