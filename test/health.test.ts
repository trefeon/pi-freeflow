/**
 * Health endpoint tests — loopback GET /_health (rich, token-gated) and
 * GET /health (unauthenticated identity probe)
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../src/proxy.ts";
import { getHealthData, handleHealthRequest } from "../src/health.ts";
import { getActiveRelayState, setActiveRelayState, resetAllRelayHealth } from "../src/relay-state.ts";
import { authHeaders } from "./_auth.ts";

function makeMockRes() {
 let status = 0;
 let headers: Record<string, string> = {};
 let body = "";
 const res: Record<string, unknown> = {
  writeHead(s: number, h: Record<string, string>) {
   status = s;
   headers = h;
  },
  end(b?: string) {
   body = b || "";
  },
  get status() { return status; },
  get headers() { return headers; },
  get body() { return body; },
 };
 return res as unknown as http.ServerResponse & { status: number; headers: Record<string, string>; body: string };
}

test("health returns 200 with active, mode, relays and catalog 35", async () => {
 const port = 29180;
 const state = getActiveRelayState();
 const orig = JSON.parse(JSON.stringify(state));
 resetAllRelayHealth();
 setActiveRelayState({ mode: "auto", enabled: true, url: "https://relay.example.com", relays: [{ url: "https://relay.example.com", label: "example" }] }, false);
 const { server } = await startProxy(port);
 try {
  const res = await fetch(`http://127.0.0.1:${port}/_health`, { headers: { ...authHeaders() } });
  assert.equal(res.status, 200);
  const json = await res.json() as { port: number; active: string; mode: string; enabled: boolean; relays: Array<{ url: string; label?: string; healthy: boolean; cooldownUntil: number; consecutiveFailures: number }>; catalog: number; version: string };
  assert.equal(json.port, port);
  assert.equal(json.active, "https://relay.example.com");
  assert.equal(json.mode, "auto");
  assert.equal(json.enabled, true);
		assert.equal(json.catalog, 35);
  assert.equal(typeof json.version, "string");
  assert.ok(json.version.length > 0, "health must report daemon version for stale-detection");
  assert.ok(Array.isArray(json.relays));
  assert.equal(json.relays.length, 1);
  assert.equal(json.relays[0].url, "https://relay.example.com");
  assert.equal(typeof json.relays[0].healthy, "boolean");
  assert.equal(typeof json.relays[0].cooldownUntil, "number");
  assert.equal(typeof json.relays[0].consecutiveFailures, "number");

  // Also verify getHealthData directly
  const direct = getHealthData(port);
		assert.equal(direct.catalog, 35);
  assert.equal(direct.port, port);
 } finally {
  await new Promise<void>((r) => server!.close(() => r()));
  setActiveRelayState(orig, false);
  resetAllRelayHealth();
 }
});

test("hidden widget still returns health", async () => {
 const port = 29181;
 const state = getActiveRelayState();
 const orig = JSON.parse(JSON.stringify(state));
 setActiveRelayState({ mode: "auto", enabled: true, url: "https://relay.example.com", relays: [{ url: "https://relay.example.com" }], hideWidget: true }, false);
 const { server } = await startProxy(port);
 try {
  const res = await fetch(`http://127.0.0.1:${port}/_health`, { headers: { ...authHeaders() } });
  assert.equal(res.status, 200);
  const json = await res.json() as { catalog: number; relays: unknown[] };
		assert.equal(json.catalog, 35);
  assert.ok(Array.isArray(json.relays));
 } finally {
  await new Promise<void>((r) => server!.close(() => r()));
  setActiveRelayState(orig, false);
  resetAllRelayHealth();
 }
});

test("health is loopback only - rejects non-loopback", async () => {
 // Direct handleHealthRequest with spoofed remoteAddress
 const req = {
  method: "GET",
  url: "/_health",
  socket: { remoteAddress: "8.8.8.8" },
 } as unknown as http.IncomingMessage;
 const res = makeMockRes();
 const handled = handleHealthRequest(req, res);
 assert.equal(handled, true);
 assert.equal(res.status, 403);

 // IPv6 loopback still allowed
 const req2 = {
  method: "GET",
  url: "/_health",
  socket: { remoteAddress: "::1" },
 } as unknown as http.IncomingMessage;
 const res2 = makeMockRes();
 const handled2 = handleHealthRequest(req2, res2, 28180);
 assert.equal(handled2, true);
 assert.equal(res2.status, 200);
 const body = JSON.parse(res2.body) as { catalog: number };
	assert.equal(body.catalog, 35);

 // Non-health path not handled
 const req3 = {
  method: "GET",
  url: "/v1/models",
  socket: { remoteAddress: "127.0.0.1" },
 } as unknown as http.IncomingMessage;
 const res3 = makeMockRes();
 assert.equal(handleHealthRequest(req3, res3), false);
});

test("health with empty pool returns 200 and catalog 35", async () => {
 const port = 29182;
 const state = getActiveRelayState();
 const orig = JSON.parse(JSON.stringify(state));
 setActiveRelayState({ mode: "auto", enabled: false, url: "", relays: [] }, false);
 resetAllRelayHealth();
 const { server } = await startProxy(port);
 try {
  const res = await fetch(`http://127.0.0.1:${port}/_health`, { headers: { ...authHeaders() } });
  assert.equal(res.status, 200);
  const json = await res.json() as { catalog: number; relays: unknown[]; enabled: boolean; port: number; version: string };
		assert.equal(json.catalog, 35);
  assert.equal(json.relays.length, 0);
  assert.equal(json.enabled, false);
  assert.equal(json.port, port);

  // The rich snapshot is token-gated: no header → 401, no relay/lease detail.
  const anonymous = await fetch(`http://127.0.0.1:${port}/_health`);
  assert.equal(anonymous.status, 401);

  // /health is the unauthenticated identity probe and carries nothing else.
  const res2 = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res2.status, 200);
  const json2 = await res2.json() as Record<string, unknown>;
		assert.deepEqual(json2, { ok: true, service: "pi-freeflow", port, version: json.version });
 } finally {
  await new Promise<void>((r) => server!.close(() => r()));
  setActiveRelayState(orig, false);
  resetAllRelayHealth();
 }
});
