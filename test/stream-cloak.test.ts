/**
 * Streaming cloak proof: placeholder strip + caller-name restore on the SSE
 * pipe path (pipeUpstreamStream + StreamCloakOptions), mirroring the
 * aggregate convertSseToJson semantics event-by-event.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type * as http from "node:http";
import {
 _resetSseStatsForTest,
 pipeUpstreamStream,
 type StreamCloakOptions,
} from "../src/stream-pipe.ts";

/** Minimal http.ServerResponse stand-in covering the surface stream-pipe uses. */
class FakeResponse extends EventEmitter {
 headersSent = false;
 writableEnded = false;
 private parts: string[] = [];

 flushHeaders(): void {
  this.headersSent = true;
 }

 writeHead(_status: number, _headers?: Record<string, string>): unknown {
  this.headersSent = true;
  return this;
 }

 write(chunk: Buffer | string): boolean {
  this.parts.push(
   typeof chunk === "string" ? chunk : chunk.toString("utf8"),
  );
  return true;
 }

 end(chunk?: Buffer | string): void {
  if (chunk !== undefined) this.write(chunk);
  this.writableEnded = true;
  this.emit("finish");
 }

 body(): string {
  return this.parts.join("");
 }
}

class FakeRequest extends EventEmitter {
 url: string;
 constructor(url: string) {
  super();
  this.url = url;
 }
}

/** Push canned SSE in byte-splits (proving cross-chunk buffering), end, collect. */
async function runStreamed(
 input: string,
 reqUrl: string,
 cloak: StreamCloakOptions | undefined,
 splitAt: number[],
): Promise<string> {
 _resetSseStatsForTest();
 const stream = new PassThrough();
 const res = new FakeResponse();
 const req = new FakeRequest(reqUrl);
 pipeUpstreamStream(
  stream,
  res as unknown as http.ServerResponse,
  req as unknown as http.IncomingMessage,
  "test",
  "direct",
  cloak,
 );
 let offset = 0;
 for (const at of splitAt) {
  stream.push(Buffer.from(input.slice(offset, at), "utf8"));
  offset = at;
 }
 if (offset < input.length) {
  stream.push(Buffer.from(input.slice(offset), "utf8"));
 }
 stream.push(null);
 await once(res, "finish");
 return res.body();
}

const thirds = (s: string): number[] => [
 Math.floor(s.length / 3),
 Math.floor((2 * s.length) / 3),
];

test("responses stream: injected placeholders dropped, caller names restored", async () => {
 const cloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: { bash: "Bash" },
  findGlob: { renamedFindToGlob: true },
  injected: ["grep", "read", "edit", "write"],
  pathname: "/v1/responses",
 };
 const completed = {
  type: "response.completed",
  response: {
   id: "resp_1",
   object: "response",
   status: "completed",
   output: [
    { type: "function_call", name: "bash", arguments: '{"cmd":"ls"}' },
    { type: "function_call", name: "glob", arguments: '{"pattern":"*.ts"}' },
    { type: "function_call", name: "grep", arguments: "{}" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
   ],
  },
 };
 const sse = [
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"call_bash","name":"bash","arguments":""}}',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"call_glob","name":"glob","arguments":""}}',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"call_grep","name":"grep","arguments":""}}',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":2,"item_id":"call_grep","delta":"{\\"path\\":\\"SECRET_GREP_ARG\\"}"}',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"call_grep","delta":"more"}',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"call_glob","delta":"{\\"pattern\\":\\"*.ts\\"}"}',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"call_bash","delta":"{\\"cmd\\":\\"ls\\"}"}',
  `event: response.completed\ndata: ${JSON.stringify(completed)}`,
 ].join("\n\n");

 const body = await runStreamed(sse, "/v1/responses", cloak, thirds(sse));

 assert.ok(!body.includes('"name":"bash"'), "lowercase placeholder bash never reaches the host");
 assert.ok(!body.includes('"name":"grep"'), "injected grep never reaches the host");
 assert.ok(!body.includes("SECRET_GREP_ARG"), "dropped index deltas never reach the host");
 assert.ok(!body.includes('"delta":"more"'), "id-keyed continuation of a dropped call is dropped");
 assert.ok(body.includes('"name":"Bash"'), "caller Bash keeps its casing");
 assert.ok(body.includes('"name":"find"'), "upstream glob restores to caller find");
 assert.ok(body.includes("*.ts"), "kept glob arguments flow through");
 assert.ok(body.includes('"type":"response.completed"'), "terminal marker flows through");
 assert.ok(
  !body.includes('"type":"response.incomplete"'),
  "recognized terminal must not trigger a synthetic incomplete",
 );
});

