import test from "node:test";
import assert from "node:assert/strict";
import {
	enforceOpencodeFingerprint,
	ensureMessagesFingerprintTools,
	convertSseToJson,
	sseToMessagesJson,
} from "../src/opencode-fingerprint.ts";
import {
	ALL_HOST_TOOL_NAMES,
	OMP_HIDDEN_TOOL_NAMES,
	OMP_TOOL_NAMES,
	OPENCODE_FINGERPRINT_TOOLS,
	PI_TOOL_NAMES,
	apiForPathname,
	buildFindGlobRestore,
	canonicalizeTool,
	injectFingerprintTools,
	restoreToolChoiceForCaller,
	restoreToolNameForCaller,
	retargetToolChoiceForUpstream,
	toAnthropicTool,
	toChatTool,
	toResponsesTool,
	translateToolsForPath,
	upstreamToolNameFor,
} from "../src/tool-translation.ts";

const PATHS = ["/v1/chat/completions", "/v1/responses", "/v1/messages"] as const;
test("translateToolsForPath: MCP, custom, and device tools translate like built-ins", () => {
	const mixed = [
		{ type: "function", function: { name: "mcp__github__search_code", description: "mcp", parameters: { type: "object" } } },
		{ type: "function", name: "my_custom_tool", description: "custom", parameters: { type: "object" } },
		{ name: "xdev_tool", description: "xdev", input_schema: { type: "object" } },
	];
	for (const path of PATHS) {
		const out = translateToolsForPath(mixed, path);
		assert.equal(out.length, 3, `${path}: nothing dropped`);
		const names = out.map((t) =>
			typeof t.name === "string" ? t.name : ((t.function as Record<string, unknown>).name as string),
		);
		assert.ok(names.includes("mcp__github__search_code"));
		assert.ok(names.includes("my_custom_tool"));
		assert.ok(names.includes("xdev_tool"));
	}
	const asMessages = translateToolsForPath(mixed, "/v1/messages");
	assert.ok(asMessages.every((t) => "input_schema" in t), "all three land in anthropic shape");
});
test("translateToolsForPath: same-shape tools pass through verbatim, strict survives conversion", () => {
	const strictChat = {
		type: "function",
		function: { name: "mcp__db__query", description: "q", parameters: { type: "object" } },
		strict: true,
	};
	const [verbatim] = translateToolsForPath([strictChat], "/v1/chat/completions");
	assert.equal(verbatim, strictChat, "identical reference, every field intact");

	const [converted] = translateToolsForPath([strictChat], "/v1/messages");
	assert.equal(converted.name, "mcp__db__query");
	assert.ok("input_schema" in converted);
	assert.equal(converted.strict, true, "strict rides along cross-shape");

	const strictResponses = { type: "function", name: "web_tool", description: "w", parameters: { type: "object" }, strict: false };
	const [kept] = translateToolsForPath([strictResponses], "/v1/responses");
	assert.equal(kept, strictResponses);
});

test("inventories: Pi exposes 8 tools, OMP 28 built-ins plus 3 hidden", () => {
	assert.equal(PI_TOOL_NAMES.length, 8);
	assert.equal(OMP_TOOL_NAMES.length, 28);
	assert.equal(OMP_HIDDEN_TOOL_NAMES.length, 3);
	assert.deepEqual([...OPENCODE_FINGERPRINT_TOOLS], ["bash", "glob", "grep", "read", "edit", "write"]);
	for (const shared of ["read", "bash", "edit", "write", "grep"]) {
		assert.ok((PI_TOOL_NAMES as readonly string[]).includes(shared));
		assert.ok((OMP_TOOL_NAMES as readonly string[]).includes(shared));
	}
	// Pi-only file tools: find is renamed to glob upstream (restore map brings
	// it back); ls/powershell pass through verbatim and are never dropped.
	for (const piOnly of ["powershell", "find", "ls"]) {
		assert.ok((PI_TOOL_NAMES as readonly string[]).includes(piOnly));
	}
	// OMP-only tools the proxy must never drop
	for (const ompOnly of ["ast_grep", "lsp", "todo", "task", "web_search", "security_scan", "browser", "computer"]) {
		assert.ok((OMP_TOOL_NAMES as readonly string[]).includes(ompOnly));
		assert.ok(ALL_HOST_TOOL_NAMES.has(ompOnly));
	}
});

