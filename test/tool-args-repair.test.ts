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
	flushBufferedToolArgs,
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

/**
 * The same parameters in the strict-mode wire form both hosts emit for
 * `strict: true`: `required` lists every property key and each optional one is
 * wrapped in `anyOf: [<schema>, { type: "null" }]` (OMP src/utils/schema/
 * CONSTRAINTS.md:34-49; Pi api/constrained-sampling.ts:118-123). OMP declares
 * todo strict=true, so this — not the bare schema above — is the form the
 * reported malformation actually arrived in.
 */
function todoStrictParameters(): Record<string, unknown> {
	const params = todoParameters();
	const props = params.properties as Record<string, Record<string, unknown>>;
	for (const [key, prop] of Object.entries(props)) {
		if (key === "op") continue; // required in the source, so never wrapped
		props[key] = { anyOf: [prop, { type: "null" }] };
	}
	return { ...params, properties: props, required: Object.keys(props), additionalProperties: false };
}

const schemas = buildArgRepairSchemas([todoTool()]);

/** `todo` schemas in that same strict form, keyed for the repair. */
const strictSchemas = buildArgRepairSchemas([
	{ type: "function", name: "todo", description: "apply a single todo operation", parameters: todoStrictParameters() },
]);

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

test("strict-wrapped todo: the reported malformation promotes through the anyOf list prop", () => {
	// At strict=true every optional payload prop — `list` included — arrives
	// wrapped as `anyOf: [T, { type: "null" }]`, so its array shape lives on the
	// wrapper's non-null branch. Reading only a top-level `type` saw an untyped
	// prop and skipped it, which made the exact payload this module exists for
	// unrepairable on the tool that reported it.
	const out = repairToolArguments("todo", REPORTED, strictSchemas);
	assert.notEqual(out, REPORTED, "the reported payload must change");
	assert.deepEqual(JSON.parse(out), {
		op: "init",
		list: [
			{ phase: "Research", items: ["Map repo structure and entrypoints", "Trace auth and login flow"] },
			{ phase: "Synthesis", items: ["Write how-it-works explanation"] },
		],
	});
	// The consumed source is nullable-listed by the strict rewrite, so a working
	// repair leaves the payload with the declared slot filled and the junk gone.
	assert.equal("items" in (JSON.parse(out) as Record<string, unknown>), false);
	// The streaming responses path repairs through the same core; the strict cloak
	// must fire there too, because that is where the live failure was seen.
	const state = createSseStreamCloakState();
	const cloak: StreamCloakOptions = { callerHadTools: true, injected: ["edit"], pathname: "/v1/responses", argSchemas: strictSchemas };
	const streamed = [
		`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", name: "todo", arguments: "" } })}`,
		`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", name: "todo", arguments: REPORTED } })}`,
	]
		.map((block) => rewriteSseBlock(block, state, cloak))
		.filter((block): block is string => block !== null)
		.join("\n\n");
	const done = streamed.split("\n\n").find((block) => block.includes("output_item.done")) ?? "";
	const streamedArgs = JSON.parse(JSON.parse(done.slice(done.indexOf("data: ") + 6)).item.arguments) as { list: Array<{ phase: string }> };
	assert.deepEqual(streamedArgs.list.map((p) => p.phase), ["Research", "Synthesis"], "the streamed responses path promotes under the strict schema");
});

