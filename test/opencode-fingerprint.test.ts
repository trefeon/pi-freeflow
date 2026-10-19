import test from "node:test";
import assert from "node:assert/strict";
import {
	OPENCODE_FINGERPRINT_TOOLS,
	convertSseToJson,
	enforceOpencodeFingerprint,
	normalizeResponsesBody,
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
	for (const tool of body.tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>) {
		assert.ok(Object.keys(tool.function.parameters.properties).length > 0, `${tool.function.name} must have non-empty properties for inference gate`);
	}
	const bashTool = (body.tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>).find((t) => t.function.name === "bash");
	assert.ok("command" in bashTool!.function.parameters.properties);
	const readTool = (body.tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>).find((t) => t.function.name === "read");
	assert.ok("path" in readTool!.function.parameters.properties);
});

test("enforceOpencodeFingerprint: Bash lowercased without dup, host tools kept", () => {
	const body: Record<string, unknown> = {
		stream: true,
		tools: [
			{ type: "function", function: { name: "Bash", description: "shell" } },
			{ type: "function", function: { name: "run_code", description: "code" } },
			{ type: "function", function: { name: "ls", description: "list" } },
			{ type: "function", function: { name: "powershell", description: "ps" } },
			{ type: "function", function: { name: "find", description: "find" } },
		],
		// Zen accepts only "auto", so a named choice is dropped rather than
		// retargeted: it cannot reach upstream in any form.
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
	assert.ok(!("tool_choice" in body), "named choice dropped — Zen supports only auto");
});

test("enforceOpencodeFingerprint: a find declaration still rides upstream as glob", () => {
	// The find declaration is renamed to glob upstream so the sextet is
	// satisfied. The caller's tool_choice naming find is dropped instead of
	// retargeted: Zen rejects every choice but "auto", so retargeting it to
	// glob would only produce another 400.
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
	assert.ok(!("tool_choice" in body), "named choice dropped");
	for (const t of ["bash", "glob", "grep", "read", "edit", "write"]) {
		assert.ok(names.includes(t), `sextet complete upstream: ${t}`);
	}
	assert.ok(!r.injected.includes("glob"), "caller-supplied glob is not re-injected");

	const autoChoice: Record<string, unknown> = {
		model: "m",
		tools: [{ type: "function", function: { name: "find", description: "f", parameters: { type: "object" } } }],
		tool_choice: "auto",
	};
	enforceOpencodeFingerprint(autoChoice, "/v1/responses");
	assert.equal(autoChoice.tool_choice, "auto", "auto rides verbatim");
	assert.equal(autoChoice.store, false, "responses cloak still applies");
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

test("sseToChatCompletionJson: parallel calls sharing index 0 stay separate", () => {
	// Observed live from space-bunny-free on 2026-10-08: two tool calls in one
	// turn, both labelled index 0, each with its own id. Keying fragments on
	// index alone spliced them into one unparseable argument blob, which the
	// host rejected with "Unexpected token at position 0" on every retry.
	const sse = [
		'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_AAA","type":"function","function":{"name":"todo","arguments":"{\\"i\\":\\"Mark A done\\",\\"op\\":\\"done\\",\\"task\\":\\"alpha\\"}"}}]}}]}',
		'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_BBB","type":"function","function":{"name":"todo","arguments":"{\\"i\\":\\"Mark B done\\",\\"op\\":\\"done\\",\\"task\\":\\"beta\\"}"}}]}}]}',
		'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
		"data: [DONE]",
	].join("\n\n");
	const res = sseToChatCompletionJson(sse, true) as {
		choices: Array<{ message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
	};
	const calls = res.choices[0].message.tool_calls;
	assert.equal(calls.length, 2, "two parallel calls must not merge into one");
	assert.deepEqual(calls.map((call) => call.id), ["call_AAA", "call_BBB"], "emission order preserved");
	for (const call of calls) {
		assert.equal(call.function.name, "todo", "each call keeps its own name");
		assert.doesNotThrow(() => JSON.parse(call.function.arguments), `arguments for ${call.id} must parse`);
	}
	assert.deepEqual(JSON.parse(calls[0].function.arguments), { i: "Mark A done", op: "done", task: "alpha" });
	assert.deepEqual(JSON.parse(calls[1].function.arguments), { i: "Mark B done", op: "done", task: "beta" });
});

test("sseToChatCompletionJson: one call split across deltas still reassembles whole", () => {
	// The ordinary shape: the first delta carries the id, later ones carry only
	// `arguments`. Those must rejoin the call the index already opened.
	const sse = [
		'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\\"comm"}}]}}]}',
		'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"ls\\"}"}}]}}]}',
		'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
		"data: [DONE]",
	].join("\n\n");
	const res = sseToChatCompletionJson(sse, true) as {
		choices: Array<{ message: { tool_calls: Array<{ id: string; function: { arguments: string } }> } }>;
	};
	const calls = res.choices[0].message.tool_calls;
	assert.equal(calls.length, 1, "id-less follow-up deltas must not open a second call");
	assert.equal(calls[0].id, "call_1");
	assert.deepEqual(JSON.parse(calls[0].function.arguments), { command: "ls" });
});

test("sseToChatCompletionJson: id-less streams still split on distinct indices", () => {
	// Providers that send no id at all keep working through the index fallback.
	const sse = [
		'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}},{"index":1,"type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"b\\"}"}}]}}]}',
		'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
		"data: [DONE]",
	].join("\n\n");
	const res = sseToChatCompletionJson(sse, true) as {
		choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>;
	};
	const calls = res.choices[0].message.tool_calls;
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((call) => JSON.parse(call.function.arguments)), [{ path: "a" }, { path: "b" }]);
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

test("normalizeResponsesBody: canned OMP chat leftovers reach responses shape", () => {
	const body: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 200,
		temperature: 0.5,
		top_p: 1,
		parallel_tool_calls: false,
		tool_choice: "none",
		reasoning: { effort: "max" },
		stream: false,
	};
	normalizeResponsesBody(body);
	assert.deepEqual(body.input, [{ role: "user", content: "hi" }]);
	assert.ok(!("messages" in body));
	assert.equal(body.max_output_tokens, 200);
	assert.ok(!("max_tokens" in body));
	assert.ok(!("temperature" in body) && !("top_p" in body));
	assert.ok(!("parallel_tool_calls" in body), "false dropped (absent-or-true only)");
	assert.ok(!("tool_choice" in body), "none dropped, never 400");
	assert.deepEqual(body.reasoning, { effort: "xhigh" }, "spark max clamps to xhigh");
	assert.equal(body.store, false);
	assert.equal(body.stream, false, "stream policy stays with enforce, not normalize");
});

test("normalizeResponsesBody: auto + parallel true + ultra survive, non-spark untouched", () => {
	const body: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		max_completion_tokens: 50,
		tool_choice: "auto",
		parallel_tool_calls: true,
		reasoning: { effort: "ultra" },
	};
	normalizeResponsesBody(body);
	assert.equal(body.tool_choice, "auto");
	assert.equal(body.parallel_tool_calls, true);
	assert.deepEqual(body.reasoning, { effort: "xhigh" });
	assert.equal(body.max_output_tokens, 50);
	const other: Record<string, unknown> = {
		model: "big-pickle",
		reasoning: { effort: "max" },
		tool_choice: { type: "none" },
	};
	normalizeResponsesBody(other);
	assert.deepEqual(other.reasoning, { effort: "max" }, "non-spark effort never clamped");
	assert.ok(!("tool_choice" in other), "{ type: none } dropped");
});

test("normalizeResponsesBody: every assistant commentary item loses its phase", () => {
	const user = { role: "user", content: [{ type: "input_text", text: "ok" }] };
	const narration = () => ({
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text: "Running the check now.", annotations: [] }],
		status: "completed",
		id: "rs_01a12c40f27b7642992f75b23eff6502",
		phase: "commentary",
	});

	const terminal: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: [user, narration(), user],
	};
	normalizeResponsesBody(terminal);
	const terminalItems = terminal.input as Array<Record<string, unknown>>;
	assert.ok(!("phase" in terminalItems[1]), "terminal commentary phase dropped — upstream 400s on it");
	assert.equal(terminalItems[1].id, "rs_01a12c40f27b7642992f75b23eff6502", "only the phase is rewritten");
	assert.deepEqual(
		terminalItems[1].content,
		[{ type: "output_text", text: "Running the check now.", annotations: [] }],
		"the text the model reads is untouched",
	);

	// A host may seat instruction items between a commentary item and the next
	// user message, so a tail-only sweep would miss it. Upstream validates the
	// whole replayed history, so every commentary item goes.
	const withSystemBetween: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: [narration(), { role: "developer", content: "extra tools" }, user],
	};
	normalizeResponsesBody(withSystemBetween);
	assert.ok(
		!("phase" in (withSystemBetween.input as Array<Record<string, unknown>>)[0]),
		"commentary followed by a developer item is still swept",
	);

	// An earlier turn's commentary must not come back once later turns append.
	const twoTurns: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: [
			{ ...narration(), id: "rs_turn_one" },
			user,
			{ ...narration(), id: "rs_turn_two", phase: "final_answer" },
			user,
		],
	};
	normalizeResponsesBody(twoTurns);
	const twoTurnItems = twoTurns.input as Array<Record<string, unknown>>;
	assert.ok(!("phase" in twoTurnItems[0]), "earlier turn's commentary swept too");
	assert.equal(twoTurnItems[2].phase, "final_answer", "final_answer is not the rejected shape");
});

