/**
 * Mock-upstream end-to-end: exercises the real proxy + relayFetch pipeline
 * against a stubbed upstream (no real network), simulating real-world user
 * flows deterministically.
 *
 * Scenarios mirror actual usage:
 *  - new user, direct mode, upstream 200
 *  - relay pool active, upstream 200 through the relay
 *  - relay 429 -> roll to the next candidate -> 200
 *  - all relays fail -> direct fallback -> 200
 *  - all relays fail AND direct fails -> last response returned
 *  - kilo model routing to api.kilo.ai
 *  - /v1/models catalog + /health identity probe + /_health snapshot
 *  - tool-call audit line written for a tool-declaring turn
 *
 * Relay/upstream fetches are stubbed; requests to the local proxy pass
 * through to the real fetch so the full HTTP path is exercised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startProxy } from "../src/proxy.ts";
import {
 resetAllRelayHealth,
 setActiveRelayState,
} from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import { authHeaders } from "./_auth.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

/** Response stub with a proper ReadableStream body (the proxy pipes upstream.body). */
function stubResponse(status: number, body = "{}"): Response {
 const encoder = new TextEncoder();
 return {
  status,
  ok: status >= 200 && status < 300,
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

const OPENCODE_MODEL = "nemotron-3.5-super-vl-free";
const KILO_MODEL = "nemotron-3-nano-omni";

function chatBody(model: string): string {
 return JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] });
}

function makeState(relays: Array<{ url: string }>, enabled = true): RelayState {
 return {
  mode: "auto",
  enabled,
  url: relays[0]?.url ?? "",
  relays: relays as RelayState["relays"],
 };
}

/**
 * Run a scenario: start the proxy, stub fetch, drive the flow, assert.
 *
 * Local-proxy requests are delegated to the real fetch with the sandbox
 * installation token attached here, once: every `/v1/*` and `/_*` route is
 * token-gated, and the tests below then only describe the flow.
 */
async function withProxyScenario(
 opts: { state: RelayState; port?: number },
 upstreamStub: (url: string, init?: RequestInit) => Response | Promise<Response>,
 fn: (port: number, testPort: string) => Promise<void>,
): Promise<void> {
 const basePort = opts.port ?? 19285;
 const { server, port } = await startProxy(basePort);
 const effectivePort = port ?? basePort;
 const localPrefix = `http://127.0.0.1:${effectivePort}`;
 const realFetch = globalThis.fetch.bind(globalThis);
 try {
  setActiveRelayState(opts.state, false);
  resetAllRelayHealth();
  const fetchMock = test.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
   const u = String(url);
   if (u.startsWith(localPrefix)) {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(authHeaders())) headers.set(name, value);
    return realFetch(u, { ...init, headers });
   }
   return upstreamStub(u, init);
  });
  try {
   await fn(effectivePort, localPrefix);
  } finally {
   fetchMock.mock.restore();
  }
 } finally {
  if (server) {
   await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 }
}

// ── 1. New user, direct mode, upstream 200 ──────────────────────────────────

test("mock upstream: new user direct mode succeeds (upstream 200)", async () => {
 await withIsolatedRelayFiles(async () => {
  await withProxyScenario(
   { state: makeState([]) },
   async (url) => {
    assert.ok(url.includes("opencode.ai"), `direct upstream URL: ${url}`);
    return stubResponse(200, JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "ok" } }] }));
   },
   async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: chatBody(OPENCODE_MODEL),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { id?: string; choices?: Array<{ message?: { content?: string } }> };
    assert.equal(json.id, "chatcmpl-1");
    assert.equal(json.choices?.[0]?.message?.content, "ok");
   },
  );
 });
});

// ── 2. Relay mode, upstream 200 through the relay ───────────────────────────