test("strict-wrapped todo: canonical and flat shapes still ride through untouched", () => {
	// The unwrap must not turn the strict schema loose: a canonical call stays
	// byte-identical, and the legitimate flat single-phase init is still left for
	// the host's own flattening (plain labels never promote, strict or not).
	assert.equal(repairToolArguments("todo", CANONICAL, strictSchemas), CANONICAL);
	const flat = '{"op":"init","items":["Map repo","Run tests"]}';
	assert.equal(repairToolArguments("todo", flat, strictSchemas), flat);
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

test("a leading fragment plus a missing closing brace still resolves", () => {
	// Observed 2026-10-13 on space-bunny-free, three times in one long session:
	// the model opened its next call by echoing the tail of the previous one AND
	// stopped before the closing brace, so the payload was
	// `<tail of previous>{"…"…` — one complete object with junk in front and its
	// last brace absent. The salvage below only ever parsed to end-of-string, so
	// the unterminated object failed, no later brace existed to try, and the host
	// refused the whole call with "Unexpected token at position 0".
	//
	// Closing the brace is only attempted when a leading fragment was already
	// detected, which is what keeps the four payloads above from being completed.
	const call = '{"op":"done","task":"Check the registry packument"}';
	for (const corrupted of [
		',"timeout":180}{"op":"done","task":"Check the registry packument"',
		',"async":true}{"op":"done","task":"Check the registry packument"',
		',"timeout":0}{"op":"done","task":"Check the registry packument"',
	]) {
		assert.deepEqual(
			JSON.parse(repairToolArguments("todo", corrupted, schemas)),
			{ op: "done", task: "Check the registry packument" },
			`${JSON.stringify(corrupted)} must resolve to the caller's own object`,
		);
	}
});

test("a missing brace alone is still refused, with no leading fragment", () => {
	// The narrow rule: without a preceding fragment to prove the model was
	// mid-call, an unterminated object stays unparseable. Only payloads whose
	// own contents are already complete get a closer appended; anything cut
	// mid-key or mid-value still fails to parse and is refused.
	for (const truncated of [
		'{"op":"init","list":[{"phase":"R","items":["a"',
		'{"op":"init"',
		'{"op":"done","task":"cut mid value',
		'{"op":"do',
	]) {
		assert.equal(repairToolArguments("todo", truncated, schemas), truncated);
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

test("a scalar-only tool is still repairable, because prefix glue is not about shape", () => {
	// Live 2026-10-14: OMP's `bash` declares only `command`/`timeout`/`cwd`/
	// `pty` (reference/oh-my-pi tools/bash.ts:327), so a filter that kept only
	// tools with an object or array property left the most-used tool out of the
	// map. The model opened its next call by echoing the previous one's tail,
	// the host rejected the payload, and the whole turn looped on it.
	const bash = buildArgRepairSchemas([
		{
			type: "function",
			name: "bash",
			description: "Run a shell command",
			parameters: {
				type: "object",
				properties: { i: { type: "string" }, command: { type: "string" }, timeout: { type: "number" }, cwd: { type: "string" } },
				required: ["command"],
			},
		},
	]);
	assert.ok(bash.has("bash"), "bash must be repairable");
	const glued = 'reelane-proxy"}{"i": "Confirming the files", "command": "git status --short", "cwd": "D:/repo"}';
	assert.deepEqual(JSON.parse(repairToolArguments("bash", glued, bash)), {
		i: "Confirming the files",
		command: "git status --short",
		cwd: "D:/repo",
	});
	// A tool with no declared parameters at all still has nothing to repair.
	assert.equal(buildArgRepairSchemas([{ type: "function", name: "x", description: "d", parameters: { type: "string" } }]).size, 0);
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
		model: "nemotron-3.5-super-vl-free",
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

test("chat stream: argument fragment riding the terminal finish_reason chunk is absorbed without rotation or duplication", () => {
	const half = Math.floor(REPORTED.length / 2);
	const body = runBlocks(
		[
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "todo", arguments: REPORTED.slice(0, half) } }] } }] })}`,
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: REPORTED.slice(half) } }] }, finish_reason: "tool_calls" }] })}`,
		],
		"/v1/chat/completions",
	);
	const flushed = body.split("\n\n").filter((block) => block.includes('"finish_reason":"tool_calls"'));
	assert.equal(flushed.length, 1, "one terminal chunk carries the flushed call");
	const chunk = JSON.parse(flushed[0].slice(flushed[0].indexOf("data: ") + 6));
	assert.equal(chunk.choices[0].delta.tool_calls.length, 1, "exactly one tool call on terminal chunk");
	const rawArgs = chunk.choices[0].delta.tool_calls[0].function.arguments;
	const args = JSON.parse(rawArgs) as { list: Array<{ phase: string }> };
	assert.deepEqual(args.list.map((p) => p.phase), ["Research", "Synthesis"]);
});

