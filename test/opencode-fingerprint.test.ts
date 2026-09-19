import test from "node:test";
import assert from "node:assert/strict";
import {
	OPENCODE_FINGERPRINT_TOOLS,
	convertSseToJson,
	enforceOpencodeFingerprint,
	ensureChatFingerprintTools,
	ensureResponsesFingerprintTools,
	isPlaceholderToolName,
	normalizePlaceholderCase,
	parseSseEvents,
	retargetToolChoice,
	sseToChatCompletionJson,
	sseToMessagesJson,
	sseToResponsesJson,
	toolNameOf,
} from "../src/opencode-fingerprint.ts";

test("toolNameOf: extracts tool name from both function-wrapped and flat tool objects", () => {
	assert.equal(toolNameOf({ type: "function", function: { name: "bash" } }), "bash");
	assert.equal(toolNameOf({ type: "function", name: "read" }), "read");
	assert.equal(toolNameOf({ name: "  grep  " }), "grep");
	assert.equal(toolNameOf(null), "");
	assert.equal(toolNameOf(undefined), "");
	assert.equal(toolNameOf("invalid"), "");
	assert.equal(toolNameOf({}), "");
});

test("ensureChatFingerprintTools: injects full sextet into tool-less bodies", () => {
	const body: Record<string, unknown> = {};
	ensureChatFingerprintTools(body);
	assert.ok(Array.isArray(body.tools));
	assert.equal(body.tools.length, 6);

	const names = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
	for (const tool of OPENCODE_FINGERPRINT_TOOLS) {
		assert.ok(names.includes(tool), `missing fingerprint tool ${tool}`);
	}
});

test("ensureChatFingerprintTools: preserves caller tools and only appends missing ones", () => {
	const body: Record<string, unknown> = {
		tools: [
			{ type: "function", function: { name: "custom_analyzer", description: "custom" } },
			{ type: "function", function: { name: "read" } },
		],
	};
	ensureChatFingerprintTools(body);
	assert.ok(Array.isArray(body.tools));
	assert.equal(body.tools.length, 7); // 1 custom + 1 existing read + 5 added (bash, glob, grep, edit, write)

	const names = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
	assert.ok(names.includes("custom_analyzer"));
	assert.ok(names.includes("read"));
	assert.ok(names.includes("bash"));
	assert.ok(names.includes("glob"));
	assert.ok(names.includes("grep"));
});

test("ensureResponsesFingerprintTools: uses flat responses format and preserves caller tools", () => {
	const body: Record<string, unknown> = {
		tools: [{ type: "function", name: "my_tool", description: "my" }],
	};
	ensureResponsesFingerprintTools(body);
	assert.ok(Array.isArray(body.tools));
	assert.equal(body.tools.length, 7);

	const tools = body.tools as Array<{ name: string; type: string }>;
	for (const t of tools) {
		assert.equal(t.type, "function");
		assert.ok(typeof t.name === "string" && t.name.length > 0);
	}
	const names = tools.map((t) => t.name);
	assert.ok(names.includes("my_tool"));
	assert.ok(names.includes("bash"));
	assert.ok(names.includes("glob"));
	assert.ok(names.includes("grep"));
	assert.ok(names.includes("read"));
});

test("enforceOpencodeFingerprint: forces stream: true and records callerHadTools without breaking tool_choice", () => {
	const nonStreamBody: Record<string, unknown> = { stream: false };
	const r1 = enforceOpencodeFingerprint(nonStreamBody, "/v1/chat/completions");
	assert.equal(r1.clientRequestedStream, false);
	assert.equal(r1.callerHadTools, false);
	assert.equal(r1.addedTools, true);
	assert.equal(nonStreamBody.stream, true);
	assert.equal((nonStreamBody.tools as unknown[]).length, 6);
	// tool_choice must NOT be set to "none" because upstream Zen returns 400 (only "auto" supported)
	assert.equal(nonStreamBody.tool_choice, undefined);

	const streamBodyWithTools: Record<string, unknown> = {
		stream: true,
		tools: [{ type: "function", name: "read" }],
		tool_choice: "auto",
	};
	const r2 = enforceOpencodeFingerprint(streamBodyWithTools, "/v1/responses");
	assert.equal(r2.clientRequestedStream, true);
	assert.equal(r2.callerHadTools, true);
	assert.equal(r2.addedTools, true);
	assert.equal(streamBodyWithTools.stream, true);
	assert.equal(streamBodyWithTools.store, false);
	assert.equal(streamBodyWithTools.tool_choice, "auto", "caller with tools preserves tool_choice");

	// Injected tools have placeholder description
	const tools = streamBodyWithTools.tools as Array<{ name: string; description?: string }>;
	const bashTool = tools.find((t) => t.name === "bash");
	assert.ok(bashTool?.description?.includes("never be invoked"));
});