test("mock upstream: relay active forwards through relay candidate", async () => {
 await withIsolatedRelayFiles(async () => {
  await withProxyScenario(
   { state: makeState([{ url: "https://relay1.example.com" }]) },
   async (url, init) => {
    assert.ok(url.startsWith("https://relay1.example.com"), `relay URL used: ${url}`);
    const h = new Headers(init?.headers);
    assert.equal(h.get("x-relay-target"), "https://opencode.ai");
    assert.ok((h.get("x-relay-path") ?? "").includes("/v1/chat/completions"));
    return stubResponse(200, JSON.stringify({ id: "via-relay", choices: [] }));
   },
   async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: chatBody(OPENCODE_MODEL),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { id?: string };
    assert.equal(json.id, "via-relay", "response must come through the relay");
   },
  );
 });
});

// ── 3. Relay 429 -> roll to next -> 200 ─────────────────────────────────────

test("mock upstream: relay 429 rolls to the next healthy relay", async () => {
 await withIsolatedRelayFiles(async () => {
  await withProxyScenario(
   { state: makeState([{ url: "https://relay1.example.com" }, { url: "https://relay2.example.com" }]) },
   async (url) => {
    if (url.startsWith("https://relay1.example.com")) {
     return stubResponse(429, JSON.stringify({ error: "upstream rate limited" }));
    }
    assert.ok(url.startsWith("https://relay2.example.com"), `rolled to: ${url}`);
    return stubResponse(200, JSON.stringify({ id: "after-roll", choices: [] }));
   },
   async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: chatBody(OPENCODE_MODEL),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { id?: string };
    assert.equal(json.id, "after-roll", "must roll 429 to the next relay");
   },
  );
 });
});

// ── 4. All relays fail -> direct fallback -> 200 ────────────────────────────

test("mock upstream: all relays fail falls back to direct upstream", async () => {
 await withIsolatedRelayFiles(async () => {
  await withProxyScenario(
   { state: makeState([{ url: "https://relay1.example.com" }]) },
   async (url) => {
    if (url.startsWith("https://relay1.example.com")) {
     return stubResponse(503, JSON.stringify({ error: "relay down" }));
    }
    assert.ok(url.includes("opencode.ai"), `direct fallback URL: ${url}`);
    return stubResponse(200, JSON.stringify({ id: "direct-fallback", choices: [] }));
   },
   async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: chatBody(OPENCODE_MODEL),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { id?: string };
    assert.equal(json.id, "direct-fallback", "must fall back to direct when relays exhaust");
   },
  );
 });
});

// ── 5. All relays fail AND direct fails -> last response returned ───────────

test("mock upstream: relays and direct all fail — last status surfaces to client", async () => {
 await withIsolatedRelayFiles(async () => {
  await withProxyScenario(
   { state: makeState([{ url: "https://relay1.example.com" }]) },
   async (url) => {
    if (url.startsWith("https://relay1.example.com")) {
     return stubResponse(503, JSON.stringify({ error: "relay down" }));
    }
    return stubResponse(503, JSON.stringify({ error: "upstream down" }));
   },
   async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: chatBody(OPENCODE_MODEL),
    });
    // The direct fallback's 503 surfaces to the client.
    assert.equal(res.status, 503);
   },
  );
 });
});

// ── 6. Kilo model routing ───────────────────────────────────────────────────

test("mock upstream: kilo model routes to api.kilo.ai keyless", async () => {
 await withIsolatedRelayFiles(async () => {
  await withProxyScenario(
   { state: makeState([]) },
   async (url, init) => {
    assert.ok(url.startsWith("https://api.kilo.ai"), `kilo upstream URL: ${url}`);
    const h = new Headers(init?.headers);
    assert.equal(h.get("authorization"), null, "kilo is keyless — a placeholder bearer is rejected upstream");
    return stubResponse(200, JSON.stringify({ id: "kilo-ok", choices: [] }));
   },
   async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: chatBody(KILO_MODEL),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { id?: string };
    assert.equal(json.id, "kilo-ok");
   },
  );
 });
});

// ── 7. /v1/models catalog ───────────────────────────────────────────────────

test("mock upstream: /v1/models serves the 32-model catalog", async () => {
 await withIsolatedRelayFiles(async () => {
  await withProxyScenario(
   { state: makeState([]) },
   async () => stubResponse(200, "{}"),
   async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { data?: Array<{ id: string }> };
				assert.equal(json.data?.length, 32);
   },
  );
 });
});

