import test from "node:test";
import assert from "node:assert/strict";
import { FULL11_TOOL_DEFS, FULL11_TOOL_NAMES } from "../src/tool-translation.ts";
import { enforceOpencodeFingerprint } from "../src/opencode-fingerprint.ts";

function propKeys(name: string): string[] {
	const params = FULL11_TOOL_DEFS[name as keyof typeof FULL11_TOOL_DEFS]
		.parameters as Record<string, unknown>;
	const props = (params.properties ?? {}) as Record<string, unknown>;
	return Object.keys(props).sort();
}

function requiredOf(name: string): unknown {
	const params = FULL11_TOOL_DEFS[name as keyof typeof FULL11_TOOL_DEFS]
		.parameters as Record<string, unknown>;
	return params.required;
}

test("live roster: exactly the 11 STB-verified tool names", () => {
	assert.deepEqual([...FULL11_TOOL_NAMES], [
		"bash", "edit", "glob", "grep", "read",
		"skill", "task", "todowrite", "webfetch", "websearch", "write",
	]);
});

test("live schemas: property keys match the verbatim CLI shapes", () => {
	assert.deepEqual(propKeys("bash"), ["command", "timeout", "workdir"]);
	assert.deepEqual(propKeys("edit"), ["filePath", "newString", "oldString", "replaceAll"]);
	assert.deepEqual(propKeys("glob"), ["path", "pattern"]);
	assert.deepEqual(propKeys("grep"), ["include", "path", "pattern"]);
	assert.deepEqual(propKeys("read"), ["filePath", "limit", "offset"]);
	assert.deepEqual(propKeys("skill"), ["name"]);
	assert.deepEqual(propKeys("task"), [
		"background", "command", "description", "prompt", "subagent_type", "task_id",
	]);
	assert.deepEqual(propKeys("todowrite"), ["todos"]);
	assert.deepEqual(propKeys("webfetch"), ["format", "timeout", "url"]);
	assert.deepEqual(propKeys("websearch"), [
		"contextMaxCharacters", "livecrawl", "numResults", "query", "type",
	]);
	assert.deepEqual(propKeys("write"), ["content", "filePath"]);
});

test("live schemas: required arrays match the verbatim CLI shapes", () => {
	assert.deepEqual(requiredOf("bash"), ["command"]);
	assert.deepEqual(requiredOf("edit"), ["filePath", "oldString", "newString"]);
	assert.deepEqual(requiredOf("glob"), ["pattern"]);
	assert.deepEqual(requiredOf("grep"), ["pattern"]);
	assert.deepEqual(requiredOf("read"), ["filePath"]);
	assert.deepEqual(requiredOf("skill"), ["name"]);
	assert.deepEqual(requiredOf("task"), ["description", "prompt", "subagent_type"]);
	assert.deepEqual(requiredOf("todowrite"), ["todos"]);
	assert.deepEqual(requiredOf("webfetch"), ["url"]);
	assert.deepEqual(requiredOf("websearch"), ["query"]);
	assert.deepEqual(requiredOf("write"), ["filePath", "content"]);
});

test("live wire: opencode/ model prefix is stripped to the bare id", () => {
	const chat: Record<string, unknown> = {
		model: "opencode/glm-5.3-flash-free",
		messages: [{ role: "user", content: "hi" }],
		tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
	};
	enforceOpencodeFingerprint(chat, "/v1/chat/completions");
	assert.equal(chat.model, "glm-5.3-flash-free");

	const responses: Record<string, unknown> = {
		model: "opencode/beam-free",
		input: "hi",
		tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
	};
	enforceOpencodeFingerprint(responses, "/v1/responses");
	assert.equal(responses.model, "beam-free");
});

test("live wire: agent turns carry no temperature/reasoning_effort, title turns keep both", () => {
	const agent: Record<string, unknown> = {
		model: "glm-5.3-flash-free",
		messages: [{ role: "user", content: "hi" }],
		temperature: 0.7,
		reasoning_effort: "high",
		tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
	};
	enforceOpencodeFingerprint(agent, "/v1/chat/completions");
	assert.ok(!("temperature" in agent), "agent turn drops temperature");
	assert.ok(!("reasoning_effort" in agent), "agent turn drops reasoning_effort");

	const title: Record<string, unknown> = {
		model: "glm-5.3-flash-free",
		messages: [{ role: "user", content: "hi" }],
		temperature: 0.7,
		reasoning_effort: "high",
	};
	enforceOpencodeFingerprint(title, "/v1/chat/completions");
	assert.equal(title.temperature, 0.7, "title-only turn keeps temperature");
	assert.equal(title.reasoning_effort, "high", "title-only turn keeps reasoning_effort");
});