test("enforceOpencodeFingerprint: tool-less body gains 6 injected tools and stream:true", () => {
	const body: Record<string, unknown> = { model: "m", stream: false };
	const r = enforceOpencodeFingerprint(body, "/v1/chat/completions");
	assert.equal(r.callerHadTools, false);
	assert.equal(r.addedTools, true);
	assert.equal(body.stream, true);
	const names = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort();
	assert.deepEqual(names, ["bash", "edit", "glob", "grep", "read", "write"]);
});

test("enforceOpencodeFingerprint: Bash lowercased without dup, tool_choice retargeted, host tools kept", () => {
	const body: Record<string, unknown> = {
		stream: true,
		tools: [
			{ type: "function", function: { name: "Bash", description: "shell" } },
			{ type: "function", function: { name: "run_code", description: "code" } },
			{ type: "function", function: { name: "ls", description: "list" } },
			{ type: "function", function: { name: "powershell", description: "ps" } },
			{ type: "function", function: { name: "find", description: "find" } },
		],
		tool_choice: { type: "function", function: { name: "Bash" } },
	};
	const r = enforceOpencodeFingerprint(body, "/v1/chat/completions");
	assert.equal(r.callerHadTools, true);
	assert.deepEqual(r.caseRestore, { bash: "Bash" });
	const tools = body.tools as Array<{ type: string; function: { name: string } }>;
	const names = tools.map((t) => t.function.name);
	assert.equal(names.filter((n) => n === "bash").length, 1, "Bash must not duplicate bash");
	assert.ok(names.includes("run_code"));
	assert.ok(names.includes("ls"), "caller ls never dropped");
	assert.ok(names.includes("powershell"), "caller powershell never dropped");
	assert.ok(names.includes("glob"), "Pi find rides upstream as glob");
	assert.deepEqual(r.injected, ["grep", "read", "edit", "write"], "bash+glob declared upstream, rest injected");
	assert.deepEqual(body.tool_choice, { type: "function", function: { name: "bash" } });
});

test("enforceOpencodeFingerprint: caller tool_choice naming find rides upstream as glob", () => {
	// Translator gap: the find declaration was renamed to glob upstream while a
	// caller tool_choice naming find was left dangling. Both shapes retarget.
	const body: Record<string, unknown> = {
		model: "m",
		stream: true,
		tools: [{ type: "function", function: { name: "find", description: "f", parameters: { type: "object" } } }],
		tool_choice: { type: "function", function: { name: "find" } },
	};
	const r = enforceOpencodeFingerprint(body, "/v1/chat/completions");
	const names = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
	assert.ok(names.includes("glob"), "find declaration renamed to glob upstream");
	assert.ok(!names.some((n) => n.toLowerCase() === "find"), "no dangling find declaration");
	assert.deepEqual(body.tool_choice, { type: "function", function: { name: "glob" } });
	for (const t of ["bash", "glob", "grep", "read", "edit", "write"]) {
		assert.ok(names.includes(t), `sextet complete upstream: ${t}`);
	}
	assert.ok(!r.injected.includes("glob"), "caller-supplied glob is not re-injected");
	const stringChoice: Record<string, unknown> = {
		stream: true,
		tools: [{ type: "function", function: { name: "find", description: "f", parameters: { type: "object" } } }],
		tool_choice: "find",
	};
	enforceOpencodeFingerprint(stringChoice, "/v1/responses");
	assert.equal(stringChoice.tool_choice, "glob", "string choice retargets too");
	assert.equal(stringChoice.store, false, "responses cloak still applies");
});

