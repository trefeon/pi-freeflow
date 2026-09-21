/**
 * Unit tests for the per-user Cline key pool and /freeflow cline commands.
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
 mapClineError,
 redactedToken,
 removeAccount,
 rollChat,
} from "../src/cline-accounts.ts";
import { CLINE_BROWSER_SIGNOUT_URL } from "../src/cline-device-auth.ts";
import { createCommandSpec } from "../src/commands.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../src/types.ts";

const SLOT_A = "workos:test-key-aaa111";
const SLOT_B = "workos:test-key-bbb222";

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

test("cline pool: login saves and reloads a slot", async () => {
 await withIsolatedPool(() => {
  addAccount("main", SLOT_A);
  _resetClinePoolCacheForTest();
  const pool = loadPool();
  assert.equal(pool.accounts.length, 1);
  assert.equal(pool.accounts[0].slot, "main");
  assert.equal(pool.accounts[0].token, SLOT_A);
 });
});

test("cline pool: file is owner-only", async () => {
 await withIsolatedPool(() => {
  addAccount("main", SLOT_A);
  if (process.platform === "win32") return;
  const mode = fs.statSync(CLINE_POOL_FILE).mode & 0o777;
  assert.equal(mode, 0o600);
 });
});

test("cline pool: corrupt file reads back empty", async () => {
 await withIsolatedPool(() => {
  fs.writeFileSync(CLINE_POOL_FILE, "{not json", "utf8");
  _resetClinePoolCacheForTest();
  assert.deepEqual(loadPool().accounts, []);
 });
});

test("cline pool: skips entries without a workos: key", async () => {
 await withIsolatedPool(() => {
  fs.writeFileSync(
   CLINE_POOL_FILE,
   JSON.stringify({ accounts: [{ slot: "bad", token: "sk-plain" }, { slot: "good", token: SLOT_A }] }),
   "utf8",
  );
  _resetClinePoolCacheForTest();
  const pool = loadPool();
  assert.equal(pool.accounts.length, 1);
  assert.equal(pool.accounts[0].slot, "good");
 });
});

test("cline pool: non-workos token is rejected without echoing it", async () => {
 await withIsolatedPool(() => {
  assert.throws(() => addAccount("main", "sk-plain-secret"), (e: unknown) => {
   assert.ok(!(e as Error).message.includes("sk-plain-secret"));
   return true;
  });
 });
});

test("cline pool: remove drops one slot", async () => {
 await withIsolatedPool(() => {
  addAccount("a", SLOT_A);
  addAccount("b", SLOT_B);
  assert.equal(removeAccount("a"), true);
  assert.equal(removeAccount("missing"), false);
  assert.deepEqual(loadPool().accounts.map((a) => a.slot), ["b"]);
 });
});

test("cline pool: redacted display leaks only the tail", () => {
 assert.equal(redactedToken(SLOT_A), `…${SLOT_A.slice(-4)}`);
 assert.ok(!redactedToken(SLOT_A).includes(SLOT_A.slice(0, -4)));
});

test("mapClineError: status to retryable kind", () => {
 assert.equal(mapClineError(200), "ok");
 assert.equal(mapClineError(401), "auth");
 assert.equal(mapClineError(403), "auth");
 assert.equal(mapClineError(429), "rate-limit");
 assert.equal(mapClineError(402), "exhausted");
 assert.equal(mapClineError(500), "server");
 assert.equal(mapClineError(400), "client");
});

test("rollChat: rolls past a rate-limited slot to the next one", async () => {
 await withIsolatedPool(async () => {
  addAccount("a", SLOT_A);
  addAccount("b", SLOT_B);
  const seen: string[] = [];
  const res = await rollChat({
   body: JSON.stringify({ model: "x", stream: true }),
   chatUrl: "https://api.cline.bot/api/v1/chat/completions",
   fetchImpl: (async (url: unknown, init: unknown) => {
    const auth = new Headers((init as RequestInit).headers).get("authorization") ?? "";
    seen.push(auth);
    return auth.endsWith(SLOT_A.slice(-6)) ? jsonResponse(429) : jsonResponse(200, '{"ok":true}');
   }) as typeof fetch,
  });
  assert.equal(res.slot, "b");
  assert.equal(res.exhausted, false);
  assert.equal(res.res.status, 200);
  assert.ok(seen.every((h) => h.startsWith("Bearer workos:")));
 });
});

test("rollChat: a chat attempt carries the Cline desktop client identity", async () => {
 await withIsolatedPool(async () => {
  addAccount("a", SLOT_A);
  const sent: Headers[] = [];
  const res = await rollChat({
   body: JSON.stringify({ model: "cline-free/kimi-k3", stream: true }),
   chatUrl: "https://api.cline.bot/api/v1/chat/completions",
   fetchImpl: (async (url: unknown, init: unknown) => {
    sent.push(new Headers((init as RequestInit).headers));
    return jsonResponse(200, '{"ok":true}');
   }) as typeof fetch,
  });
  assert.equal(res.res.status, 200);
  assert.equal(sent.length, 1, "one attempt must have reached Cline");
  // The desktop identity is what makes Cline advertise its sixth free model.
  assert.equal(sent[0].get("x-client-type"), "cline-desktop");
 });
});

test("rollChat: all slots failing returns the last real failure", async () => {
 await withIsolatedPool(async () => {
  addAccount("a", SLOT_A);
  const res = await rollChat({
   body: "{}",
   chatUrl: "https://api.cline.bot/api/v1/chat/completions",
   fetchImpl: (async () => jsonResponse(429)) as typeof fetch,
  });
  assert.equal(res.slot, "a");
  assert.equal(res.exhausted, true);
  assert.equal(res.res.status, 429);
 });
});

test("rollChat: empty pool is exhausted with login guidance", async () => {
 await withIsolatedPool(async () => {
  let called = false;
  const res = await rollChat({
   body: "{}",
   chatUrl: "https://api.cline.bot/api/v1/chat/completions",
   fetchImpl: (async () => {
    called = true;
    return jsonResponse(200);
   }) as typeof fetch,
  });
  assert.equal(called, false);
  assert.equal(res.exhausted, true);
  // Not a rate limit: hosts must not back off and hide the login guidance.
  assert.equal(res.res.status, 401);
  const text = await res.res.text();
  assert.ok(text.includes("cline login"));
 });
});

test("rollChat: a transient refresh fault still yields a readable upstream body", async () => {
 await withIsolatedPool(async () => {
  addAccount("a", SLOT_A, { refreshToken: "refresh-a", expiresAt: Date.now() - 1000 });
  const res = await rollChat({
   body: "{}",
   chatUrl: "https://api.cline.bot/api/v1/chat/completions",
   // The saved bearer is stale, the attempt comes back 401, and the refresh
   // itself blows up: the slot's real 401 must survive to the caller intact.
   fetchImpl: (async () => jsonResponse(401, '{"error":{"message":"token expired"}}')) as typeof fetch,
   refreshImpl: async () => {
    throw new Error("network down");
   },
  });
  assert.equal(res.exhausted, true);
  assert.equal(res.res.status, 401);
  const body = await res.res.text();
  assert.ok(body.includes("token expired"), `upstream body must survive, got ${JSON.stringify(body)}`);
 });
});

test("rollChat: a refresh grant Cline rejects marks the slot dead, not transient", async () => {
 await withIsolatedPool(async () => {
  addAccount("a", SLOT_A, { refreshToken: "refresh-a", expiresAt: Date.now() - 1000 });
  let refreshes = 0;
  const res = await rollChat({
   body: "{}",
   chatUrl: "https://api.cline.bot/api/v1/chat/completions",
   fetchImpl: (async () => jsonResponse(401)) as typeof fetch,
   refreshImpl: async () => {
    refreshes += 1;
    return null;
   },
  });
  assert.equal(refreshes, 1, "a dead grant must not be retried within the same request");
  assert.equal(res.exhausted, true);
 });
});

test("rollChat: a caller error returns on the first slot without rolling", async () => {
 await withIsolatedPool(async () => {
  addAccount("a", SLOT_A);
  const res = await rollChat({
   body: "{}",
   chatUrl: "https://api.cline.bot/api/v1/chat/completions",
   fetchImpl: (async () => jsonResponse(400)) as typeof fetch,
  });
  assert.equal(res.slot, "a");
  assert.equal(res.kind, "client");
 });
});

const mockApi: ExtensionAPI = {
 registerProvider() { },
 registerCommand() { },
};

function cliContext(inputs: string[]): { ctx: ExtensionContext; notifications: Array<{ message: string; type?: string }> } {
 const notifications: Array<{ message: string; type?: string }> = [];
 const queue = [...inputs];
 const ui: ExtensionUIContext = {
  notify(message: string, type?: "info" | "warning" | "error") {
   notifications.push({ message, type });
  },
  setStatus() { },
  input(_prompt: string, defaultValue?: string) {
   const next = queue.shift();
   return Promise.resolve(next ?? defaultValue ?? "");
  },
  select(_prompt: string, options: string[]) {
   return Promise.resolve(options[0]);
  },
 };
 return { ctx: { ui }, notifications };
}

test("command: /freeflow cline login saves without leaking the key", async () => {
 await withIsolatedPool(async () => {
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = cliContext([SLOT_A]);
  await spec.handler("cline login main --key", ctx);
  assert.equal(loadPool().accounts.length, 1);
  const shown = notifications.map((n) => n.message).join("\n");
  assert.ok(shown.includes("[main]"));
  assert.ok(!shown.includes(SLOT_A));
 });
});

test("command: /freeflow cline accounts lists saved slots redacted", async () => {
 await withIsolatedPool(async () => {
  addAccount("main", SLOT_A);
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = cliContext([]);
  await spec.handler("cline accounts", ctx);
  const shown = notifications.map((n) => n.message).join("\n");
  assert.ok(shown.includes("[main]"));
  assert.ok(!shown.includes(SLOT_A));
 });
});

test("command: /freeflow cline logout removes the slot", async () => {
 await withIsolatedPool(async () => {
  addAccount("main", SLOT_A);
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = cliContext([]);
  await spec.handler("cline logout main", ctx);
  assert.deepEqual(loadPool().accounts, []);
  assert.ok(notifications.some((n) => n.message.includes("[main]")));
 });
});

test("command: /freeflow cline logout accepts the accounts number", async () => {
 await withIsolatedPool(async () => {
  addAccount("main", SLOT_A);
  addAccount("second", SLOT_B);
  const spec = createCommandSpec(mockApi);
  const { ctx } = cliContext([]);
  await spec.handler("cline logout 1", ctx);
  assert.deepEqual(loadPool().accounts.map((a) => a.slot), ["second"]);
 });
});

test("command: /freeflow cline logout with one login removes it directly", async () => {
 await withIsolatedPool(async () => {
  addAccount("main", SLOT_A);
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = cliContext([]);
  await spec.handler("cline logout", ctx);
  assert.deepEqual(loadPool().accounts, []);
  assert.ok(notifications.some((n) => n.message.includes("[main]")));
 });
});

test("command: /freeflow cline signout shows the browser sign-out link and keeps saved logins", async () => {
 await withIsolatedPool(async () => {
  addAccount("default", SLOT_A);
  addAccount("slot-2", SLOT_B);
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = cliContext([]);
  await spec.handler("cline signout", ctx);
  const shown = notifications.map((n) => n.message).join("\n");
  assert.ok(shown.includes(CLINE_BROWSER_SIGNOUT_URL), "must show the sign-out link");
  assert.ok(shown.includes("you have 2"), "must count the saved logins");
  assert.ok(shown.includes("slot-3"), "must name the slot the next account would use");
  // Browser sign-out is not local removal.
  assert.deepEqual(loadPool().accounts.map((a) => a.slot), ["default", "slot-2"]);
  assert.ok(!shown.includes(SLOT_A) && !shown.includes(SLOT_B), "must never echo a key");
 });
});

test("cline pool: a second slot for the same account is refused", async () => {
 await withIsolatedPool(() => {
  addAccount("default", SLOT_A, { accountId: "user-1", email: "someone@example.com" });
  assert.throws(
   () => addAccount("slot-2", SLOT_B, { accountId: "user-1", email: "someone@example.com" }),
   (e: unknown) => {
    const msg = (e as Error).message;
    assert.ok(msg.includes("[default]"), `must name the existing slot, got: ${msg}`);
    assert.ok(!msg.includes(SLOT_B), "must never echo the token");
    return true;
   },
  );
  assert.deepEqual(loadPool().accounts.map((a) => a.slot), ["default"]);
 });
});

test("cline pool: identity falls back to email, then to an identical key", async () => {
 await withIsolatedPool(() => {
  addAccount("default", SLOT_A, { email: "Someone@Example.com" });
  // Same person, different casing, no account id on either side.
  assert.throws(() => addAccount("slot-2", SLOT_B, { email: "someone@example.com" }));
  // No identity at all: only the same bearer proves the same credential.
  addAccount("keyed", "workos:keyed-token-1");
  assert.throws(() => addAccount("keyed-2", "workos:keyed-token-1"));
  assert.equal(addAccount("keyed-3", "workos:keyed-token-2").accounts.length, 3);
 });
});

test("cline pool: re-logging into an existing slot is not a duplicate", async () => {
 await withIsolatedPool(() => {
  addAccount("default", SLOT_A, { accountId: "user-1", email: "someone@example.com" });
  addAccount("default", SLOT_B, { accountId: "user-1", email: "someone@example.com" });
  assert.deepEqual(loadPool().accounts.map((a) => a.slot), ["default"]);
  assert.equal(loadPool().accounts[0].token, SLOT_B, "the fresh grant replaces the old one");
 });
});

test("command: /freeflow cline login --key refuses an account already saved", async () => {
 await withIsolatedPool(async () => {
  addAccount("default", SLOT_A);
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = cliContext([SLOT_A]);
  await spec.handler("cline login slot-2 --key", ctx);
  assert.deepEqual(loadPool().accounts.map((a) => a.slot), ["default"]);
  const shown = notifications.map((n) => n.message).join("\n");
  assert.ok(shown.includes("[default]"), `must explain the clash, got: ${shown}`);
  assert.ok(!shown.includes(SLOT_A), "must never echo the key");
 });
});

test("command: /freeflow cline accounts marks a duplicate account", async () => {
 await withIsolatedPool(async () => {
  // Written straight to the pool file: this is a pool saved before the
  // duplicate check existed, which is the only way such a pair can exist now.
  fs.writeFileSync(
   CLINE_POOL_FILE,
   JSON.stringify({
    accounts: [
     { slot: "default", token: SLOT_A, addedAt: new Date().toISOString(), email: "someone@example.com" },
     { slot: "slot-2", token: SLOT_B, addedAt: new Date().toISOString(), email: "someone@example.com" },
    ],
    activeSlot: "default",
   }),
   "utf8",
  );
  _resetClinePoolCacheForTest();
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = cliContext([]);
  await spec.handler("cline accounts", ctx);
  const shown = notifications.map((n) => n.message).join("\n");
  assert.ok(shown.includes("same account as [default]"), `must mark the duplicate, got: ${shown}`);
 });
});

test("cline pool: an unreadable main file recovers from the backup copy", async () => {
 await withIsolatedPool(() => {
  addAccount("default", SLOT_A);
  addAccount("slot-2", SLOT_B);
  // Second save snapshots the first, so the backup holds the earlier state.
  addAccount("slot-2", SLOT_B);
  assert.ok(fs.existsSync(CLINE_POOL_BACKUP_FILE), "savePool must keep a recovery copy");
  fs.writeFileSync(CLINE_POOL_FILE, "{not json", "utf8");
  _resetClinePoolCacheForTest();
  const recovered = loadPool();
  assert.deepEqual(recovered.accounts.map((a) => a.slot), ["default", "slot-2"]);
  // Recovery heals the main file so it is not redone on every load.
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(CLINE_POOL_FILE, "utf8")));
 });
});

test("cline pool: a deleted main file recovers from the backup copy", async () => {
 await withIsolatedPool(() => {
  addAccount("default", SLOT_A);
  addAccount("slot-2", SLOT_B);
  fs.rmSync(CLINE_POOL_FILE, { force: true });
  _resetClinePoolCacheForTest();
  assert.deepEqual(loadPool().accounts.map((a) => a.slot), ["default", "slot-2"]);
 });
});

test("cline pool: a legitimately empty pool is never resurrected from the backup", async () => {
 await withIsolatedPool(() => {
  addAccount("default", SLOT_A);
  addAccount("slot-2", SLOT_B);
  assert.deepEqual(removeAccount("default"), true);
  assert.deepEqual(removeAccount("slot-2"), true);
  assert.deepEqual(loadPool().accounts, []);
  // The backup still holds the old logins; removing the last one must stick.
  _resetClinePoolCacheForTest();
  assert.deepEqual(loadPool().accounts, []);
 });
});

test("cline pool: a run of smaller writes cannot clobber the good backup", async () => {
 await withIsolatedPool(() => {
  // The incident this guards: a real 2-login pool replaced by a 1-login
  // fixture, then a second fixture write replacing the backup too.
  addAccount("default", SLOT_A, { email: "real-one@example.com" });
  addAccount("slot-2", SLOT_B, { email: "real-two@example.com" });
  fs.writeFileSync(CLINE_POOL_FILE, JSON.stringify({ accounts: [{ slot: "fixture", token: "workos:fx" }] }), "utf8");
  _resetClinePoolCacheForTest();
  addAccount("fixture-2", "workos:fx2");
  fs.writeFileSync(CLINE_POOL_FILE, "{broken", "utf8");
  _resetClinePoolCacheForTest();
  assert.deepEqual(loadPool().accounts.map((a) => a.slot), ["default", "slot-2"], "the larger good pool must survive");
  assert.deepEqual(
   loadPool().accounts.map((a) => a.email),
   ["real-one@example.com", "real-two@example.com"],
   "the recovered copy must be the real logins, not the fixtures",
  );
 });
});

test("command: /freeflow cline logout offers a picker for several logins", async () => {
 await withIsolatedPool(async () => {
  addAccount("main", SLOT_A);
  addAccount("second", SLOT_B);
  const spec = createCommandSpec(mockApi);
  const { ctx } = cliContext([]);
  await spec.handler("cline logout", ctx);
  assert.deepEqual(loadPool().accounts.map((a) => a.slot), ["second"]);
 });
});
