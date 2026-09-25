/**
 * Command-level coverage for the P0/P1/P2 /freeflow wiring:
 * test subcommand, status banner, list health badges, logs relay filter,
 * and the deploy picker/confirm flow.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCommandSpec, validateDeployProjectName } from "../src/commands.ts";
import { LOG_FILE, RELAY_STATE_FILE } from "../src/config.ts";
import {
 loadRelayState,
 markRelayFailure,
 markRelaySuccess,
 resetAllRelayHealth,
 setActiveRelayState,
} from "../src/relay-state.ts";
import {
 _resetClinePoolCacheForTest,
 CLINE_POOL_BACKUP_FILE,
 CLINE_POOL_FILE,
 addAccount,
} from "../src/cline-accounts.ts";
import {
 _resetUpstreamHealthForTest,
 recordUpstreamFailure,
} from "../src/upstream-health.ts";
import type {
 ExtensionAPI,
 ExtensionContext,
 ExtensionUIContext,
 RelayState,
} from "../src/types.ts";

async function withSavedDiskState(fn: () => Promise<void> | void): Promise<void> {
 const read = (p: string): string | null =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
 const mainBefore = read(RELAY_STATE_FILE);
 const bakBefore = read(`${RELAY_STATE_FILE}.bak`);
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
  restore(`${RELAY_STATE_FILE}.bak`, bakBefore);
 }
}
function createMockContext(opts: {
 inputValues?: Array<string | undefined>;
 selectValue?: string | null;
 confirmValue?: boolean;
} = {}): {
 ctx: ExtensionContext;
 notifications: Array<{ message: string; type?: string }>;
 statuses: Array<{ key: string; status?: string }>;
 confirms: Array<{ title: string; message?: string }>;
} {
 const notifications: Array<{ message: string; type?: string }> = [];
 const statuses: Array<{ key: string; status?: string }> = [];
 const confirms: Array<{ title: string; message?: string }> = [];
 const inputValues = opts.inputValues ?? [];
 let inputIdx = 0;

 const ui: ExtensionUIContext = {
  notify(message: string, type?: "info" | "warning" | "error") {
   notifications.push({ message, type });
  },
  setStatus(key: string, status: string | undefined) {
   statuses.push({ key, status });
  },
  input(_prompt: string, defaultValue?: string) {
   const v = inputValues[inputIdx++];
   return Promise.resolve(v !== undefined ? v : (defaultValue ?? ""));
  },
  select(_prompt: string, options: string[]) {
   const v = opts.selectValue;
   if (v === undefined) return Promise.resolve(options[0]);
   return Promise.resolve(v === null ? undefined : v);
  },
  confirm(_title: string, _message?: string) {
   confirms.push({ title: _title, message: _message });
   return Promise.resolve(opts.confirmValue ?? true);
  },
 };

 return {
  ctx: { ui },
  notifications,
  statuses,
  confirms,
 };
}

const mockApi: ExtensionAPI = {
 registerProvider() { },
 registerCommand() { },
};

function singleRelayState(): RelayState {
 return {
  mode: "auto",
  enabled: true,
  url: "https://relay1.example.com",
  relays: [{ url: "https://relay1.example.com", label: "relay1" }],
 };
}

const VERCEL_OPTION = "Vercel (1M req/mo — recommended)";

// ── /freeflow test ───────────────────────────────────────────────────

test("command spec: /freeflow test reports ok (HTTP 200) for a reachable relay", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState(singleRelayState(), false);
  t.mock.method(globalThis, "fetch", async () => {
   return {
    status: 200,
    ok: true,
    headers: new Headers(),
    text: async () => "",
    body: null,
   } as unknown as Response;
  });
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext();

  await spec.handler("test relay1", ctx);

  assert.ok(
   notifications.some((n) => n.message.includes("ok (HTTP 200")),
   `expected ok (HTTP 200) notify, got: ${JSON.stringify(notifications)}`,
  );
 });
});

test("command spec: /freeflow test unknown target notifies not-in-saved-list", async () => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState(singleRelayState(), false);
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext();

  await spec.handler("test nope", ctx);

  assert.ok(
   notifications.some((n) => n.message.includes("not in saved list")),
   `expected not-in-saved-list notify, got: ${JSON.stringify(notifications)}`,
  );
 });
});

test("command spec: /freeflow test failure reports failed on fetch error", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState(singleRelayState(), false);
  t.mock.method(globalThis, "fetch", async () => {
   throw new Error("ECONNREFUSED");
  });
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext();

  await spec.handler("test relay1", ctx);

  assert.ok(
   notifications.some((n) => n.message.includes("failed")),
   `expected failed notify, got: ${JSON.stringify(notifications)}`,
  );
 });
});

test("command spec: /freeflow test opencode tests upstream OpenCode directly", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState(singleRelayState(), false);
  let calledUrl = "";
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
   calledUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
   return {
    status: 200,
    ok: true,
    headers: new Headers(),
    text: async () => "",
    body: null,
   } as unknown as Response;
  });
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext();

  await spec.handler("test opencode", ctx);

  assert.equal(calledUrl, "https://opencode.ai/zen/v1/models");
  assert.ok(
   notifications.some((n) => n.message.includes("OpenCode endpoint ok (HTTP 200")),
   `expected OpenCode endpoint ok notify, got: ${JSON.stringify(notifications)}`,
  );
 });
});

test("command spec: /freeflow test opencode --chat performs a chat probe", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState(singleRelayState(), false);
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
   calledUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
   calledInit = init;
   return {
    status: 200,
    ok: true,
    headers: new Headers(),
    text: async () => "",
    body: null,
   } as unknown as Response;
  });
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext();

  await spec.handler("test opencode --chat", ctx);

  assert.equal(calledUrl, "https://opencode.ai/zen/v1/chat/completions");
  assert.equal(calledInit?.method, "POST");
  assert.ok(
   notifications.some((n) => n.message.includes("OpenCode endpoint ok (HTTP 200")),
   `expected OpenCode endpoint ok notify, got: ${JSON.stringify(notifications)}`,
  );
 });
});

test("command spec: /freeflow test with no args falls back to active relay", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState(singleRelayState(), false);
  let calledUrl = "";
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
   calledUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
   return {
    status: 200,
    ok: true,
    headers: new Headers(),
    text: async () => "",
    body: null,
   } as unknown as Response;
  });
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext();

  await spec.handler("test", ctx);

  assert.equal(calledUrl, "https://relay1.example.com/v1/models");
  assert.ok(
   notifications.some((n) => n.message.includes("ok (HTTP 200")),
   `expected ok notify, got: ${JSON.stringify(notifications)}`,
  );
 });
});

// ── /freeflow status ─────────────────────────────────────────────────

test("command spec: /freeflow status banner shows mode, pool size and state file", async () => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  const state: RelayState = {
   mode: "auto",
   enabled: true,
   url: "https://relay1.example.com",
   relays: [
    { url: "https://relay1.example.com", label: "relay1" },
    { url: "https://relay2.example.com", label: "relay2" },
   ],
  };
  setActiveRelayState(state, false);
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext();

  await spec.handler("status", ctx);

  assert.ok(
   notifications.some(
    (n) =>
     n.message.includes("Mode: auto") &&
     n.message.includes("2 relay(s)") &&
     n.message.includes("State file:"),
   ),
   `expected status banner, got: ${JSON.stringify(notifications)}`,
  );
 });
});

test("command spec: /freeflow status shows upstream open when nothing gated", async () => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  _resetUpstreamHealthForTest();
  try {
   setActiveRelayState(singleRelayState(), false);
   const spec = createCommandSpec(mockApi);
   const { ctx, notifications } = createMockContext();

   await spec.handler("status", ctx);

   assert.ok(
    notifications.some((n) => n.message.includes("Upstream: zen open | kilo open")),
    `expected open upstream line, got: ${JSON.stringify(notifications)}`,
   );
  } finally {
   _resetUpstreamHealthForTest();
  }
 });
});

test("command spec: /freeflow status shows zen gated with fail count after free-tier 403s", async () => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  _resetUpstreamHealthForTest();
  try {
   const freeTierBody = JSON.stringify({
    error: {
     type: "FreeTierError",
     message: "OpenCode's free tier can only be used from within OpenCode",
    },
   });
   recordUpstreamFailure("zen", 403, freeTierBody);
   recordUpstreamFailure("zen", 403, freeTierBody);
   setActiveRelayState(singleRelayState(), false);
   const spec = createCommandSpec(mockApi);
   const { ctx, notifications } = createMockContext();

   await spec.handler("status", ctx);

   assert.ok(
    notifications.some((n) =>
     n.message.includes("Upstream: zen gated (2 fails) — new sessions degraded | kilo open"),
    ),
    `expected gated upstream line, got: ${JSON.stringify(notifications)}`,
   );
  } finally {
   _resetUpstreamHealthForTest();
  }
 });
});

// ── /freeflow list ───────────────────────────────────────────────────

test("command spec: /freeflow list shows latency badge and ok/fail counters", async () => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState(singleRelayState(), false);
  markRelayFailure("https://relay1.example.com", 503, "boom");
  markRelaySuccess("https://relay1.example.com", 250);

  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext();

  await spec.handler("list", ctx);

  const msg = notifications.find((n) => n.message.includes("Saved Relays"));
  assert.ok(msg, `expected list header, got: ${JSON.stringify(notifications)}`);
  assert.ok(
   msg.message.includes("[250ms]"),
   `expected [250ms] latency badge, got: ${msg.message}`,
  );
  assert.ok(
   msg.message.includes("ok / "),
   `expected ok/fail counters, got: ${msg.message}`,
  );
 });
});

// ── /freeflow logs relay <text> ──────────────────────────────────────

test("command spec: /freeflow logs relay <text> sets filterText, not a level", async () => {
 const hadLog = fs.existsSync(LOG_FILE);
 const backup = hadLog ? fs.readFileSync(LOG_FILE, "utf8") : null;
 try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(
   LOG_FILE,
   "[INFO] relay1 round trip ok\n[INFO] unrelated line\n",
  );
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext();

  await spec.handler("logs relay relay1", ctx); // must not throw

  const header = notifications.find((n) => n.message.includes("text=relay1"));
  assert.ok(
   header,
   `expected relay text filter in logs notify, got: ${JSON.stringify(notifications)}`,
  );
  // The 'relay' flag must be consumed as a filter marker, never parsed
  // as a log level (which would surface as level=relay).
  assert.ok(
   !header.message.includes("level=relay"),
   `relay flag leaked into level filter: ${header.message}`,
  );
 } finally {
  if (hadLog && backup !== null) {
   fs.writeFileSync(LOG_FILE, backup);
  } else if (!hadLog) {
   try { fs.unlinkSync(LOG_FILE); } catch { }
  }
 }
});

// ── /freeflow deploy picker + confirm ────────────────────────────────

type StubResponse = { status?: number; body?: unknown; reject?: string };

function scriptedFetch(
 responder: (url: string, init: RequestInit | undefined, call: number) => StubResponse,
): typeof fetch {
 let call = 0;
 return (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
   typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const r = responder(url, init, call++);
  if (r.reject) throw new Error(r.reject);
  const status = r.status ?? 200;
  const payload = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
  return new Response(payload, {
   status,
   headers: { "content-type": "application/json" },
  });
 }) as typeof fetch;
}

test("command spec: /freeflow deploy vercel picker + confirm deploys and probes reachable", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
  t.mock.method(
   globalThis,
   "fetch",
   scriptedFetch((url, init) => {
    if (url.endsWith("/v1/models")) {
     return { status: 200, body: {} }; // post-deploy probe
    }
    if (url.includes("/v13/deployments/")) {
     return { body: { readyState: "READY", url: "relay-my-relay.vercel.app" } };
    }
    if (url.includes("/v13/deployments") && init?.method === "POST") {
     return { body: { id: "dep1", projectId: "proj1" } };
    }
    if (url.includes("/v9/projects/")) {
     return { body: {} };
    }
    return { status: 500, body: { error: { message: `unexpected ${init?.method} ${url}` } } };
   }),
  );
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext({
   selectValue: VERCEL_OPTION,
   inputValues: ["fake-token", "my-relay"],
   confirmValue: true,
  });

  await spec.handler("deploy", ctx);

  assert.ok(
   notifications.some((n) => n.message.includes("Deployed & active")),
   `expected Deployed & active notify, got: ${JSON.stringify(notifications)}`,
  );
  assert.ok(
   notifications.some((n) => n.message.includes("reachable")),
   `expected reachable probe note, got: ${JSON.stringify(notifications)}`,
  );
 });
});

test("command spec: /freeflow deploy picker cancelled does not deploy", async () => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext({
   selectValue: null, // picker cancelled
  });

  await spec.handler("deploy", ctx);

  assert.equal(
   notifications.some((n) => n.message.includes("Deploy")),
   false,
   `no Deploy notify expected after cancelled picker, got: ${JSON.stringify(notifications)}`,
  );
 });
});

test("command spec: /freeflow deploy confirm declined notifies Deploy cancelled", async () => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext({
   selectValue: VERCEL_OPTION,
   inputValues: ["fake-token", "my-relay"],
   confirmValue: false,
  });

  await spec.handler("deploy", ctx);

  assert.ok(
   notifications.some((n) => n.message.includes("Deploy cancelled")),
   `expected Deploy cancelled notify, got: ${JSON.stringify(notifications)}`,
  );
 });
});

// ── /freeflow deploy hardening: validation, dedupe, hygiene, atomicity ──

test("deploy validator rejects unusable names and over-long platform names (pure)", () => {
 assert.equal(validateDeployProjectName("!!!", "vercel").ok, false);
 assert.equal(validateDeployProjectName("---", "deno").ok, false);
 const good = validateDeployProjectName("My Cool Relay!", "vercel");
 assert.equal(good.ok, true);
 if (good.ok) assert.equal(good.name, "my-cool-relay");
 assert.equal(validateDeployProjectName("a".repeat(40), "deno").ok, false);
 assert.equal(validateDeployProjectName("a".repeat(32), "deno").ok, true);
 assert.equal(validateDeployProjectName("a".repeat(60), "cloudflare").ok, false);
 assert.equal(validateDeployProjectName("a".repeat(58), "cloudflare").ok, true);
 assert.equal(validateDeployProjectName("relay-mfx123abc", "vercel").ok, true);
});

test("command spec: /freeflow deploy rejects a garbage project name before any network call", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
   fetchCalls++;
   return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext({
   selectValue: VERCEL_OPTION,
   inputValues: ["fake-token-12345", "!!!"],
   confirmValue: true,
  });
  await spec.handler("deploy", ctx);
  assert.equal(fetchCalls, 0, "no network call may precede project-name validation");
  assert.ok(notifications.some((n) => n.message.includes("Deploy cancelled")));
  assert.ok(!notifications.some((n) => n.message.includes("Deployed & active")));
 });
});

test("command spec: /freeflow deploy deno rejects an over-long name before any network call", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
   fetchCalls++;
   return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext({
   inputValues: ["fake-token-12345", "a".repeat(40)],
   confirmValue: true,
  });
  await spec.handler("deploy deno", ctx);
  assert.equal(fetchCalls, 0, "no network call may precede project-name validation");
  assert.ok(notifications.some((n) => n.message.includes("Deploy cancelled")));
 });
});

test("command spec: /freeflow deploy dedupes a re-deployed URL, keeps a custom label, refreshes the secret", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  const seedUrl = "https://relay-dedupe-case.vercel.app";
  const seed: RelayState = { mode: "auto", enabled: true, url: seedUrl, relays: [{ url: seedUrl, label: "prod", auth: "old-secret" }] };
  setActiveRelayState(seed, false);
  fs.writeFileSync(RELAY_STATE_FILE, JSON.stringify(seed), "utf8");
  t.mock.method(globalThis, "fetch", scriptedFetch((url, init) => {
   if (url.endsWith("/v1/models")) return { status: 200, body: {} };
   if (url.includes("/v13/deployments/")) return { body: { readyState: "READY", url: "relay-dedupe-case.vercel.app/" } };
   if (url.includes("/v13/deployments") && init?.method === "POST") return { body: { id: "dep1", projectId: "proj1" } };
   if (url.includes("/v9/projects/")) return { body: {} };
   return { status: 500, body: {} };
  }));
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext({
   selectValue: VERCEL_OPTION,
   inputValues: ["fake-token-12345", "second-run"],
   confirmValue: true,
  });
  await spec.handler("deploy", ctx);
  const onDisk = loadRelayState();
  assert.equal(onDisk.relays.length, 1, "trailing-slash re-deploy must not duplicate the pool entry");
  assert.equal(onDisk.relays[0].url, seedUrl);
  assert.equal(onDisk.relays[0].label, "prod", "a user-chosen short name survives re-deploy");
  const refreshedAuth = onDisk.relays[0].auth;
  assert.ok(typeof refreshedAuth === "string" && refreshedAuth.length > 0 && refreshedAuth !== "old-secret", "re-deploy refreshes the relay secret");
  assert.equal(onDisk.url, seedUrl);
  assert.ok(notifications.some((n) => n.message.includes("Deployed & active")));
 });
});

test("command spec: /freeflow deploy confirm shows only the last 4 of the API token and never persists it", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
  t.mock.method(globalThis, "fetch", scriptedFetch((url, init) => {
   if (url.endsWith("/v1/models")) return { status: 200, body: {} };
   if (url.includes("/v13/deployments/")) return { body: { readyState: "READY", url: "relay-hygiene-case.vercel.app" } };
   if (url.includes("/v13/deployments") && init?.method === "POST") return { body: { id: "dep1", projectId: "proj1" } };
   if (url.includes("/v9/projects/")) return { body: {} };
   return { status: 500, body: {} };
  }));
  const secret = "fake-token-SECRET-99";
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications, confirms } = createMockContext({
   selectValue: VERCEL_OPTION,
   inputValues: [secret, "my-relay"],
   confirmValue: true,
  });
  await spec.handler("deploy", ctx);
  assert.equal(confirms.length, 1);
  assert.ok(!confirms[0].message?.includes(secret), "confirm must not echo the full token");
  assert.ok(confirms[0].message?.includes(secret.slice(-4)), "confirm shows the last 4 for identification");
  assert.ok(notifications.every((n) => !n.message.includes(secret)), "no notify may carry the token");
  const diskRaw = fs.readFileSync(RELAY_STATE_FILE, "utf8");
  assert.ok(!diskRaw.includes(secret), "the platform token must never reach the state file");
 });
});

test("command spec: /freeflow deploy failure redacts the API token from the error", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
  const secret = "fake-token-SECRET-99";
  t.mock.method(globalThis, "fetch", scriptedFetch((url, init) => {
   if (url.includes("/v13/deployments") && init?.method === "POST") {
    return { status: 400, body: { error: { message: `rejected key ${secret}: bad credentials` } } };
   }
   return { status: 500, body: {} };
  }));
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext({
   selectValue: VERCEL_OPTION,
   inputValues: [secret, "my-relay"],
   confirmValue: true,
  });
  await spec.handler("deploy", ctx);
  const failure = notifications.find((n) => n.message.startsWith("Deploy failed"));
  assert.ok(failure, "deploy must report the failure");
  assert.ok(!failure.message.includes(secret), "the token must be redacted from the error");
  assert.ok(failure.message.includes("[redacted]"));
 });
});

test("command spec: /freeflow deploy surfaces the live URL plus a manual add when the pool write fails", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
  const liveUrl = "https://relay-pool-fail-case.vercel.app";
  t.mock.method(globalThis, "fetch", scriptedFetch((url, init) => {
   if (url.endsWith("/v1/models")) return { status: 200, body: {} };
   if (url.includes("/v13/deployments/")) return { body: { readyState: "READY", url: "relay-pool-fail-case.vercel.app" } };
   if (url.includes("/v13/deployments") && init?.method === "POST") return { body: { id: "dep1", projectId: "proj1" } };
   if (url.includes("/v9/projects/")) return { body: {} };
   return { status: 500, body: {} };
  }));
  const origWrite = fs.writeFileSync;
  let blockStateWrites = true;
  t.mock.method(fs, "writeFileSync", (function(...args: unknown[]) {
   const p = args[0];
   if (blockStateWrites && typeof p === "string" && p.startsWith(RELAY_STATE_FILE)) throw new Error("mock EACCES");
   return (origWrite as (...a: never[]) => unknown)(...(args as never[]));
  }) as unknown as typeof fs.writeFileSync);
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext({
   selectValue: VERCEL_OPTION,
   inputValues: ["fake-token-12345", "pool-fail"],
   confirmValue: true,
  });
  await spec.handler("deploy", ctx);
  blockStateWrites = false;
  const surfaced = notifications.find((n) => n.type === "error" && n.message.includes(liveUrl));
  assert.ok(surfaced, `pool-write failure must surface the live URL, got: ${JSON.stringify(notifications)}`);
  assert.ok(surfaced.message.includes(`/freeflow add ${liveUrl}`), "must give the manual-add recovery command");
  assert.ok(!notifications.some((n) => n.message.includes("Deployed & active")), "must not claim success when the pool write failed");
 });
});

test("command spec: /freeflow deploy warns with exact retry/remove commands when the new relay is unreachable", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  setActiveRelayState({ mode: "auto", enabled: true, url: "", relays: [] }, false);
  const liveUrl = "https://relay-unreachable-case.vercel.app";
  t.mock.method(globalThis, "fetch", scriptedFetch((url, init) => {
   if (url.endsWith("/v1/models")) return { status: 502, body: {} };
   if (url.includes("/v13/deployments/")) return { body: { readyState: "READY", url: "relay-unreachable-case.vercel.app" } };
   if (url.includes("/v13/deployments") && init?.method === "POST") return { body: { id: "dep1", projectId: "proj1" } };
   if (url.includes("/v9/projects/")) return { body: {} };
   return { status: 500, body: {} };
  }));
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext({
   selectValue: VERCEL_OPTION,
   inputValues: ["fake-token-12345", "unreachable-run"],
   confirmValue: true,
  });
  await spec.handler("deploy", ctx);
  const done = notifications.find((n) => n.message.includes("Deployed & active"));
  assert.ok(done, `deploy must still activate, got: ${JSON.stringify(notifications)}`);
  assert.ok(done.message.includes(`/freeflow test ${liveUrl}`), "must give the exact retry probe command");
  assert.ok(done.message.includes(`/freeflow remove ${liveUrl}`), "must give the exact remove command");
  assert.equal(loadRelayState().url, liveUrl, "unreachable deploy stays active-primary by explicit warn, never silent");
 });
});

test("command spec: /freeflow remove refuses the active relay so the sticky primary is never stranded", async (t) => {
 await withSavedDiskState(async () => {
  resetAllRelayHealth();
  const activeUrl = "https://relay-sticky-guard.vercel.app";
  const seed: RelayState = { mode: "auto", enabled: true, url: activeUrl, relays: [{ url: activeUrl, label: "keep" }, { url: "https://relay-other-guard.vercel.app", label: "other" }] };
  setActiveRelayState(seed, false);
  fs.writeFileSync(RELAY_STATE_FILE, JSON.stringify(seed), "utf8");
  const spec = createCommandSpec(mockApi);
  const { ctx, notifications } = createMockContext({});
  await spec.handler(`remove ${activeUrl}`, ctx);
  assert.ok(notifications.some((n) => n.message.toLowerCase().includes("cannot remove") || n.message.toLowerCase().includes("active")));
  const onDisk = loadRelayState();
  assert.equal(onDisk.relays.length, 2, "blocked remove must not mutate the pool");
  assert.equal(onDisk.url, activeUrl, "the sticky primary must survive a remove attempt");
 });
});

// ── Cline usage widget ───────────────────────────────────────────────

const CLINE_SLOT_A = "workos:test-key-aaa111";
const CLINE_SLOT_B = "workos:test-key-bbb222";
const CLINE_EMAIL_A = "alice@example.com";
const CLINE_EMAIL_B = "bob@example.org";
const CLINE_MODEL = "cline-free/deepseek-v4.1-flash";

async function withIsolatedClinePool(fn: () => Promise<void> | void): Promise<void> {
 // The pool and its recovery copy: savePool snapshots the main file to .bak,
 // so a helper that restores only the main file leaks fixtures into neighbors.
 const read = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
 const before = read(CLINE_POOL_FILE);
 const beforeBak = read(CLINE_POOL_BACKUP_FILE);
 const restore = (p: string, content: string | null): void => {
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

/** Two logins plus a usage row shaped like the on-disk tracker output. */
function seedClinePoolWithUsage(): void {
 addAccount("default", CLINE_SLOT_A, { email: CLINE_EMAIL_A });
 addAccount("slot-2", CLINE_SLOT_B, { email: CLINE_EMAIL_B });
 _resetClinePoolCacheForTest();
 const doc = JSON.parse(fs.readFileSync(CLINE_POOL_FILE, "utf8"));
 doc.usage = {
  default: { served: 3, lastAt: Date.now() - 2 * 3_600_000, lastModel: CLINE_MODEL },
 };
 fs.writeFileSync(CLINE_POOL_FILE, JSON.stringify(doc), "utf8");
 _resetClinePoolCacheForTest();
}