test("normalizePlaceholderCase + retargetToolChoice: bounded per-request restore", () => {
	const body: Record<string, unknown> = {
		tools: [{ name: "Grep" }, { name: "ls" }],
		tool_choice: { type: "function", name: "Grep" },
	};
	const restore = normalizePlaceholderCase(body);
	assert.deepEqual(restore, { grep: "Grep" });
	assert.equal((body.tools as Array<{ name: string }>)[0].name, "grep");
	assert.equal((body.tools as Array<{ name: string }>)[1].name, "ls");
	retargetToolChoice(body);
	assert.deepEqual(body.tool_choice, { type: "function", name: "grep" });
	assert.ok(isPlaceholderToolName("WRITE"));
	assert.ok(!isPlaceholderToolName("ls"));
	assert.ok(!isPlaceholderToolName("find"));
});

test("ensureChatFingerprintTools: case-insensitive idempotent, no Bash/bash dup", () => {
	const body: Record<string, unknown> = {
		tools: [{ type: "function", function: { name: "Bash" } }],
	};
	ensureChatFingerprintTools(body);
	const names = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
	assert.equal(names.filter((n) => n.toLowerCase() === "bash").length, 1);
	assert.equal(names.length, 6);
});

test("parseSseEvents: parses raw SSE text blocks into events and data", () => {
	const sse = "event: message\ndata: hello\n\nevent: done\ndata: [DONE]\n\n";
	const events = parseSseEvents(sse);
	assert.equal(events.length, 2);
	assert.equal(events[0].event, "message");
	assert.equal(events[0].data, "hello");
	assert.equal(events[1].event, "done");
	assert.equal(events[1].data, "[DONE]");
});

test("sseToChatCompletionJson: reconstructs full completion from streaming deltas", () => {
	const sse = [
		'data: {"id":"chatcmpl-1","model":"muse-spark","created":1700000000,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}',
		'data: {"id":"chatcmpl-1","model":"muse-spark","created":1700000000,"choices":[{"index":0,"delta":{"content":" world!"}}]}',
		'data: {"id":"chatcmpl-1","model":"muse-spark","created":1700000000,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
		"data: [DONE]",
	].join("\n\n");

	const res = sseToChatCompletionJson(sse);
	assert.equal(res.id, "chatcmpl-1");
	assert.equal(res.model, "muse-spark");
	assert.equal(res.object, "chat.completion");
	assert.ok(Array.isArray(res.choices));
	const choice = (res.choices as Array<{ message: { role: string; content: string }; finish_reason: string }>)[0];
	assert.equal(choice.message.role, "assistant");
	assert.equal(choice.message.content, "Hello world!");
	assert.equal(choice.finish_reason, "stop");
	assert.deepEqual(res.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
});

test("sseToResponsesJson: extracts completed response object from response.completed event", () => {
	const expectedResponse = {
		id: "resp_test123",
		object: "response",
		status: "completed",
		output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] }],
	};
	const sse = [
		'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test123","status":"in_progress"}}',
		`event: response.completed\ndata: {"type":"response.completed","response":${JSON.stringify(expectedResponse)}}`,
	].join("\n\n");

	const res = sseToResponsesJson(sse);
	assert.deepEqual(res, expectedResponse);
});