test("apiForPathname: routes all three proxy paths", () => {
	assert.equal(apiForPathname("/v1/chat/completions"), "chat");
	assert.equal(apiForPathname("/v1/responses"), "responses");
	assert.equal(apiForPathname("/v1/messages"), "messages");
});

test("canonicalizeTool: reads chat, responses, and anthropic shapes", () => {
	const chat = canonicalizeTool({
		type: "function",
		function: { name: "read", description: "r", parameters: { type: "object" } },
	});
	assert.deepEqual(chat, { name: "read", description: "r", parameters: { type: "object" } });

	const responses = canonicalizeTool({
		type: "function",
		name: "grep",
		description: "g",
		parameters: { type: "object" },
	});
	assert.deepEqual(responses, { name: "grep", description: "g", parameters: { type: "object" } });

	const anthropic = canonicalizeTool({
		name: "edit",
		description: "e",
		input_schema: { type: "object", properties: { path: { type: "string" } } },
	});
	assert.deepEqual(anthropic, {
		name: "edit",
		description: "e",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	});

	// Non-function tools are not canonicalized (caller keeps them verbatim)
	assert.equal(canonicalizeTool({ type: "web_search", name: "ws" }), null);
	assert.equal(canonicalizeTool(null), null);
	assert.equal(canonicalizeTool({}), null);
});

test("converters: same canonical tool emits all three wire shapes", () => {
	const canon = { name: "todo", description: "plan", parameters: { type: "object", properties: {} } };
	assert.deepEqual(toChatTool(canon), {
		type: "function",
		function: { name: "todo", description: "plan", parameters: canon.parameters },
	});
	assert.deepEqual(toResponsesTool(canon), {
		type: "function",
		name: "todo",
		description: "plan",
		parameters: canon.parameters,
	});
	assert.deepEqual(toAnthropicTool(canon), {
		name: "todo",
		description: "plan",
		input_schema: canon.parameters,
	});
});

function sampleTools(style: "chat" | "responses" | "anthropic", names: readonly string[]) {
	return names.map((name) =>
		style === "chat"
			? { type: "function", function: { name, description: `${name} tool`, parameters: { type: "object" } } }
			: style === "responses"
				? { type: "function", name, description: `${name} tool`, parameters: { type: "object" } }
				: { name, description: `${name} tool`, input_schema: { type: "object" } },
	);
}

test("translateToolsForPath: full OMP inventory survives on all three APIs", () => {
	for (const style of ["chat", "responses", "anthropic"] as const) {
		for (const path of PATHS) {
			const out = translateToolsForPath(sampleTools(style, OMP_TOOL_NAMES), path);
			assert.equal(out.length, OMP_TOOL_NAMES.length, `${style} -> ${path}: no tool dropped`);
			const names = out.map((t) =>
				typeof t.name === "string"
					? t.name
					: ((t.function as Record<string, unknown>).name as string),
			);
			for (const name of OMP_TOOL_NAMES) assert.ok(names.includes(name), `${style} -> ${path}: keeps ${name}`);
			// Target shape check
			if (path.endsWith("/messages")) {
				for (const t of out) assert.ok("input_schema" in t, "messages shape uses input_schema");
			} else if (path.endsWith("/responses")) {
				for (const t of out) assert.equal(t.type, "function");
			} else {
				for (const t of out) assert.ok("function" in t, "chat shape wraps in function");
			}
		}
	}
});