test("chat+responses stream: disguised context tool names restore to the caller's", async () => {
 const findGlob = {
  renamedFindToGlob: false,
  renamed: { notes_tool: "context_notes", refresh_tool: "new_context" },
 };
 const chatCloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: {},
  findGlob,
  injected: ["bash", "glob", "grep", "read", "edit", "write"],
  pathname: "/v1/chat/completions",
 };
 const chatSse = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"notes_tool","arguments":"{}"}}]}}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"more"}}]}}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"refresh_tool","arguments":"{}"}}]}}]}',
  "data: [DONE]",
 ].join("\n\n");
 const chat = await runStreamed(chatSse, "/v1/chat/completions", chatCloak, thirds(chatSse));
 assert.ok(chat.includes('"name":"context_notes"'), "notes_tool restores to context_notes");
 assert.ok(chat.includes('"name":"new_context"'), "refresh_tool restores to new_context");
 assert.ok(!chat.includes('"name":"notes_tool"'), "the disguise never reaches the host");
 assert.ok(!chat.includes('"name":"refresh_tool"'), "the disguise never reaches the host");

 const responsesCloak: StreamCloakOptions = { ...chatCloak, pathname: "/v1/responses" };
 const completed = {
  type: "response.completed",
  response: {
   id: "resp_1",
   object: "response",
   status: "completed",
   output: [
    { type: "function_call", name: "notes_tool", arguments: "{}" },
    { type: "function_call", name: "refresh_tool", arguments: "{}" },
   ],
  },
 };
 const responsesSse = [
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"call_1","name":"notes_tool","arguments":""}}',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"call_2","name":"refresh_tool","arguments":""}}',
  `event: response.completed\ndata: ${JSON.stringify(completed)}`,
 ].join("\n\n");
 const responses = await runStreamed(responsesSse, "/v1/responses", responsesCloak, thirds(responsesSse));
 assert.ok(responses.includes('"name":"context_notes"'), "responses notes_tool restores to context_notes");
 assert.ok(responses.includes('"name":"new_context"'), "responses refresh_tool restores to new_context");
 assert.ok(!responses.includes('"name":"notes_tool"'), "the disguise never reaches the host");
 assert.ok(!responses.includes('"name":"refresh_tool"'), "the disguise never reaches the host");
});

test("stream: prototype-like caller names restore to themselves", async () => {
 const cloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: { bash: "Bash" },
  findGlob: { renamedFindToGlob: false },
  injected: [],
  pathname: "/v1/chat/completions",
 };
 const sse = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"constructor","arguments":"{}"}}]}}]}',
  "data: [DONE]",
 ].join("\n\n");
 const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));
 assert.ok(body.includes('"name":"constructor"'), "a caller tool named constructor survives the case restore");
});