test("convertSseToJson: converts SSE to JSON string according to pathname", () => {
	const chatSse =
		'data: {"id":"c1","model":"m1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\ndata: [DONE]';
	const chatJsonStr = convertSseToJson(chatSse, "/v1/chat/completions");
	const chatObj = JSON.parse(chatJsonStr) as { choices: Array<{ message: { content: string } }> };
	assert.equal(chatObj.choices[0].message.content, "ok");

	const rawNonSse = JSON.stringify({ error: { message: "bad request" } });
	assert.equal(convertSseToJson(rawNonSse, "/v1/chat/completions"), rawNonSse);
});
test("sseToChatCompletionJson: drops tool_calls when caller had no tools", () => {
	const sse = [
		'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
		"data: [DONE]",
	].join("\n\n");

	const res = sseToChatCompletionJson(sse, false);
	const choice = (res.choices as Array<{ message: { role: string; content?: string; tool_calls?: unknown } }>)[0];
	assert.equal(choice.message.tool_calls, undefined, "tool_calls must be removed for tool-less callers");
	assert.ok(choice.message.content?.includes("a.txt"), "content must receive arguments fallback");
});
test("sseToResponsesJson: strips only injected names when caller had tools", () => {
	const response = {
		id: "resp_1",
		object: "response",
		status: "completed",
		output: [
			{ type: "function_call", name: "bash", arguments: "{}" },
			{ type: "function_call", name: "my_tool", arguments: "{}" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
		],
	};
	const sse = `event: response.completed\ndata: {"type":"response.completed","response":${JSON.stringify(response)}}`;
	const injected = ["bash", "glob", "grep", "read", "edit", "write"];
	const res = sseToResponsesJson(sse, true, undefined, undefined, injected) as {
		output: Array<{ type: string; name?: string }>;
	};
	assert.equal(res.output.length, 2);
	assert.ok(!res.output.some((o) => o.name === "bash"), "injected bash call cloaked (non-empty too)");
	assert.ok(res.output.some((o) => o.name === "my_tool"), "caller call preserved");
});

test("sseToResponsesJson: legacy direct calls without records keep everything", () => {
	const response = {
		id: "resp_1",
		object: "response",
		status: "completed",
		output: [{ type: "function_call", name: "bash", arguments: "{}" }],
	};
	const sse = `event: response.completed\ndata: {"type":"response.completed","response":${JSON.stringify(response)}}`;
	const res = sseToResponsesJson(sse, true) as { output: Array<{ type: string; name?: string }> };
	assert.equal(res.output.length, 1, "no record means indistinguishable: never drop a possibly-real call");
});

test("sseToChatCompletionJson: strips only injected, restores caller casing and find->glob", () => {
	const sse = [
		'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{}"}},{"index":1,"id":"call_2","type":"function","function":{"name":"glob","arguments":"{}"}}]}}]}',
		"data: [DONE]",
	].join("\n\n");
	const res = sseToChatCompletionJson(sse, true, { bash: "Bash" }, { renamedFindToGlob: true }, [
		"bash",
		"edit",
		"grep",
		"read",
		"write",
	]) as {
		choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
	};
	assert.equal(res.choices[0].message.tool_calls.length, 1, "injected bash stripped, caller glob kept");
	assert.equal(res.choices[0].message.tool_calls[0].function.name, "find", "upstream glob restored to caller find");
});

test("enforce+sse round trip: caller Bash survives cloak with original casing", () => {
	const body: Record<string, unknown> = {
		stream: false,
		tools: [{ type: "function", function: { name: "Bash", description: "shell" } }],
	};
	const r = enforceOpencodeFingerprint(body, "/v1/chat/completions");
	assert.ok(!r.injected.includes("bash"), "caller-declared bash is not injected");
	const sse = [
		'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}',
		"data: [DONE]",
	].join("\n\n");
	const res = sseToChatCompletionJson(sse, true, r.caseRestore, r.findGlob, r.injected) as {
		choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
	};
	assert.equal(res.choices[0].message.tool_calls.length, 1, "caller's own bash never cloaked");
	assert.equal(res.choices[0].message.tool_calls[0].function.name, "Bash");
});

test("sseToMessagesJson: drops placeholder tool_use, keeps caller blocks with restored names", () => {
	const sse = [
		'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_ph","name":"read","input":{}}}',
		'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
		'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"glob","input":{}}}',
		'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":1}"}}',
	].join("\n\n");
	const res = sseToMessagesJson(sse, true, undefined, { renamedFindToGlob: true }, [
		"bash",
		"grep",
		"read",
		"edit",
		"write",
	]) as {
		content: Array<{ type: string; name?: string; input?: unknown }>;
	};
	assert.equal(res.content.length, 1);
	assert.equal(res.content[0].name, "find", "upstream glob restored to caller find");
	assert.deepEqual(res.content[0].input, { q: 1 });
});
