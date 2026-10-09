/**
 * Schema-driven repair of malformed tool-call arguments, proven end to end.
 *
 * Live probe 2026-10-08 (scripts/live-tool-args.ts, OpenCode Zen, real OMP
 * `todo` schema): at one tool the model emits canonical arguments, but at ~70
 * tools the same model delivered structured phases JSON-encoded into the flat
 * string list, with each inner array wrapped as `items: { item: [...] }`. The
 * OMP todo widget then rendered every phase as a raw JSON string under the
 * default "Tasks" phase — exactly `Tasks · 0/2` with JSON children.
 *
 * These tests pin both directions: the repairable malformations come out
 * schema-valid, and everything else (invented vocabulary, truncation, other
 * tools, requests with no structured schema) rides through byte-identical.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildArgRepairSchemas,
	repairToolArguments,
	repairToolArgumentsValue,
} from "../src/tool-args.ts";
import {
	convertSseToJson,
	enforceOpencodeFingerprint,
} from "../src/opencode-fingerprint.ts";
import {
	createSseStreamCloakState,
	rewriteSseBlock,
	type StreamCloakOptions,
} from "../src/stream-pipe.ts";

const OP_ENUM = ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"];

/** Real OMP todo parameters, inlined (mirrors the full-schema translation test). */
function todoParameters(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			op: { type: "string", enum: OP_ENUM },
			list: {
				type: "array",
				items: {
					type: "object",
					properties: {
						phase: { type: "string" },
						items: { type: "array", items: { type: "string" }, minItems: 1 },
					},
					required: ["phase", "items"],
				},
			},
			task: { type: "string" },
			phase: { type: "string" },
			items: { type: "array", items: { type: "string" } },
			reason: { type: "string" },
		},
		required: ["op"],
	};
}

function todoTool(): Record<string, unknown> {
	return { type: "function", name: "todo", description: "apply a single todo operation", parameters: todoParameters() };
}

const schemas = buildArgRepairSchemas([todoTool()]);

/** The reported failure: phases JSON-encoded into the flat string list. */
const REPORTED = JSON.stringify({
	op: "init",
	items: [
		'{"phase":"Research","items":{"item":["Map repo structure and entrypoints","Trace auth and login flow"]}}',
		'{"phase":"Synthesis","items":{"item":["Write how-it-works explanation"]}}',
	],
});

const CANONICAL = '{"op":"init","list":[{"phase":"Research","items":["Map repo structure"]}]}';

test("reported malformation: JSON-encoded phases promote into the declared list", () => {
	const out = repairToolArguments("todo", REPORTED, schemas);
	assert.notEqual(out, REPORTED, "the reported payload must change");
	assert.deepEqual(JSON.parse(out), {
		op: "init",
		list: [
			{ phase: "Research", items: ["Map repo structure and entrypoints", "Trace auth and login flow"] },
			{ phase: "Synthesis", items: ["Write how-it-works explanation"] },
		],
	});
	// The widget failure was "every phase rendered as one raw JSON label", so the
	// repair must produce real task strings, never a re-encoded envelope.
	const parsed = JSON.parse(out) as { list: Array<{ items: string[] }> };
	for (const phase of parsed.list) {
		for (const task of phase.items) assert.equal(typeof task, "string");
	}
});

test("inner array envelope unwraps: items: { item: [...] } becomes a real array", () => {
	const out = repairToolArguments(
		"todo",
		'{"op":"init","items":["{\\"phase\\":\\"R\\",\\"items\\":{\\"item\\":[\\"a\\",\\"b\\"]}}"]}',
		schemas,
	);
	assert.deepEqual(JSON.parse(out), { op: "init", list: [{ phase: "R", items: ["a", "b"] }] });
});

test("canonical arguments are returned byte-identical", () => {
	assert.equal(repairToolArguments("todo", CANONICAL, schemas), CANONICAL);
});

test("a declared string property holding JSON text is never decoded", () => {
	// `task` is declared string: JSON-looking task content must survive as text.
	const args = '{"op":"start","task":"{\\"phase\\":\\"R\\"}"}';
	assert.equal(repairToolArguments("todo", args, schemas), args);
});

test("flat single-phase init (a legitimate OMP shape) is left alone", () => {
	const args = '{"op":"init","items":["Map repo","Run tests"]}';
	assert.equal(repairToolArguments("todo", args, schemas), args);
});

test("mixed labels never promote: one plain string blocks the whole move", () => {
	// Promoting only the JSON-looking member would corrupt the real label, so
	// the packet must ride through untouched.
	const args = '{"op":"init","items":["plain label","{\\"phase\\":\\"R\\",\\"items\\":[\\"a\\"]}"]}';
	assert.equal(repairToolArguments("todo", args, schemas), args);
});

