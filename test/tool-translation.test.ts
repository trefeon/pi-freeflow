import test from "node:test";
import assert from "node:assert/strict";
import {
	convertSseToJson,
	enforceOpencodeFingerprint,
	ensureMessagesFingerprintTools,
	sseToChatCompletionJson,
	sseToMessagesJson,
	sseToResponsesJson,
	toolNameOf,
} from "../src/opencode-fingerprint.ts";
import {
	ALL_HOST_TOOL_NAMES,
	COMPAT_TOOL_DESCRIPTION,
	OMP_CUSTOM_TOOL_NAMES,
	OMP_HIDDEN_TOOL_NAMES,
	OMP_TOOL_NAMES,
	OPENCODE_FINGERPRINT_TOOLS,
	PI_TOOL_NAMES,
	apiForPathname,
	buildFindGlobRestore,
	canonicalizeTool,
	clineChatBodyFromResponsesBody,
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
	assert.deepEqual([...OMP_CUSTOM_TOOL_NAMES], ["generate_image", "tts"]);
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
	// Settings-gated custom tools: not built-ins, but model-callable when enabled
	for (const custom of [...OMP_CUSTOM_TOOL_NAMES]) {
		assert.ok(!(OMP_TOOL_NAMES as readonly string[]).includes(custom), `${custom} is not a built-in`);
		assert.ok(ALL_HOST_TOOL_NAMES.has(custom), `${custom} rides the host inventory`);
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

test("ensureMessagesFingerprintTools: OMP caller gets real defs, Pi caller keeps placeholders", () => {
	const ompBody: Record<string, unknown> = { tools: [{ name: "todo", description: "t" }] };
	ensureMessagesFingerprintTools(ompBody);
	const ompTools = ompBody.tools as Array<Record<string, unknown>>;
	assert.equal(ompTools.length, 7);
	const bash = ompTools.find((t) => t.name === "bash");
	assert.ok(bash);
	assert.ok(!(bash.description as string).includes("never be invoked"), "OMP bash is executable, not a placeholder");
	const schema = bash.input_schema as { type?: unknown; properties?: Record<string, unknown> };
	assert.equal(schema.type, "object");
	assert.ok(Object.keys(schema.properties ?? {}).length > 0, "OMP bash carries a real params schema");
	const piBody: Record<string, unknown> = { tools: [{ name: "find", description: "f" }] };
	ensureMessagesFingerprintTools(piBody, false);
	const piTools = piBody.tools as Array<Record<string, unknown>>;
	const piBash = piTools.find((t) => t.name === "bash");
	assert.ok(piBash);
	assert.ok((piBash.description as string).includes("never be invoked"), "Pi keeps the empty placeholder");
	assert.deepEqual(piBash.input_schema, { type: "object", properties: {} });
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
	"generate_image",
	"tts",
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
		const combined = [...OMP_TOOL_NAMES, ...OMP_HIDDEN_TOOL_NAMES, ...OMP_CUSTOM_TOOL_NAMES, ...PI_TOOL_NAMES].map((name) => ({ type: "function", name, description: `${name} tool`, parameters: { type: "object" } }));
		const out = translateToolsForPath(combined, path);
		assert.equal(out.length, 35, `${path}: 41 caller names collapse shared dupes plus find+glob to 35 upstream`);
		const names = out.map(upstreamNameOf);
		assert.ok(!names.includes("find"), `${path}: find never sent upstream`);
		assert.ok(names.includes("glob"), `${path}: glob present`);
		assert.ok(names.includes("ls") && names.includes("powershell"), `${path}: Pi ls/powershell verbatim`);
		assert.ok(names.includes("browser") && names.includes("computer"), `${path}: OMP browser/computer present`);
		assert.ok(names.includes("generate_image") && names.includes("tts"), `${path}: OMP custom tools survive`);
	}
});

/**
 * Full-inventory round-trip contract (E2eMatrixTests): every caller-declared
 * schema rides upstream VERBATIM on all three wire paths — params,
 * description, required, strict, and extra top-level fields — the fingerprint
 * sextet appears exactly once, and downstream restore maps glob->find plus
 * caller casing. Fails without PassthroughFix if translation rewrites schemas
 * or duplicates/drops fingerprint slots.
 */
function richCallerTool(name: string, host: string): Record<string, unknown> {
	return {
		type: "function",
		function: {
			name,
			description: `${name} host tool`,
			parameters: {
				type: "object",
				properties: {
					input: { type: "string", description: `${name} primary input` },
					opts: { type: "object", properties: { verbose: { type: "boolean" } } },
				},
				required: ["input"],
			},
		},
		strict: true,
		"x-host": host,
	};
}

function upstreamSchemaOf(t: Record<string, unknown>): Record<string, unknown> {
	const fn = t.function as Record<string, unknown> | undefined;
	const cand = fn?.parameters ?? (t as Record<string, unknown>).parameters ?? (t as Record<string, unknown>).input_schema;
	return cand as Record<string, unknown>;
}

test("contract: full Pi inventory round-trips verbatim on all three paths", () => {
	for (const path of PATHS) {
		const caller = PI_TOOL_NAMES.map((n) => richCallerTool(n, "pi"));
		const snapshot = JSON.parse(JSON.stringify(caller)) as Array<Record<string, unknown>>;
		const translated = translateToolsForPath(caller, path);
		const withFp = injectFingerprintTools([...translated], path);
		const names = withFp.map((t) => upstreamNameOf(t).toLowerCase());
		assert.equal(names.length, new Set(names).size, `${path}: no duplicate upstream names`);
		for (const fp of OPENCODE_FINGERPRINT_TOOLS) {
			assert.equal(names.filter((n) => n === fp).length, 1, `${path}: fingerprint ${fp} exactly once`);
		}
		assert.ok(!names.includes("find"), `${path}: caller find never sent upstream as find`);
		for (const orig of snapshot) {
			const fn = orig.function as Record<string, unknown>;
			const cname = String(fn.name);
			const uname = cname.toLowerCase() === "find" ? "glob" : cname;
			const hit = withFp.find((t) => upstreamNameOf(t).toLowerCase() === uname.toLowerCase());
			assert.ok(hit, `${path}: keeps caller tool ${cname}`);
			assert.equal(upstreamDescOf(hit!), `${cname} host tool`, `${path}: ${cname} description verbatim`);
			assert.deepEqual(upstreamSchemaOf(hit!), (fn.parameters as Record<string, unknown>), `${path}: ${cname} params verbatim`);
			assert.equal((hit as Record<string, unknown>).strict, true, `${path}: ${cname} strict verbatim`);
			assert.equal((hit as Record<string, unknown>)["x-host"], "pi", `${path}: ${cname} extra field verbatim`);
		}
		const restore = buildFindGlobRestore(caller);
		assert.equal(restore.renamedFindToGlob, true, `${path}: Pi find->glob rename recorded`);
		assert.equal(restoreToolNameForCaller("glob", restore), "find", `${path}: upstream glob restores to caller find`);
		assert.equal(restoreToolNameForCaller("read", restore), "read", `${path}: untouched names restore verbatim`);
	}
});

test("contract: full OMP inventory round-trips verbatim, zero injected", () => {
	const all = [...OMP_TOOL_NAMES, ...OMP_HIDDEN_TOOL_NAMES, ...OMP_CUSTOM_TOOL_NAMES];
	for (const path of PATHS) {
		const caller = all.map((n) => richCallerTool(n, "omp"));
		const translated = translateToolsForPath(caller, path);
		assert.equal(translated.length, all.length, `${path}: OMP covers every fingerprint slot, nothing added or dropped`);
		const names = translated.map((t) => upstreamNameOf(t).toLowerCase());
		for (const fp of OPENCODE_FINGERPRINT_TOOLS) {
			assert.equal(names.filter((n) => n === fp).length, 1, `${path}: fingerprint ${fp} exactly once`);
		}
		for (const tool of translated) {
			const uname = upstreamNameOf(tool);
			const orig = caller.find((c) => String((c.function as Record<string, unknown>).name).toLowerCase() === uname.toLowerCase());
			assert.ok(orig, `${path}: upstream ${uname} maps to a caller tool`);
			assert.equal(upstreamDescOf(tool), `${(orig!.function as Record<string, unknown>).name} host tool`, `${path}: ${uname} description verbatim`);
			assert.deepEqual(upstreamSchemaOf(tool), ((orig!.function as Record<string, unknown>).parameters as Record<string, unknown>), `${path}: ${uname} params verbatim`);
			assert.equal((tool as Record<string, unknown>)["x-host"], "omp", `${path}: ${uname} extra field verbatim`);
		}
		const again = injectFingerprintTools([...translated], path);
		assert.equal(again.length, translated.length, `${path}: re-inject adds zero when caller owns every slot`);
	}
});

test("contract: OMP-like injected glob uses the host path-optional schema", () => {
	// Catches PassthroughFix bug #1: the old injected glob demanded
	// {pattern: required}, but the real OMP GlobTool carries its pattern in an
	// OPTIONAL `path` field ({path?, hidden?, gitignore?, limit?}). A model
	// handed the old def emits pattern-shaped calls the host cannot execute.
	for (const path of PATHS) {
		const caller = [richCallerTool("ask", "omp"), richCallerTool("todo", "omp")];
		const withFp = injectFingerprintTools(translateToolsForPath(caller, path), path);
		const glob = withFp.find((t) => upstreamNameOf(t).toLowerCase() === "glob");
		assert.ok(glob, `${path}: missing glob is injected for OMP-like callers`);
		const schema = upstreamSchemaOf(glob!) as { properties?: Record<string, unknown>; required?: unknown };
		assert.ok(schema.properties && typeof schema.properties === "object", `${path}: injected glob has executable properties`);
		assert.ok("path" in (schema.properties as Record<string, unknown>), `${path}: injected glob accepts the host path field`);
		const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
		assert.ok(!required.includes("pattern"), `${path}: injected glob must not demand pattern`);
	}
});

test("contract: injected edit never ships the unexecutable path+edit shape", () => {
	// Catches PassthroughFix bug #2: the old injected edit used
	// {path, edit: string}, which matches NO host (OMP default is hashline
	// {input}, Pi wants an edits[] array) yet rode the cloak-exempt path, so
	// models could invoke a def the host rejects. Fixed behavior: a cloaked
	// COMPAT placeholder, or the real OMP hashline {input} def.
	for (const path of PATHS) {
		const caller = [richCallerTool("ask", "omp"), richCallerTool("todo", "omp")];
		const withFp = injectFingerprintTools(translateToolsForPath(caller, path), path);
		const edit = withFp.find((t) => upstreamNameOf(t).toLowerCase() === "edit");
		assert.ok(edit, `${path}: missing edit is injected for OMP-like callers`);
		const schema = upstreamSchemaOf(edit!) as { properties?: Record<string, unknown> };
		const props = (schema.properties ?? {}) as Record<string, unknown>;
		const desc = String(upstreamDescOf(edit!));
		const isCompat = desc === COMPAT_TOOL_DESCRIPTION;
		const isHashline = "input" in props;
		const isOldBroken = "edit" in props && !("input" in props) && !isCompat;
		assert.ok(!isOldBroken, `${path}: injected edit must not use the {path, edit} shape`);
		assert.ok(isCompat || isHashline, `${path}: injected edit is a cloaked placeholder or the host hashline def`);
	}
});

test("contract: aggregate cloak strips injected-only, restores caller names, keeps ids/args", () => {
	// Regression guard for CloakStreamFix: only names in this request's
	// injected[] list are stripped; caller-owned same-name calls survive with
	// casing + glob->find restored, ids and argument payloads value-identical.
	// `injected` holds only truly-missing slots: caller-owned bash/read/glob are
	// absent so they survive; caller-less grep is present so it strips. This is
	// the observable proof of the injected-only rule: same-name caller calls are
	// indistinguishable by name and must survive.
	const injected = ["grep", "edit", "write"];
	const caseRestore = { bash: "Bash" };
	const findGlob = { renamedFindToGlob: true };
	const chatFrame = (delta: unknown, finish?: string): string =>
		`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}`;
	const chatSse = [
		chatFrame({
			tool_calls: [
				{ index: 0, id: "call_bash_9", type: "function", function: { name: "bash", arguments: '{"command":"ls é"}' } },
				{ index: 1, id: "call_grep_9", type: "function", function: { name: "grep", arguments: '{"pattern":"x"}' } },
				{ index: 2, id: "call_glob_9", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } },
			]
		}),
		chatFrame({}, "tool_calls"),
		"data: [DONE]",
	].join("\n\n");
	const chat = sseToChatCompletionJson(chatSse, true, caseRestore, findGlob, injected) as {
		choices: Array<{ message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
	};
	const chatCalls = chat.choices[0].message.tool_calls ?? [];
	assert.deepEqual(chatCalls.map((c) => c.function.name), ["Bash", "find"], "caller Bash keeps casing, upstream glob restores to find, injected grep stripped");
	assert.equal(chatCalls[0].id, "call_bash_9", "caller call id preserved");
	assert.equal(chatCalls[0].function.arguments, '{"command":"ls é"}', "caller args value-preserved through restore");
	assert.ok(!JSON.stringify(chat).includes("call_grep_9"), "stripped call id never leaks");

	const respSse = [
		'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_9","object":"response","status":"completed","output":[{"type":"function_call","id":"fc_read_9","name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"},{"type":"function_call","id":"fc_grep_9","name":"grep","arguments":"{\\"pattern\\":\\"x\\"}"},{"type":"function_call","id":"fc_glob_9","name":"glob","arguments":"{\\"pattern\\":\\"*.ts\\"}"}]}}',
	].join("\n\n");
	const resp = sseToResponsesJson(respSse, true, caseRestore, findGlob, injected) as {
		output: Array<{ type: string; id?: string; name?: string; arguments?: string }>;
	};
	const calls = resp.output.filter((o) => o.type === "function_call");
	assert.deepEqual(calls.map((c) => c.name).sort(), ["find", "read"], "responses keeps caller calls only, injected grep stripped");
	assert.ok(calls.some((c) => c.name === "find" && c.id === "fc_glob_9" && c.arguments === '{"pattern":"*.ts"}'), "glob restores to find with id/args intact");
	assert.ok(calls.some((c) => c.name === "read" && c.id === "fc_read_9"), "caller read survives with id intact");
	assert.ok(!calls.some((c) => c.name === "grep"), "injected grep stripped");

	const msgSse = [
		'data: {"type":"message_start","message":{"id":"msg_9","model":"m"}}',
		'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_bash_9","name":"bash"}}',
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}',
		'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_grep_9","name":"grep"}}',
		'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\":\\"x\\"}"}}',
		'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
	].join("\n\n");
	const msg = sseToMessagesJson(msgSse, true, caseRestore, findGlob, injected) as {
		content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
	};
	const uses = msg.content.filter((b) => b.type === "tool_use");
	assert.equal(uses.length, 1, "messages strips the injected grep block");
	assert.equal(uses[0].name, "Bash", "messages restores caller casing");
	assert.equal(uses[0].id, "tu_bash_9", "messages preserves the block id");
	assert.deepEqual(uses[0].input, { cmd: "ls" }, "messages aggregates input deltas");
});