test("chat stream: injected tool_calls dropped incl. nameless continuations", async () => {
 const cloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: { bash: "Bash" },
  findGlob: { renamedFindToGlob: true },
  injected: ["bash", "grep", "read", "edit", "write"],
  pathname: "/v1/chat/completions",
 };
 const sse = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_0","type":"function","function":{"name":"bash","arguments":"{\\"cmd\\":\\"SECRET_CHAT_DROP\\"}"}},{"index":1,"id":"call_1","type":"function","function":{"name":"glob","arguments":"{}"}}]}}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"more"}}]}}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"pattern\\":\\"*.ts\\"}"}}]}}]}',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hello"}}]}',
  "data: [DONE]",
 ].join("\n\n");

 const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

 assert.ok(!body.includes("bash"), "injected bash never reaches the host");
 assert.ok(!body.includes("SECRET_CHAT_DROP"), "dropped call arguments never reach the host");
 assert.ok(!body.includes("more"), "nameless continuation of a dropped index is dropped");
 assert.ok(body.includes('"name":"find"'), "upstream glob restores to caller find");
 assert.ok(body.includes("*.ts"), "kept call arguments flow through");
 assert.ok(body.includes("hello"), "text deltas flow through");
 assert.equal(
  body.split("[DONE]").length - 1,
  1,
  "single terminal [DONE], no synthetic duplicate",
 );
});

test("chat stream: tool-less caller loses tool_calls with args folded to text", async () => {
 const cloak: StreamCloakOptions = {
  callerHadTools: false,
  caseRestore: {},
  findGlob: { renamedFindToGlob: false },
  injected: ["bash", "glob", "grep", "read", "edit", "write"],
  pathname: "/v1/chat/completions",
 };
 const sse = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
  "data: [DONE]",
 ].join("\n\n");

 const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

 assert.ok(!body.includes("tool_calls"), "tool-less callers never see tool_calls");
 assert.ok(body.includes("a.txt"), "dropped arguments fold to text");
});

test("full-inventory stream passes through byte-identical", async () => {
 const cloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: {},
  findGlob: { renamedFindToGlob: false },
  injected: [],
  pathname: "/v1/responses",
 };
 const sse = [
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"call_1","name":"my_tool","arguments":""}}',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[{"type":"function_call","name":"my_tool","arguments":"{}"}]}}',
 ].join("\n\n") + "\n\n";

 const body = await runStreamed(sse, "/v1/responses", cloak, thirds(sse));

 assert.equal(body, sse, "nothing to cloak means byte-identical passthrough");
});

test("messages stream: injected tool_use dropped with continuations, caller names restored", async () => {
 // Fails without CloakStreamFix: the messages path used to bypass the
 // streaming cloak entirely (byte-identical passthrough), so injected calls
 // leaked and caller casing/find->glob were never restored on the pipe.
 const cloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: { bash: "Bash" },
  findGlob: { renamedFindToGlob: true },
  injected: ["grep", "edit"],
  pathname: "/v1/messages",
 };
 const sse = [
  'data: {"type":"message_start","message":{"id":"msg_stream_1","model":"m"}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_bash_s","name":"bash"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_grep_s","name":"grep"}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"SECRET_GREP_ARG"}}',
  'data: {"type":"content_block_stop","index":1}',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_glob_s","name":"glob"}}',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\":\\"*.ts\\"}"}}',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
 ].join("\n\n");

 const body = await runStreamed(sse, "/v1/messages", cloak, thirds(sse));

 assert.ok(!body.includes("tu_grep_s"), "injected grep block never reaches the host");
 assert.ok(!body.includes("SECRET_GREP_ARG"), "dropped block deltas never reach the host");
 assert.ok(body.includes('"name":"Bash"'), "caller Bash keeps its casing on the pipe");
 assert.ok(body.includes('"name":"find"'), "upstream glob restores to caller find on the pipe");
 assert.ok(body.includes("tu_bash_s") && body.includes("tu_glob_s"), "surviving block ids ride verbatim");
 assert.ok(body.includes("*.ts"), "surviving block arguments flow through");
});