test("invented vocabulary is mapped by structural role, not by name", () => {
	// Live 2026-10-08: space-bunny-free emitted {phases:[{name,tasks}]}, and
	// longcat/mimo emitted {todos:[{phase,tasks}]} / {phases:"[{...}]"} for the
	// declared {list:[{phase,items}]}. Every unknown key has exactly one
	// structurally compatible missing property, so the move is forced.
	assert.deepEqual(
		JSON.parse(repairToolArguments("todo", '{"op":"init","phases":[{"name":"R","tasks":["a"]}]}', schemas)),
		{ op: "init", list: [{ phase: "R", items: ["a"] }] },
	);
	assert.deepEqual(
		JSON.parse(repairToolArguments("todo", '{"op":"init","todos":[{"phase":"R","tasks":["a"]}]}', schemas)),
		{ op: "init", list: [{ phase: "R", items: ["a"] }] },
	);
	assert.deepEqual(
		JSON.parse(repairToolArguments("todo", '{"op":"init","phases":"[{\\"phase\\":\\"R\\",\\"tasks\\":[\\"a\\"]}]"}', schemas)),
		{ op: "init", list: [{ phase: "R", items: ["a"] }] },
	);
});

test("a wrapper object around the invented array is not unwrapped blindly", () => {
	// `plan` decodes to an object, not the array the target slot needs, and
	// nothing forces which declared property it should become.
	for (const args of [
		'{"op":"init","plan":{"phases":[]}}',
		'{"op":"init","plan":"{\\"phases\\":[]}"}',
	]) {
		assert.equal(repairToolArguments("todo", args, schemas), args);
	}
});

test("an ambiguous role mapping is refused rather than guessed", () => {
	// Two missing string properties and one invented string key: no forced
	// mapping exists, so the call must ride through untouched.
	const twoSlots = buildArgRepairSchemas([
		{
			type: "function",
			name: "two_slots",
			description: "d",
			parameters: {
				type: "object",
				properties: {
					op: { type: "string" },
					list: {
						type: "array",
						items: { type: "object", properties: { alpha: { type: "string" }, beta: { type: "string" } }, required: ["alpha"] },
					},
				},
			},
		},
	]);
	const args = '{"op":"init","phases":[{"gamma":"x"}]}';
	assert.equal(repairToolArguments("two_slots", args, twoSlots), args);
});

test("an unplaceable invented key blocks the whole promotion", () => {
	// `extra` matches no declared property, so promoting would smuggle the
	// model's invention into the host: the packet must ride through as-is.
	const args = '{"op":"init","phases":[{"phase":"R","items":["a"],"extra":1}]}';
	assert.equal(repairToolArguments("todo", args, schemas), args);
});

test("truncated arguments are never completed", () => {
	const truncated = '{"op":"init","list":[{"phase":"R","items":["a"';
	assert.equal(repairToolArguments("todo", truncated, schemas), truncated);
});

test("a leading fragment of the previous call is stripped", () => {
	// Live 2026-10-09 on space-bunny-free: the model opened its next call by
	// echoing the tail of the one it had just seen, so a single tool call
	// arrived as `<tail of previous>{"…this call…"}`. Keying stream fragments
	// by call id cannot separate these - there is only one call - so the host
	// refused the payload with "Unexpected token at position 0".
	const call = '{"op":"done","task":"Fetch mlbb.io ranked stats"}';
	for (const junk of [
		',"timeout":400}',
		'}]}',
		'}{',
		'{"op":"view","task":"previous call"}},',
		' ranks for both heroes"}',
	]) {
		const corrupted = junk + call;
		const out = repairToolArguments("todo", corrupted, schemas);
		assert.deepEqual(
			JSON.parse(out),
			{ op: "done", task: "Fetch mlbb.io ranked stats" },
			`prefix ${JSON.stringify(junk)} must be dropped`,
		);
	}
});

test("the salvage never fabricates a call that was never made", () => {
	// A prefix with no complete object behind it, and a truncation that happens
	// to contain a brace, both stay unparseable rather than becoming a call.
	for (const corrupted of [
		',"timeout":400}',
		'{"op":"init","list":[{"phase":"R","items":["a"',
		'prefix {"partial": ',
		'{"op":"init"',
	]) {
		assert.equal(repairToolArguments("todo", corrupted, schemas), corrupted);
	}
});

test("a salvaged payload is not otherwise reshaped", () => {
	// The caller's own object sits behind the junk; the repair must hand back
	// exactly that, not also run shape repair over it.
	const call = '{"op":"done","task":"keep me"}';
	assert.equal(repairToolArguments("todo", 'junk' + call, schemas), call);
});