test("chat stream: terminal chunk fragment with multibyte CJK, emoji, and escaped quotes resolves cleanly", () => {
	const payload = JSON.stringify({
		op: "init",
		items: ["研究 🚀 \"quoted text\" \n newline", "東京🗼"],
	});
	const splitIdx = payload.indexOf("東京");
	const part1 = payload.slice(0, splitIdx);
	const part2 = payload.slice(splitIdx);
	const body = runBlocks(
		[
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "todo", arguments: part1 } }] } }] })}`,
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part2 } }] }, finish_reason: "tool_calls" }] })}`,
		],
		"/v1/chat/completions",
	);
	const flushed = body.split("\n\n").filter((block) => block.includes('"finish_reason":"tool_calls"'));
	assert.equal(flushed.length, 1);
	const chunk = JSON.parse(flushed[0].slice(flushed[0].indexOf("data: ") + 6));
	assert.equal(chunk.choices[0].delta.tool_calls.length, 1);
	const args = JSON.parse(chunk.choices[0].delta.tool_calls[0].function.arguments) as { op: string; items: string[] };
	assert.equal(args.op, "init");
	assert.deepEqual(args.items, ["研究 🚀 \"quoted text\" \n newline", "東京🗼"]);
});

test("chat stream: a tool the caller never declared a schema for keeps streaming incrementally", () => {
	// A tool absent from argSchemas (here: not one this request declared) must
	// not be buffered — its arguments flow through on the original delta. Every
	// tool that DOES declare parameters is now buffered, scalar-only ones
	// included, because prefix glue reaches them too.
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

test("a truncated number literal is refused, never rounded into a wrong value", () => {
	// `timeout` is a declared number on both hosts' bash. Closing the object
	// here would hand the host a value the model never finished writing.
	const bashSchemas = buildArgRepairSchemas([
		{
			type: "function",
			name: "bash",
			description: "Run a shell command",
			parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] },
		},
	]);
	for (const cut of [
		'{"async":true}{"command":"ls","timeout":18',
		'{"async":true}{"command":"ls","timeout":1',
		'{"async":true}{"command":"ls","timeout":1.',
		'{"async":true}{"command":"ls","timeout":1e',
		'{"command":"ls","timeout":18',
	]) {
		assert.equal(repairToolArguments("bash", cut, bashSchemas), cut, `${cut} must ride through untouched`);
	}
	// A payload whose only fault is the prefix still repairs.
	const glued = '{"async":true}{"command":"ls","timeout":180}';
	assert.equal(repairToolArguments("bash", glued, bashSchemas), '{"command":"ls","timeout":180}');
});

test("an inner object is never promoted over the wrapper that declares it", () => {
	// The salvage must not hand back `{"a":1}` for `{"opts":{"a":1}`: the
	// declared `opts` key would vanish and the host would see a shape its own
	// schema never described.
	const cfgSchemas = buildArgRepairSchemas([
		{
			type: "function",
			name: "cfg",
			description: "Configure",
			parameters: { type: "object", properties: { opts: { type: "object", properties: { a: { type: "number" } } } } },
		},
	]);
	const cut = '{"opts":{"a":1}';
	assert.equal(repairToolArguments("cfg", cut, cfgSchemas), cut, "the inner object must not replace the call");
	// With a prefix in front the same call still recovers whole.
	assert.equal(repairToolArguments("cfg", `garbage${cut}`, cfgSchemas), '{"opts":{"a":1}}');
});

test("chat stream: arguments survive a stream that never sends finish_reason", () => {
	// The buffered fragments are released on the terminal chunk; a cut stream
	// never sends one, so without the end-of-stream flush the client received a
	// tool call whose arguments had been deleted and never re-emitted.
	const body = runBlocks(
		[
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "todo", arguments: REPORTED } }] } }] })}`,
		],
		"/v1/chat/completions",
	);
	assert.ok(!body.includes("arguments"), "the fragment stays buffered until the call is whole");
	const state = createSseStreamCloakState();
	const cloak = streamCloak("/v1/chat/completions");
	rewriteSseBlock(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "todo", arguments: REPORTED } }] } }] })}`, state, cloak);
	const flushed = flushBufferedToolArgs(state, cloak);
	assert.ok(flushed, "the end-of-stream flush must emit the buffered call");
	const call = JSON.parse(flushed!.slice(flushed!.indexOf("data: ") + 6)).choices[0].delta.tool_calls[0] as { function: { name: string; arguments: string } };
	assert.equal(call.function.name, "todo");
	const args = JSON.parse(call.function.arguments) as { list: Array<{ phase: string }> };
	assert.deepEqual(args.list.map((p) => p.phase), ["Research", "Synthesis"]);
	assert.equal(flushBufferedToolArgs(state, cloak), null, "the flush is one-shot");
});

