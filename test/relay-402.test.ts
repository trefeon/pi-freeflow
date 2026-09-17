/**
 * Relay 402 deployment-disabled regression: only a 402 carrying Vercel edge
 * markers or a DEPLOYMENT_DISABLED body match is a relay-host failure (roll
 * to the next relay with cooldown). Generic 402s are payment/quota verdicts
 * that must surface immediately on the first relay with no cooldown.
 * 402 is never blanket-retriable — never isRetriableStatus.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RELAY_STATE_FILE } from "../src/config.ts";
import { isRetriableStatus, relayFetch, _resetRollNotifyForTest } from "../src/relay.ts";
import {
 getRelayHealth,
 isRelayHealthy,
 resetAllRelayHealth,
 setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;

/** Isolate both main and .bak disk files (relay auto-switch writes state). */
async function withIsolatedRelayFiles(fn: () => Promise<void>): Promise<void> {
 const read = (p: string): string | null =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
 const mainBefore = read(RELAY_STATE_FILE);
 const bakBefore = read(BAK_FILE);
 try {
  await fn();
 } finally {
  if (mainBefore === null) {
   if (fs.existsSync(RELAY_STATE_FILE)) fs.unlinkSync(RELAY_STATE_FILE);
  } else {
   fs.writeFileSync(RELAY_STATE_FILE, mainBefore);
  }
  if (bakBefore === null) {
   if (fs.existsSync(BAK_FILE)) fs.unlinkSync(BAK_FILE);
  } else {
   fs.writeFileSync(BAK_FILE, bakBefore);
  }
  resetAllRelayHealth();
 }
}

const UPSTREAM_URL = "https://opencode.ai/zen/v1/chat/completions";
const RELAY_A = "https://relay-a.example.com";
const RELAY_B = "https://relay-b.example.com";

function poolState(): RelayState {
 return {
  enabled: true,
  url: RELAY_A,
  relays: [{ url: RELAY_A }, { url: RELAY_B }],
 };
}

/**
 * Response-like stub with cloneable text body. When `cloneThrows` is set the
 * clone peek fails, so the gated branch must decide on headers alone.
 */
function stubResponse(
 status: number,
 cancelled: number[],
 bodyText = "",
 headers: Record<string, string> = {},
 cloneThrows = false,
): Response {
 const stub = {
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(headers),
  body: {
   cancel: async () => {
    cancelled.push(status);
   },
  },
  clone() {
   if (cloneThrows) throw new Error("clone failed");
   return { text: async () => bodyText };
  },
  text: async () => bodyText,
 } as unknown as Response;
 return stub;
}

test("relay 402: DEPLOYMENT_DISABLED body rolls to next relay with cooldown", async (t) => {
 await withIsolatedRelayFiles(async () => {
  setActiveRelayState(poolState(), false);
  resetAllRelayHealth();
  _resetRollNotifyForTest();

  const cancelled: number[] = [];
  const seenUrls: string[] = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
   seenUrls.push(String(input));
   if (seenUrls.length === 1) {
    return stubResponse(
     402,
     cancelled,
     '{"error":{"code":"DEPLOYMENT_DISABLED","message":"deployment disabled"}}',
    );
   }
   return stubResponse(200, cancelled, "{}");
  });

  const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t402a");

  assert.equal(out.status, 200);
  assert.equal(fetchMock.mock.callCount(), 2, "disabled deployment must roll to the next candidate");
  assert.deepEqual(seenUrls, [RELAY_A, RELAY_B], "both candidates must be attempted in order");
  assert.equal(getRelayHealth(RELAY_A)?.consecutiveFailures, 1, "402 roll must record a failure on the disabled relay");
  assert.equal(isRelayHealthy(RELAY_A), false, "disabled relay must cool down after the roll");
 });
});

test("relay 402: generic payment/quota 402 is terminal on the first relay", async (t) => {
 await withIsolatedRelayFiles(async () => {
  setActiveRelayState(poolState(), false);
  resetAllRelayHealth();
  _resetRollNotifyForTest();

  const cancelled: number[] = [];
  const seenUrls: string[] = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
   seenUrls.push(String(input));
   return stubResponse(
    402,
    cancelled,
    '{"error":{"code":"insufficient_quota","message":"payment required"}}',
   );
  });

  const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t402b");

  assert.equal(out.status, 402, "generic 402 must surface immediately");
  assert.equal(fetchMock.mock.callCount(), 1, "generic 402 must not try the next relay");
  assert.deepEqual(seenUrls, [RELAY_A], "generic 402 must stop at the first relay");
  assert.equal(isRelayHealthy(RELAY_A), true, "generic 402 must not cool down the relay");
 });
});

test("relay 402: Vercel edge headers roll even when the body is unreadable", async (t) => {
 await withIsolatedRelayFiles(async () => {
  setActiveRelayState(poolState(), false);
  resetAllRelayHealth();
  _resetRollNotifyForTest();

  const cancelled: number[] = [];
  const seenUrls: string[] = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
   seenUrls.push(String(input));
   if (seenUrls.length === 1) {
    return stubResponse(402, cancelled, "", { "x-vercel-error": "DEPLOYMENT_DISABLED" }, true);
   }
   return stubResponse(200, cancelled, "{}");
  });

  const out = await relayFetch(UPSTREAM_URL, { method: "POST" }, "t402c");

  assert.equal(out.status, 200);
  assert.equal(fetchMock.mock.callCount(), 2, "edge-marked 402 must roll even with an unreadable body");
  assert.deepEqual(seenUrls, [RELAY_A, RELAY_B], "both candidates must be attempted in order");
  assert.equal(isRelayHealthy(RELAY_A), false, "edge-marked 402 must cool down the relay");
 });
});

test("relay 402: isRetriableStatus(402) stays false (gated branch, never blanket-retriable)", () => {
 assert.equal(isRetriableStatus(402), false, "402 rolls only through the gated deployment-disabled branch");
});