test("translateToolsForPath: full Pi inventory survives on all three APIs", () => {
	for (const path of PATHS) {
		const out = translateToolsForPath(sampleTools("anthropic", PI_TOOL_NAMES), path);
		assert.equal(out.length, PI_TOOL_NAMES.length, `pi -> ${path}: no tool dropped`);
	}
});

test("translateToolsForPath: non-function tools pass through verbatim, duplicates collapse", () => {
	const out = translateToolsForPath(
		[
			{ type: "web_search", query: "x" },
			{ type: "function", name: "read", description: "r" },
			{ type: "function", function: { name: "read", description: "dup" } },
		],
		"/v1/messages",
	);
	assert.equal(out.length, 2);
	assert.deepEqual(out[0], { type: "web_search", query: "x" });
	assert.equal(out[1].name, "read");
});

test("injectFingerprintTools: completes the placeholder set in every target shape", () => {
	const chat = injectFingerprintTools([], "/v1/chat/completions");
	assert.equal(chat.length, 6);
	assert.ok(chat.every((t) => "function" in t));
	const responses = injectFingerprintTools([], "/v1/responses");
	assert.equal(responses.length, 6);
	assert.ok(responses.every((t) => t.type === "function" && typeof t.name === "string"));
	const messages = injectFingerprintTools([], "/v1/messages");
	assert.equal(messages.length, 6);
	assert.ok(messages.every((t) => "input_schema" in t && !("function" in t)));
});

test("ensureMessagesFingerprintTools: anthropic shape with input_schema", () => {
	const body: Record<string, unknown> = { tools: [{ name: "todo", description: "t" }] };
	ensureMessagesFingerprintTools(body);
	const tools = body.tools as Array<Record<string, unknown>>;
	assert.equal(tools.length, 7);
	const bash = tools.find((t) => t.name === "bash");
	assert.ok(bash);
	assert.ok((bash.description as string).includes("never be invoked"));
	assert.deepEqual(bash.input_schema, { type: "object", properties: {} });
});

test("enforceOpencodeFingerprint: messages path translates caller tools and injects placeholder set", () => {
	const body: Record<string, unknown> = {
		model: "union-alpha",
		stream: false,
		// OMP host sends chat-shaped tools even for a messages-path model
		tools: [{ type: "function", function: { name: "todo", description: "plan" } }],
	};
	const r = enforceOpencodeFingerprint(body, "/v1/messages");
	assert.equal(r.clientRequestedStream, false);
	assert.equal(r.callerHadTools, true);
	assert.equal(body.stream, true);
	const tools = body.tools as Array<Record<string, unknown>>;
	const names = tools.map((t) => t.name as string);
	assert.ok(names.includes("todo"), "caller tool kept");
	for (const q of ["bash", "glob", "grep", "read", "edit", "write"]) assert.ok(names.includes(q), `placeholder set has ${q}`);
	assert.ok(tools.every((t) => "input_schema" in t), "all tools in anthropic shape");
});
test("enforceOpencodeFingerprint: Pi find renamed to glob, ls kept verbatim on chat path", () => {
	const body: Record<string, unknown> = {
		model: "big-pickle",
		stream: false,
		tools: [
			{ type: "function", function: { name: "find", description: "f", parameters: { type: "object", properties: { pattern: { type: "string" } } } } },
			{ type: "function", function: { name: "ls", description: "l" } },
		],
	};
	enforceOpencodeFingerprint(body, "/v1/chat/completions");
	const tools = body.tools as Array<{ function: { name: string; description: string; parameters?: unknown } }>;
	const names = tools.map((t) => t.function.name);
	assert.ok(!names.includes("find"), "Pi find renamed upstream, never sent as find");
	assert.ok(names.includes("glob"), "renamed find lands as glob");
	assert.ok(names.includes("ls"), "ls kept verbatim");
	const glob = tools.find((t) => t.function.name === "glob")!;
	assert.equal(glob.function.description, "f", "original find description verbatim");
	assert.deepEqual(glob.function.parameters, { type: "object", properties: { pattern: { type: "string" } } });
});

