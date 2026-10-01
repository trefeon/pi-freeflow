/**
 * todo op:init call-restore proof on the muse-spark responses path.
 *
 * Ground truth (inline literal copy of the OMP TodoTool.initPhases shape,
 * reference/oh-my-pi/.../tools/todo.ts:78-88,395-408 — never imported):
 * init requires `{ op: "init", list: [{ phase, items: string[1..] }] }`
 * (flat `{ op: "init", items: [...] }` also observed on the wire); the
 * "Missing list for init operation" error fires only when BOTH list and
 * non-empty items are absent — i.e. a bare `{ op: "init" }`.
 *
 * Proves the proxy is lossless for todo: the OMP caller marker makes the
 * request OMP-like (injectedReal), so todo calls execute downstream and are
 * never cloaked as fingerprint placeholders; list/items arguments ride
 * verbatim through the aggregate (convertSseToJson) and streaming
 * (rewriteSseBlock) cloaks. The bare-init control passes through unchanged,
 * proving the observed error is model-sent bare init, not proxy stripping.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	convertSseToJson,
	enforceOpencodeFingerprint,
	normalizeResponsesBody,
	sseToResponsesJson,
} from "../src/opencode-fingerprint.ts";
import {
	createSseStreamCloakState,
	rewriteSseBlock,
} from "../src/stream-pipe.ts";

function responsesTool(name: string, description: string, parameters: unknown): Record<string, unknown> {
	return { type: "function", name, description, parameters: parameters as Record<string, unknown> };
}

/** OMP-like caller body: todo marker + one fingerprint slot covered. */
function todoCallerBody(): Record<string, unknown> {
	return {
		model: "muse-spark-1.3-contributor-free",
		input: "hi",
		stream: false,
		tools: [
			responsesTool("todo", "Manage tasks", { type: "object", properties: { op: { type: "string" } } }),
			responsesTool("glob", "Find files", { type: "object", properties: { path: { type: "string" } } }),
		],
	};
}

const LIST_ARGS = {
	op: "init",
	list: [{ phase: "build", items: ["write code", "run tests"] }],
};
const FLAT_ARGS = { op: "init", items: ["write code", "run tests"] };
const BARE_ARGS = { op: "init" };

function completedSse(calls: Array<Record<string, unknown>>): string {
	const response = { id: "resp_todo", object: "response", status: "completed", output: calls };
	return `event: response.completed\ndata: {"type":"response.completed","response":${JSON.stringify(response)}}`;
}

function todoCall(id: string, args: unknown): Record<string, unknown> {
	return { type: "function_call", id, name: "todo", arguments: JSON.stringify(args) };
}

test("todo caller is OMP-like: canonical name survives, only edit cloaked", () => {
	const body = todoCallerBody();
	const r = enforceOpencodeFingerprint(body, "/v1/responses");
	assert.equal(r.clientRequestedStream, false);
	assert.equal(r.callerHadTools, true);
	assert.deepEqual(r.injected, ["edit"]);
	assert.ok(!r.injected.includes("todo"), "todo is a caller tool, never an injected placeholder");
	assert.ok(!r.injectedReal.includes("todo"), "todo needs no injection: caller declared it");
	const tools = body.tools as Array<Record<string, unknown>>;
	assert.ok(tools.some((t) => t.name === "todo"), "todo definition served verbatim");
	assert.equal(tools.find((t) => t.name === "todo")?.description, "Manage tasks");
	assert.equal(body.stream, true, "upstream still forced to stream");
});

test("init with list arrives downstream verbatim (aggregate responses path)", () => {
	const r = enforceOpencodeFingerprint(todoCallerBody(), "/v1/responses");
	const sse = completedSse([
		todoCall("fc_todo_list", LIST_ARGS),
		{ type: "function_call", id: "fc_edit", name: "edit", arguments: '{"path":"x"}' },
	]);
	const out = sseToResponsesJson(sse, true, r.caseRestore, r.findGlob, r.injected) as {
		output: Array<{ type: string; name?: string; arguments?: string }>;
	};
	assert.equal(out.output.length, 1, "injected edit decoy stripped, todo kept");
	assert.equal(out.output[0].name, "todo");
	assert.deepEqual(JSON.parse(out.output[0].arguments ?? ""), LIST_ARGS, "list/items verbatim");
});