test("tool_choice is auto-or-absent on every Zen path", () => {
	const unsupported = ["none", "required", "any"] as const;
	for (const value of unsupported) {
		const body: Record<string, unknown> = { model: "nemotron-3.5-super-vl-free", input: "hi", tool_choice: value };
		normalizeResponsesBody(body);
		assert.ok(!("tool_choice" in body), `"${value}" dropped — Zen supports only auto`);
	}
	const named: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		tool_choice: { type: "function", name: "bash" },
	};
	normalizeResponsesBody(named);
	assert.ok(!("tool_choice" in named), "named function choice dropped");

	const auto: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		tool_choice: "auto",
	};
	normalizeResponsesBody(auto);
	assert.equal(auto.tool_choice, "auto", "auto rides verbatim");

	const chat: Record<string, unknown> = { model: "big-pickle", messages: [], tool_choice: "required" };
	enforceOpencodeFingerprint(chat, "/v1/chat/completions");
	assert.ok(!("tool_choice" in chat), "chat path drops an unsupported choice too");

	const chatNone: Record<string, unknown> = { model: "big-pickle", messages: [], tool_choice: "none" };
	enforceOpencodeFingerprint(chatNone, "/v1/chat/completions");
	assert.ok(!("tool_choice" in chatNone), "chat path still drops none");

	const chatAuto: Record<string, unknown> = { model: "big-pickle", messages: [], tool_choice: "auto" };
	enforceOpencodeFingerprint(chatAuto, "/v1/chat/completions");
	assert.equal(chatAuto.tool_choice, "auto", "chat auto rides verbatim");

	// The messages path shares the chat branch: Zen accepts only auto there
	// too, so an unsupported choice is dropped rather than passed through.
	const messagesPath: Record<string, unknown> = { model: "claude-fable-5", messages: [], tool_choice: "required" };
	enforceOpencodeFingerprint(messagesPath, "/v1/messages");
	assert.ok(!("tool_choice" in messagesPath), "messages path drops an unsupported choice too");

	const messagesAuto: Record<string, unknown> = { model: "claude-fable-5", messages: [], tool_choice: "auto" };
	enforceOpencodeFingerprint(messagesAuto, "/v1/messages");
	assert.equal(messagesAuto.tool_choice, "auto", "messages auto rides verbatim");
});