test("command spec: /freeflow cline accounts shows per-login usage with no raw identity in new text", async () => {
 await withSavedDiskState(async () => {
  await withIsolatedClinePool(async () => {
   seedClinePoolWithUsage();
   const spec = createCommandSpec(mockApi);
   const { ctx, notifications } = createMockContext({});
   await spec.handler("cline accounts", ctx);
   const shown = notifications.map((n) => n.message).join("\n");
   assert.ok(shown.includes("Cline logins (2)"), `must list both logins, got: ${shown}`);
   assert.ok(shown.includes("served 3"), `used slot must show its count, got: ${shown}`);
   assert.ok(shown.includes(`last ${CLINE_MODEL}`), `used slot must show its last model, got: ${shown}`);
   assert.ok(shown.includes("served 0"), `unused slot must show the zero state, got: ${shown}`);
   assert.ok(shown.includes("never used"), `unused slot must read never used, got: ${shown}`);
   // The masked identity lives on the NEW status Cline block (asserted
   // below): account lines keep their legacy login prefix untouched, so the
   // NEW usage text here is only checked to carry no raw identity — just the
   // appended suffix of each account line (from "served" on).
   for (const line of shown.split("\n")) {
    if (!line.includes("served")) continue;
    const suffix = line.slice(line.indexOf("served"));
    assert.ok(!suffix.includes(CLINE_EMAIL_A), `usage suffix must not carry the raw email, got: ${line}`);
    assert.ok(!suffix.includes(CLINE_EMAIL_B), `usage suffix must not carry the raw email, got: ${line}`);
   }
   assert.ok(!shown.includes(CLINE_SLOT_A), "the full token must never surface");
  });
 });
});

