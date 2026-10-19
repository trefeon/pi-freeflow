/**
 * Relay-egress model gate: only free-catalog models ride relays,
 * unknown/paid models go direct upstream.
 *
 * Unit-covers isRelayEligibleModel plus one proxy-level routing proof:
 * with a seeded fake relay pool, a free-model POST touches the relay URL
 * while an unknown-model POST only ever hits direct upstream.
 */
import "./user-flow-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { isRelayEligibleModel, startProxy } from "../src/proxy.ts";
import { resetAllRelayHealth, setActiveRelayState } from "../src/relay-state.ts";
import type { KnownRelay, RelayState } from "../src/types.ts";
import { clearSandboxFiles, withIsolatedSandboxFiles } from "./_sandbox-helpers.ts";
import { authHeaders } from "./_auth.ts";

const ZEN_FREE = "nemotron-3.5-super-vl-free";
const KILO_FREE = "dots-studio/dots-3-note-preview:free";
const UNKNOWN_MODEL = "gpt-9-ultra-paid";
const OVH_FREE = "ovh-free/gpt-oss-20b";

// ── Helper unit coverage ──────────────────────────────────────────

test("isRelayEligibleModel allows zen free catalog ids", () => {
 assert.equal(isRelayEligibleModel(ZEN_FREE), true);
	assert.equal(isRelayEligibleModel("mimo-v2.6-flash-free"), true);
	assert.equal(isRelayEligibleModel("mimo-v2.5-free"), false, "pruned model must not stay relay-eligible");
	assert.equal(isRelayEligibleModel("ling-3.0-flash-fin-free"), false, "pruned model must not stay relay-eligible");
});

test("isRelayEligibleModel allows kilo free catalog ids", () => {
 assert.equal(isRelayEligibleModel(KILO_FREE), true);
});

test("isRelayEligibleModel rejects direct-only lanes (Cline, OVH)", () => {
 // Both lanes fetch upstream themselves and are deliberately absent from
 // the deployed relay allowlist, so neither may ever be labeled eligible.
 assert.equal(isRelayEligibleModel(OVH_FREE), false, "ovh catalog ids are never relay-eligible");
 assert.equal(isRelayEligibleModel("gpt-oss-20b"), false, "an ovh alias resolves to an ovh id first");
 assert.equal(isRelayEligibleModel("z-ai/glm-5.3-flash"), false, "cline stays direct-only");
});

test("isRelayEligibleModel rejects unknown/paid models and non-strings", () => {
 assert.equal(isRelayEligibleModel(UNKNOWN_MODEL), false);
 assert.equal(isRelayEligibleModel("gpt-4"), false);
 assert.equal(isRelayEligibleModel(42), false);
 assert.equal(isRelayEligibleModel({}), false);
 assert.equal(isRelayEligibleModel([]), false);
});

test("isRelayEligibleModel allows missing/empty models (bodiless routes keep routing)", () => {
 assert.equal(isRelayEligibleModel(undefined), true);
 assert.equal(isRelayEligibleModel(null), true);
 assert.equal(isRelayEligibleModel(""), true);
 assert.equal(isRelayEligibleModel("   "), true);
});

// ── Proxy-level routing proof ─────────────────────────────

/** Minimal JSON response the proxy can pipe (mirrors user-flow stubResponse). */
function stubJson(body: string): Response {
 const encoder = new TextEncoder();
 return {
  status: 200,
  ok: true,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => body,
  body: new ReadableStream({
   start(controller) {
    controller.enqueue(encoder.encode(body));
    controller.close();
   },
  }),
 } as unknown as Response;
}

function chatBody(model: string): string {
 return JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] });
}

