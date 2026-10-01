/**
 * Spread relay mode: distribute requests across the healthy relays instead of
 * always starting at the single sticky primary, while reasoning affinity (the
 * preferred issuer) still wins. Disk writes are isolated (main + .bak).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RELAY_STATE_FILE } from "../src/config.ts";
import { relayFetch } from "../src/relay.ts";
import {
 getActiveRelayState,
 loadRelayState,
 markRelayFailure,
 orderedRelayCandidates,
 resetAllRelayHealth,
 saveRelayState,
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

const POOL = [
 "https://r1.example.com",
 "https://r2.example.com",
 "https://r3.example.com",
 "https://r4.example.com",
];

function poolState(mode: RelayState["mode"]): RelayState {
 return { mode, enabled: true, url: POOL[0], relays: POOL.map((url) => ({ url })) };
}

function stubResponse(status: number): Response {
 return {
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers({ "content-type": "application/json" }),
  body: { cancel: async () => { } },
  clone() {
   return { text: async () => "" };
  },
  text: async () => "{}",
 } as unknown as Response;
}

test("spread: a stable conversation key always shards to the same first relay", async () => {
 await withIsolatedRelayFiles(async () => {
  resetAllRelayHealth();
  setActiveRelayState(poolState("spread"), false);
  const first = orderedRelayCandidates(undefined, "conversation-abc")[0];
  const again = orderedRelayCandidates(undefined, "conversation-abc")[0];
  assert.equal(first, again, "same conversation key must map to the same relay");
  assert.ok(POOL.includes(first));
 });
});

test("spread: without a key successive requests rotate across the whole healthy pool", async () => {
 await withIsolatedRelayFiles(async () => {
  resetAllRelayHealth();
  setActiveRelayState(poolState("spread"), false);
  const seen = new Set<string>();
  for (let i = 0; i < POOL.length; i++) seen.add(orderedRelayCandidates()[0]);
  assert.equal(seen.size, POOL.length, "round-robin must cover every healthy relay");
 });
});

test("spread: a rate-limited relay is never preferred and stays at the tail", async () => {
 await withIsolatedRelayFiles(async () => {
  resetAllRelayHealth();
  setActiveRelayState(poolState("spread"), false);
  markRelayFailure(POOL[0], 429);
  for (let i = 0; i < 8; i++) {
   const order = orderedRelayCandidates();
   assert.notEqual(order[0], POOL[0], "a cooling relay must not lead");
   assert.equal(order[order.length - 1], POOL[0], "cooling relay stays at the tail");
  }
 });
});

test("spread: reasoning issuer affinity still hoists the preferred relay", async () => {
 await withIsolatedRelayFiles(async () => {
  resetAllRelayHealth();
  setActiveRelayState(poolState("spread"), false);
  const order = orderedRelayCandidates(POOL[3]);
  assert.equal(order[0], POOL[3], "preferred issuer must lead despite spread");
  assert.equal(order.length, POOL.length);
 });
});

test("spread: a relay that served after a roll does not rewrite the sticky primary", async () => {
 await withIsolatedRelayFiles(async () => {
  resetAllRelayHealth();
  setActiveRelayState(poolState("spread"), false);
  let calls = 0;
  test.mock.method(globalThis, "fetch", async () => stubResponse(++calls === 1 ? 429 : 200));
  await relayFetch("https://opencode.ai/zen/v1/chat/completions", {}, "spread-rid");
  assert.equal(
   getActiveRelayState().url,
   POOL[0],
   "spread has no single primary, so state.url must stay put",
  );
 });
});

test("auto: the same roll still rewrites the sticky primary (regression)", async () => {
 await withIsolatedRelayFiles(async () => {
  resetAllRelayHealth();
  setActiveRelayState(poolState("auto"), false);
  let calls = 0;
  test.mock.method(globalThis, "fetch", async () => stubResponse(++calls === 1 ? 429 : 200));
  await relayFetch("https://opencode.ai/zen/v1/chat/completions", {}, "auto-rid");
  const served = getActiveRelayState().url;
  assert.notEqual(served, POOL[0], "auto mode keeps its sticky-switch behaviour");
  assert.ok(POOL.includes(served));
 });
});

test("loadRelayState accepts the spread mode from disk", async () => {
 await withIsolatedRelayFiles(async () => {
  saveRelayState(poolState("spread"));
  assert.equal(loadRelayState().mode, "spread");
 });
});
