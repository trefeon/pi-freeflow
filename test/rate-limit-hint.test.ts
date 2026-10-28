/**
 * Natural-429 guidance hint test suite.
 *
 * Behavioral coverage: spins up the real in-process proxy and stubs the
 * upstream fetch to return 429. No local quota gate exists anymore — the
 * deploy hint is attached to a genuine upstream 429 passthrough, which by
 * construction means every relay plus direct is rate-limited (relayFetch
 * exhausts all candidates and the direct fallback before a 429 surfaces).
 * The hint is throttled to at most once per 10 minutes per process and
 * returns after _reset429HintForTest().
 *
 * One minimal source guard keeps the hint text pinned to exactly one
 * code path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { startProxy, _reset429HintForTest } from "../src/proxy.ts";
import {
 getActiveRelayState,
 getRelayHealth,
 resetAllRelayHealth,
 setActiveRelayState,
} from "../src/relay-state.ts";
import { authHeaders } from "./_auth.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

/** The exact hint string clients receive in a natural-429 body. */
const HINT_TEXT =
 "Shared free-tier IP quota reached. Add your own relay egress: /freeflow deploy (Cloudflare recommended, 100k req/day free)";

const TEST_PORT = 19183;
const TEST_PORT_RELAY = 19184;
const TEST_PORT_QUOTA = 19185;
const MODEL = "nemotron-3.5-super-vl-free";
const FAKE_RELAY = "https://dead-relay-999.example.com";

/** Response-like stub: a JSON error with the given status, no stream body. */
function stubResponse(status: number, body: string): Response {
 return {
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => body,
  body: null,
 } as unknown as Response;
}

const UPSTREAM_429 = JSON.stringify({ error: "FreeUsageLimitError" });
/** Genuine quota exhaustion: the usage code plus retry/reset language. */
const UPSTREAM_QUOTA_429 = JSON.stringify({
 error: { code: "FreeUsageLimitError", message: "Free usage quota exceeded for today; resets at 00:00 UTC, retry after 3600s" },
});

// ── Behavioral: no hint on a shape 429 (fingerprint fault, not quota) ───────

