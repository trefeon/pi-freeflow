#!/usr/bin/env node
/**
 * Intercepting reverse proxy for live upstream capture.
 *
 * Sits between a host (Pi/omp) and the upstream, terminating the local HTTP
 * connection and opening the real TLS connection itself, so every request and
 * response body is visible in full — including streamed SSE, which is where
 * tool-call arguments actually arrive.
 *
 * This is the deliberate opt-in replacement for mitmproxy: the repo is already
 * zero-dependency Node, while system mitmproxy on the validation box is broken
 * (mitmproxy 8.x imports `blinker._saferef`, removed in blinker 1.7+).
 *
 * Usage:
 *   node scripts/capture-upstream.mjs
 *   CAP_PORT=8899 CAP_TARGET=https://opencode.ai CAP_LOG=/tmp/cap/flows.jsonl \
 *     node scripts/capture-upstream.mjs
 *
 * Then point a provider's baseUrl at http://127.0.0.1:<CAP_PORT> and make a
 * request; every exchange is appended to CAP_LOG as one JSON object per line so
 * a capture survives a kill mid-run.
 *
 * Env: CAP_PORT (8899), CAP_TARGET (https://opencode.ai), CAP_LOG
 *      (capture-upstream.jsonl), CAP_MAX_BODY (8 MiB per body).
 *
 * Authorization headers are redacted; bodies are kept verbatim on purpose.
 */
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";

const PORT = Number(process.env.CAP_PORT || 8899);
const TARGET = new URL(process.env.CAP_TARGET || "https://opencode.ai");
const LOG = process.env.CAP_LOG || "capture-upstream.jsonl";
const MAX_BODY = Number(process.env.CAP_MAX_BODY || 8 * 1024 * 1024);

const REDACT = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie"]);
// fetch already decoded any content-encoding, so these must not be replayed.
const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

function redactHeaders(headers) {
 const out = {};
 for (const [key, value] of Object.entries(headers)) {
  out[key] = REDACT.has(key.toLowerCase()) ? "<redacted>" : value;
 }
 return out;
}

function capBody(buffer) {
 const truncated = buffer.length > MAX_BODY;
 return {
  bytes: buffer.length,
  text: buffer.subarray(0, MAX_BODY).toString("utf8"),
  truncated,
 };
}

function upstreamUrlFor(requestUrl) {
 const base = TARGET.pathname.replace(/\/+$/, "");
 return new URL(base + requestUrl, TARGET.origin);
}

function append(record) {
 try {
  fs.appendFileSync(LOG, JSON.stringify(record) + "\n");
 } catch (error) {
  console.error(`[capture] log write failed: ${error.message}`);
 }
}

const server = http.createServer(async (req, res) => {
 const started = Date.now();
 const chunks = [];
 for await (const chunk of req) chunks.push(chunk);
 const requestBody = Buffer.concat(chunks);
 const upstreamUrl = upstreamUrlFor(req.url);

 // Hop-by-hop and length headers are recomputed by fetch; host must match the target.
 const forwardHeaders = {};
 for (const [key, value] of Object.entries(req.headers)) {
  const lower = key.toLowerCase();
  if (lower === "host" || lower === "content-length" || lower === "connection") continue;
  forwardHeaders[key] = value;
 }

 let upstreamResponse;
 try {
  upstreamResponse = await fetch(upstreamUrl, {
   method: req.method,
   headers: forwardHeaders,
   body: requestBody.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? requestBody : undefined,
  });
 } catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[capture] upstream fetch failed: ${message}`);
  append({
   ts: Date.now() / 1000,
   method: req.method,
   url: upstreamUrl.href,
   req_headers: redactHeaders(req.headers),
   req: capBody(requestBody),
   status: 0,
   error: message,
   duration_ms: Date.now() - started,
  });
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "capture proxy upstream failure", message }));
  return;
 }

 const responseHeaders = {};
 for (const [key, value] of upstreamResponse.headers) {
  if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
  responseHeaders[key] = value;
 }
 res.writeHead(upstreamResponse.status, responseHeaders);

 const captured = [];
 let capturedBytes = 0;
 if (upstreamResponse.body) {
  for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
   res.write(chunk);
   if (capturedBytes < MAX_BODY) {
    captured.push(chunk);
    capturedBytes += chunk.length;
   }
  }
 }
 res.end();

 const responseBody = Buffer.concat(captured);
 const duration = Date.now() - started;
 append({
  ts: started / 1000,
  method: req.method,
  url: upstreamUrl.href,
  req_headers: redactHeaders(req.headers),
  req: capBody(requestBody),
  status: upstreamResponse.status,
  resp_headers: redactHeaders(responseHeaders),
  resp: capBody(responseBody),
  resp_bytes_total: capturedBytes,
  resp_truncated: capturedBytes >= MAX_BODY,
  duration_ms: duration,
 });
 console.log(
  `[capture] ${upstreamResponse.status} ${req.method} ${upstreamUrl.pathname} ` +
  `req=${requestBody.length}B resp=${capturedBytes}B ${duration}ms -> ${LOG}`,
 );
});

server.listen(PORT, "127.0.0.1", () => {
 console.log(`[capture] listening on http://127.0.0.1:${PORT} -> ${TARGET.origin}`);
 console.log(`[capture] writing full request/response bodies to ${LOG}`);
});
