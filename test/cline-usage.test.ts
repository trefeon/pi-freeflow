/**
 * Usage tracking for the per-user Cline key pool: every served turn bumps a
 * per-slot counter row (`usage[slot] = { served, lastAt, lastModel }`).
 * All network use is mocked; the pool file lives in the test sandbox.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
 _resetClinePoolCacheForTest,
 CLINE_POOL_BACKUP_FILE,
 CLINE_POOL_FILE,
 addAccount,
 loadPool,
 recordClineUsageOnDisk,
 rollChat,
} from "../src/cline-accounts.ts";

const SLOT_A = "workos:test-key-aaa111";
const MODEL = "cline-free/deepseek-v4.1-flash";
const CHAT_URL = "https://api.cline.bot/api/v1/chat/completions";

async function withIsolatedPool(fn: () => Promise<void> | void): Promise<void> {
 // Both the pool and its recovery copy: savePool snapshots the main file to
 // .bak, so a helper that restores only the main file leaks test data into the
 // next test and can resurrect its own fixtures.
 const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
 const before = read(CLINE_POOL_FILE);
 const beforeBak = read(CLINE_POOL_BACKUP_FILE);
 const restore = (p: string, content: string | null) => {
  if (content !== null) fs.writeFileSync(p, content, "utf8");
  else {
   try { fs.rmSync(p, { force: true }); } catch { }
  }
 };
 try {
  fs.rmSync(CLINE_POOL_FILE, { force: true });
  fs.rmSync(CLINE_POOL_BACKUP_FILE, { force: true });
 } catch { }
 _resetClinePoolCacheForTest();
 try {
  await fn();
 } finally {
  _resetClinePoolCacheForTest();
  restore(CLINE_POOL_FILE, before);
  restore(CLINE_POOL_BACKUP_FILE, beforeBak);
 }
}

function jsonResponse(status: number, body = "{}"): Response {
 return new Response(body, { status, headers: { "content-type": "application/json" } });
}

test("cline usage: served turn writes a usage row", async () => {
 await withIsolatedPool(async () => {
  addAccount("main", SLOT_A, { email: "alice@example.com" });
  const before = Date.now();
  const res = await rollChat({
   body: JSON.stringify({ model: MODEL, stream: true }),
   chatUrl: CHAT_URL,
   fetchImpl: (async () => jsonResponse(200, '{"ok":true}')) as typeof fetch,
  });
  assert.equal(res.exhausted, false);
  assert.equal(res.slot, "main");
  _resetClinePoolCacheForTest();
  const pool = loadPool();
  const row = pool.usage?.["main"];
  assert.ok(row, "expected a usage row for the serving slot");
  assert.equal(row.served, 1);
  assert.equal(row.lastModel, MODEL);
  assert.ok(row.lastAt >= before && row.lastAt <= Date.now());
  // Counters only: the usage row must not carry the bearer or the identity.
  const doc: unknown = JSON.parse(fs.readFileSync(CLINE_POOL_FILE, "utf8"));
  assert.ok(doc && typeof doc === "object" && "usage" in doc);
  const usageBlob = JSON.stringify(doc.usage);
  assert.ok(!usageBlob.includes(SLOT_A), "usage row leaks the token");
  assert.ok(!usageBlob.includes("alice@example.com"), "usage row leaks the email");
 });
});

test("cline usage: second served turn bumps the counter", async () => {
 await withIsolatedPool(async () => {
  addAccount("main", SLOT_A);
  const okFetch = (async () => jsonResponse(200, '{"ok":true}')) as typeof fetch;
  await rollChat({ body: JSON.stringify({ model: MODEL, stream: true }), chatUrl: CHAT_URL, fetchImpl: okFetch });
  await rollChat({ body: JSON.stringify({ model: MODEL, stream: true }), chatUrl: CHAT_URL, fetchImpl: okFetch });
  _resetClinePoolCacheForTest();
  assert.equal(loadPool().usage?.["main"]?.served, 2);
 });
});

test("cline usage: unknown slot is a no-op", async () => {
 await withIsolatedPool(async () => {
  addAccount("main", SLOT_A);
  recordClineUsageOnDisk("ghost", MODEL);
  _resetClinePoolCacheForTest();
  assert.equal(loadPool().usage, undefined);
 });
});

test("cline usage: failed turns write no usage row", async () => {
 await withIsolatedPool(async () => {
  addAccount("main", SLOT_A);
  const res = await rollChat({
   body: JSON.stringify({ model: MODEL, stream: true }),
   chatUrl: CHAT_URL,
   fetchImpl: (async () => jsonResponse(500)) as typeof fetch,
  });
  assert.equal(res.exhausted, true);
  _resetClinePoolCacheForTest();
  assert.equal(loadPool().usage, undefined);
 });
});
