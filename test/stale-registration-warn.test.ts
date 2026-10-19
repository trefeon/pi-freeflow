/**
 * Stale provider-registration guard (src/proxy.ts): a model whose catalog
 * entry declares an `api` flavor but arrives on the wrong path means the
 * host still holds a pre-fix provider registration. The proxy must log a
 * "stale provider registration" warning and still proxy the request
 * (warn-only, never blocked). A model on its matching path warns nothing.
 *
 * NOTE: only models with a declared `api` can trip the guard — catalog
 * chat models declare no `api`, so a chat model on /v1/responses is
 * (observably) a silent passthrough, locked in below. The guard is also
 * Zen-lane only: the Cline responses model on a chat/messages path is
 * served verbatim without a warning (locked in below).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startProxy } from "../src/proxy.ts";
import { getActiveRelayState, resetAllRelayHealth, setActiveRelayState } from "../src/relay-state.ts";
import { readRecentLogs } from "../src/logger.ts";
import { _resetFreeTierHintForTest, _resetUpstreamHealthForTest } from "../src/upstream-health.ts";
import { CLINE_POOL_FILE, _resetClinePoolCacheForTest } from "../src/cline-accounts.ts";

// The only static catalog entry that declares api: "openai-responses" is the
// Cline Muse Spark model (the Zen muse-spark contributor ids were retired
// upstream). A Cline request needs one pool slot so the lane reaches the
// stubbed upstream instead of failing auth first.
const RESPONSES_MODEL = "cline-free/muse-spark-1.3-contributor";
const CHAT_MODEL = "mimo-v2.6-flash-free";
const CLINE_POOL_FIXTURE = JSON.stringify({
	accounts: [{ slot: "stale-warn-fixture", token: "workos:fixture", addedAt: new Date(0).toISOString() }],
});

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
 const priorPool = fs.existsSync(CLINE_POOL_FILE) ? fs.readFileSync(CLINE_POOL_FILE, "utf8") : null;
 fs.mkdirSync(path.dirname(CLINE_POOL_FILE), { recursive: true });
 fs.writeFileSync(CLINE_POOL_FILE, CLINE_POOL_FIXTURE, { mode: 0o600 });
 _resetClinePoolCacheForTest();
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
  if (priorPool === null) fs.rmSync(CLINE_POOL_FILE, { force: true });
  else fs.writeFileSync(CLINE_POOL_FILE, priorPool, "utf8");
  _resetClinePoolCacheForTest();
  _resetUpstreamHealthForTest();
  _resetFreeTierHintForTest();
 }
}

async function post(port: number, path: string, body: unknown): Promise<{ status: number; text: string }> {
 const res = await fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
 });
 return { status: res.status, text: await res.text() };
}

test("stale registration guard is Zen-only: a Cline responses model on chat/messages paths warns nothing", async () => {
 await withProxy(async (port) => {
  const before = warnCount();
  const chat = await post(port, "/v1/chat/completions", { model: RESPONSES_MODEL, messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(chat.status, 200, "mismatched Cline request must still proxy verbatim");
  const messages = await post(port, "/v1/messages", { model: RESPONSES_MODEL, messages: [{ role: "user", content: "hi" }] });
  assert.notEqual(messages.status, 400, "mismatched request must not be rejected by the proxy itself");
  assert.equal(
   newWarnsSince(before).length,
   0,
   "the guard only runs on the Zen lane; the Zen responses clause is dormant until a Zen responses model returns",
  );
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
  const res = await post(port, "/v1/responses", { model: RESPONSES_MODEL, input: "hi", stream: false });
  assert.equal(res.status, 200);
  assert.equal(newWarnsSince(before).length, 0, "responses model on /v1/responses must not warn");
  const beforeChat = warnCount();
  const chat = await post(port, "/v1/chat/completions", { model: CHAT_MODEL, messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(chat.status, 200);
  assert.equal(newWarnsSince(beforeChat).length, 0, "chat model on /v1/chat/completions must not warn");
 });
});