test("command spec: /freeflow cline accounts shows never-used zero state without usage rows", async () => {
 await withSavedDiskState(async () => {
  await withIsolatedClinePool(async () => {
   addAccount("default", CLINE_SLOT_A, { email: CLINE_EMAIL_A });
   _resetClinePoolCacheForTest();
   const spec = createCommandSpec(mockApi);
   const { ctx, notifications } = createMockContext({});
   await spec.handler("cline accounts", ctx);
   const shown = notifications.map((n) => n.message).join("\n");
   assert.ok(shown.includes("served 0"), `fresh login must show the zero state, got: ${shown}`);
   assert.ok(shown.includes("never used"), `fresh login must read never used, got: ${shown}`);
  });
 });
});

test("command spec: /freeflow status appends a masked Cline usage block", async () => {
 await withSavedDiskState(async () => {
  await withIsolatedClinePool(async () => {
   seedClinePoolWithUsage();
   resetAllRelayHealth();
   _resetUpstreamHealthForTest();
   setActiveRelayState(singleRelayState(), false);
   const spec = createCommandSpec(mockApi);
   const { ctx, notifications } = createMockContext({});
   await spec.handler("status", ctx);
   const banner = notifications.map((n) => n.message).join("\n");
   assert.ok(banner.includes("Cline: 2 login(s)"), `status must count the Cline logins, got: ${banner}`);
   assert.ok(banner.includes("last used: [default]"), `status must name the most used slot, got: ${banner}`);
   assert.ok(banner.includes("a***@example.com"), "status Cline block must show the masked identity");
   assert.ok(banner.includes(CLINE_MODEL), `status Cline block must name the last model, got: ${banner}`);
   const clineLine = banner.split("\n").find((l) => l.startsWith("Cline:")) ?? "";
   assert.ok(!clineLine.includes(CLINE_EMAIL_A), `status Cline line must never carry the raw email, got: ${clineLine}`);
   assert.ok(!clineLine.includes(CLINE_EMAIL_B), `status Cline line must never carry the raw email, got: ${clineLine}`);
  });
 });
});

test("command spec: /freeflow status and cline accounts handle a fresh empty pool", async () => {
 await withSavedDiskState(async () => {
  await withIsolatedClinePool(async () => {
   resetAllRelayHealth();
   _resetUpstreamHealthForTest();
   setActiveRelayState(singleRelayState(), false);
   const spec = createCommandSpec(mockApi);
   const { ctx: statusCtx, notifications: statusNotes } = createMockContext({});
   await spec.handler("status", statusCtx);
   const banner = statusNotes.map((n) => n.message).join("\n");
   assert.ok(banner.includes("Cline: no logins"), `empty pool must read no logins, got: ${banner}`);
   const { ctx: accountsCtx, notifications: accountsNotes } = createMockContext({});
   await spec.handler("cline accounts", accountsCtx);
   const shown = accountsNotes.map((n) => n.message).join("\n");
   assert.ok(shown.includes("No Cline logins saved"), `empty pool keeps the existing hint, got: ${shown}`);
  });
 });
});