/**
 * Zen upstream degradation: gate tracking, new-session chat failover, 403 hint.
 *
 * Two consecutive 403 free-tier gates trip the Zen gate; afterwards new
 * (never proven) chat sessions fail over to a healthy Kilo model on the same
 * wire API while proven sessions and responses requests pass through.
 * Upstream is a stubbed global fetch (localhost seam passthrough) — no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { classifyZenChatFailover, startProxy } from "../src/proxy.ts";
import {
 decideZenChatRoute,
 _resetFreeTierHintForTest,
 _resetUpstreamHealthForTest,
 isUpstreamGated,
 recordUpstreamFailure,
 recordUpstreamSuccess,
 withFreeTierHint,
} from "../src/upstream-health.ts";
import { isRetriableStatus } from "../src/relay.ts";
import {
 getActiveRelayState,
 resetAllRelayHealth,
 setActiveRelayState,
} from "../src/relay-state.ts";
import { RELAY_STATE_FILE } from "../src/config.ts";
import { KILO_MODEL_IDS, resolveCanonicalModelId } from "../src/models.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;
const TEST_PORT = 19291;
const ZEN_MODEL = "mimo-v2.5-free";
const GATE_BODY = JSON.stringify({
 error: {
  code: "FreeTierError",
  message: "OpenCode's free tier can only be used from within OpenCode",
 },
});

/** Read a stubbed-fetch request body regardless of how the caller encoded it. */
function requestText(body: unknown): string {
 if (typeof body === "string") return body;
 if (body instanceof Uint8Array) {
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
 }
 if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
 return "";
}

/** Isolate both main and .bak disk files for the duration of an async test. */
function withIsolatedRelayFiles(fn: () => Promise<void>): Promise<void> {
 const read = (p: string): string | null =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
 const mainBefore = read(RELAY_STATE_FILE);
 const bakBefore = read(BAK_FILE);
 return (async () => {
  try {
   await fn();
  } finally {
   const restore = (p: string, before: string | null): void => {
    if (before !== null) {
     fs.writeFileSync(p, before, "utf8");
    } else {
     try {
      fs.rmSync(p, { force: true });
     } catch { }
    }
   };
   restore(RELAY_STATE_FILE, mainBefore);
   restore(BAK_FILE, bakBefore);
  }
 })();
}

/** Real Response stub (supports the clone().text() peek the proxy performs). */
function jsonResponse(status: number, body: string): Response {
 return new Response(body, {
  status,
  headers: { "content-type": "application/json" },
 });
}

function chatBody(model: string, text: string, key?: string): string {
 const body: Record<string, unknown> = {
  model,
  stream: false,
  messages: [{ role: "user", content: text }],
 };
 if (key !== undefined) body.prompt_cache_key = key;
 return JSON.stringify(body);
}

function newChat(text = "hello"): Record<string, unknown> {
 return JSON.parse(chatBody(ZEN_MODEL, text));
}

// ── Branch decision while ungated ────────────────────────────────────────────

test("degrade: ungated zen chat passes through (kilo/responses/empty too)", () => {
 _resetUpstreamHealthForTest();
 assert.equal(isUpstreamGated("zen"), false);
 assert.deepEqual(
  classifyZenChatFailover(newChat(), "/v1/chat/completions"),
  { action: "passthrough" },
 );
 assert.deepEqual(
  classifyZenChatFailover(
   JSON.parse(chatBody("nemotron-3-nano-omni", "hello")),
   "/v1/chat/completions",
  ),
  { action: "passthrough" },
  "kilo models never fail over",
 );
 assert.deepEqual(
  classifyZenChatFailover(newChat(), "/v1/responses"),
  { action: "passthrough" },
  "responses-path routing always passes through",
 );
 assert.deepEqual(classifyZenChatFailover(null, "/v1/chat/completions"), {
  action: "passthrough",
 });
 assert.deepEqual(
  classifyZenChatFailover({ model: 42 }, "/v1/chat/completions"),
  { action: "passthrough" },
 );
});

// ── Gate trips on two qualifying 403s; failover + proven passthrough ─────────

test("degrade: two 403 gates trip zen; new chat fails over, proven passes through", () => {
 _resetUpstreamHealthForTest();
 assert.equal(isUpstreamGated("zen"), false);

 recordUpstreamFailure("zen", 403, GATE_BODY);
 assert.equal(isUpstreamGated("zen"), false, "single gate must not trip yet");
 recordUpstreamFailure("zen", 403, GATE_BODY);
 assert.equal(isUpstreamGated("zen"), true);

 assert.equal(
  decideZenChatRoute(newChat(), "/v1/chat/completions"),
  "canary",
  "first gated fresh session is the canary and passes through",
 );
 const decision = classifyZenChatFailover(newChat(), "/v1/chat/completions");
 assert.equal(decision.action, "failover");
 if (decision.action === "failover") {
  assert.ok(
   KILO_MODEL_IDS.has(resolveCanonicalModelId(decision.model)),
   `failover target must be a Kilo model, got ${decision.model}`,
  );
 }

 recordUpstreamSuccess("zen", { sessionKey: "sess-proven" });
 assert.deepEqual(
  classifyZenChatFailover(
   JSON.parse(chatBody(ZEN_MODEL, "hello again", "sess-proven")),
   "/v1/chat/completions",
  ),
  { action: "passthrough" },
  "proven sessions are never rerouted",
 );

 const multiTurn = newChat();
 multiTurn.messages = [
  { role: "user", content: "first" },
  { role: "assistant", content: "reply" },
  { role: "user", content: "follow-up" },
 ];
 assert.deepEqual(
  classifyZenChatFailover(multiTurn, "/v1/chat/completions"),
  { action: "passthrough" },
  "multi-turn continuations pass through while gated",
 );
 assert.deepEqual(
  classifyZenChatFailover(newChat(), "/v1/responses"),
  { action: "passthrough" },
  "responses requests always pass through while gated",
 );
});

