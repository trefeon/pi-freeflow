/**
 * Proxy 503 relay_disabled passthrough: when the relay layer reports every
 * candidate disabled (HTTP 503 `relay_disabled` JSON), the proxy must forward
 * status + body unchanged so the host retries/fails fast. Generic quota 402s
 * stay terminal and byte-identical.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { startProxy, isRelayDisabledError } from "../src/proxy.ts";
import {
 getActiveRelayState,
 resetAllRelayHealth,
 setActiveRelayState,
} from "../src/relay-state.ts";
import { RELAY_STATE_FILE } from "../src/config.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;

const TEST_PORT_DISABLED = 19185;
const TEST_PORT_QUOTA = 19186;
const TEST_PORT_DIRECT = 19187;
const MODEL = "muse-spark-1.2-contributor-free";
const FAKE_RELAY = "https://dead-relay-998.example.com";

const DISABLED_BODY = JSON.stringify({
 error: {
  code: "relay_disabled",
  message: `All relays disabled: ${FAKE_RELAY} returned DEPLOYMENT_DISABLED. Redeploy the relay or run /freeflow remove ${FAKE_RELAY}.`,
 },
});
const QUOTA_BODY = JSON.stringify({
 error: { code: "insufficient_quota", message: "payment required" },
});

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

/** Response stub: a JSON error with the given status and a readable body. */
function stubResponse(status: number, body: string): Response {
 return new Response(body, {
  status,
  headers: { "content-type": "application/json" },
 });
}

/** Read error.code from an unknown JSON value, or null when absent. */
function errorCodeOf(body: unknown): unknown {
 if (typeof body !== "object" || body === null || !("error" in body)) return null;
 const err: unknown = body.error;
 if (typeof err !== "object" || err === null || !("code" in err)) return null;
 return err.code;
}

/** Read error.message from an unknown JSON value, or null when absent. */
function errorMessageOf(body: unknown): unknown {
 if (typeof body !== "object" || body === null || !("error" in body)) return null;
 const err: unknown = body.error;
 if (typeof err !== "object" || err === null || !("message" in err)) return null;
 return err.message;
}

// ── Pure helper: the exact predicate the relay response writer uses ─────────

test("proxy 402: isRelayDisabledError detects the exhausted-disabled verdict", () => {
 assert.equal(isRelayDisabledError(503, DISABLED_BODY), true);
 const parsed: unknown = JSON.parse(DISABLED_BODY);
 assert.equal(errorCodeOf(parsed), "relay_disabled");
 const message = errorMessageOf(parsed);
 assert.ok(typeof message === "string" && message.includes(FAKE_RELAY));
 assert.ok(typeof message === "string" && message.includes("/freeflow remove"));
});

test("proxy 402: generic 402 and unrelated bodies are never disabled verdicts", () => {
 assert.equal(isRelayDisabledError(402, QUOTA_BODY), false);
 assert.equal(isRelayDisabledError(402, DISABLED_BODY), false, "relay_disabled shape on 402 is a relay-layer concern, never the proxy's");
 assert.equal(isRelayDisabledError(503, QUOTA_BODY), false);
 assert.equal(isRelayDisabledError(503, "not json"), false);
 assert.equal(isRelayDisabledError(503, JSON.stringify({ error: "busy" })), false);
 assert.equal(isRelayDisabledError(503, JSON.stringify({ error: { code: "Overloaded" } })), false);
 assert.equal(isRelayDisabledError(429, DISABLED_BODY), false);
 assert.equal(isRelayDisabledError(200, DISABLED_BODY), false);
});

// ── Behavioral: exhausted-disabled 503 forwarded with status + code intact ──

test("proxy 402: exhausted-disabled 503 passes through with code intact", async (t) => {
 await withIsolatedRelayFiles(async () => {
  const priorState = getActiveRelayState();
  setActiveRelayState(
   { enabled: true, url: FAKE_RELAY, relays: [{ url: FAKE_RELAY, label: "dead" }] },
   false,
  );
  resetAllRelayHealth();

  const { server, port } = await startProxy(TEST_PORT_DISABLED);
  const effectivePort = port ?? TEST_PORT_DISABLED;
  const localPrefix = `http://127.0.0.1:${effectivePort}`;
  const realFetch = globalThis.fetch.bind(globalThis);

  try {
   // Relay candidate and direct fallback both report disabled.
   t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(localPrefix)) return realFetch(u, init);
    return stubResponse(503, DISABLED_BODY);
   });

   const res = await fetch(`${localPrefix}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false }),
   });
   assert.equal(res.status, 503);
   const raw = await res.text();
   assert.equal(raw, DISABLED_BODY, "disabled verdict must pass through byte-identical");
   assert.equal(errorCodeOf(JSON.parse(raw) as unknown), "relay_disabled");
  } finally {
   resetAllRelayHealth();
   setActiveRelayState(priorState, false);
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});

// ── Behavioral: generic quota 402 passes through byte-identical ─────────────

test("proxy 402: generic quota 402 passes through byte-identical", async (t) => {
 await withIsolatedRelayFiles(async () => {
  const priorState = getActiveRelayState();
  setActiveRelayState(
   { enabled: true, url: FAKE_RELAY, relays: [{ url: FAKE_RELAY, label: "dead" }] },
   false,
  );
  resetAllRelayHealth();

  const { server, port } = await startProxy(TEST_PORT_QUOTA);
  const effectivePort = port ?? TEST_PORT_QUOTA;
  const localPrefix = `http://127.0.0.1:${effectivePort}`;
  const realFetch = globalThis.fetch.bind(globalThis);
  const seenUpstream: string[] = [];

  try {
   t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(localPrefix)) return realFetch(u, init);
    seenUpstream.push(u);
    return stubResponse(402, QUOTA_BODY);
   });

   const res = await fetch(`${localPrefix}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false }),
   });
   assert.equal(res.status, 402, "generic 402 must surface immediately");
   const raw = await res.text();
   assert.equal(raw, QUOTA_BODY, "generic 402 body must pass through byte-identical");
   assert.ok(
    !seenUpstream.some((u) => u.includes("opencode.ai")),
    "generic 402 must stop at the first relay without a direct fallback attempt",
   );
  } finally {
   resetAllRelayHealth();
   setActiveRelayState(priorState, false);
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});

// ── Behavioral: direct-path 503 disabled verdict passes through unchanged ───

test("proxy 402: direct-path 503 relay_disabled passes through unchanged", async (t) => {
 await withIsolatedRelayFiles(async () => {
  // Direct mode with an empty relay pool.
  const priorState = getActiveRelayState();
  setActiveRelayState({ enabled: true, url: "", relays: [] }, false);
  resetAllRelayHealth();

  const { server, port } = await startProxy(TEST_PORT_DIRECT);
  const effectivePort = port ?? TEST_PORT_DIRECT;
  const localPrefix = `http://127.0.0.1:${effectivePort}`;
  const realFetch = globalThis.fetch.bind(globalThis);

  try {
   t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(localPrefix)) return realFetch(u, init);
    return stubResponse(503, DISABLED_BODY);
   });

   const res = await fetch(`${localPrefix}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false }),
   });
   assert.equal(res.status, 503);
   const raw = await res.text();
   assert.equal(raw, DISABLED_BODY, "direct-path disabled verdict must pass through byte-identical");
  } finally {
   resetAllRelayHealth();
   setActiveRelayState(priorState, false);
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});