test("a replayed tool call with a malformed name is folded on the wire", () => {
	// Captured live: space-bunny-free emitted a call named `id id=`, and Pi
	// replays it in input[] forever, so every later turn 400s.
	const body: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: [
			{ role: "user", content: [{ type: "input_text", text: "go" }] },
			{ type: "function_call", call_id: "call_983ed385be8d42d1a0841458", name: "id id=", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_983ed385be8d42d1a0841458", output: "ok" },
			{ role: "user", content: [{ type: "input_text", text: "again" }] },
		],
	};
	normalizeResponsesBody(body);
	const items = body.input as Array<Record<string, unknown>>;
	assert.equal(items[1].name, "id_id_", "the malformed call name is folded");
	assert.equal(items[1].call_id, "call_983ed385be8d42d1a0841458", "the call id is untouched");
	assert.equal(items[1].arguments, "{}", "arguments untouched");

	const custom: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: [
			{ type: "custom_tool_call", call_id: "c1", name: "xd://browser__open", input: "{}" },
			{ type: "custom_tool_call", call_id: "c1", name: "bash", input: "{}" },
		],
	};
	normalizeResponsesBody(custom);
	const customItems = custom.input as Array<Record<string, unknown>>;
	assert.equal(customItems[0].name, "xd___browser__open", "custom_tool_call folded too (one _ per invalid character)");
	assert.equal(customItems[1].name, "bash", "a legal replayed call name rides verbatim");

	// A `messages` body copied into `input` is covered by the same sweep.
	const viaMessages: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		messages: [{ type: "function_call", call_id: "c2", name: "bad name", arguments: "{}" }],
	};
	normalizeResponsesBody(viaMessages);
	assert.equal(
		(viaMessages.input as Array<Record<string, unknown>>)[0].name,
		"bad_name",
		"chat leftovers copied into input[] are swept too",
	);
});

