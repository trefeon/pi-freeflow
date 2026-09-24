/**
 * Expired reasoning references (`rs_... was not found or has expired`) are
 * fatal without daemon-side recovery: blob-stripping does not help, and the
 * host resends the same poisoned history until the session dies. These tests
 * cover the chained recovery: blob strip first, then drop every reasoning
 * item plus `previous_response_id` when the retry comes back expired, and
 * remember the dead ids even when the retry fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startProxy } from "../src/proxy.ts";
import { resetAllRelayHealth, setActiveRelayState } from "../src/relay-state.ts";
import { withIsolatedSandboxFiles } from "./_sandbox-helpers.ts";
import {
 _resetReasoningStateForTest,
 extractExpiredReasoningIds,
 isExpiredReasoningReference,
 rejectedReasoningCount,
 rejectedReasoningIdsCount,
 rememberIssuerRelay,
 rememberRejectedReasoningIds,
 stripPreviousResponseId,
 stripRejectedReasoningIds,
 stripUnresolvableReasoning,
} from "../src/responses.ts";
import type { RelayState } from "../src/types.ts";

const CALLER_MISMATCH_400 =
 '{"status":400,"message":"400 Error from provider (Console): Upstream request failed: [invalid_request_error] reasoning `encrypted_content` was not issued to this caller\\nError from provider (Console): Upstream request failed"}';
const EXPIRED_400 =
 '{"status":400,"message":"Error from provider (Console): Referenced reasoning item \'rs_6ab4402be55b882c95004d31:rs_01a0d01aab0f73798fa75fe6f5a06028\' was not found or has expired."}';

const CONVERSATION_A = "02b1916c-4ea5-7724-a7f4-287405a5c38c";
const CONVERSATION_B = "02b187d3-1935-7366-b07e-61083dd1c191";
const BLOB_OLD = "Q-PaDgGZsZwYwucXWKWXkBWujf6p3Ko_oNq57dMu";

function reasoning(id: string, blob?: string): Record<string, unknown> {
 const item: Record<string, unknown> = { type: "reasoning", id, summary: [] };
 if (blob) item.encrypted_content = blob;
 return item;
}

function responsesBody(key: string, input: unknown[], previousResponseId?: string): string {
 const body: Record<string, unknown> = {
  model: "muse-spark-1.3-contributor-free",
  store: false,
  stream: false,
  prompt_cache_key: key,
  include: ["reasoning.encrypted_content"],
  input,
 };
 if (previousResponseId) body.previous_response_id = previousResponseId;
 return JSON.stringify(body);
}

function bodyWithHistory(key: string): string {
 return responsesBody(
  key,
  [
   { type: "message", id: "msg_1", role: "user", content: "hi" },
   reasoning("rs_6ab4402be55b882c95004d31", BLOB_OLD),
   reasoning("rs_01a0d01aab0f73798fa75fe6f5a06028"),
   { type: "function_call", id: "fc_1", name: "read", arguments: "{}" },
  ],
  "resp_prev_123",
 );
}

function inputOf(body: string | Buffer): Array<Record<string, unknown>> {
 const text = typeof body === "string" ? body : body.toString("utf8");
 return (JSON.parse(text) as { input?: Array<Record<string, unknown>> }).input ?? [];
}

function blobsIn(body: string | Buffer): string[] {
 return inputOf(body)
  .filter((i) => typeof i.encrypted_content === "string")
  .map((i) => String(i.encrypted_content));
}

function reasoningIdsIn(body: string | Buffer): string[] {
 return inputOf(body)
  .filter((i) => i.type === "reasoning" && typeof i.id === "string")
  .map((i) => String(i.id));
}

function previousResponseIdOf(body: string | Buffer): string | null {
 const text = typeof body === "string" ? body : body.toString("utf8");
 const parsed = JSON.parse(text) as Record<string, unknown>;
 return typeof parsed.previous_response_id === "string" ? parsed.previous_response_id : null;
}

/** Response stub that also supports the clone() the recovery path inspects. */
function stubResponse(status: number, body: string): Response {
 const make = (): Response =>
  ({
   status,
   ok: status >= 200 && status < 300,
   headers: new Headers({ "content-type": "application/json" }),
   text: async () => body,
   body: new ReadableStream({
    start(controller) {
     controller.enqueue(new TextEncoder().encode(body));
     controller.close();
    },
   }),
  }) as unknown as Response;
 const response = make();
 (response as Response & { clone: () => Response }).clone = make;
 return response;
}

function relayState(relays: string[]): RelayState {
 return {
  mode: "auto",
  enabled: true,
  url: relays[0] ?? "",
  relays: relays.map((url) => ({ url }) as RelayState["relays"][number]),
 };
}

