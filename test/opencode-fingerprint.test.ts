import test from "node:test";
import assert from "node:assert/strict";
import {
	OPENCODE_FINGERPRINT_TOOLS,
	convertSseToJson,
	enforceOpencodeFingerprint,
	ensureChatFingerprintTools,
	ensureResponsesFingerprintTools,
	parseSseEvents,
	sseToChatCompletionJson,
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

test("ensureChatFingerprintTools: injects full quartet into tool-less bodies", () => {
	const body: Record<string, unknown> = {};
	ensureChatFingerprintTools(body);
	assert.ok(Array.isArray(body.tools));
	assert.equal(body.tools.length, 4);

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
	assert.equal(body.tools.length, 5); // 1 custom + 1 existing read + 3 added (bash, glob, grep)

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
	assert.equal(body.tools.length, 5);

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
	assert.equal(nonStreamBody.stream, true);
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
	assert.equal(streamBodyWithTools.stream, true);
	assert.equal(streamBodyWithTools.store, false);
	assert.equal(streamBodyWithTools.tool_choice, "auto", "caller with tools preserves tool_choice");

	// Injected tools have placeholder description
	const tools = streamBodyWithTools.tools as Array<{ name: string; description?: string }>;
	const bashTool = tools.find((t) => t.name === "bash");
	assert.ok(bashTool?.description?.includes("never be invoked"));
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