test("unknown-model POST bypasses the relay pool while free-model POST uses it", async () => {
 await withIsolatedSandboxFiles(async () => {
  clearSandboxFiles();
  const relay = "http://127.0.0.1:19371";
  const state: RelayState = {
   mode: "on",
   enabled: true,
   url: relay,
   relays: [{ url: relay }] as KnownRelay[],
  };
  const testPort = 19370;
  const { server, port } = await startProxy(testPort);
  assert.ok(server, "proxy must start");
  const effectivePort = port ?? testPort;
  const localPrefix = `http://127.0.0.1:${effectivePort}`;
  const realFetch = globalThis.fetch.bind(globalThis);
  const seen: string[] = [];
  try {
   setActiveRelayState(state, true);
   resetAllRelayHealth();
   const fetchMock = test.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init?: RequestInit) => {
     const u = String(url);
     if (u.startsWith(localPrefix)) return realFetch(u, init);
     seen.push(u);
     return stubJson(JSON.stringify({ id: "ok", choices: [] }));
    },
   );
   try {
    // Free catalog model rides the relay even with the pool on.
    const freeRes = await fetch(`${localPrefix}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json", ...authHeaders() },
     body: chatBody(ZEN_FREE),
    });
    assert.equal(freeRes.status, 200);
    await freeRes.text();
    assert.ok(
     seen.some((u) => u.startsWith(relay)),
     `free-model POST must touch the relay URL, saw: ${seen.join(", ")}`,
    );

    // Unknown/paid model bypasses every relay and goes direct.
    seen.length = 0;
    const paidRes = await fetch(`${localPrefix}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json", ...authHeaders() },
     body: chatBody(UNKNOWN_MODEL),
    });
    assert.equal(paidRes.status, 200);
    await paidRes.text();
    assert.ok(seen.length > 0, "unknown-model POST must still reach upstream");
    assert.ok(
     seen.every((u) => !u.startsWith(relay)),
     `unknown-model POST must never touch a relay URL, saw: ${seen.join(", ")}`,
    );
    assert.ok(
     seen.some((u) => u.includes("opencode.ai")),
     `unknown-model POST must go direct upstream, saw: ${seen.join(", ")}`,
    );
   } finally {
    fetchMock.mock.restore();
   }
  } finally {
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});

test("ovh-model POST bypasses the relay pool while a zen free-model POST uses it", async () => {
 // Direct-only lane: the OVH branch fetches upstream itself, so with the
 // pool on an OVH request must still land on the OVH endpoint and must never
 // touch a relay URL. The zen request in the same live pool proves the pool
 // is genuinely armed, so the OVH bypass is a decision and not a no-op test.
 await withIsolatedSandboxFiles(async () => {
  clearSandboxFiles();
  const relay = "http://127.0.0.1:19373";
  const state: RelayState = {
   mode: "on",
   enabled: true,
   url: relay,
   relays: [{ url: relay }] as KnownRelay[],
  };
  const testPort = 19372;
  const { server, port } = await startProxy(testPort);
  assert.ok(server, "proxy must start");
  const effectivePort = port ?? testPort;
  const localPrefix = `http://127.0.0.1:${effectivePort}`;
  const realFetch = globalThis.fetch.bind(globalThis);
  const seen: string[] = [];
  try {
   setActiveRelayState(state, true);
   resetAllRelayHealth();
   const fetchMock = test.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init?: RequestInit) => {
     const u = String(url);
     if (u.startsWith(localPrefix)) return realFetch(u, init);
     seen.push(u);
     return stubJson(JSON.stringify({ id: "ok", choices: [] }));
    },
   );
   try {
    // Zen free model rides the relay: the pool is armed and reachable.
    const zenRes = await fetch(`${localPrefix}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json", ...authHeaders() },
     body: chatBody(ZEN_FREE),
    });
    assert.equal(zenRes.status, 200);
    await zenRes.text();
    assert.ok(
     seen.some((u) => u.startsWith(relay)),
     `zen free-model POST must touch the relay URL, saw: ${seen.join(", ")}`,
    );

    // OVH model never rides it, by catalog id and by short alias.
    for (const model of [OVH_FREE, "gpt-oss-20b"]) {
     seen.length = 0;
     const ovhRes = await fetch(`${localPrefix}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: chatBody(model),
     });
     assert.equal(ovhRes.status, 200);
     await ovhRes.text();
     assert.ok(seen.length > 0, "ovh POST must still reach upstream");
     assert.ok(
      seen.every((u) => !u.startsWith(relay)),
      `ovh POST (${model}) must never touch a relay URL, saw: ${seen.join(", ")}`,
     );
     assert.ok(
      seen.some((u) => u.includes("oai.endpoints.kepler.ai.cloud.ovh.net")),
      `ovh POST (${model}) must go direct to OVH, saw: ${seen.join(", ")}`,
     );
    }
   } finally {
    fetchMock.mock.restore();
   }
  } finally {
   if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});
