import test from "node:test";
import assert from "node:assert/strict";
import {
	enforceOpencodeFingerprint,
	sseToChatCompletionJson,
} from "../src/opencode-fingerprint.ts";
import {
	COMPAT_TOOL_DESCRIPTION,
	FULL11_TOOL_DEFS,
	restoreToolNameForCaller,
} from "../src/tool-translation.ts";

const HASHLINE_DESCRIPTION =
	"Hashline patches existing files; new files: `write`. Each file: `[PATH#TAG]`, `TAG` required 4-hex snapshot from latest `read`/`search`.";
const HASHLINE_PARAMS = {
	type: "object",
	properties: { path: { type: "string" }, input: { type: "string" } },
	required: ["path", "input"],
};

function chatTool(name: string, description: string, parameters: Record<string, unknown>): Record<string, unknown> {
	return { type: "function", function: { name, description, parameters } };
}

function namesOf(body: Record<string, unknown>): string[] {
	const tools = body.tools as Array<Record<string, unknown>>;
	return tools.map((tool) => String((tool.function as Record<string, unknown>).name));
}

function functionOf(body: Record<string, unknown>, name: string): Record<string, unknown> {
	const tools = body.tools as Array<Record<string, unknown>>;
	const tool = tools.find((candidate) => (candidate.function as Record<string, unknown>).name === name);
	assert.ok(tool, `tool ${name} present`);
	return tool.function as Record<string, unknown>;
}

function editBody(): Record<string, unknown> {
	return {
		model: "deepseek-v4.1-flash-free",
		stream: true,
		messages: [{ role: "user", content: "hi" }],
		tools: [chatTool("edit", HASHLINE_DESCRIPTION, HASHLINE_PARAMS)],
	};
}

test("enforce: caller edit is disguised to edit_file and the CLI edit slot is a compat placeholder", () => {
	const body = editBody();
	const res = enforceOpencodeFingerprint(body, "/v1/chat/completions");
	const names = namesOf(body);
	assert.equal(names.filter((name) => name === "edit_file").length, 1, "one real edit");
	assert.equal(names.filter((name) => name === "edit").length, 1, "one gate slot");

	const real = functionOf(body, "edit_file");
	assert.equal(real.description, HASHLINE_DESCRIPTION, "caller edit description stays with the real tool");
	assert.deepEqual(real.parameters, HASHLINE_PARAMS, "caller edit schema stays with the real tool");

	const slot = functionOf(body, "edit");
	assert.equal(slot.description, COMPAT_TOOL_DESCRIPTION, "gate slot must not be called");
	assert.deepEqual(slot.parameters, FULL11_TOOL_DEFS.edit.parameters, "gate slot keeps the verbatim CLI schema");

	assert.ok(res.injected.includes("edit"), "gate slot is cloaked");
	assert.ok(!res.injected.includes("edit_file"), "real edit is never cloaked");
	assert.equal(restoreToolNameForCaller("edit_file", res.findGlob), "edit", "real edit restores to the caller name");
});

test("enforce: a repaired body with the compat edit slot is a fixed point", () => {
	const body = editBody();
	enforceOpencodeFingerprint(body, "/v1/chat/completions");
	const snapshot = JSON.stringify(body);
	const second = enforceOpencodeFingerprint(body, "/v1/chat/completions");
	assert.equal(JSON.stringify(body), snapshot, "second enforce pass changes nothing");
	assert.equal(second.addedTools, false, "second pass injects nothing");
	assert.ok(second.injected.includes("edit"), "the existing compat slot stays cloaked");
	assert.equal(namesOf(body).filter((name) => name === "edit").length, 1, "exactly one gate slot");
});

test("chat cloak drops the compat edit slot and restores edit_file to edit", () => {
	const body = editBody();
	const res = enforceOpencodeFingerprint(body, "/v1/chat/completions");
	const sse = [
		'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_slot","type":"function","function":{"name":"edit","arguments":"{\\"filePath\\":\\"/tmp/x\\",\\"oldString\\":\\"a\\",\\"newString\\":\\"b\\"}"}}]}}]}',
		'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_real","type":"function","function":{"name":"edit_file","arguments":"{\\"input\\":\\"[x#ABCD]\\\\nPUT 1.=1:\\\\n+b\\"}"}}]}}]}',
		'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
		"data: [DONE]",
	].join("\n\n");
	const out = sseToChatCompletionJson(sse, true, undefined, res.findGlob, res.injected, res.argSchemas) as {
		choices: Array<{ message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
	};
	const calls = out.choices[0].message.tool_calls;
	assert.deepEqual(calls.map((call) => call.id), ["call_real"], "compat slot dropped");
	assert.equal(calls[0].function.name, "edit", "real call restored to caller name");
	assert.deepEqual(JSON.parse(calls[0].function.arguments), { input: "[x#ABCD]\nPUT 1.=1:\n+b" });
});