test("degrade: non-gate failures never trip the zen gate", () => {
 _resetUpstreamHealthForTest();
 recordUpstreamFailure("zen", 403, JSON.stringify({ error: "forbidden" }));
 recordUpstreamFailure("zen", 403, JSON.stringify({ error: "forbidden" }));
 recordUpstreamFailure("zen", 500, GATE_BODY);
 assert.equal(isUpstreamGated("zen"), false);
 assert.equal(isRetriableStatus(403), false, "403 stays a terminal verdict");
 _resetUpstreamHealthForTest();
});

// ── Hint wrapping without network ────────────────────────────────────────────

test("degrade: 403 gate body carries a recovery hint, others pass through", () => {
 _resetFreeTierHintForTest();
 const hinted: Record<string, unknown> = JSON.parse(withFreeTierHint(403, GATE_BODY));
 const hintedError = hinted.error;
 assert.ok(hintedError && typeof hintedError === "object" && "code" in hintedError);
 assert.equal(hintedError.code, "FreeTierError", "upstream error survives hint wrapping");
 assert.equal(typeof hinted.hint, "string");
 assert.ok(typeof hinted.hint === "string" && hinted.hint.length > 0);

 _resetFreeTierHintForTest();
 assert.equal(withFreeTierHint(429, GATE_BODY), GATE_BODY);
 assert.equal(withFreeTierHint(200, GATE_BODY), GATE_BODY);
 assert.equal(
  withFreeTierHint(403, JSON.stringify({ error: "forbidden" })),
  JSON.stringify({ error: "forbidden" }),
  "non-gate 403 bodies pass through untouched",
 );
 _resetFreeTierHintForTest();
});

// ── End-to-end through the real proxy (stubbed upstream) ─────────────────────

test("degrade e2e: gate x2 then new chat served as Kilo, proven stays on zen", async (t) => {
 await withIsolatedRelayFiles(async () => {
  const priorState = getActiveRelayState();
  setActiveRelayState({ enabled: true, url: "", relays: [] }, false);
  resetAllRelayHealth();
  _resetUpstreamHealthForTest();
  _resetFreeTierHintForTest();

  const { server, port } = await startProxy(TEST_PORT);
  const effectivePort = port ?? TEST_PORT;
  const localPrefix = `http://127.0.0.1:${effectivePort}`;
  const realFetch = globalThis.fetch.bind(globalThis);
  try {
   t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init?: RequestInit) => {
     const u = String(url);
     if (u.startsWith(localPrefix)) return realFetch(u, init);
     const sent = requestText(init?.body);
     if (u.includes("api.kilo.ai")) {
      const sentBody: { model?: unknown } = JSON.parse(sent);
      const received = String(sentBody.model);
      return jsonResponse(
       200,
       JSON.stringify({ served_by: "kilo", model: received }),
      );
     }
     if (sent.includes("proven-e2e")) {
      return jsonResponse(
       200,
       JSON.stringify({ served_by: "zen", model: ZEN_MODEL }),
      );
     }
     return jsonResponse(403, GATE_BODY);
    },
   );

   const post = (body: string): Promise<Response> =>
    fetch(`${localPrefix}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body,
    });

   const provenFirst = await post(
    chatBody(ZEN_MODEL, "proven-e2e hello", "e2e-proven-1"),
   );
   assert.equal(provenFirst.status, 200);

   for (let i = 0; i < 2; i++) {
    const gated = await post(chatBody(ZEN_MODEL, `fresh-${i}`));
    assert.equal(gated.status, 403);
    const gatedBody: Record<string, unknown> = await gated.json();
    if (i === 0) {
     assert.equal(
      typeof gatedBody.hint,
      "string",
      "first gate 403 must carry the recovery hint",
     );
    }
   }

   let failedOver: Record<string, unknown> | null = null;
   for (let i = 0; i < 6 && failedOver === null; i++) {
    const attempt = await post(chatBody(ZEN_MODEL, `fresh-after-${i}`));
    if (attempt.status !== 200) continue;
    const body: Record<string, unknown> = await attempt.json();
    if (body.served_by === "kilo") failedOver = body;
   }
   assert.ok(
    failedOver !== null,
    "a new chat session must fail over to Kilo while zen is gated",
   );
   assert.ok(
    KILO_MODEL_IDS.has(
     resolveCanonicalModelId(String(failedOver.model)),
    ),
    `failover must serve a Kilo model, got ${String(failedOver.model)}`,
   );

   const stillZen = await post(
    chatBody(ZEN_MODEL, "proven-e2e hello", "e2e-proven-1"),
   );
   assert.equal(stillZen.status, 200);
   const stillBody: Record<string, unknown> = await stillZen.json();
   assert.equal(
    stillBody.served_by,
    "zen",
    "proven sessions keep passing through to zen while gated",
   );
  } finally {
   _resetUpstreamHealthForTest();
   _resetFreeTierHintForTest();
   resetAllRelayHealth();
   setActiveRelayState(priorState, false);
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});
