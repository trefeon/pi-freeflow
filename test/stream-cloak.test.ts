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
 ].join("\n\n");

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