test("sseToMessagesJson: aggregates anthropic content deltas into one message", () => {
	const sse = [
		'event: message_start',
		'data: {"type":"message_start","message":{"id":"msg_1","model":"union-alpha"}}',
		"",
		'event: content_block_start',
		'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
		"",
		'event: content_block_delta',
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}',
		"",
		'event: content_block_delta',
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}',
		"",
		'event: message_delta',
		'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":5,"output_tokens":3}}',
		"",
	].join("\n");
	const msg = sseToMessagesJson(sse, false);
	assert.equal(msg.id, "msg_1");
	assert.equal(msg.type, "message");
	assert.equal(msg.role, "assistant");
	assert.deepEqual(msg.content, [{ type: "text", text: "hello world" }]);
	assert.equal(msg.stop_reason, "end_turn");
});

test("sseToMessagesJson: tool_use blocks survive only when the caller had tools", () => {
	const sse = [
		'event: content_block_start',
		'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash"}}',
		"",
		'event: content_block_delta',
		'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}',
		"",
	].join("\n");
	const withTools = sseToMessagesJson(sse, true);
	assert.deepEqual(withTools.content, [
		{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } },
	]);
	const withoutTools = sseToMessagesJson(sse, false);
	assert.deepEqual(withoutTools.content, [{ type: "text", text: '{"command":"ls"}' }]);
});

test("convertSseToJson: routes /v1/messages to the messages aggregator", () => {
	const sse = [
		'event: message_start',
		'data: {"type":"message_start","message":{"id":"msg_9","model":"m"}}',
		"",
		'event: content_block_delta',
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
		"",
	].join("\n");
	const out = JSON.parse(convertSseToJson(sse, "/v1/messages", false));
	assert.equal(out.type, "message");
	assert.deepEqual(out.content, [{ type: "text", text: "hi" }]);
});