test("well-formed arguments never enter the salvage path", () => {
	// A brace inside a declared string value must stay put: only payloads that
	// already fail to parse are rescanned.
	const args = '{"op":"start","task":"use { and } literally"}';
	assert.equal(repairToolArguments("todo", args, schemas), args);
});

test("an absent required property is not invented", () => {
	// OMP repairs a bare init itself; the proxy must not fabricate a list.
	const bare = '{"op":"init"}';
	assert.equal(repairToolArguments("todo", bare, schemas), bare);
});

test("unknown tools and requests without schemas are untouched", () => {
	assert.equal(repairToolArguments("bash", REPORTED, schemas), REPORTED);
	assert.equal(repairToolArguments("todo", REPORTED, undefined), REPORTED);
	assert.equal(repairToolArguments("todo", REPORTED, new Map()), REPORTED);
});

test("tool lookup is case-insensitive", () => {
	assert.notEqual(repairToolArguments("TODO", REPORTED, schemas), REPORTED);
});

test("tools without structured parameters are absent from the map", () => {
	// `read` takes one string: there is nothing to repair, so requests that
	// declare only such tools keep streaming byte-identically.
	const scalarOnly = buildArgRepairSchemas([
		{ type: "function", name: "read", description: "d", parameters: { type: "object", properties: { path: { type: "string" } } } },
	]);
	assert.equal(scalarOnly.size, 0);
	assert.equal(buildArgRepairSchemas([todoTool()]).size, 1);
});

test("value-level repair keeps reference identity when nothing changes", () => {
	const input = { op: "init", list: [{ phase: "R", items: ["a"] }] };
	assert.equal(repairToolArgumentsValue("todo", input, schemas), input);
});

test("value-level repair handles the Anthropic parsed-input shape", () => {
	const out = repairToolArgumentsValue(
		"todo",
		{ op: "init", items: ['{"phase":"R","items":["a"]}'] },
		schemas,
	) as { list: Array<{ phase: string; items: string[] }> };
	assert.deepEqual(out.list, [{ phase: "R", items: ["a"] }]);
});

test("aggregate responses path repairs the reported payload end to end", () => {
	const body: Record<string, unknown> = {
		model: "muse-spark-1.3-contributor-free",
		input: "hi",
		stream: false,
		tools: [todoTool()],
	};
	const fp = enforceOpencodeFingerprint(body, "/v1/responses");
	const response = {
		id: "resp_1",
		object: "response",
		status: "completed",
		output: [{ type: "function_call", id: "fc_1", name: "todo", arguments: REPORTED }],
	};
	const sse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}`;
	const out = JSON.parse(
		convertSseToJson(sse, "/v1/responses", fp.callerHadTools, fp.caseRestore, fp.findGlob, fp.injected, fp.argSchemas),
	) as { output: Array<{ arguments: string }> };
	assert.equal(out.output.length, 1);
	const args = JSON.parse(out.output[0].arguments) as { list: Array<{ items: string[] }> };
	assert.equal(args.list.length, 2);
	assert.deepEqual(args.list[1], { phase: "Synthesis", items: ["Write how-it-works explanation"] });
});

test("aggregate chat path repairs the reported payload end to end", () => {
	const body: Record<string, unknown> = {
		model: "space-bunny-free",
		messages: [{ role: "user", content: "hi" }],
		stream: false,
		tools: [todoTool()],
	};
	const fp = enforceOpencodeFingerprint(body, "/v1/chat/completions");
	const sse = [
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "todo", arguments: REPORTED } }] } }] })}`,
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}`,
		"data: [DONE]",
	].join("\n\n");
	const out = JSON.parse(
		convertSseToJson(sse, "/v1/chat/completions", fp.callerHadTools, fp.caseRestore, fp.findGlob, fp.injected, fp.argSchemas),
	) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }> };
	const call = out.choices[0].message.tool_calls[0];
	const args = JSON.parse(call.function.arguments) as { list: Array<{ phase: string }> };
	assert.deepEqual(args.list.map((p) => p.phase), ["Research", "Synthesis"]);
});

test("aggregate messages path repairs the parsed input object", () => {
	const body: Record<string, unknown> = {
		model: "space-bunny-free",
		messages: [{ role: "user", content: "hi" }],
		stream: false,
		tools: [todoTool()],
	};
	const fp = enforceOpencodeFingerprint(body, "/v1/messages");
	const sse = [
		`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "todo" } })}`,
		`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: REPORTED } })}`,
		`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
		`data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "space-bunny-free" } })}`,
		`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}`,
	].join("\n\n");
	const out = JSON.parse(
		convertSseToJson(sse, "/v1/messages", fp.callerHadTools, fp.caseRestore, fp.findGlob, fp.injected, fp.argSchemas),
	) as { content: Array<{ type: string; input?: { list?: Array<{ phase: string }> } }> };
	const toolUse = out.content.find((block) => block.type === "tool_use");
	assert.ok(toolUse?.input, "tool_use block carries repaired input");
	assert.deepEqual(toolUse.input?.list?.map((p) => p.phase), ["Research", "Synthesis"]);
});