test("messages stream: tool-less caller drops every tool_use", async () => {
 // Fails without CloakStreamFix for the same bypass reason: a tool-less
 // caller used to see raw tool_use blocks on the messages stream.
 const cloak: StreamCloakOptions = {
  callerHadTools: false,
  caseRestore: {},
  findGlob: { renamedFindToGlob: false },
  injected: ["bash", "glob", "grep", "read", "edit", "write"],
  pathname: "/v1/messages",
 };
 const sse = [
  'data: {"type":"message_start","message":{"id":"msg_stream_2","model":"m"}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_read_s","name":"read"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
 ].join("\n\n");

 const body = await runStreamed(sse, "/v1/messages", cloak, thirds(sse));

 assert.ok(!body.includes("tu_read_s"), "dropped block id never leaks");
 assert.ok(!body.includes('"type":"tool_use"'), "tool-less callers never see tool_use blocks on the pipe");
});
test("responses stream: tool-less caller drops every function_call even with an empty injected list", async () => {
 // Fails without CloakStreamFix: the old responses streaming cloak stripped
 // only names present in injected[], so with an empty record every call
 // leaked. Tool-less callers own no tools, so every call must drop.
 const cloak: StreamCloakOptions = {
  callerHadTools: false,
  caseRestore: {},
  findGlob: { renamedFindToGlob: false },
  injected: [],
  pathname: "/v1/responses",
 };
 const sse = [
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"call_leak","name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","object":"response","status":"completed","output":[{"type":"function_call","id":"call_leak","name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}',
 ].join("\n\n");

 const body = await runStreamed(sse, "/v1/responses", cloak, thirds(sse));

 assert.ok(!body.includes("function_call"), "tool-less callers never see function_call on the pipe");
 assert.ok(!body.includes("call_leak"), "dropped call id never leaks");
});

test("chat stream: caller-owned same-name call survives with restored casing", async () => {
 // Guard for the injected-only rule on the pipe: bash is a fingerprint name
 // but this request did NOT inject it (caller owns Bash), so the model call
 // survives with casing restored while the truly-injected grep strips —
 // including its nameless argument continuation.
 const cloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: { bash: "Bash" },
  findGlob: { renamedFindToGlob: false },
  injected: ["grep"],
  pathname: "/v1/chat/completions",
 };
 const sse = [
  'data: {"id":"c9","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_bash_k","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}},{"index":1,"id":"call_grep_k","type":"function","function":{"name":"grep","arguments":"{}"}}]}}]}',
  'data: {"id":"c9","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"SECRET_GREP_TAIL"}}]}}]}',
  'data: {"id":"c9","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" tail"}}]}}]}',
  "data: [DONE]",
 ].join("\n\n");

 const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

 assert.ok(body.includes("call_bash_k"), "caller-owned call id flows through");
 assert.ok(body.includes('"name":"Bash"'), "caller casing restored on the pipe");
 assert.ok(body.includes("tail"), "surviving call continuations flow through");
 assert.ok(!body.includes("call_grep_k"), "injected call id never leaks");
 assert.ok(!body.includes("SECRET_GREP_TAIL"), "dropped call continuations never reach the host");
});

 // Delta helper for the parallel-collision tests: one-choice chat chunk.
 const chatDelta = (tool_calls: unknown[]): string =>
	`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls } }] })}`;
 const finishDelta = (): string =>
	`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}`;

 /** One tool_call riding a streamed chat delta; name/arguments optional so omitted keys never serialize. */
 const chatToolCall = (id: string, fn: { name?: string; arguments?: string }): Record<string, unknown> => (
	{ index: 0, id, type: "function", function: fn }
 );

 /** Decoded `data:` frames of a streamed body (single-choice chat). */
 const dataFrames = (body: string): Array<Record<string, any>> =>
	body
		.split("\n\n")
		.filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
		.map((block) => JSON.parse(block.slice(6)));

 /** Emitted tool_calls entries that carry name+arguments — the flushed whole calls. */
 const flushedChatCalls = (
	body: string,
 ): Array<{ index: number; type: string; function: { name: string; arguments: string } }> => {
	const out: Array<{ index: number; type: string; function: { name: string; arguments: string } }> = [];
	for (const frame of dataFrames(body)) {
	 for (const tc of frame.choices?.[0]?.delta?.tool_calls ?? []) {
		if (
		 tc &&
		 typeof tc === "object" &&
		 typeof tc.index === "number" &&
		 typeof tc.function?.name === "string" &&
		 typeof tc.function.arguments === "string"
		) {
		 out.push(tc);
		}
	 }
	}
	return out;
 };

 test("chat stream: parallel id-bearing calls at one upstream index stay two calls at two host indices", async () => {
	// Defect K1: glm-style free models label EVERY parallel tool call
	// `index: 0` while still sending per-call ids on every fragment. Keyed by
	// index alone the two fragment streams interweaved into one buffer, so the
	// terminal flush salvaged only the last parseable object: one call was
	// silently lost. Keyed by id, each call flushes whole at its own
	// host-visible index; the colliding arrival gets a fresh sequential index.
	const todoSchema = {
	 type: "object",
	 properties: {
		list: {
		 type: "array",
		 items: {
			type: "object",
			properties: { phase: { type: "string" }, items: { type: "array", items: { type: "string" } } },
			required: ["phase", "items"],
		 },
		},
	 },
	 required: ["list"],
	};
	const cloak: StreamCloakOptions = {
	 callerHadTools: true,
	 caseRestore: {},
	 findGlob: { renamedFindToGlob: false },
	 injected: [],
	 argSchemas: new Map([["todo", todoSchema]]),
	 pathname: "/v1/chat/completions",
	};
	const sse = [
	 chatDelta([chatToolCall("a1", { name: "todo", arguments: '{"list":[{"ph' })]),
	 chatDelta([chatToolCall("b2", { name: "todo", arguments: '{"list":[{"ph' })]),
	 chatDelta([chatToolCall("a1", { arguments: 'ase":"R","items":["1","2"]}]}' })]),
	 chatDelta([chatToolCall("b2", { arguments: 'ase":"S","items":["3"]}]}' })]),
	 finishDelta(),
	].join("\n\n");
	const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

	// Name deltas ride the pipe (fragments withheld), collider at a fresh index.
	const nameDeltas = dataFrames(body)
	 .flatMap((frame) => frame.choices?.[0]?.delta?.tool_calls ?? [])
	 .filter((c) => typeof c.id === "string" && c.function?.arguments === undefined);
	assert.deepEqual(nameDeltas.map((c) => [c.id, c.index]), [["a1", 0], ["b2", 1]], "the colliding second call gets the next fresh host index");
	assert.equal(nameDeltas.length, 2, "exactly the two name-bearing deltas flow; the id-bearing fragments are absorbed");

	const flushed = flushedChatCalls(body);
	assert.equal(flushed.length, 2, "both id-bearing calls flush whole, not one merged call");
	const byIndex = new Map(flushed.map((call) => [call.index, call]));
	assert.deepEqual([...byIndex.keys()].sort(), [0, 1], "two distinct host indices, one per call");
	const first = byIndex.get(0);
	const second = byIndex.get(1);
	assert.equal(first?.function.name, "todo");
	assert.deepEqual(JSON.parse(first!.function.arguments), { list: [{ phase: "R", items: ["1", "2"] }] }, "first call's own arguments");
	assert.equal(second?.function.name, "todo");
	assert.deepEqual(JSON.parse(second!.function.arguments), { list: [{ phase: "S", items: ["3"] }] }, "second call's own arguments");
	const payloads = flushedChatCalls(body).map((call) => call.function.arguments);
	assert.equal(payloads.filter((p) => p.includes('"phase":"R"')).length, 1, "first call's payload appears exactly once — no salvage of merged junk");
	assert.equal(payloads.filter((p) => p.includes('"phase":"S"')).length, 1, "second call's payload appears exactly once");
 });

 test("chat stream: real id-bearing call reusing a dropped injected call's index survives whole", async () => {
	// Regression pin for the observed `Received arguments: {}` / missing_required
	// shape: an injected placeholder dropped at an upstream index, with its
	// id-bearing fragment arriving AFTER a real id-bearing call reusing that
	// same index. Keyed by index alone the fragment joined the real call's
	// repair buffer, shipping the placeholder's payload as the real call's
	// arguments. Drops are per call now, so the real call stays clean.
	const readSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
	const cloak: StreamCloakOptions = {
	 callerHadTools: true,
	 caseRestore: {},
	 findGlob: { renamedFindToGlob: false },
	 injected: ["edit"],
	 argSchemas: new Map([["read", readSchema]]),
	 pathname: "/v1/chat/completions",
	};
	const sse = [
	 chatDelta([chatToolCall("call_e", { name: "edit", arguments: "{}" })]),
	 chatDelta([chatToolCall("call_r", { name: "read", arguments: '{"path":"a.txt"}' })]),
	 chatDelta([chatToolCall("call_e", { arguments: '{"command":"echo hi"}' })]),
	 finishDelta(),
	].join("\n\n");
	const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

	assert.ok(!body.includes("echo hi"), "the injected call's own fragment never reaches the host");
	assert.ok(!body.includes('"name":"edit"'), "the injected placeholder name never reaches the host");
	const flushed = flushedChatCalls(body);
	assert.equal(flushed.length, 1, "exactly the real call flushes");
	assert.equal(flushed[0].index, 1, "the real call was re-homed: index 0 was claimed by the (dropped) placeholder");
	assert.deepEqual(JSON.parse(flushed[0].function.arguments), { path: "a.txt" }, "complete arguments, untouched by the dropped call's fragment");
 });

 test("chat stream: colliding non-repairable and repairable calls rewrite indices without cross-contamination", async () => {
	// One upstream index shared by a repairable (buffered) id-bearing call and
	// a non-repairable one: the repairable packet is withheld and flushes
	// whole at its first index; the non-repairable call keeps streaming
	// incrementally at the fresh index, its fragments never touching the
	// buffered packet.
	const todoSchema = {
	 type: "object",
	 properties: {
		list: {
		 type: "array",
		 items: {
			type: "object",
			properties: { phase: { type: "string" }, items: { type: "array", items: { type: "string" } } },
			required: ["phase", "items"],
		 },
		},
	 },
	 required: ["list"],
	};
	const cloak: StreamCloakOptions = {
	 callerHadTools: true,
	 caseRestore: {},
	 findGlob: { renamedFindToGlob: false },
	 injected: [],
	 argSchemas: new Map([["todo", todoSchema]]),
	 pathname: "/v1/chat/completions",
	};
	const sse = [
	 chatDelta([chatToolCall("call_t", { name: "todo", arguments: JSON.stringify({ list: [{ phase: "R", items: ["a"] }] }) })]),
	 chatDelta([chatToolCall("call_w", { name: "widget" })]),
	 chatDelta([chatToolCall("call_w", { arguments: '{"q":"cats"}' })]),
	 finishDelta(),
	].join("\n\n");
	const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

	const flushed = flushedChatCalls(body);
	assert.equal(flushed.length, 1);
	assert.equal(flushed[0].index, 0, "the repairable call keeps its first index");
	assert.deepEqual(JSON.parse(flushed[0].function.arguments), { list: [{ phase: "R", items: ["a"] }] }, "whole packet, uncontaminated");
	assert.ok(!JSON.stringify(flushed).includes("cats"), "the widget's streamed fragment never lands in the buffered packet");

	const widgetDeltas = dataFrames(body)
	 .flatMap((frame) => frame.choices?.[0]?.delta?.tool_calls ?? [])
	 .filter((c) => c.id === "call_w");
	assert.deepEqual(widgetDeltas.map((c) => c.index), [1, 1], "both widget deltas rewritten to the fresh host index");
	const fragment = widgetDeltas.filter((c) => typeof c.function?.arguments === "string")[0];
	assert.equal(fragment.function.arguments, '{"q":"cats"}', "non-repairable arguments keep streaming unchanged");
 });

 test("chat stream: id-less fragments colliding at one index stay merged (legacy pin)", async () => {
	// Explicit PIN, not a regression fix: id-less calls all labelled index 0
	// that genuinely merge into one fragment stream keep today's salvage-last
	// behavior — one state bucket per index (idx:N), the buffer is the raw
	// concatenation, and the terminal flush salvages the last parseable
	// object. Without an id there is no truth to split by; this stays
	// unmanaged by design.
	const todoSchema = {
	 type: "object",
	 properties: {
		list: {
		 type: "array",
		 items: {
			type: "object",
			properties: { phase: { type: "string" }, items: { type: "array", items: { type: "string" } } },
			required: ["phase", "items"],
		 },
		},
	 },
	 required: ["list"],
	};
	const cloak: StreamCloakOptions = {
	 callerHadTools: true,
	 caseRestore: {},
	 findGlob: { renamedFindToGlob: false },
	 injected: [],
	 argSchemas: new Map([["todo", todoSchema]]),
	 pathname: "/v1/chat/completions",
	};
	const sse = [
	 chatDelta([{ index: 0, type: "function", function: { name: "todo", arguments: '{"list":[{"phase":"R","items":["a"]}]}' } }]),
	 chatDelta([{ index: 0, function: { arguments: '{"list":[{"phase":"S","items":["b"]}]}' } }]),
	 finishDelta(),
	].join("\n\n");
	const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

	const flushed = flushedChatCalls(body);
	assert.equal(flushed.length, 1, "the merged bucket flushes exactly one call");
	assert.equal(flushed[0].index, 0);
	assert.equal(flushed[0].function.name, "todo");
	assert.deepEqual(
	 JSON.parse(flushed[0].function.arguments),
	 { list: [{ phase: "S", items: ["b"] }] },
	 "the last parseable object wins the salvage, exactly as before",
	);
 });

 test("chat stream: single-call classic stream is byte-identical across the rework", async () => {
	// Byte-identity pin (requirement 5): one tool call, no collisions — same
	// delta passthrough (arguments removed only for buffered calls), same
	// flush shape {index,type,function}, same index values.
	const readSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
	const cloak: StreamCloakOptions = {
	 callerHadTools: true,
	 caseRestore: {},
	 findGlob: { renamedFindToGlob: false },
	 injected: [],
	 argSchemas: new Map([["read", readSchema]]),
	 pathname: "/v1/chat/completions",
	};
	const sse = [
	 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_r","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
	 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
	 "data: [DONE]",
	].join("\n\n");
	const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

	assert.equal(
	 body,
	 [
		'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_r","type":"function","function":{"name":"read"}}]}}]}\n\n',
		'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
		"data: [DONE]\n\n",
	 ].join(""),
	);
 });

 test("messages stream: synthesized flush carries its content_block_delta event line", async () => {
 // Both hosts filter SSE frames by their `event:` field, so a synthesized
 // frame emitted data-only was dropped and the repaired arguments never
 // reached the tool call.
 const todoSchema = {
  type: "object",
  properties: {
   list: {
    type: "array",
    items: {
     type: "object",
     properties: {
      phase: { type: "string" },
      items: { type: "array", items: { type: "string" } },
     },
     required: ["phase", "items"],
    },
   },
  },
  required: ["list"],
 };
 const cloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: {},
  findGlob: { renamedFindToGlob: false },
  injected: [],
  argSchemas: new Map([["todo", todoSchema]]),
  pathname: "/v1/messages",
 };
 const malformed = JSON.stringify({ list: { item: [{ phase: "R", items: ["a"] }] } });
 const sse = [
  'data: {"type":"message_start","message":{"id":"msg_stream_3","model":"m"}}',
  `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_todo", name: "todo" } })}`,
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: malformed } })}`,
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
 ].join("\n\n");

 const body = await runStreamed(sse, "/v1/messages", cloak, thirds(sse));

 // The upstream deltas were buffered (they carry no name), so the only frame
 // bearing the repaired input is the one synthesized ahead of the stop block.
 const flushed = body.split("\n\n").find((block) => block.includes("input_json_delta"));
 assert.ok(flushed, "repaired arguments are re-emitted when the block stops");
 assert.ok(
  flushed!.startsWith("event: content_block_delta\ndata: "),
  "the synthesized delta must carry its event line for event-filtering hosts",
 );
 const parsed = JSON.parse(flushed!.slice(flushed!.indexOf("data: ") + 6)) as {
  delta: { partial_json: string };
 };
 assert.deepEqual(
  JSON.parse(parsed.delta.partial_json),
  { list: [{ phase: "R", items: ["a"] }] },
  "the frame carries the repaired (envelope-unwrapped) arguments",
 );
});

test("chat stream: a restated full name on the arguments frame reaches the host once", async () => {
 // OpenCode Zen streams one call as a name-only frame followed by a frame
 // restating the whole name WITH the arguments (observed live 2026-10-22).
 // Hosts concatenate streamed name deltas, so forwarding the second copy hands
 // them `get_weatherget_weather` — a name no declared tool matches. The repeat
 // header is authoritative: it replaces the accumulated name and stays off the
 // wire when the host already holds it.
 const cloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: { get_weather: "Get_Weather" },
  findGlob: { renamedFindToGlob: false },
  injected: [],
  pathname: "/v1/chat/completions",
 };
 const sse = [
  chatDelta([chatToolCall("call_w", { name: "get_weather" })]),
  chatDelta([chatToolCall("call_w", { name: "get_weather", arguments: '{"city":"Tokyo"}' })]),
  finishDelta(),
 ].join("\n\n");
 const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

 const deltas = dataFrames(body).flatMap((frame) => frame.choices?.[0]?.delta?.tool_calls ?? []);
 assert.deepEqual(
  deltas.filter((c) => typeof c.function?.name === "string").map((c) => c.function.name),
  ["Get_Weather"],
  "the name is emitted exactly once, restored to the caller's casing",
 );
 assert.deepEqual(
  deltas.filter((c) => typeof c.function?.arguments === "string").map((c) => c.function.arguments),
  ['{"city":"Tokyo"}'],
  "the arguments still flow, on their own frame",
 );
 assert.ok(!body.includes("get_weatherget_weather"), "the doubled name never reaches the host");
});

test("chat stream: a name split across deltas reassembles into the flushed call", async () => {
 // The piecewise shape must keep appending: replacing on every name delta
 // would leave the flushed call named after its last fragment only.
 const weatherSchema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
 const cloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: {},
  findGlob: { renamedFindToGlob: false },
  injected: [],
  argSchemas: new Map([["get_weather", weatherSchema]]),
  pathname: "/v1/chat/completions",
 };
 const sse = [
  chatDelta([chatToolCall("call_w", { name: "get_" })]),
  chatDelta([chatToolCall("call_w", { name: "weather" })]),
  chatDelta([chatToolCall("call_w", { arguments: '{"city":"Tokyo"}' })]),
  finishDelta(),
 ].join("\n\n");
 const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

 const flushed = flushedChatCalls(body);
 assert.equal(flushed.length, 1, "one call flushes");
 assert.equal(flushed[0].function.name, "get_weather", "name fragments append, so the flush carries the whole name");
 assert.deepEqual(JSON.parse(flushed[0].function.arguments), { city: "Tokyo" });
});

test("chat stream: repeated function.name on second argument delta preserves first delta's buffered arguments", async () => {
 const weatherSchema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
 const cloak: StreamCloakOptions = {
  callerHadTools: true,
  caseRestore: {},
  findGlob: { renamedFindToGlob: false },
  injected: [],
  argSchemas: new Map([["get_weather", weatherSchema]]),
  pathname: "/v1/chat/completions",
 };
 const sse = [
  chatDelta([chatToolCall("call_w", { name: "get_weather", arguments: '{"city":' })]),
  chatDelta([chatToolCall("call_w", { name: "get_weather", arguments: '"Tokyo"}' })]),
  finishDelta(),
 ].join("\n\n") + "\n\n";
 const body = await runStreamed(sse, "/v1/chat/completions", cloak, thirds(sse));

 const flushed = flushedChatCalls(body);
 assert.equal(flushed.length, 1, "one call flushes");
 assert.equal(flushed[0].function.name, "get_weather");
 assert.deepEqual(JSON.parse(flushed[0].function.arguments), { city: "Tokyo" });
});
