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