function streamCloak(pathname: string): StreamCloakOptions {
	return { callerHadTools: true, injected: ["edit"], pathname, argSchemas: schemas };
}

/** Feed SSE blocks through the streaming rewriter and return the output text. */
function runBlocks(blocks: string[], pathname: string): string {
	const cloak = streamCloak(pathname);
	const state = createSseStreamCloakState();
	const out: string[] = [];
	for (const block of blocks) {
		const next = rewriteSseBlock(block, state, cloak);
		if (next !== null) out.push(next);
	}
	return out.join("\n\n");
}

test("responses stream: output_item.done arguments are repaired", () => {
	const body = runBlocks(
		[
			`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", name: "todo", arguments: "" } })}`,
			`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", name: "todo", arguments: REPORTED } })}`,
		],
		"/v1/responses",
	);
	const done = body.split("\n\n").find((block) => block.includes("output_item.done")) ?? "";
	const args = JSON.parse(JSON.parse(done.slice(done.indexOf("data: ") + 6)).item.arguments) as { list: Array<{ phase: string }> };
	assert.deepEqual(args.list.map((p) => p.phase), ["Research", "Synthesis"]);
});

test("responses stream: function_call_arguments.done is repaired", () => {
	const body = runBlocks(
		[
			`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", name: "todo", arguments: "" } })}`,
			`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: REPORTED })}`,
		],
		"/v1/responses",
	);
	const done = body.split("\n\n").find((block) => block.includes("function_call_arguments.done"))!;
	const args = JSON.parse(JSON.parse(done.slice(done.indexOf("data: ") + 6)).arguments) as { list: Array<{ phase: string }> };
	assert.deepEqual(args.list.map((p) => p.phase), ["Research", "Synthesis"]);
});

test("chat stream: fragmented arguments are buffered and repaired on the terminal chunk", () => {
	// Split the malformed packet across two deltas: neither half is judgeable
	// alone, so the whole must be reassembled before repair.
	const half = Math.floor(REPORTED.length / 2);
	const body = runBlocks(
		[
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "todo", arguments: REPORTED.slice(0, half) } }] } }] })}`,
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: REPORTED.slice(half) } }] } }] })}`,
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}`,
		],
		"/v1/chat/completions",
	);
	const flushed = body.split("\n\n").filter((block) => block.includes('"finish_reason":"tool_calls"'));
	assert.equal(flushed.length, 1, "one terminal chunk carries the flushed call");
	const args = JSON.parse(JSON.parse(flushed[0].slice(flushed[0].indexOf("data: ") + 6)).choices[0].delta.tool_calls[0].function.arguments) as { list: Array<{ phase: string }> };
	assert.deepEqual(args.list.map((p) => p.phase), ["Research", "Synthesis"]);
});

test("chat stream: a tool with no repairable schema keeps streaming incrementally", () => {
	// `read` takes one string, so it is absent from argSchemas: its arguments
	// must flow through in the original delta, untouched.
	const args = '{"path":"a.txt"}';
	const body = runBlocks(
		[
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: args } }] } }] })}`,
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}`,
		],
		"/v1/chat/completions",
	);
	const first = body.split("\n\n")[0];
	const forwarded = JSON.parse(first.slice(first.indexOf("data: ") + 6)) as {
		choices: Array<{ delta: { tool_calls: Array<{ function: { arguments: string } }> } }>;
	};
	assert.equal(
		forwarded.choices[0].delta.tool_calls[0].function.arguments,
		args,
		"unrepairable tool arguments reach the host verbatim on their original delta",
	);
});

test("messages stream: fragmented input is buffered and repaired on content_block_stop", () => {
	const half = Math.floor(REPORTED.length / 2);
	const body = runBlocks(
		[
			`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "todo" } })}`,
			`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: REPORTED.slice(0, half) } })}`,
			`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: REPORTED.slice(half) } })}`,
			`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
		],
		"/v1/messages",
	);
	const delta = body.split("\n\n").find((block) => block.includes("input_json_delta"));
	assert.ok(delta, "the repaired input is emitted before the block stops");
	const args = JSON.parse(JSON.parse(delta!.slice(delta!.indexOf("data: ") + 6)).delta.partial_json) as { list: Array<{ phase: string }> };
	assert.deepEqual(args.list.map((p) => p.phase), ["Research", "Synthesis"]);
});