test("429 hint: FreeUsage shape 429 carries no deploy guidance", async (t) => {
 await withIsolatedRelayFiles(async () => {
  // Direct mode with an empty relay pool.
  const priorState = getActiveRelayState();
  setActiveRelayState({ enabled: true, url: "", relays: [] }, false);
  resetAllRelayHealth();
  _reset429HintForTest();

  const { server, port } = await startProxy(TEST_PORT);
  const effectivePort = port ?? TEST_PORT;
  const localPrefix = `http://127.0.0.1:${effectivePort}`;
  const realFetch = globalThis.fetch.bind(globalThis);

  try {
   // Stub upstream: passthrough local proxy traffic, bare shape 429 elsewhere.
   t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(localPrefix)) return realFetch(u, init);
    return stubResponse(429, UPSTREAM_429);
   });

   const postChat = (stream: boolean): Promise<Response> =>
    fetch(`${localPrefix}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json", ...authHeaders() },
     body: JSON.stringify({ model: MODEL, stream }),
    });

   // A bare FreeUsageLimitError is a shape verdict (missing/wrong env block
   // or fingerprint), not quota: the deploy hint must stay off so it never
   // misleads, on first sight and after a throttle reset alike.
   const shaped = await postChat(false);
   assert.equal(shaped.status, 429);
   const shapedBody = (await shaped.json()) as Record<string, unknown>;
   assert.equal(shapedBody.error, "FreeUsageLimitError");
   assert.equal(shapedBody.hint, undefined, "shape 429 must not carry the quota hint");

   _reset429HintForTest();
   const reshaped = await postChat(true);
   assert.equal(reshaped.status, 429);
   const reshapedBody = (await reshaped.json()) as Record<string, unknown>;
   assert.equal(reshapedBody.hint, undefined, "shape 429 must not carry the hint after reset either");
  } finally {
   _reset429HintForTest();
   resetAllRelayHealth();
   setActiveRelayState(priorState, false);
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});

// ── Behavioral: hint on a genuine quota 429 ─────────────────────────────────

test("429 hint: quota 429 carries guidance, throttled 10 min, resettable", async (t) => {
 await withIsolatedRelayFiles(async () => {
  // Direct mode with an empty relay pool (dedicated port: the shape test's
  // server above may still be draining keep-alive sockets on TEST_PORT).
  const priorState = getActiveRelayState();
  setActiveRelayState({ enabled: true, url: "", relays: [] }, false);
  resetAllRelayHealth();
  _reset429HintForTest();

  const { server, port } = await startProxy(TEST_PORT_QUOTA);
  const effectivePort = port ?? TEST_PORT_QUOTA;
  const localPrefix = `http://127.0.0.1:${effectivePort}`;
  const realFetch = globalThis.fetch.bind(globalThis);

  try {
   // Stub upstream: passthrough local proxy traffic, quota 429 elsewhere.
   t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(localPrefix)) return realFetch(u, init);
    return stubResponse(429, UPSTREAM_QUOTA_429);
   });

   const postChat = (stream: boolean): Promise<Response> =>
    fetch(`${localPrefix}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json", ...authHeaders() },
     body: JSON.stringify({ model: MODEL, stream }),
    });

   // First quota 429 carries the guidance hint alongside the upstream error.
   const limited = await postChat(false);
   assert.equal(limited.status, 429);
   const limitedBody = (await limited.json()) as Record<string, unknown>;
   assert.equal(
    typeof (limitedBody.hint ?? (limitedBody.error as Record<string, unknown>)?.message),
    "string",
    "first quota 429 must carry the guidance hint",
   );
   const hintText = String(limitedBody.hint ?? (limitedBody.error as Record<string, unknown>).message);
   assert.ok(
    hintText.includes("free-tier IP quota"),
    "hint must point at the shared free-tier IP quota",
   );

   assert.ok(
    hintText.includes("Cloudflare"),
    "hint must recommend Cloudflare, not Vercel",
   );
   assert.ok(
    !hintText.toLowerCase().includes("vercel"),
    "hint must no longer recommend Vercel",
   );

   // Immediate follow-up is still 429 but the 10-minute throttle suppresses the hint.
   const throttled = await postChat(false);
   assert.equal(throttled.status, 429);
   const throttledBody = (await throttled.json()) as Record<string, unknown>;
   const throttledHint = throttledBody.hint ?? (throttledBody.error as Record<string, unknown>).message;
   assert.ok(
    !String(throttledHint).includes("free-tier IP quota"),
    "hint must be throttled for 10 minutes",
   );

   // Test-only reset rewinds the throttle: a stream-requested 429 also
   // gets the hint as buffered JSON instead of a piped stream body.
   _reset429HintForTest();
   const resumed = await postChat(true);
   assert.equal(resumed.status, 429);
   const resumedBody = (await resumed.json()) as Record<string, unknown>;
   const resumedHint = String(resumedBody.hint ?? (resumedBody.error as Record<string, unknown>).message);
   assert.ok(
    resumedHint.includes("free-tier IP quota"),
    "hint must reappear after _reset429HintForTest()",
   );
  } finally {
   _reset429HintForTest();
   resetAllRelayHealth();
   setActiveRelayState(priorState, false);
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});

// ── Behavioral: hint when the whole relay pool plus direct is 429 ───────────

test("429 hint: exhausted relay pool 429 carries guidance", async (t) => {
 await withIsolatedRelayFiles(async () => {
  const priorState = getActiveRelayState();
  setActiveRelayState(
   { enabled: true, url: FAKE_RELAY, relays: [{ url: FAKE_RELAY, label: "dead" }] },
   false,
  );
  resetAllRelayHealth();
  _reset429HintForTest();

  const { server, port } = await startProxy(TEST_PORT_RELAY);
  const effectivePort = port ?? TEST_PORT_RELAY;
  const localPrefix = `http://127.0.0.1:${effectivePort}`;
  const realFetch = globalThis.fetch.bind(globalThis);

  try {
   // Both the relay candidate and the direct fallback are rate-limited; the
   // direct verdict carries quota language so the guidance hint applies.
   t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(localPrefix)) return realFetch(u, init);
    if (u.includes("dead-relay-999")) return stubResponse(429, JSON.stringify({ error: "relay 429" }));
    return stubResponse(429, UPSTREAM_QUOTA_429);
   });

   const res = await fetch(`${localPrefix}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ model: MODEL, stream: false }),
   });
   assert.equal(res.status, 429);
   const body = (await res.json()) as Record<string, unknown>;
   const quotaHint = String(body.hint ?? (body.error as Record<string, unknown>).message);
   assert.ok(
    quotaHint.includes("free-tier IP quota"),
    "exhausted-pool quota 429 must carry the guidance hint",
   );
   assert.ok(
    (getRelayHealth(FAKE_RELAY)?.consecutiveFailures ?? 0) >= 1,
    "the 429 relay must have been tried and marked failed before direct",
   );
  } finally {
   _reset429HintForTest();
   resetAllRelayHealth();
   setActiveRelayState(priorState, false);
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});

// ── Minimal source guard ────────────────────────────────────────────────────

test("Rate-Limit Hint hint text appears exactly once in proxy source", () => {
 const PROXY_SRC = fs.readFileSync(
  new URL("../src/proxy.ts", import.meta.url),
  "utf8",
 );
 const occurrences = PROXY_SRC.split(HINT_TEXT).length - 1;
 assert.equal(occurrences, 1, "hint must be emitted from exactly one code path");
});

test("429 hint: object-shaped error gains guidance inside message", async (t) => {
 await withIsolatedRelayFiles(async () => {
  const priorState = getActiveRelayState();
  setActiveRelayState({ enabled: true, url: "", relays: [] }, false);
  resetAllRelayHealth();
  _reset429HintForTest();

  const { server, port } = await startProxy(TEST_PORT);
  const effectivePort = port ?? TEST_PORT;
  const localPrefix = `http://127.0.0.1:${effectivePort}`;
  const realFetch = globalThis.fetch.bind(globalThis);

  try {
   t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(localPrefix)) return realFetch(u, init);
    return stubResponse(429, JSON.stringify({ error: { code: "Overloaded", message: "Upstream busy" } }));
   });

   const res = await fetch(`${localPrefix}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ model: MODEL, stream: false }),
   });
   assert.equal(res.status, 429);
   const body = (await res.json()) as { hint: string; error: { code: string; message: string } };
   assert.equal(body.error.code, "Overloaded");
   assert.ok(body.error.message.includes("Upstream busy"), "upstream text survives");
   assert.ok(body.error.message.includes("free-tier IP quota"), "guidance is host-visible");
  } finally {
   _reset429HintForTest();
   resetAllRelayHealth();
   setActiveRelayState(priorState, false);
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});