// ── 8. health endpoints ─────────────────────────────────────────────────────

test("mock upstream: /_health reports active pool; /health is the identity probe", async () => {
 await withIsolatedRelayFiles(async () => {
  await withProxyScenario(
   { state: makeState([{ url: "https://relay1.example.com" }]) },
   async () => stubResponse(200, "{}"),
   async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/_health`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { enabled?: boolean; active?: string; port?: number };
    assert.equal(json.enabled, true);
    assert.equal(json.active, "https://relay1.example.com");

    // Unauthenticated identity probe: exactly ok/service/port/version.
    const identity = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(identity.status, 200);
    const body = (await identity.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["ok", "port", "service", "version"]);
    assert.equal(body.ok, true);
    assert.equal(body.service, "pi-freeflow");
    assert.equal(body.port, port);
   },
  );
 });
});

// ── 9. tool-call audit trail ────────────────────────────────────────────────

test("mock upstream: a tool-declaring turn that answers text is recorded in the audit log", async () => {
 await withIsolatedRelayFiles(async () => {
  const auditFile = path.join(process.env["PI_FREEFLOW_DATA_DIR"] ?? "", "toolcall-audit.jsonl");
  const before = fs.existsSync(auditFile)
   ? fs.readFileSync(auditFile, "utf8").split("\n").filter((line) => line.trim() !== "").length
   : 0;
  // Unique markers prove the record carries no message or schema contents.
  const contentSentinel = "SECRET-CONTENT-7f3a";
  const schemaSentinel = "SECRET-SCHEMA-9b1c";
  await withProxyScenario(
   { state: makeState([]), port: 19296 },
   async (url) => {
    assert.ok(url.includes("opencode.ai"), `direct upstream URL: ${url}`);
    // A plain assistant text completion: the model declared tools and never
    // called one, which is exactly the failure the audit must name.
    return stubResponse(200, JSON.stringify({
     id: "chatcmpl-text-only",
     object: "chat.completion",
     choices: [{
      index: 0,
      message: { role: "assistant", content: "plain text answer" },
      finish_reason: "stop",
     }],
    }));
   },
   async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({
      model: OPENCODE_MODEL,
      stream: false,
      messages: [{ role: "user", content: contentSentinel }],
      tools: [
       {
        type: "function",
        function: {
         name: "bash",
         description: schemaSentinel,
         parameters: { type: "object", properties: { command: { type: "string" } } },
        },
       },
       {
        type: "function",
        function: {
         name: "read",
         description: "read a file",
         parameters: { type: "object", properties: { path: { type: "string" } } },
        },
       },
      ],
     }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { id?: string };
    assert.equal(json.id, "chatcmpl-text-only", "the upstream body passes through");
   },
  );

  const appended = fs.readFileSync(auditFile, "utf8")
   .split("\n")
   .filter((line) => line.trim() !== "")
   .slice(before);
  const summary = appended
   .map((line) => JSON.parse(line) as Record<string, unknown>)
   .find((record) => record["kind"] === "summary");
  assert.ok(summary, `an audit summary line must be appended (appended lines: ${appended.length})`);
  assert.deepEqual(summary["failures"], ["no_tool_calls"]);
  assert.equal(summary["remap"], "model", "a tool-less answer to a tools turn implicates the model, not the name map");
  assert.deepEqual(summary["declared"], ["bash", "read"], "the caller's declared names are recorded");
  assert.equal(summary["lane"], "opencode");
  assert.equal(summary["wire"], "chat");
  assert.equal(summary["stream"], false);
  assert.equal(summary["finishReason"], "stop");
  assert.equal(summary["model"], OPENCODE_MODEL);
  for (const line of appended) {
   assert.ok(!line.includes(contentSentinel), "no message contents in the audit log");
   assert.ok(!line.includes(schemaSentinel), "no tool schemas in the audit log");
  }
 });
});