test("dropping a forced tool call keeps the model's native reasoning on", () => {
	// Captured live: OMP forces its synthetic `think` tool and switches native
	// reasoning off with effort "none". Dropping the forced call must not leave
	// the model reasoning-free, and "none" is itself rejected upstream.
	const body: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: [{ role: "user", content: [{ type: "input_text", text: "go" }] }],
		tool_choice: { type: "function", name: "think" },
		reasoning: { effort: "none" },
	};
	normalizeResponsesBody(body);
	assert.ok(!("tool_choice" in body), "the forced call is dropped");
	assert.equal(
		(body.reasoning as Record<string, unknown>).effort,
		"xhigh",
		"native reasoning is restored to the model's highest supported level",
	);

	const flat: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		tool_choice: "required",
		reasoning_effort: "none",
	};
	normalizeResponsesBody(flat);
	assert.equal(flat.reasoning_effort, "xhigh", "the flat field is restored too");

	const camel: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		tool_choice: "required",
		reasoningEffort: "none",
	};
	normalizeResponsesBody(camel);
	assert.equal(camel.reasoningEffort, "xhigh", "the camelCase field is restored too");

	// Genuine reasoning-off is the caller's real intent and must survive.
	const genuineOff: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		tool_choice: "required",
		reasoning: { effort: "off" },
	};
	normalizeResponsesBody(genuineOff);
	assert.equal((genuineOff.reasoning as Record<string, unknown>).effort, "off", "an explicit off is never rewritten");

	// A supported effort is left exactly as the caller set it.
	const chosen: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		tool_choice: "required",
		reasoning: { effort: "low" },
	};
	normalizeResponsesBody(chosen);
	assert.equal((chosen.reasoning as Record<string, unknown>).effort, "low", "a supported effort is untouched");

	// No forced call means no restore: the host's own value stands.
	const untouched: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		reasoning: { effort: "none" },
	};
	normalizeResponsesBody(untouched);
	assert.equal(
		(untouched.reasoning as Record<string, unknown>).effort,
		"none",
		"without a dropped forced call the host's value is left alone",
	);
});

test("enforceOpencodeFingerprint: responses path normalizes before fingerprint", () => {
	const body: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 200,
		temperature: 0.5,
		tool_choice: "none",
		reasoning: { effort: "max" },
		stream: false,
		tools: [{ type: "function", name: "my_tool", description: "m", parameters: { type: "object" } }],
	};
	const r = enforceOpencodeFingerprint(body, "/v1/responses");
	assert.equal(r.clientRequestedStream, false);
	assert.equal(body.stream, true, "upstream still forced stream:true");
	assert.ok(Array.isArray(body.input) && !("messages" in body));
	assert.equal(body.max_output_tokens, 200);
	assert.ok(!("tool_choice" in body));
	assert.deepEqual(body.reasoning, { effort: "xhigh" });
	assert.equal(body.store, false);
	assert.equal((body.tools as unknown[]).length, 7, "caller tool + sextet");
	const chat: Record<string, unknown> = {
		model: "big-pickle",
		messages: [{ role: "user", content: "hi" }],
		temperature: 0.5,
		tool_choice: "none",
		stream: false,
	};
	enforceOpencodeFingerprint(chat, "/v1/chat/completions");
	assert.ok(Array.isArray(chat.messages), "chat path keeps messages");
	assert.equal(chat.temperature, 0.5, "chat path keeps temperature");
	assert.ok(!("tool_choice" in chat), "chat none dropped, never 400");
	assert.ok(!("store" in chat), "store stays responses-only");
});

test("normalizeResponsesBody: flat reasoning effort max|ultra clamp to xhigh", () => {
	const body: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		reasoning_effort: "max",
		reasoningEffort: "ultra",
	};
	normalizeResponsesBody(body);
	assert.equal(body.reasoning_effort, "xhigh");
	assert.equal(body.reasoningEffort, "xhigh");
	const upper: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		reasoning_effort: "MAX",
		reasoningEffort: "Ultra",
	};
	normalizeResponsesBody(upper);
	assert.equal(upper.reasoning_effort, "xhigh", "clamp is case-insensitive");
	assert.equal(upper.reasoningEffort, "xhigh", "clamp is case-insensitive");
	for (const level of ["off", "low", "medium", "high", "xhigh"]) {
		const kept: Record<string, unknown> = {
			model: "nemotron-3.5-super-vl-free",
			input: "hi",
			reasoning_effort: level,
			reasoningEffort: level,
		};
		normalizeResponsesBody(kept);
		assert.equal(kept.reasoning_effort, level, `${level} untouched`);
		assert.equal(kept.reasoningEffort, level, `${level} untouched`);
	}
	const other: Record<string, unknown> = {
		model: "big-pickle",
		input: "hi",
		reasoning_effort: "max",
		reasoningEffort: "ultra",
	};
	normalizeResponsesBody(other);
	assert.equal(other.reasoning_effort, "max", "non-spark flat effort never clamped");
	assert.equal(other.reasoningEffort, "ultra", "non-spark flat effort never clamped");
});

