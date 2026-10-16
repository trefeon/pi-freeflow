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
 * `capture.path` (optional) receives the upstream pathname, for assertions
 * about which endpoint a lane actually called.
 */
async function withProxyAndMock(
	proxyPort: number,
	respond: (res: http.ServerResponse) => void,
	client: (port: number) => Promise<void>,
	capture?: { path?: string },
): Promise<Record<string, unknown> | null> {
	_resetUpstreamHealthForTest();
	_resetFreeTierHintForTest();
	let upstreamReceivedBody: Record<string, unknown> | null = null;
	const mock = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			if (capture) capture.path = req.url ?? "";
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
	// Zen free tier accepts only "auto", so a named caller choice is dropped
	// rather than carried: it cannot reach upstream in any form.
	assert.ok(!("tool_choice" in upstream), "an unsupported tool_choice never reaches upstream");
	assert.ok(Array.isArray(upstream.tools));
	const tools = upstream.tools as Array<unknown>;
	assert.equal(tools.length, 12, "8 caller tools translated + 4 injected (3 real defs + cloaked edit, OMP-like caller)");
	assertFingerprintOnce(tools, "chat");
	// OMP-like caller (ask present): injected grep/read/write carry executable real
	// schemas, never COMPAT text. Injected edit is always the cloaked placeholder:
	// no static edit schema executes on either host.
	for (const n of ["grep", "read", "write"]) {
		const t = byUpstreamName(tools, n) as Record<string, unknown>;
		const fn = t.function as Record<string, unknown>;
		assert.ok(!String(fn.description).includes("never be invoked"), `injected ${n} is a real definition`);
		const params = fn.parameters as { properties?: Record<string, unknown> };
		assert.ok(params.properties && Object.keys(params.properties).length > 0, `injected ${n} has executable params`);
	}
	const injectedEdit = byUpstreamName(tools, "edit") as Record<string, unknown>;
	assert.ok(
		String((injectedEdit.function as Record<string, unknown>).description).includes("never be invoked"),
		"injected edit stays the cloaked placeholder",
	);
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
	assert.deepEqual(names, ["find", "Bash", "ask", "read"], "upstream glob restores to caller find, bash restores to caller Bash, injected read executes (real def, not cloaked)");
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
	assert.equal(tools.length, 12, "8 caller tools translated + 4 injected real definitions (OMP-like caller)");
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
	assert.deepEqual(calls, ["find", "Bash", "ask", "read"], "upstream glob restores to caller find, injected read executes (real def, not cloaked)");
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
	assert.equal(tools.length, 12, "8 caller tools translated + 4 injected real definitions (OMP-like caller)");
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
	assert.deepEqual(blocks, ["find", "Bash", "ask", "grep"], "upstream glob restores to caller find, injected grep executes (real def, not cloaked)");
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

const CLINE_MODEL = "z-ai/glm-5.3-flash";

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
		});
		assert.equal(res.status, 200);
		clientBody = res.body;
	}, capture);
	assert.ok(upstream);
	assert.equal(capture.path, "/v1/chat/completions", "/v1/responses must never be sent upstream for an ovh model");
	assert.equal(upstream.model, "Qwen3.8-27B", "the ovh-free/ prefix must be stripped for the wire");
	assert.equal(upstream.stream, true, "ovh upstream always streams for aggregation");
	assert.ok(!("store" in upstream), "ovh never adds store");
	assert.ok(!("input" in upstream), "the responses-only input field never reaches the chat endpoint");
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

