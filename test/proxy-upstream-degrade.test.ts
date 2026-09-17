/**
 * Zen upstream degradation: gate tracking, chat + responses failover, 403
 * hint, canary recovery, and resume auto-fix (a session Zen just refused
 * fails over on retry instead of replaying the refusal).
 *
 * Two consecutive 403 free-tier gates trip the Zen gate; afterwards refused
 * and fresh sessions fail over to a healthy Kilo model on the same wire API
 * while working sessions pass through. Upstream is a stubbed global fetch
 * (localhost seam passthrough) — no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { classifyZenFailover, startProxy } from "../src/proxy.ts";
import {
 decideZenRoute,
 _resetFreeTierHintForTest,
 _resetUpstreamHealthForTest,
 isUpstreamGated,
 recordUpstreamFailure,
 recordUpstreamSuccess,
 rememberGateRejection,
 withFreeTierHint,
} from "../src/upstream-health.ts";
import { prepareResponsesFailoverBody } from "../src/responses.ts";
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
const RESPONSES_MODEL = "muse-spark-1.3-contributor-free";
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

function responsesBody(model: string, text: string, key?: string): string {
 const body: Record<string, unknown> = {
  model,
  stream: false,
  store: false,
  input: text,
 };
 if (key !== undefined) body.prompt_cache_key = key;
 return JSON.stringify(body);
}

function newResponses(text = "hello"): Record<string, unknown> {
 return JSON.parse(responsesBody(RESPONSES_MODEL, text));
}

// ── Branch decision while ungated ────────────────────────────────────────────

test("degrade: ungated zen chat passes through (kilo/responses/empty too)", () => {
 _resetUpstreamHealthForTest();
 assert.equal(isUpstreamGated("zen"), false);
 assert.deepEqual(
  classifyZenFailover(newChat(), "/v1/chat/completions"),
  { action: "passthrough" },
 );
 assert.deepEqual(
  classifyZenFailover(
   JSON.parse(chatBody("nemotron-3-nano-omni", "hello")),
   "/v1/chat/completions",
  ),
  { action: "passthrough" },
  "kilo models never fail over",
 );
 assert.deepEqual(
  classifyZenFailover(newChat(), "/v1/responses"),
  { action: "passthrough" },
  "responses-path routing always passes through",
 );
 assert.deepEqual(classifyZenFailover(null, "/v1/chat/completions"), {
  action: "passthrough",
 });
 assert.deepEqual(
  classifyZenFailover({ model: 42 }, "/v1/chat/completions"),
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
  decideZenRoute(newChat(), "/v1/chat/completions"),
  "canary",
  "first gated fresh session is the canary and passes through",
 );
 const decision = classifyZenFailover(newChat(), "/v1/chat/completions");
 assert.equal(decision.action, "failover");
 if (decision.action === "failover") {
  assert.ok(
   KILO_MODEL_IDS.has(resolveCanonicalModelId(decision.model)),
   `failover target must be a Kilo model, got ${decision.model}`,
  );
 }

 recordUpstreamSuccess("zen", { sessionKey: "sess-proven" });
 assert.deepEqual(
  classifyZenFailover(
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
  classifyZenFailover(multiTurn, "/v1/chat/completions"),
  { action: "passthrough" },
  "multi-turn continuations pass through while gated",
 );
 assert.deepEqual(classifyZenFailover(newResponses(), "/v1/chat/completions"), {
  action: "passthrough",
 });
 const respDecision = classifyZenFailover(newResponses(), "/v1/responses");
 assert.equal(respDecision.action, "failover");
 if (respDecision.action === "failover") {
  assert.ok(
   KILO_MODEL_IDS.has(resolveCanonicalModelId(respDecision.model)),
   `responses failover target must be a Kilo model, got ${respDecision.model}`,
  );
 }
});

test("degrade: first gated fresh session is the canary, crossed bodies pass through", () => {
 _resetUpstreamHealthForTest();
 recordUpstreamFailure("zen", 403, GATE_BODY);
 recordUpstreamFailure("zen", 403, GATE_BODY);
 assert.equal(isUpstreamGated("zen"), true);
 assert.deepEqual(classifyZenFailover(newChat(), "/v1/chat/completions"), {
  action: "canary",
 });
 const respFirst = classifyZenFailover(newResponses(), "/v1/responses");
 assert.equal(respFirst.action, "failover");
 if (respFirst.action === "failover") {
  assert.ok(
   KILO_MODEL_IDS.has(resolveCanonicalModelId(respFirst.model)),
   `responses failover target must be a Kilo model, got ${respFirst.model}`,
  );
 }
 assert.deepEqual(
  classifyZenFailover(newChat(), "/v1/responses"),
  { action: "passthrough" },
  "crossed bodies never fail over",
 );
 recordUpstreamSuccess("zen", { canary: true });
 assert.equal(isUpstreamGated("zen"), false, "canary success clears the gate");
 _resetUpstreamHealthForTest();
});

test("degrade: refused sessions fail over on retry, even proven or multi-turn", () => {
 _resetUpstreamHealthForTest();
 recordUpstreamFailure("zen", 403, GATE_BODY);
 recordUpstreamFailure("zen", 403, GATE_BODY);
 assert.equal(isUpstreamGated("zen"), true);

 const resumedChat = JSON.parse(chatBody(ZEN_MODEL, "resumed hello", "sess-resumed-chat"));
 resumedChat.messages.push({ role: "assistant", content: "old reply" });
 resumedChat.messages.push({ role: "user", content: "resumed hello" });
 assert.deepEqual(
  classifyZenFailover(resumedChat, "/v1/chat/completions"),
  { action: "passthrough" },
  "multi-turn replays pass through until refused",
 );
 rememberGateRejection(resumedChat, "/v1/chat/completions", 403, GATE_BODY);
 const retry = classifyZenFailover(resumedChat, "/v1/chat/completions");
 assert.equal(retry.action, "failover", "refused replay fails over on retry");

 const keyed = JSON.parse(responsesBody(RESPONSES_MODEL, "resume me", "sess-resumed-resp"));
 recordUpstreamSuccess("zen", { sessionKey: "sess-resumed-resp" });
 assert.deepEqual(
  classifyZenFailover(keyed, "/v1/responses"),
  { action: "passthrough" },
  "proven sessions pass through until refused",
 );
 rememberGateRejection(keyed, "/v1/responses", 403, GATE_BODY);
 assert.equal(
  classifyZenFailover(keyed, "/v1/responses").action,
  "failover",
  "proven-but-refused sessions fail over on retry",
 );
 _resetUpstreamHealthForTest();
});

test("degrade: responses failover bodies drop Zen-bound state", () => {
 const fresh = newResponses();
 prepareResponsesFailoverBody(fresh);
 assert.equal(fresh.model, RESPONSES_MODEL);
 assert.ok(!("previous_response_id" in fresh));

 const resumed = newResponses();
 resumed.previous_response_id = "resp_zen_123";
 resumed.input = [
  { type: "message", role: "user", content: "hi" },
  { type: "reasoning", encrypted_content: "zen-blob", summary: [] },
 ];
 prepareResponsesFailoverBody(resumed);
 assert.ok(!("previous_response_id" in resumed));
 assert.ok(Array.isArray(resumed.input));
 const [first, second] = resumed.input;
 assert.ok(typeof first === "object" && first !== null && "type" in first && first.type === "message");
 assert.ok(typeof second === "object" && second !== null && !("encrypted_content" in second));
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

   const postResponses = (body: string): Promise<Response> =>
    fetch(`${localPrefix}/v1/responses`, {
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

   const respServed = await postResponses(
    responsesBody(RESPONSES_MODEL, "e2e-resp-fresh"),
   );
   assert.equal(respServed.status, 200, "fresh responses fail over while gated");
   const respBody: Record<string, unknown> = await respServed.json();
   assert.equal(respBody.served_by, "kilo");
   assert.ok(
    KILO_MODEL_IDS.has(resolveCanonicalModelId(String(respBody.model))),
    `responses failover must serve a Kilo model, got ${String(respBody.model)}`,
   );

   const resumed = JSON.parse(chatBody(ZEN_MODEL, "e2e resumed hello"));
   resumed.messages.push({ role: "assistant", content: "old reply" });
   resumed.messages.push({ role: "user", content: "e2e resumed hello" });
   const resumedText = JSON.stringify(resumed);
   const refused = await post(resumedText);
   assert.equal(refused.status, 403, "resumed replay passes through until refused");
   const healed = await post(resumedText);
   assert.equal(healed.status, 200, "resumed retry fails over after the refusal");
   const healedBody: Record<string, unknown> = await healed.json();
   assert.equal(healedBody.served_by, "kilo");
  } finally {
   _resetUpstreamHealthForTest();
   _resetFreeTierHintForTest();
   resetAllRelayHealth();
   setActiveRelayState(priorState, false);
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});