test("messages stream: arguments survive a block that never stops", () => {
	const state = createSseStreamCloakState();
	const cloak = streamCloak("/v1/messages");
	rewriteSseBlock(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "todo" } })}`, state, cloak);
	rewriteSseBlock(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: REPORTED } })}`, state, cloak);
	// No content_block_stop: the recovered delta must still precede the events
	// that close the message.
	const closing = rewriteSseBlock(`data: ${JSON.stringify({ type: "message_stop" })}`, state, cloak);
	assert.ok(closing, "message_stop is forwarded");
	const blocks = closing!.split("\n\n").filter((b) => b.includes("input_json_delta"));
	assert.equal(blocks.length, 1, "the buffered input is emitted exactly once");
	const args = JSON.parse(JSON.parse(blocks[0].slice(blocks[0].indexOf("data: ") + 6)).delta.partial_json) as { list: Array<{ phase: string }> };
	assert.deepEqual(args.list.map((p) => p.phase), ["Research", "Synthesis"]);
	assert.ok(closing!.indexOf("input_json_delta") < closing!.indexOf("message_stop"), "the recovered input precedes message_stop");
});

test("a brace-heavy payload beyond the salvage budget answers fast instead of scanning quadratically", () => {
	// The salvage re-slices and re-parses at every top-level brace, so a
	// brace-heavy emission costs O(candidates x payload): measured 2092 ms for
	// this 83 KB payload (34.5 s at 80 KB in a live capture) on the
	// single-threaded proxy, and the scan even returned a salvage it then had
	// to discard. The bound refuses the scan and hands the payload back
	// unharmed, so the host answers with its own schema error instead.
	const bash = buildArgRepairSchemas([
		{
			type: "function",
			name: "bash",
			description: "Run a shell command",
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		},
	]);
	const huge = '{"command":"check"}'.repeat(4_400);
	assert.ok(huge.length > 64 * 1024, `payload must exceed the byte budget, got ${huge.length}`);
	const started = performance.now();
	const out = repairToolArguments("bash", huge, bash);
	const elapsedMs = performance.now() - started;
	assert.equal(out, huge, "nothing salvaged: the payload rides through unchanged");
	assert.ok(elapsedMs < 1000, `the bound must keep this under 1 s, took ${Math.round(elapsedMs)} ms`);

	// Under the byte budget the candidate cap carries the bound: a complete
	// call sitting behind 200 junk objects lies past the offered offsets, so it
	// is never handed to the parser (a live glue is one short echo, not 200).
	const capped = `${'{"a":1}'.repeat(200)}{"command":"check"}`;
	assert.equal(repairToolArguments("bash", capped, bash), capped, "past the candidate cap nothing is salvaged");
});

test("the salvage still repairs the live glue shapes under the bounds", () => {
	// The bound must not cost the shapes it exists for: a short echo in front
	// of the caller's own object, and the same with its closing brace missing.
	const bash = buildArgRepairSchemas([
		{
			type: "function",
			name: "bash",
			description: "Run a shell command",
			parameters: { type: "object", properties: { i: { type: "string" }, command: { type: "string" }, timeout: { type: "number" }, cwd: { type: "string" } }, required: ["command"] },
		},
	]);
	assert.deepEqual(
		JSON.parse(repairToolArguments("bash", '{"async":true}{"command":"ls","timeout":180}', bash)),
		{ command: "ls", timeout: 180 },
	);
	assert.deepEqual(
		JSON.parse(repairToolArguments("bash", 'reelane-proxy"}{"i": "Confirming the files", "command": "git status --short"}', bash)),
		{ i: "Confirming the files", command: "git status --short" },
	);
});