test("contract: cline body translation reshapes tools with zero fingerprint", () => {
	// Kilo/Cline paths bypass the fingerprint entirely: tools are only
	// reshaped to chat, never injected, and the stream policy is untouched.
	const caller = [richCallerTool("ask", "omp"), richCallerTool("find", "pi")];
	const out = clineChatBodyFromResponsesBody({
		model: "cline-free/deepseek-v4.1-flash",
		input: [{ role: "user", content: "hi" }],
		tools: JSON.parse(JSON.stringify(caller)),
		tool_choice: "auto",
		stream: false,
	});
	assert.ok(Array.isArray(out.tools), "cline tools ride along");
	assert.equal((out.tools as unknown[]).length, 2, "cline adds zero fingerprint tools");
	assert.ok(!("stream" in out), "cline translation never imposes a stream policy");
	assert.equal(out.tool_choice, "auto", "cline carries tool_choice verbatim");
});
test("contract: OMP gated custom tools are caller tools end-to-end, never cloaked", () => {
	// Row 3: generate_image + tts ride as ordinary caller tools. OMP-like caller
	// (todo marker + glob-without-find) on the responses path: the pair must
	// survive enforce unrenamed, land in neither injected list, and model calls
	// to them must survive the downstream cloak like any caller call.
	const imgParams = { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] };
	const ttsParams = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
	const imgArgs = '{"subject":"a red boat"}';
	const ttsArgs = '{"text":"hello there"}';
	const body: Record<string, unknown> = {
		model: "zen-reasoner-free",
		stream: false,
		tools: [
			{ type: "function", function: { name: "todo", description: "plan" } },
			{ type: "function", function: { name: "glob", description: "g" } },
			{ type: "function", function: { name: "generate_image", description: "Generate or edit an image", parameters: imgParams }, strict: false },
			{ type: "function", function: { name: "tts", description: "Synthesize speech", parameters: ttsParams }, strict: false },
		],
	};
	const r = enforceOpencodeFingerprint(body, "/v1/responses");
	assert.equal(r.callerHadTools, true);
	assert.deepEqual(r.injected, ["edit"], "only the truly-missing edit cloaks; customs never do");
	assert.deepEqual(r.injectedReal, ["bash", "grep", "read", "write"], "customs never placeholder-injected either");
	const tools = body.tools as Array<Record<string, unknown>>;
	assert.equal(tools.length, 9, "4 caller + 5 missing fingerprint tools, zero dropped");
	for (const n of ["generate_image", "tts"]) {
		const found = tools.find((t) => toolNameOf(t) === n);
		assert.ok(found, `${n} survives enforce unrenamed`);
		assert.equal(found?.strict, false, `${n} strict:false verbatim through enforce`);
		assert.equal(found?.type, "function", `${n} lands in responses shape`);
	}
	// Downstream: upstream answers with calls to both customs plus an injected
	// placeholder (edit, must strip) and an injected-real (bash, executable,
	// must survive like any caller call).
	const output = [
		{ type: "function_call", id: "fc_img_1", call_id: "call_img_1", name: "generate_image", arguments: imgArgs },
		{ type: "function_call", id: "fc_tts_1", call_id: "call_tts_1", name: "tts", arguments: ttsArgs },
		{ type: "function_call", id: "fc_bash_1", call_id: "call_bash_1", name: "bash", arguments: '{"command":"ls"}' },
		{ type: "function_call", id: "fc_edit_1", call_id: "call_edit_1", name: "edit", arguments: '{"edits":[]}' },
	];
	const respSse = [
		"event: response.completed",
		`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_c", object: "response", status: "completed", output } })}`,
	].join("\n");
	const resp = sseToResponsesJson(respSse, r.callerHadTools, r.caseRestore, r.findGlob, r.injected) as {
		output: Array<{ type: string; id?: string; call_id?: string; name?: string; arguments?: string }>;
	};
	const calls = resp.output.filter((o) => o.type === "function_call");
	assert.deepEqual(calls.map((c) => c.name).sort(), ["bash", "generate_image", "tts"], "custom + injected-real calls persist, injected edit stripped");
	assert.ok(calls.some((c) => c.name === "generate_image" && c.id === "fc_img_1" && c.call_id === "call_img_1" && c.arguments === imgArgs), "generate_image id/args verbatim");
	assert.ok(calls.some((c) => c.name === "tts" && c.id === "fc_tts_1" && c.arguments === ttsArgs), "tts id/args verbatim");
	assert.ok(!calls.some((c) => c.name === "edit"), "injected edit stripped");
	// Same stream through the universal router.
	const back = JSON.parse(convertSseToJson(respSse, "/v1/responses", r.callerHadTools, r.caseRestore, r.findGlob, r.injected)) as {
		output: Array<{ type: string; name?: string }>;
	};
	assert.deepEqual(back.output.filter((o) => o.type === "function_call").map((c) => c.name).sort(), ["bash", "generate_image", "tts"], "convertSseToJson routes responses identically");
	// Chat-path mirror: a tool_calls entry for generate_image survives, edit strips.
	const chatSse = [
		`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { tool_calls: [
			{ index: 0, id: "call_img_c", type: "function", function: { name: "generate_image", arguments: imgArgs } },
			{ index: 1, id: "call_edit_c", type: "function", function: { name: "edit", arguments: '{"edits":[]}' } },
		] } }] })}`,
		`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}`,
		"data: [DONE]",
	].join("\n\n");
	const chat = JSON.parse(convertSseToJson(chatSse, "/v1/chat/completions", r.callerHadTools, r.caseRestore, r.findGlob, r.injected)) as {
		choices: Array<{ message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>; 
	};
	const chatCalls = chat.choices[0].message.tool_calls ?? [];
	assert.deepEqual(chatCalls.map((c) => c.function.name), ["generate_image"], "chat cloak keeps the custom call, strips injected edit");
	assert.equal(chatCalls[0].id, "call_img_c", "chat custom call id preserved");
	assert.equal(chatCalls[0].function.arguments, imgArgs, "chat custom args verbatim");
});