test("enforceOpencodeFingerprint: responses path clamps flat effort end to end", () => {
	const body: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		reasoning_effort: "max",
		reasoningEffort: "ultra",
		stream: false,
	};
	enforceOpencodeFingerprint(body, "/v1/responses");
	assert.equal(body.reasoning_effort, "xhigh");
	assert.equal(body.reasoningEffort, "xhigh");
	const other: Record<string, unknown> = {
		model: "big-pickle",
		input: "hi",
		reasoning_effort: "max",
		reasoningEffort: "ultra",
		stream: false,
	};
	enforceOpencodeFingerprint(other, "/v1/responses");
	assert.equal(other.reasoning_effort, "max", "non-spark untouched end to end");
	assert.equal(other.reasoningEffort, "ultra", "non-spark untouched end to end");
});

test("enforceOpencodeFingerprint: chat path drops tool_choice none, keeps auto-or-absent", () => {
	for (const none of ["none", "None", { type: "none" }]) {
		const body: Record<string, unknown> = {
			model: "nemotron-3.5-super-vl-free",
			messages: [{ role: "user", content: "hi" }],
			tool_choice: none,
			stream: false,
		};
		enforceOpencodeFingerprint(body, "/v1/chat/completions");
		assert.ok(!("tool_choice" in body), `none dropped, never 400: ${JSON.stringify(none)}`);
		assert.equal(body.stream, true, "stream still forced");
	}
	const auto: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		messages: [{ role: "user", content: "hi" }],
		tool_choice: "auto",
		stream: false,
	};
	enforceOpencodeFingerprint(auto, "/v1/chat/completions");
	assert.equal(auto.tool_choice, "auto", "auto still rides");
	const absent: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		messages: [{ role: "user", content: "hi" }],
		stream: false,
	};
	enforceOpencodeFingerprint(absent, "/v1/chat/completions");
	assert.ok(!("tool_choice" in absent), "no choice imposed");
});

test("normalizeResponsesBody: drops response_format leftover from chat completions", () => {
	const body: Record<string, unknown> = {
		model: "nemotron-3.5-super-vl-free",
		input: "hi",
		response_format: { type: "json_object" },
	};
	normalizeResponsesBody(body);
	assert.ok(!("response_format" in body), "response_format stripped on responses path");
});

test("normalizeResponsesBody: generalized model effort clamping for mimo and nemotron", () => {
	// mimo-v2.6-flash-free: max is null, highest non-null is xhigh (mapped to high)
	const mimo: Record<string, unknown> = {
		model: "mimo-v2.6-flash-free",
		input: "hi",
		reasoning_effort: "max",
		reasoningEffort: "ultra",
	};
	normalizeResponsesBody(mimo);
	assert.equal(mimo.reasoning_effort, "xhigh", "mimo max clamped to highest supported xhigh");
	assert.equal(mimo.reasoningEffort, "xhigh", "mimo ultra clamped to highest supported xhigh");

	// nemotron-3-ultra-free: max is null, highest non-null is xhigh
	const nemo: Record<string, unknown> = {
		model: "nemotron-3-ultra-free",
		input: "hi",
		reasoning_effort: "max",
		reasoningEffort: "ultra",
	};
	normalizeResponsesBody(nemo);
	assert.equal(nemo.reasoning_effort, "xhigh", "nemotron max clamped to highest supported xhigh");
	assert.equal(nemo.reasoningEffort, "xhigh", "nemotron ultra clamped to highest supported xhigh");

	// nested reasoning.effort works as well
	const nested: Record<string, unknown> = {
		model: "mimo-v2.6-flash-free",
		input: "hi",
		reasoning: { effort: "max" },
	};
	normalizeResponsesBody(nested);
	assert.equal((nested.reasoning as Record<string, unknown>).effort, "xhigh", "nested reasoning effort clamped");
});