async function withProxy(
 port: number,
 relays: string[],
 upstream: (url: string, body: string) => Response,
 fn: (port: number, calls: Array<{ url: string; body: string }>) => Promise<void>,
): Promise<void> {
 const { server, port: bound } = await startProxy(port);
 const effectivePort = bound ?? port;
 const localPrefix = `http://127.0.0.1:${effectivePort}`;
 const realFetch = globalThis.fetch.bind(globalThis);
 const calls: Array<{ url: string; body: string }> = [];
 try {
  setActiveRelayState(relayState(relays), false);
  resetAllRelayHealth();
  const fetchMock = test.mock.method(
   globalThis,
   "fetch",
   async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(localPrefix)) return realFetch(u, init);
    const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    calls.push({ url: u, body });
    return upstream(u, body);
   },
  );
  try {
   await fn(effectivePort, calls);
  } finally {
   fetchMock.mock.restore();
  }
 } finally {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
 }
}

async function postResponses(port: number, body: string): Promise<Response> {
 return await fetch(`http://127.0.0.1:${port}/v1/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
 });
}

// ── Unit: signature, extraction, strips ─────────────────────────────────────

test("expired reference: recognizes only the expired-reasoning 400", () => {
 assert.equal(isExpiredReasoningReference(EXPIRED_400), true);
 assert.equal(isExpiredReasoningReference(CALLER_MISMATCH_400), false);
 assert.equal(
  isExpiredReasoningReference('{"message":"[invalid_request_error] context length exceeded"}'),
  false,
 );
});

test("expired reference: extracts every rs_ id from colon-joined pairs", () => {
 assert.deepEqual(extractExpiredReasoningIds(EXPIRED_400), [
  "rs_6ab4402be55b882c95004d31",
  "rs_01a0d01aab0f73798fa75fe6f5a06028",
 ]);
 assert.deepEqual(extractExpiredReasoningIds(CALLER_MISMATCH_400), []);
});

test("expired reference: full strip drops reasoning items plus the chain pointer", () => {
 _resetReasoningStateForTest();
 const stripped = stripUnresolvableReasoning(Buffer.from(bodyWithHistory(CONVERSATION_A), "utf8"));
 assert.ok(stripped, "a body with reasoning history must be rewritten");
 assert.deepEqual(reasoningIdsIn(stripped), [], "no reasoning item may survive");
 assert.equal(blobsIn(stripped).length, 0, "blobs go down with their items");
 assert.equal(previousResponseIdOf(stripped), null, "the unresolvable pointer must go");
 const parsed = JSON.parse(stripped.toString("utf8")) as { input: unknown[] };
 assert.equal(parsed.input.length, 2, "message and tool call survive");
 assert.equal(
  JSON.parse(bodyWithHistory(CONVERSATION_A)).input.length,
  4,
  "precondition: the history carries four items",
 );
 assert.equal(stripUnresolvableReasoning(Buffer.from(responsesBody(CONVERSATION_A, [
  { type: "message", id: "msg_1", role: "user", content: "hi" },
 ]), "utf8")), null, "a body with no reasoning and no pointer is untouched");
 _resetReasoningStateForTest();
});

test("expired reference: pointer-only strip drops the chain pointer", () => {
 const raw = Buffer.from(responsesBody(CONVERSATION_A, [
  { type: "message", id: "msg_1", role: "user", content: "hi" },
 ], "resp_prev_123"), "utf8");
 const stripped = stripPreviousResponseId(raw);
 assert.ok(stripped);
 assert.equal(previousResponseIdOf(stripped), null);
 assert.equal(
  stripPreviousResponseId(Buffer.from(responsesBody(CONVERSATION_A, [
   { type: "message", id: "msg_1", role: "user", content: "hi" },
  ]), "utf8")),
  null,
  "no pointer means no rewrite",
 );
});

test("expired reference: selective strip drops only the dead ids plus the pointer", () => {
 _resetReasoningStateForTest();
 assert.equal(rememberRejectedReasoningIds(EXPIRED_400, CONVERSATION_A), 2);
 assert.equal(rejectedReasoningIdsCount(CONVERSATION_A), 2);
 assert.equal(rejectedReasoningIdsCount(CONVERSATION_B), 0, "other conversations stay untouched");

 const nextTurn = responsesBody(
  CONVERSATION_A,
  [
   { type: "message", id: "msg_1", role: "user", content: "hi" },
   reasoning("rs_6ab4402be55b882c95004d31"),
   reasoning("rs_live_999"),
  ],
  "resp_prev_123",
 );
 const stripped = stripRejectedReasoningIds(Buffer.from(nextTurn, "utf8"), CONVERSATION_A);
 assert.ok(stripped, "a dead id present in the body must be stripped");
 assert.deepEqual(reasoningIdsIn(stripped), ["rs_live_999"], "live reasoning survives");
 assert.equal(previousResponseIdOf(stripped), null, "the pointer goes down with the dead item");
 assert.equal(
  stripRejectedReasoningIds(Buffer.from(nextTurn, "utf8"), CONVERSATION_B),
  null,
  "other conversations stay verbatim",
 );
 _resetReasoningStateForTest();
});

// ── End to end through the proxy ────────────────────────────────────────────

test("proxy chains blob strip then expired-reference strip on the same relay", async () => {
 _resetReasoningStateForTest();
 await withIsolatedSandboxFiles(async () => {
  await withProxy(
   19301,
   ["https://relay1.example.com"],
   (_url, body) => {
    if (blobsIn(body).length > 0) return stubResponse(400, CALLER_MISMATCH_400);
    if (reasoningIdsIn(body).length > 0 || previousResponseIdOf(body) !== null) {
     return stubResponse(400, EXPIRED_400);
    }
    return stubResponse(200, '{"id":"resp_ok","status":"completed"}');
   },
   async (port, calls) => {
    const res = await postResponses(port, bodyWithHistory(CONVERSATION_A));
    assert.equal(res.status, 200, "the chained retry must hide both 400s from the host");
    assert.equal((await res.json() as { id?: string }).id, "resp_ok");
    assert.equal(calls.length, 3, "verbatim, blob-stripped, then fully stripped");
    assert.ok(calls.every((c) => c.url.startsWith("https://relay1.example.com")), "same relay, no roll penalty");
    assert.deepEqual(blobsIn(calls[1].body).length, 0, "second attempt drops every blob");
    assert.deepEqual(reasoningIdsIn(calls[2].body), [], "third attempt drops every reasoning item");
    assert.equal(previousResponseIdOf(calls[2].body), null, "third attempt drops the chain pointer");
    assert.equal(rejectedReasoningCount(CONVERSATION_A), 1, "the blob is remembered");
    assert.equal(rejectedReasoningIdsCount(CONVERSATION_A), 2, "the expired ids are remembered");
   },
  );
 });
 _resetReasoningStateForTest();
});

test("proxy learns dead ids even when the chained retry fails", async () => {
 _resetReasoningStateForTest();
 await withIsolatedSandboxFiles(async () => {
  let attempt = 0;
  await withProxy(
   19302,
   ["https://relay1.example.com"],
   (_url, body) => {
    attempt += 1;
    const dead = extractExpiredReasoningIds(EXPIRED_400);
    const ids = reasoningIdsIn(body);
    // Turn 1 fails throughout (transient outage); afterwards the backend
    // serves anything without blobs or dead ids.
    if (attempt <= 3) {
     if (blobsIn(body).length > 0) return stubResponse(400, CALLER_MISMATCH_400);
     return stubResponse(400, EXPIRED_400);
    }
    if (blobsIn(body).length > 0) return stubResponse(400, CALLER_MISMATCH_400);
    if (ids.some((id) => dead.includes(id))) return stubResponse(400, EXPIRED_400);
    return stubResponse(200, '{"id":"resp_ok","status":"completed"}');
   },
   async (port, calls) => {
    const res = await postResponses(port, bodyWithHistory(CONVERSATION_A));
    assert.equal(res.status, 400, "upstream still fails, but the lesson must stick");
    assert.equal(calls.length, 3, "both recovery steps still fire");
    assert.equal(rejectedReasoningCount(CONVERSATION_A), 1, "blobs are remembered on failure");
    assert.equal(rejectedReasoningIdsCount(CONVERSATION_A), 2, "ids are remembered on failure");

    // Next turn strips what the failure taught without extra attempts.
    const followUp = responsesBody(
     CONVERSATION_A,
     [
      { type: "message", id: "msg_1", role: "user", content: "hi" },
      reasoning("rs_6ab4402be55b882c95004d31"),
      reasoning("rs_live_999"),
     ],
     "resp_prev_123",
    );
    const before = calls.length;
    const res2 = await postResponses(port, followUp);
    assert.equal(res2.status, 200, "the learned strip recovers the next turn");
    assert.equal(calls.length, before + 1, "memory strips up front: no retry needed");
    assert.deepEqual(reasoningIdsIn(calls[calls.length - 1].body), ["rs_live_999"]);
   },
  );
 });
 _resetReasoningStateForTest();
});

test("issuer hop ships portable history: blobs and pointer go, dead ids stay dropped", async () => {
 _resetReasoningStateForTest();
 await withIsolatedSandboxFiles(async () => {
  await withProxy(
   19303,
   ["https://relay1.example.com"],
   () => stubResponse(200, '{"id":"resp_ok","status":"completed"}'),
   async (port, calls) => {
    assert.equal(rememberRejectedReasoningIds(EXPIRED_400, CONVERSATION_A), 2);
    rememberIssuerRelay(CONVERSATION_A, "https://relay-retired.example.com");
    const res = await postResponses(port, bodyWithHistory(CONVERSATION_A));
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, "the hop must not cost a rejected attempt");
    assert.equal(blobsIn(calls[0].body).length, 0, "hop strips blobs");
    assert.equal(previousResponseIdOf(calls[0].body), null, "hop strips the chain pointer");
    assert.deepEqual(reasoningIdsIn(calls[0].body), [], "dead ids stay dropped on the hop");
   },
  );
 });
 _resetReasoningStateForTest();
});
