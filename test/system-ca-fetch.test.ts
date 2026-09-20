import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchWithSystemCA, isCertError, requestViaNodeHttp } from "../src/system-ca-fetch.ts";

function chainError(code: string): Error {
 const inner = new Error("self-signed certificate in certificate chain") as Error & { code: string };
 inner.code = code;
 const outer = new Error("fetch failed") as Error & { cause: unknown };
 (outer as { cause: unknown }).cause = inner;
 return outer;
}

describe("isCertError", () => {
 it("detects chain/issuer codes including nested causes", () => {
  assert.equal(isCertError(chainError("SELF_SIGNED_CERT_IN_CHAIN")), true);
  assert.equal(isCertError(chainError("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), true);
  assert.equal(isCertError(chainError("DEPTH_ZERO_SELF_SIGNED_CERT")), true);
  assert.equal(isCertError(new Error("unable to verify the first certificate")), true);
 });
 it("rejects transport and status failures", () => {
  assert.equal(isCertError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" })), false);
  assert.equal(isCertError(new Error("HTTP 401")), false);
  assert.equal(isCertError(null), false);
 });
});

describe("fetchWithSystemCA", () => {
 it("passes healthy responses through the global fetch untouched", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
   calls += 1;
   return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
   const res = await fetchWithSystemCA("https://api.cline.bot/api/v1/models");
   assert.equal(calls, 1);
   assert.equal(res.status, 200);
   assert.equal(await res.text(), '{"ok":true}');
  } finally {
   globalThis.fetch = realFetch;
  }
 });
 it("rethows non-cert failures without a fallback attempt", async () => {
  const realFetch = globalThis.fetch;
  const boom = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  globalThis.fetch = (async () => { throw boom; }) as typeof fetch;
  try {
   await assert.rejects(fetchWithSystemCA("https://api.cline.bot/api/v1/models"), (e: unknown) => e === boom);
  } finally {
   globalThis.fetch = realFetch;
  }
 });
 it("retries cert failures through node:http and returns the body", async () => {
  const realFetch = globalThis.fetch;
  const server = http.createServer((_req, res) => {
   res.writeHead(200, { "content-type": "application/json" });
   res.end('{"fallback":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  globalThis.fetch = (async () => { throw chainError("SELF_SIGNED_CERT_IN_CHAIN"); }) as typeof fetch;
  try {
   const res = await fetchWithSystemCA(`http://127.0.0.1:${port}/v1/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ probe: 1 }),
   });
   assert.equal(res.status, 200);
   assert.equal(await res.text(), '{"fallback":true}');
  } finally {
   globalThis.fetch = realFetch;
   await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
 it("requestViaNodeHttp posts form bodies to plain http", async () => {
  const server = http.createServer((req, res) => {
   let raw = "";
   req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
   req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ seen: raw }));
   });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
   const res = await requestViaNodeHttp(`http://127.0.0.1:${port}/device`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "test-id" }),
   });
   assert.equal(res.status, 200);
   assert.deepEqual(await res.json(), { seen: "client_id=test-id" });
  } finally {
   await new Promise<void>((resolve) => server.close(() => resolve()));
  }
 });
});
