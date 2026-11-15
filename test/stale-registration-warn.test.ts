/**
 * Stale provider-registration guard (src/proxy.ts): a model whose catalog
 * entry declares an `api` flavor but arrives on the wrong path means the
 * host still holds a pre-fix provider registration. The proxy logs a
 * "stale provider registration" warning and still proxies an active request
 * (warn-only for catalog entries). A model on its matching path warns nothing.
 *
 * NOTE: only models with a declared `api` can reach that branch, and since
 * 2026-10-22 the static catalog declares none — the Zen muse-spark contributor
 * ids retired on 2026-10-17/18 and Cline's Muse Spark 1.3 (the last
 * `api: "openai-responses"` entry) stopped resolving upstream. The guard stays
 * wired for a future non-chat entry and re-arms by itself; locked in below: it
 * must never warn for models without a declared api, and a chat model on
 * /v1/responses is a silent passthrough, not a warning.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.ts";
import { getActiveRelayState, resetAllRelayHealth, setActiveRelayState } from "../src/relay-state.ts";
import { readRecentLogs } from "../src/logger.ts";
import { _resetFreeTierHintForTest, _resetUpstreamHealthForTest } from "../src/upstream-health.ts";
import { ALL_MODELS } from "../src/models.ts";
import { authHeaders } from "./_auth.ts";

const CHAT_MODEL = "mimo-v2.6-flash-free";
// A host that upgraded from a pre-2026-10-22 build can still hold this retired
// Cline id in its provider registration. It is no longer in the active catalog.
const RETIRED_CLINE_MODEL = "cline-free/muse-spark-1.3-contributor";

const CHAT_SSE = 'data: {"id":"chatcmpl-1","model":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\ndata: [DONE]\n\n';
const RESPONSES_SSE = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[]}}\n\n';

function warnCount(): number {
 return readRecentLogs("warn", null, 200, "stale provider registration").lines.length;
}

function newWarnsSince(before: number): string[] {
 return readRecentLogs("warn", null, 200, "stale provider registration").lines.slice(before);
}

async function withProxy(fn: (port: number) => Promise<void>): Promise<void> {
 _resetUpstreamHealthForTest();
 _resetFreeTierHintForTest();
 const prior = getActiveRelayState();
 const mock = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
   res.writeHead(200, { "content-type": "text/event-stream" });
   res.end(req.url?.endsWith("/responses") ? RESPONSES_SSE : CHAT_SSE);
  });
 });
 let mockPort = 0;
 await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => {
  const addr = mock.address();
  if (addr && typeof addr === "object") mockPort = addr.port;
  resolve();
 }));
 const { server, port } = await startProxy(0);
 const realFetch = globalThis.fetch.bind(globalThis);
 const localPrefix = `http://127.0.0.1:${port}`;
 const fetchMock = test.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith(localPrefix)) return realFetch(u, init);
  return realFetch(`http://127.0.0.1:${mockPort}${new URL(u).pathname}`, init);
 });
 try {
  setActiveRelayState({ relays: [], mode: "auto", enabled: false, url: "" }, false);
  resetAllRelayHealth();
  await fn(port);
 } finally {
  fetchMock.mock.restore();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  setActiveRelayState(prior, false);
  _resetUpstreamHealthForTest();
  _resetFreeTierHintForTest();
 }
}

async function post(port: number, path: string, body: unknown): Promise<{ status: number; text: string }> {
 const res = await fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...authHeaders() },
  body: JSON.stringify(body),
 });
 return { status: res.status, text: await res.text() };
}

test("stale registration guard is dormant: no static model declares a non-chat api", async () => {
 // The guard's positive branch needs `knownDef.api` to differ from the path.
 // With the responses entries retired there is nothing left to trip it — if a
 // future entry declares one, this assertion fails and the guard's live
 // coverage must be restored alongside it.
 const declared = ALL_MODELS.filter((m) => m.api !== undefined && m.api !== "openai-completions");
 assert.deepEqual(declared.map((m) => m.id), [], "no static model may declare a non-chat api while the guard is untested end to end");

 await withProxy(async (port) => {
  const before = warnCount();
   // A stale host still holding the retired Cline id receives the same local
   // catalog rejection as every other unknown model, without a stale-path warning.
   const chat = await post(port, "/v1/chat/completions", { model: RETIRED_CLINE_MODEL, messages: [{ role: "user", content: "hi" }], stream: false });
   assert.equal(chat.status, 400);
   assert.equal(JSON.parse(chat.text).error.code, "model_not_found");
   const messages = await post(port, "/v1/messages", { model: RETIRED_CLINE_MODEL, messages: [{ role: "user", content: "hi" }] });
   assert.equal(messages.status, 400);
   assert.equal(JSON.parse(messages.text).error.code, "model_not_found");
  assert.equal(newWarnsSince(before).length, 0, "an id with no catalog definition must never warn");
 });
});

test("stale registration: chat model without declared api passes silently on responses path", async () => {
 await withProxy(async (port) => {
  const before = warnCount();
  const res = await post(port, "/v1/responses", { model: CHAT_MODEL, input: "hi", stream: false });
  assert.equal(res.status, 200, "request must still proxy");
  assert.equal(newWarnsSince(before).length, 0, "chat model with no declared api must not warn (guard needs knownDef.api)");
 });
});

test("stale registration: matching model+path emits no warning", async () => {
 await withProxy(async (port) => {
  const before = warnCount();
  const res = await post(port, "/v1/chat/completions", { model: CHAT_MODEL, messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(res.status, 200);
  assert.equal(newWarnsSince(before).length, 0, "chat model on /v1/chat/completions must not warn");
 });
});