function upstreamNameOf(t: Record<string, unknown>): string {
	if (typeof t.name === "string") return t.name;
	const fn = t.function as Record<string, unknown> | undefined;
	return String((fn as Record<string, unknown>).name);
}
function upstreamParamsOf(t: Record<string, unknown>): unknown {
	const fn = t.function as Record<string, unknown> | undefined;
	if (fn && typeof fn === "object" && "parameters" in fn) return (fn as Record<string, unknown>).parameters;
	if ("parameters" in t) return t.parameters;
	return (t as Record<string, unknown>).input_schema;
}
function upstreamDescOf(t: Record<string, unknown>): unknown {
	const fn = t.function as Record<string, unknown> | undefined;
	if (fn && typeof fn === "object" && "description" in fn) return (fn as Record<string, unknown>).description;
	return t.description;
}
const MATRIX_TOOLS = [
	"ls",
	"powershell",
	"edit",
	"write",
	"read",
	"bash",
	"grep",
	"ask",
	"todo",
	"task",
	"hub",
	"eval",
	"debug",
	"github",
	"lsp",
	"checkpoint",
	"rewind",
	"security_scan",
	"web_search",
	"browser",
	"computer",
	"learn",
	"manage_skill",
	"ast_grep",
	"ast_edit",
] as const;
function matrixTool(style: "chat" | "responses" | "anthropic", name: string): Record<string, unknown> {
	const params = { type: "object", properties: { [name]: { type: "string" } } };
	const description = `${name} desc`;
	if (style === "chat") return { type: "function", function: { name, description, parameters: params }, strict: true, x_extra: `x-${name}` };
	if (style === "responses") return { type: "function", name, description, parameters: params, strict: true, x_extra: `x-${name}` };
	return { name, description, input_schema: params, strict: true, x_extra: `x-${name}` };
}
test("translateToolsForPath: matrix shared + OMP uniques survive verbatim, no additionalProperties", () => {
	for (const style of ["chat", "responses", "anthropic"] as const) {
		for (const path of PATHS) {
			for (const name of MATRIX_TOOLS) {
				const [out] = translateToolsForPath([matrixTool(style, name)], path);
				assert.ok(out, `${style} -> ${path} ${name}: not dropped`);
				assert.equal(upstreamNameOf(out), name, `${style} -> ${path} ${name}: name verbatim`);
				assert.equal(upstreamDescOf(out), `${name} desc`, `${style} -> ${path} ${name}: description verbatim`);
				assert.deepEqual(upstreamParamsOf(out), { type: "object", properties: { [name]: { type: "string" } } }, `${style} -> ${path} ${name}: params verbatim`);
				assert.equal((out as Record<string, unknown>).strict, true, `${style} -> ${path} ${name}: strict verbatim`);
				assert.equal((out as Record<string, unknown>).x_extra, `x-${name}`, `${style} -> ${path} ${name}: extra field carried`);
				assert.ok(!JSON.stringify(upstreamParamsOf(out)).includes("additionalProperties"), `${style} -> ${path} ${name}: never injects additionalProperties`);
			}
		}
	}
});
test("translateToolsForPath: unknown mcp custom xd tools pass verbatim on every shape x path", () => {
	const names = ["mcp__github__search_code", "my_custom_tool", "xd://browser__open", "some_unknown_tool_xyz"];
	for (const style of ["chat", "responses", "anthropic"] as const) {
		for (const path of PATHS) {
			const input = names.map((name) => matrixTool(style, name));
			const out = translateToolsForPath(input, path);
			assert.equal(out.length, names.length, `${style} -> ${path}: nothing dropped`);
			for (const name of names) {
				const found = out.find((t) => upstreamNameOf(t) === name);
				assert.ok(found, `${style} -> ${path}: keeps ${name}`);
				assert.deepEqual(upstreamParamsOf(found!), { type: "object", properties: { [name]: { type: "string" } } });
				assert.ok(!JSON.stringify(upstreamParamsOf(found!)).includes("additionalProperties"));
			}
		}
	}
});
test("translateToolsForPath: Pi find renames to glob on all shapes, OMP glob untouched, restore both ways", () => {
	const findParams = { type: "object", properties: { pattern: { type: "string" } } };
	const styles = ["chat", "responses", "anthropic"] as const;
	const makeFind = (style: (typeof styles)[number]): Record<string, unknown> => {
		if (style === "chat") return { type: "function", function: { name: "find", description: "f", parameters: findParams } };
		if (style === "responses") return { type: "function", name: "find", description: "f", parameters: findParams };
		return { name: "find", description: "f", input_schema: findParams };
	};
	for (const style of styles) {
		for (const path of PATHS) {
			const [out] = translateToolsForPath([makeFind(style)], path);
			assert.equal(upstreamNameOf(out), "glob", `${style} -> ${path}: find becomes glob`);
			assert.equal(upstreamDescOf(out), "f", `${style} -> ${path}: find description verbatim`);
			assert.deepEqual(upstreamParamsOf(out), findParams, `${style} -> ${path}: find params verbatim`);
		}
	}
	for (const style of styles) {
		for (const path of PATHS) {
			const globInput = style === "chat"
				? { type: "function", function: { name: "glob", description: "g", parameters: { type: "object" } } }
				: style === "responses"
					? { type: "function", name: "glob", description: "g", parameters: { type: "object" } }
					: { name: "glob", description: "g", input_schema: { type: "object" } };
			const [out] = translateToolsForPath([globInput], path);
			assert.equal(upstreamNameOf(out), "glob", `${style} -> ${path}: OMP glob untouched`);
		}
	}
	assert.equal(upstreamToolNameFor("find"), "glob");
	assert.equal(upstreamToolNameFor("Find"), "glob");
	assert.equal(upstreamToolNameFor("glob"), "glob");
	const renamed = buildFindGlobRestore([{ type: "function", name: "find", description: "f", parameters: { type: "object" } }]);
	assert.equal(renamed.renamedFindToGlob, true);
	assert.equal(restoreToolNameForCaller("glob", renamed), "find");
	assert.equal(restoreToolNameForCaller("read", renamed), "read");
	const both = buildFindGlobRestore([
		{ type: "function", name: "find", description: "f", parameters: { type: "object" } },
		{ type: "function", name: "glob", description: "g", parameters: { type: "object" } },
	]);
	assert.equal(both.renamedFindToGlob, false, "find+glob together never restores");
	assert.equal(restoreToolNameForCaller("glob", both), "glob");
	const none = buildFindGlobRestore([{ type: "function", name: "read", description: "r", parameters: { type: "object" } }]);
	assert.equal(none.renamedFindToGlob, false);
	assert.deepEqual(retargetToolChoiceForUpstream({ type: "function", name: "find" }, renamed), { type: "function", name: "glob" });
	assert.deepEqual(retargetToolChoiceForUpstream({ type: "function", function: { name: "find" } }, renamed), { type: "function", function: { name: "glob" } });
	assert.equal(retargetToolChoiceForUpstream("auto", renamed), "auto", "tool_choice auto never retargeted");
	assert.deepEqual(restoreToolChoiceForCaller({ type: "function", name: "glob" }, renamed), { type: "function", name: "find" });
	assert.deepEqual(restoreToolChoiceForCaller({ type: "function", name: "glob" }, both), { type: "function", name: "glob" }, "no restore without rename");
});
test("translateToolsForPath: dup collapse case-insensitive, second translate adds zero", () => {
	const dupes = [
		{ type: "function", function: { name: "bash", description: "a", parameters: { type: "object" } } },
		{ type: "function", name: "Bash", description: "b", parameters: { type: "object" } },
		{ name: "BASH", description: "c", input_schema: { type: "object" } },
	];
	for (const path of PATHS) {
		const out = translateToolsForPath(dupes, path);
		assert.equal(out.length, 1, `${path}: Bash collapses to bash`);
		assert.equal(upstreamNameOf(out[0]).toLowerCase(), "bash");
		const again = translateToolsForPath(out, path);
		assert.equal(again.length, 1, `${path}: idempotent, second translate adds zero`);
	}
	const findGlob = [
		{ type: "function", name: "find", description: "f", parameters: { type: "object" } },
		{ type: "function", name: "glob", description: "g", parameters: { type: "object" } },
	];
	const collapsed = translateToolsForPath(findGlob, "/v1/responses");
	assert.equal(collapsed.length, 1, "find collapses with glob upstream");
	assert.equal((collapsed[0] as Record<string, unknown>).name, "glob");
	const reCollapsed = translateToolsForPath(collapsed, "/v1/responses");
	assert.equal(reCollapsed.length, 1, "re-translate adds zero");
});
test("translateToolsForPath: hidden plus full host sets survive every path", () => {
	const hidden = ["yield", "goal", "think"];
	for (const path of PATHS) {
		const out = translateToolsForPath(sampleTools("chat", hidden), path);
		assert.equal(out.length, hidden.length, `${path}: hidden tools never dropped`);
		for (const name of hidden) assert.ok(out.some((t) => upstreamNameOf(t) === name), `${path}: keeps hidden ${name}`);
	}
	for (const path of PATHS) {
		const combined = [...OMP_TOOL_NAMES, ...OMP_HIDDEN_TOOL_NAMES, ...PI_TOOL_NAMES].map((name) => ({ type: "function", name, description: `${name} tool`, parameters: { type: "object" } }));
		const out = translateToolsForPath(combined, path);
		assert.equal(out.length, 33, `${path}: 34 caller names collapse find+glob to 33 upstream`);
		const names = out.map(upstreamNameOf);
		assert.ok(!names.includes("find"), `${path}: find never sent upstream`);
		assert.ok(names.includes("glob"), `${path}: glob present`);
		assert.ok(names.includes("ls") && names.includes("powershell"), `${path}: Pi ls/powershell verbatim`);
		assert.ok(names.includes("browser") && names.includes("computer"), `${path}: OMP browser/computer present`);
	}
});