test("contract: prompt_cache_key rides the Zen responses path untouched, never a compat flag", () => {
	// Verdict (research row 20): DO NOT emit supportsPromptCacheKey.
	// - Pi host (reference/pi packages/ai openai-completions.ts) keys chat-path
	//   prompt_cache_key off baseUrl api.openai.com / supportsLongCacheRetention,
	//   never off supportsPromptCacheKey: the symbol means nothing to Pi.
	// - OMP host sends it on responses UNGATED (openai-responses.ts always sets
	//   prompt_cache_key from the session) so no flag is needed where the key is
	//   load-bearing: caller-bound blob memory, relay affinity, gate failover.
	// - Emitting the flag WOULD change OMP chat-path wire behavior (a new field
	//   forwarded verbatim upstream) with no live proof Zen/Kilo chat tolerates
	//   it; the chat-path consumer (sessionKeyOf) already falls back to a
	//   content hash. Status quo plus this passthrough lock is the safe contract.
	// The sole strip (Cline reshape, proxy.ts) is correct and out of scope here:
	// Cline has no blob memory, so the key must not ride a translated chat body.
	const key = "sess_conv_abc123";
	const body: Record<string, unknown> = {
		model: "zen-reasoner-free",
		stream: false,
		prompt_cache_key: key,
		input: [{ role: "user", content: "hi" }],
		tools: [{ type: "function", function: { name: "todo", description: "plan" } }],
	};
	const r = enforceOpencodeFingerprint(body, "/v1/responses");
	assert.equal(body.prompt_cache_key, key, "responses enforce never strips the conversation key");
	assert.equal(body.stream, true, "fingerprint stream force still applies alongside the key");
	assert.equal(r.callerHadTools, true);
	// Chat-path enforce (non-Cline Zen) carries it too: no normalization drops it.
	const chatBody: Record<string, unknown> = {
		model: "zen-reasoner-free",
		prompt_cache_key: key,
		messages: [{ role: "user", content: "hi" }],
		tools: [{ type: "function", function: { name: "todo", description: "plan" } }],
	};
	enforceOpencodeFingerprint(chatBody, "/v1/chat/completions");
	assert.equal(chatBody.prompt_cache_key, key, "chat enforce never strips the conversation key");
});