test("init with flat items arrives verbatim (convertSseToJson non-stream path)", () => {
	const r = enforceOpencodeFingerprint(todoCallerBody(), "/v1/responses");
	const sse = completedSse([todoCall("fc_todo_flat", FLAT_ARGS)]);
	const json = convertSseToJson(sse, "/v1/responses", true, r.caseRestore, r.findGlob, r.injected);
	const out = JSON.parse(json) as { output: Array<{ type: string; name?: string; arguments?: string }> };
	assert.equal(out.output.length, 1);
	assert.equal(out.output[0].name, "todo");
	assert.deepEqual(JSON.parse(out.output[0].arguments ?? ""), FLAT_ARGS, "flat items verbatim");
});

test("init args survive the streaming cloak block-by-block", () => {
	const r = enforceOpencodeFingerprint(todoCallerBody(), "/v1/responses");
	const cloak = {
		callerHadTools: true,
		caseRestore: r.caseRestore,
		findGlob: r.findGlob,
		injected: r.injected,
		pathname: "/v1/responses",
	};
	const state = createSseStreamCloakState();
	const argStr = JSON.stringify(LIST_ARGS);
	const added =
		`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,` +
		`"item":{"type":"function_call","id":"call_todo","name":"todo","arguments":""}}`;
	const delta =
		`event: response.function_call_arguments.delta\ndata: ` +
		`{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"call_todo","delta":${JSON.stringify(argStr)}}`;
	const completed =
		`event: response.completed\ndata: {"type":"response.completed","response":` +
		`${JSON.stringify({ id: "resp_todo", object: "response", status: "completed", output: [todoCall("call_todo", LIST_ARGS)] })}}`;
	const keptAdded = rewriteSseBlock(added, state, cloak);
	assert.ok(keptAdded !== null && keptAdded.includes('"todo"'), "todo added block forwarded");
	const keptDelta = rewriteSseBlock(delta, state, cloak);
	assert.ok(keptDelta !== null && keptDelta.includes("write code"), "todo argument delta forwarded verbatim");
	const keptCompleted = rewriteSseBlock(completed, state, cloak);
	assert.ok(keptCompleted !== null && keptCompleted.includes('"todo"'), "todo completed block forwarded");
	assert.ok(keptCompleted.includes("write code"), "todo arguments intact in terminal object");
	const dropped = rewriteSseBlock(
		`event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,` +
			`"item":{"type":"function_call","id":"call_edit","name":"edit","arguments":"{}"}}`,
		state,
		cloak,
	);
	assert.equal(dropped, null, "injected edit placeholder still cloaked on stream path");
});

test("bare init control passes through unchanged (error is model-sent, not stripped)", () => {
	const r = enforceOpencodeFingerprint(todoCallerBody(), "/v1/responses");
	const sse = completedSse([todoCall("fc_todo_bare", BARE_ARGS)]);
	const out = sseToResponsesJson(sse, true, r.caseRestore, r.findGlob, r.injected) as {
		output: Array<{ type: string; name?: string; arguments?: string }>;
	};
	assert.equal(out.output.length, 1, "bare init not dropped by cloak");
	assert.equal(out.output[0].name, "todo");
	assert.deepEqual(JSON.parse(out.output[0].arguments ?? ""), BARE_ARGS);
});

test("normalizeResponsesBody leaves todo tools alone (spark effort clamp only)", () => {
	const body: Record<string, unknown> = {
		model: "muse-spark-1.3-contributor-free",
		input: "hi",
		reasoning: { effort: "max" },
		tools: [responsesTool("todo", "Manage tasks", { type: "object" })],
	};
	normalizeResponsesBody(body);
	assert.equal((body.reasoning as Record<string, unknown>).effort, "xhigh", "stale max effort still clamped");
	const tools = body.tools as Array<Record<string, unknown>>;
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "todo", "tools untouched by normalization");
	assert.equal(body.store, false);
});
