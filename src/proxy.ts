/**
 * Single-port local HTTP proxy and dynamic upstream router for pi-freeflow
 *
 * Provides loopback proxying on port 28180 (shared across parent and subagents),
 * intelligent routing to OpenCode Zen and KiloCode Gateway, and failover support.
 */

import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { handleHealthRequest, isLoopbackIP } from "./health.ts";
import { getLeaseCount, registerClient, renewClient, touchActivity, unregisterClient } from "./lease.ts";
import {
 ensureToken,
 isAuthorizedBearer,
} from "./token.ts";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { getAliveCatalog } from "./catalog.ts";
import {
 ALLOWED_METHODS,
 ALLOWED_PATH_PATTERN,
 BASE_PORT_REPROBE_MS,
 HOST,
 PATH_TRAVERSAL_PATTERN,
 MAX_BODY_BYTES,
 PORT,
 UPSTREAM_HEADER_TIMEOUT_MS,
 UPSTREAM_OPENCODE,
 OPENCODE_ORIGIN,
 OPENCODE_EXTRA_HEADERS_ENV,
 opencodeHeaders,
 refreshOpenCodeUserAgent,
 zenUpstreamPathFor,
} from "./config.ts";

import {
 convertSseToJson,
 enforceOpencodeFingerprint,
 looksLikeSse,
 normalizePromptCacheKey,
 repairJsonToolArguments,
 type CaseRestoreMap,
 type FindGlobRestore,
} from "./opencode-fingerprint.ts";
import { isDebugEnabled, log } from "./logger.ts";
import {
 getModelUpstream,
 isClineModel,
 isOvhModel,
 KILO_MODEL_IDS,
 MODEL_MAP,
 resolveCanonicalModelId,
} from "./models.ts";
import { fetchZenDirectViaSidecar, resolveZenSidecarScript, resolveZenTransport } from "./zen-transport.ts";
import type { ZenTransportMode } from "./zen-transport.ts";
import { relayFetch } from "./relay.ts";
import { getActiveRelayState, markRelayFailure, orderedRelayCandidates } from "./relay-state.ts";
import {
 issuerRelayFor,
 prepareChatFailoverBody,
 prepareResponsesFailoverBody,
 rejectedReasoningCount,
 rejectedReasoningIdsCount,
 rememberIssuerRelay,
 rememberRejectedReasoning,
 rememberRejectedReasoningIds,
 responsesConversationKey,
 stripPreviousResponseId,
 stripRejectedReasoning,
 stripRejectedReasoningIds,
 stripReasoningEncryption,
 stripUnresolvableReasoning,
 isExpiredReasoningReference,
 isReasoningCallerMismatch,
} from "./responses.ts";
import { pipeUpstreamStream, type StreamCloakOptions } from "./stream-pipe.ts";
import { createToolcallRecorder, type ToolcallRecorder, type ToolcallWire } from "./toolcall-audit.ts";
import {
 isFreeTierGate,
 isFreeUsageShapeError,
 isUpstreamGated,
 recordUpstreamFailure,
 recordUpstreamSuccess,
 rejectionFingerprint,
 rememberGateRejection,
 sessionKeyOf,
 withFreeTierHint,
} from "./upstream-health.ts";

import {
 decrementActiveRequests,
 getActiveRequests,
 incrementActiveRequests,
 isProxyAlive,
} from "./proxy-ports.ts";

import {
 auditFinalBody,
 auditWireFor,
 classifyZenFailover,
 declaredToolNames,
 handleClineRequest,
 handleKiloRequest,
 handleOvhRequest,
 isRelayEligibleModel,
 isStaleOpenCodeVersionError,
 relayBypassedForTransport,
 stopClineKeepAlive,
 upstreamTimeoutError,
 withRateLimitHint,
} from "./proxy-lanes.ts";

export * from "./proxy-ports.ts";
export * from "./proxy-lanes.ts";

// Rate-limit hint string (defined in proxy-lanes.ts): "Shared free-tier IP quota reached. Add your own relay egress: /freeflow deploy (Cloudflare recommended, 100k req/day free)"
// Process executions in proxy-ports.ts use windowsHide: true

let shutdownShouldExit = false;
export function setShutdownShouldExit(v: boolean): void {
 shutdownShouldExit = v;
}

/**
 * Exhausted-disabled relay verdict from the relay layer (HTTP 503 JSON with
 * `error.code === "relay_disabled"`): every candidate rolled as disabled and
 * the direct fallback is unavailable, so the host must retry/fail fast
 * instead of parking on a provider wait. Passes through to the host
 * unchanged — hint rewrites must never touch its code or guidance.
 */
export function isRelayDisabledError(status: number, data: string): boolean {
 if (status !== 503) return false;
 try {
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  if (!("error" in parsed)) return false;
  const err: unknown = parsed.error;
  if (typeof err !== "object" || err === null || Array.isArray(err)) return false;
  if (!("code" in err)) return false;
  return err.code === "relay_disabled";
 } catch {
  return false;
 }
}
/**
 * Extract client IP address from incoming HTTP request.
 */
export function getClientIP(req: http.IncomingMessage): string {
 const addr = req.socket.remoteAddress;
 if (!addr) return "unknown";
 return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

/**
 * Validate that the request URL matches allowed API path patterns and prevents path traversal.
 */
export function validatePath(rawUrl: string): URL | null {
 const cleaned = rawUrl.replace(/^\/+/, "");
 if (!ALLOWED_PATH_PATTERN.test(`/${cleaned}`)) return null;
 if (PATH_TRAVERSAL_PATTERN.test(cleaned)) return null;
 try {
  const decoded = decodeURIComponent(cleaned);
  if (PATH_TRAVERSAL_PATTERN.test(decoded)) return null;
  if (decoded !== cleaned && !ALLOWED_PATH_PATTERN.test(`/${decoded}`)) {
   return null;
  }
 } catch {
  return null;
 }
 try {
  return new URL(cleaned, `${UPSTREAM_OPENCODE}/`);
 } catch {
  return null;
 }
}

/**
 * Extra-header allowlist entries that must never ride the OpenCode lane even
 * when the operator lists them: credentials, cookies, hop-by-hop framing, and
 * headers the proxy owns (host, user-agent, accept-encoding). x-opencode-* is
 * refused before this list is consulted.
 */
const EXTRA_HEADER_DENY = new Set([
 "authorization",
 "proxy-authorization",
 "cookie",
 "set-cookie",
 "content-length",
 "transfer-encoding",
 "connection",
 "keep-alive",
 "proxy-connection",
 "te",
 "trailer",
 "upgrade",
 "host",
 "user-agent",
 "accept-encoding",
 "x-relay-auth",
 "x-session-affinity",
 "x-session-id",
]);

/**
 * Sanitize and inject standard headers before forwarding request to upstream.
 * Affinity headers (x-session-affinity / x-session-id) are NEVER forwarded on
 * the opencode lane — opencodeHeaders() no longer emits them, and any client
 * copy is stripped here. Non-opencode lanes that need affinity set it
 * themselves after calling this helper.
 */
export function sanitizeHeaders(
 incoming: http.IncomingHttpHeaders,
 targetHost: string,
 sessionKey?: string,
): Record<string, string> {
 // authorization is deliberately NOT forwarded: the host provider registers
 // with a dummy key (placeholder), and every free upstream here is keyless —
 // sending that fake key upstream gets 401 Invalid API key. Kilo's own branch
 // sends no Authorization either (its gateway rejects a placeholder bearer).
 const allowed: Record<string, true> = {
  "content-type": true,
  accept: true,
  "x-request-id": true,
 };
 // Parse the opt-in allowlist once per request, not once per header. Entries
 // on EXTRA_HEADER_DENY are dropped: an operator-listed credential, cookie,
 // or framing header must never be forwarded just because it was named.
 const extraRaw = process.env[OPENCODE_EXTRA_HEADERS_ENV];
 const extraAllowed = new Set(
  typeof extraRaw === "string" && extraRaw.length > 0
   ? extraRaw.split(",").map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0 && !EXTRA_HEADER_DENY.has(p))
   : [],
 );
 const sanitized: Record<string, string> = {};
 for (const [key, value] of Object.entries(incoming)) {
  const lower = key.toLowerCase();
  if (lower.startsWith(":")) continue;
  // No caller x-opencode-* ever rides: stale pins (version/channel), stale
  // request/session/project stamps, and affinity-shaped keys would all read
  // as a non-OpenCode signal upstream. The live roster is assigned below.
  if (lower.startsWith("x-opencode-")) continue;
  if (!allowed[lower] && !extraAllowed.has(lower)) continue;
  if (typeof value === "string") sanitized[lower] = value;
  else if (Array.isArray(value)) sanitized[lower] = value.join(", ");
 }
 // Opt-in default accept: only when the allowlist lists accept and the caller
 // sent none — default (unset) leaves it absent.
 if (sanitized["accept"] === undefined && extraAllowed.has("accept")) {
  sanitized["accept"] = "*/*";
 }
 sanitized.host = targetHost;
 // Drop the client's own user-agent so opencodeHeaders() cannot produce a
 // duplicate (case-differing) User-Agent pair — upstream resets connections
 // that send two conflicting User-Agent headers.
 delete sanitized["user-agent"];
 // A client copy of the affinity pair must never ride the opencode lane
 // (upstream treats it as a non-OpenCode signal); non-opencode lanes set
 // their own affinity downstream of this helper.
 delete sanitized["x-session-affinity"];
 delete sanitized["x-session-id"];
 // The client's working-directory header is PII that must never leave the
 // loopback listener; the project header carries only its sha1/global form.
 delete sanitized["x-opencode-directory"];
 Object.assign(sanitized, opencodeHeaders(sessionKey));
 sanitized["accept-encoding"] = "identity";
 sanitized.connection = "keep-alive";
 return sanitized;
}

/**
 * Host header allowlist: only names that resolve to this loopback listener.
 * A hostile page can point a hostname at 127.0.0.1 (DNS rebinding), and the
 * token is a file this process reads — not a value a browser has — so the
 * Host check keeps the port from being reached under a foreign origin.
 */
const ALLOWED_HOST_PATTERN = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

/** True when the request's Host header names this loopback listener. */
export function isAllowedHostHeader(host: string | undefined): boolean {
 if (typeof host !== "string") return false;
 return ALLOWED_HOST_PATTERN.test(host.trim());
}

/**
 * Loopback-only client lease + control endpoints used by the detached-daemon
 * protocol (src/client.ts). Returns false when the request is not a control
 * endpoint (caller continues). Control writes are async (chunked JSON).
 */
export function handleControlRequest(
 req: http.IncomingMessage,
 res: http.ServerResponse,
 reqPathname: string | null,
 closeServer: () => void,
): boolean {
 if (reqPathname === null) return false;
 const isShutdown = reqPathname === "/_shutdown";
 const isClientRoute = reqPathname.startsWith("/_client/");
 if (!isShutdown && !isClientRoute) return false;
 const clientIP = req.socket.remoteAddress ?? "";
 if (!isLoopbackIP(clientIP)) {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "loopback only" }));
  return true;
 }
 if (isShutdown) {
  log("info", "control /_shutdown received — closing proxy");
  res.writeHead(200, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ ok: true }));
  setTimeout(() => {
   try {
    stopClineKeepAlive();
    closeServer();
   } catch { }
   if (shutdownShouldExit) process.exit(0);
  }, 50);
  return true;
 }
 req.on("error", () => {});
 const chunks: Buffer[] = [];
 let total = 0;
 req.on("data", (c: Buffer) => {
  total += c.length;
  if (total > 4096) { req.destroy(); return; }
  chunks.push(c);
 });
 req.on("end", () => {
  let clientId = "";
  try {
   const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
   if (parsed && typeof parsed === "object" && "id" in parsed) {
    const candidate = parsed.id;
    // Trim once here so attach/heartbeat/detach agree on the lease key;
    // registerClient trims again as defense in depth.
    if (typeof candidate === "string" && candidate.trim()) clientId = candidate.trim();
   }
  } catch { }
  if (!clientId) {
   res.writeHead(400, { "content-type": "application/json" });
   res.end(JSON.stringify({ error: "missing client id" }));
   return;
  }
  if (reqPathname === "/_client/attach") {
   const verdict = registerClient(clientId);
   if (verdict !== "ok") {
    const status = verdict === "invalid" ? 400 : 429;
    log("warn", `client attach rejected (${verdict})`, { id: clientId.slice(0, 32), leases: getLeaseCount() });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: verdict === "invalid" ? "invalid client id" : "too many clients" }));
    return;
   }
  } else if (reqPathname === "/_client/heartbeat") {
   // Unknown id = daemon restarted since attach. Report ok:false so the
   // client re-attaches instead of heartbeating lease-less.
   if (!renewClient(clientId)) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
    return;
   }
  } else if (reqPathname === "/_client/detach") unregisterClient(clientId);
  else {
   res.writeHead(404, { "content-type": "application/json" });
   res.end(JSON.stringify({ error: "not found" }));
   return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
 });
 return true;
}

/**
 * Recover from upstream rejecting a replayed reasoning history.
 *
 * Upstream binds each reasoning `encrypted_content` blob to the service
 * instance that issued it. When the conversation is later served by a different
 * instance the whole replayed history is rejected with a 400, which the relay
 * pool never retries (400 is not a roll status) and the host repeats until the
 * session dies. Measured on 2026-09-13: same relay returned 200 and 400 one
 * second apart, the direct path returned the same 400, and a 45s burst hit ten
 * conversations.
 *
 * Reasoning references also age out server-side (observed around 9.5h): the
 * retry after a blob strip can come back as `referenced reasoning item
 * 'rs_...' was not found or has expired`. That poisoned history cannot be
 * resolved by any backend, so the chained second step drops every reasoning
 * item plus `previous_response_id` and retries the same relay again — one
 * turn of reasoning context is lost instead of the whole session.
 *
 * Both 400s are request-scoped: the relay served correctly and is never
 * marked failed for them. The 400 body is inspected through a clone: a
 * successful streaming response (the normal path) is never consumed here.
 */
async function retryWithoutReasoningEncryption(
 response: Response,
 sentBody: Buffer,
 resend: (body: Buffer) => Promise<Response>,
 reqId: string,
 conversationKey: string | null,
): Promise<Response> {
 if (response.status !== 400) return response;
 if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
  return response;
 }
 let errorText: string;
 try {
  errorText = await response.clone().text();
 } catch {
  return response;
 }
 const callerMismatch = isReasoningCallerMismatch(errorText);
 const expiredDirect = isExpiredReasoningReference(errorText);
 if (!callerMismatch && !expiredDirect) return response;

 let current = response;
 let currentBody = sentBody;
 let currentErrorText = errorText;

 if (callerMismatch) {
  const portable = stripReasoningEncryption(sentBody);
  if (!portable) {
   log(
    "warn",
    "upstream rejected caller-bound reasoning but the request carries no encrypted_content to strip",
    { status: 400 },
    reqId,
   );
   if (!expiredDirect) return response;
  } else {
   log(
    "warn",
    "upstream rejected caller-bound reasoning (blobs issued by another instance); retrying with encrypted_content stripped",
    { status: 400, tracked: conversationKey !== null },
    reqId,
   );
   const retried = await resend(portable);
   if (conversationKey) {
    const remembered = rememberRejectedReasoning(sentBody, conversationKey);
    log(
     "info",
     `conversation will drop ${remembered} rejected reasoning blob(s) on later turns`,
     undefined,
     reqId,
    );
   }
   if (retried.status !== 400) return retried;
   if ((retried.headers.get("content-type") ?? "").includes("text/event-stream")) return retried;
   let retryText: string;
   try {
    retryText = await retried.clone().text();
   } catch {
    return retried;
   }
   if (!isExpiredReasoningReference(retryText)) return retried;
   current = retried;
   currentBody = portable;
   currentErrorText = retryText;
  }
 }

 if (!isExpiredReasoningReference(currentErrorText)) return current;
 const unresolvable = stripUnresolvableReasoning(currentBody);
 if (!unresolvable) {
  if (conversationKey) {
   const remembered = rememberRejectedReasoningIds(currentErrorText, conversationKey);
   log(
    "warn",
    `upstream rejected expired reasoning reference (${remembered} id(s)); nothing strippable left in the request`,
    { status: 400, tracked: true },
    reqId,
   );
  }
  return current;
 }
 let rememberedIds = 0;
 if (conversationKey) {
  rememberedIds = rememberRejectedReasoningIds(currentErrorText, conversationKey);
 }
 log(
  "warn",
  `upstream rejected expired reasoning reference (${rememberedIds} id(s)); retrying without reasoning history`,
  { status: 400, tracked: conversationKey !== null },
  reqId,
 );
 return await resend(unresolvable);
}

/**
 * Start the local HTTP proxy daemon.
 * Implements master/worker single-port reuse: if port 28180 is already held by a live
 * parent or sibling OMP session, resolves immediately with { server: null, port: 28180 }.
 */
export function startProxy(
 overridePort?: number,
): Promise<{ server: http.Server | null; port: number }> {
 const basePort = overridePort ?? PORT;
 // Write/read the installation token before the listener is bound so the host
 // can never observe a port that answers without a token, and so the daemon
 // owns the value its own clients will read from the file.
 let serverToken = ensureToken();
 if (!serverToken) {
  log("error", "proxy token unavailable — refusing every request until the data directory is writable");
 }

 const server = http.createServer((req, res) => {
  const clientIP = getClientIP(req);
  const reqId = randomUUID().slice(0, 8);
  if (isDebugEnabled()) {
   log(
    "debug",
    `incoming ${req.method} ${req.url} from ${clientIP}`,
    { ip: clientIP, method: req.method, url: req.url },
    reqId,
   );
  }

  if (!ALLOWED_METHODS.has(req.method ?? "")) {
   res.writeHead(405, { "content-type": "application/json" });
   res.end(JSON.stringify({ error: "method not allowed" }));
   return;
  }

  if (req.method === "OPTIONS") {
   // No CORS headers: loopback proxy is not a cross-origin resource.
   // Keep a bare 204 so OPTIONS never reaches validatePath/upstream.
   res.writeHead(204);
   res.end();
   return;
  }

  // DNS-rebinding guard: a hostile page can resolve a name to 127.0.0.1, so
  // the Host header must name this loopback listener.
  if (!isAllowedHostHeader(req.headers.host)) {
   res.writeHead(403, { "content-type": "application/json" });
   res.end(JSON.stringify({ error: "forbidden host" }));
   return;
  }

  let reqPathname: string | null = null;
  try {
   reqPathname = new URL(req.url ?? "/", `http://${HOST}`).pathname;
  } catch { }

  // Loopback is not an authorization boundary: any local process can connect.
  // Every functional route (the whole /v1/* surface plus the /_* control and
  // health routes) requires the per-installation token. GET /health is the one
  // deliberate exception — the unauthenticated identity probe that lets a
  // client recognise its daemon before it has a token.
  const isIdentityProbe = req.method === "GET" && reqPathname === "/health";
  if (!isIdentityProbe && !isAuthorizedBearer(req.headers.authorization, serverToken)) {
   const latestToken = ensureToken();
   if (latestToken && latestToken !== serverToken) serverToken = latestToken;
   if (!isAuthorizedBearer(req.headers.authorization, serverToken)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
   }
  }

  if (handleControlRequest(req, res, reqPathname, () => { try { server.closeIdleConnections?.(); } catch {} server.close(); })) return;
  // Loopback-only health endpoint — always accessible even when widget hidden
  if (req.method === "GET" && reqPathname !== null && (reqPathname === "/_health" || reqPathname === "/health")) {
   const addr = server.address();
   const realPort = addr && typeof addr === "object" ? (addr as { port: number }).port : basePort;
   if (handleHealthRequest(req, res, realPort, getActiveRequests())) return;
  }
  if (req.method === "GET" && (reqPathname === "/v1/models" || reqPathname === "/v1/models/")) {
   const alive = getAliveCatalog();
   const body = JSON.stringify({
    object: "list",
    data: alive.map((m) => ({
     id: m.id,
     object: "model",
     created: 0,
     owned_by: m.source === "kilo" ? "kilocode" : m.source === "cline" ? "clinecode" : m.source === "ovh" ? "ovhcloud" : "opencode",
    })),
   });
   res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
   });
   res.end(body);
   return;
  }

  const target = validatePath(req.url ?? "/");
  if (!target) {
   const cleaned = (req.url ?? "/").replace(/^\/+/, "");
   if (PATH_TRAVERSAL_PATTERN.test(cleaned)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
   } else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
   }
   return;
  }
  touchActivity();
  // Buffer request body to inspect model ID for upstream routing
  const bodyChunks: Buffer[] = [];
  incrementActiveRequests();
  res.on("close", () => {
   decrementActiveRequests();
  });

  // Reject oversized bodies before buffering starts: the client declares
  // the size in content-length, so no transfer cost is wasted.
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
   res.writeHead(413, { "content-type": "application/json" });
   res.end(JSON.stringify({ error: "payload too large" }));
   return;
  }
  let bufferedBytes = 0;
  req.on("error", (err) => {
   log(
    "warn",
    "client request error during body buffering",
    { error: String(err) },
    reqId,
   );
   if (!res.headersSent) {
    res.writeHead(400, { "content-type": "application/json" });
   }
   res.end(JSON.stringify({ error: "bad request" }));
  });

  // Running cap for chunked/undeclared bodies: stop buffering the instant
  // the limit is crossed instead of holding the whole payload in memory.
  req.on("data", (chunk: Buffer) => {
   bufferedBytes += chunk.length;
   if (bufferedBytes > MAX_BODY_BYTES) {
    bodyChunks.length = 0;
    if (!res.headersSent) {
     res.writeHead(413, { "content-type": "application/json", connection: "close" });
     res.end(JSON.stringify({ error: "payload too large" }), () => req.destroy());
    } else {
     req.destroy();
    }
    return;
   }
   bodyChunks.push(chunk);
  });

  req.on("end", async () => {
   const bodyStr = Buffer.concat(bodyChunks).toString();
   let isKilo = false;
   let isCline = false;
   let isOvh = false;
   let parsedBody: Record<string, unknown> | null = null;
   let clientRequestedStream = false;
   let bodyModified = false;

   try {
    parsedBody = JSON.parse(bodyStr);
    if (typeof parsedBody?.model === "string") {
     const canonical = resolveCanonicalModelId(parsedBody.model);
     if (canonical !== parsedBody.model) {
      parsedBody.model = canonical;
      bodyModified = true;
     } else {
      parsedBody.model = canonical;
     }
     if (isClineModel(canonical)) {
      isCline = true;
     } else if (isOvhModel(canonical)) {
      isOvh = true;
     } else if (KILO_MODEL_IDS.has(canonical)) {
      isKilo = true;
     }
    }
    if (parsedBody && typeof parsedBody === "object") {
     clientRequestedStream = parsedBody.stream === true;
    }
   } catch { }

   // Tool-call audit capture, BEFORE any body mutation (zen failover swaps the
   // model, the fingerprint injects placeholder tools): `declaredNames` must be
   // the caller's own surface, and a host re-send of the same conversation has
   // to hash to the same retry key. Both are bounded names/lists — never
   // message text or argument values.
   const auditModel = parsedBody !== null && typeof parsedBody.model === "string" ? parsedBody.model : "unknown";
   const auditDeclaredNames = parsedBody !== null ? declaredToolNames(parsedBody) : [];
   const auditConversationSeed = parsedBody !== null
    ? { model: auditModel, messages: parsedBody.messages ?? parsedBody.input, tools: parsedBody.tools }
    : undefined;

   const sessionKey = (() => {
    if (parsedBody !== null && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
     normalizePromptCacheKey(parsedBody as Record<string, unknown>);
    }
    return sessionKeyOf(parsedBody);
   })();
   // Gate-rejection memory, captured BEFORE the body is rewritten: the next
   // attempt of this conversation is hashed from the caller's own bytes, so a
   // fingerprint taken after the fingerprint/tool normalization and the env
   // block landed would never match and the retry would replay the refusal.
   const gateFingerprint = parsedBody !== null
   ? (rejectionFingerprint(parsedBody, target.pathname) ?? undefined)
   : undefined;
   // Zen free-tier gate failover: refused or fresh Zen sessions ride a
   // healthy Kilo model on the same wire API via the existing Kilo branch.
   // Working sessions pass through untouched; canary sessions pass through
   // carrying the recovery probe (their success clears the gate). Responses
   // bodies are scrubbed of Zen-bound state (chain pointer, reasoning blobs)
   // Kilo cannot honor before the model swap.
   const zenFailover = classifyZenFailover(parsedBody, target.pathname);
   const isCanary = zenFailover.action === "canary";
   if (zenFailover.action === "failover" && parsedBody) {
    const from = String(parsedBody.model);
    parsedBody.model = zenFailover.model;
    bodyModified = true;
    if (target.pathname.endsWith("/responses")) {
     prepareResponsesFailoverBody(parsedBody);
    } else {
     prepareChatFailoverBody(parsedBody);
    }
    isKilo = true;
    log("info", `zen gated — session failed over ${from} -> ${zenFailover.model}`, { model: from, failover: zenFailover.model }, reqId);
   }

   // One recorder per turn, active only when the caller declared tools (an
   // empty list is a no-op recorder that writes nothing). Created after the
   // lane flags settle — a zen failover is served by the Kilo lane — while the
   // model and tool names above stay the caller's, pre-mutation.
   const audit = createToolcallRecorder({
    reqId,
    model: auditModel,
    lane: isCline ? "cline" : isOvh ? "ovh" : isKilo ? "kilo" : "opencode",
    wire: auditWireFor(target.pathname),
    stream: clientRequestedStream,
    declaredNames: auditDeclaredNames,
    conversationSeed: auditConversationSeed,
   });

   // OpenCode Zen free-tier fingerprint: upstream mandates stream: true and the
   // live 11-tool roster. Missing tools (such as on
   // subagent or advisor watchdog turns) trigger 403 FreeTierError.
   // bodyModified was initialized above before model alias / failover mutations.
   let callerHadTools = true;
   let callerCaseRestore: CaseRestoreMap | undefined;
   let callerFindGlob: FindGlobRestore | undefined;
   let callerInjected: string[] | undefined;
   let callerArgSchemas: Map<string, Record<string, unknown>> | undefined;
   if (!isKilo && !isCline && !isOvh && parsedBody) {
    const fp = enforceOpencodeFingerprint(parsedBody, target.pathname);
    callerHadTools = fp.callerHadTools;
    callerCaseRestore = fp.caseRestore;
    callerFindGlob = fp.findGlob;
    callerInjected = fp.injected;
    callerArgSchemas = fp.argSchemas;
    bodyModified = true;
   }
   // Streaming cloak: thread this request's placeholder records into the SSE
   // pipe so streamed deltas get the same strip+restore as aggregated bodies.
   // Kilo/Cline/OVH bypass the fingerprint, so their streams stay verbatim.
   const streamCloak: StreamCloakOptions | undefined = !isKilo && !isCline && !isOvh && callerInjected !== undefined
    ? { callerHadTools, caseRestore: callerCaseRestore, findGlob: callerFindGlob, injected: callerInjected, argSchemas: callerArgSchemas, pathname: target.pathname }
    : undefined;

   const isStream = clientRequestedStream;

   // Stale-registration guard: a model whose declared api does not match the
   // path means the host still holds a pre-fix provider registration (stale
   // disk cache or no restart after upgrade) and upstream answers 500.
   // Zen-lane only (Kilo/Cline/OVH are served verbatim) and dormant while the
   // Zen catalog declares no non-chat api — a new responses or messages entry
   // re-arms it automatically.
   if (!isKilo && !isCline && !isOvh && typeof parsedBody?.model === "string") {
    const knownDef = MODEL_MAP.get(String(parsedBody.model));
    if (target.pathname.endsWith("/chat/completions") && knownDef?.api && knownDef.api !== "openai-completions") {
     log("warn", `model ${String(parsedBody.model)} expects ${knownDef.api} but got ${target.pathname} — stale provider registration (restart Pi/OMP after upgrade)`, { model: String(parsedBody.model), path: target.pathname }, reqId);
    } else if (target.pathname.endsWith("/messages") && knownDef?.api && knownDef.api !== "anthropic-messages") {
     log("warn", `model ${String(parsedBody.model)} expects ${knownDef.api} but got ${target.pathname} — stale provider registration (restart Pi/OMP after upgrade)`, { model: String(parsedBody.model), path: target.pathname }, reqId);
    } else if (target.pathname.endsWith("/responses") && knownDef?.api && knownDef.api !== "openai-responses") {
     log("warn", `model ${String(parsedBody.model)} expects ${knownDef.api} but got ${target.pathname} — stale provider registration (restart Pi/OMP after upgrade)`, { model: String(parsedBody.model), path: target.pathname }, reqId);
    }
   }
   try {
    if (isCline && parsedBody) {
     // Cline serves chat completions only, direct (never relay pool, no
     // opencode fingerprint). The pool module owns the per-user Bearer
     // token: the proxy only passes the body and maps the answer.
     await handleClineRequest({ parsedBody, pathname: target.pathname, req, res, reqId, clientRequestedStream, audit });
    } else if (isKilo && parsedBody) {
     await handleKiloRequest({
      parsedBody,
      pathname: target.pathname,
      req,
      res,
      reqId,
      clientRequestedStream,
      sessionKey,
      audit,
     });
   } else if (isOvh && parsedBody) {
    // OVH serves chat upstream only (see handleOvhRequest): direct, keyless,
    // no fingerprint, and a responses-path body translated to chat and back.
    await handleOvhRequest({ parsedBody, pathname: target.pathname, req, res, reqId, clientRequestedStream, audit });
   } else {
     // OpenCode routing — relay egress is for free-catalog models
     // only; unknown/paid models go direct upstream.
     const relayState = getActiveRelayState();
     const relayPoolOn =
      relayState.mode !== "off" &&
      relayState.enabled !== false &&
      Boolean(relayState.url || (relayState.relays && relayState.relays.length > 0));
     const relayEligible = isRelayEligibleModel(parsedBody?.model);
     // Sidecar-active Zen requests skip the relay pool: a relay would
     // re-originate the connection and forfeit the sidecar's fingerprint.
     const zenTransport = resolveZenTransport();
     const transportBypass = relayBypassedForTransport(zenTransport.mode);
     const shouldUseRelay = relayPoolOn && relayEligible && !transportBypass;
     if (relayPoolOn && !relayEligible) {
      log("info", `relay bypass for non-catalog model ${String(parsedBody?.model ?? "?")} — routing direct upstream`, { model: parsedBody?.model }, reqId);
     } else if (relayPoolOn && transportBypass) {
      log("info", "relay bypass for bun-sidecar transport — routing direct upstream", { transport: zenTransport.mode }, reqId);
     }
     if (shouldUseRelay) {
      // Dead-client guard: 'close' fires when the client goes away, the
      // relay fetch aborts, and the catch below cannot tell a client abort
      // from a timeout abort. Without this flag a dead client gets a fresh
      // orphan direct fetch; with it the turn ends quietly.
      let relayClientGone = false;
      let relayResponse: Response | null = null;
      const markRelayClientGone = () => { relayClientGone = true; };
      res.once("close", markRelayClientGone);
      req.once("error", markRelayClientGone);
      const fullUrl = `${OPENCODE_ORIGIN}${zenUpstreamPathFor(target.pathname)}`;
      const activeHost = relayState.url
       ? new URL(relayState.url).host
       : "opencode.ai";
      const relayHeaders = sanitizeHeaders(req.headers, activeHost, sessionKey ?? undefined);

      try {
       if (parsedBody) {
        const requestBody = bodyModified
         ? Buffer.from(JSON.stringify(parsedBody), "utf8")
         : Buffer.concat(bodyChunks);
        // Reasoning `encrypted_content` is bound to the caller that
        // requested it, and a relay roll changes that caller. A
        // conversation already rejected for foreign blobs keeps its
        // history portable from then on.
        const conversationKey = responsesConversationKey(parsedBody);
        const responsesRequest = target.pathname.endsWith("/responses");
        // Per-conversation affinity: reasoning blobs are only readable
        // by the backend that issued them, so stay on the issuing relay
        // while it is healthy.
        const issuer = responsesRequest && conversationKey !== null
         ? issuerRelayFor(conversationKey)
         : undefined;
        const candidates = orderedRelayCandidates(
         typeof issuer === "string" ? issuer : undefined,
        );
        const servingRelay = candidates[0] ?? null;
        // Affinity cannot be honored (issuer cooling, dropped from the
        // pool, or the path changed relay<->direct): the next backend
        // cannot read this history, so send it portable instead of
        // letting upstream reject the whole request.
        const issuerChanged = issuer !== undefined && issuer !== servingRelay;
        // Portable history on hops, selective memory on every turn: dead-id
        // stripping applies regardless of the hop guard, because a
        // relay-to-relay or relay-to-direct hop also changes the backend
        // that must resolve the ids.
        let bodyForUpstream: Buffer = requestBody;
        if (responsesRequest && conversationKey !== null) {
         if (issuerChanged) {
          bodyForUpstream = stripReasoningEncryption(bodyForUpstream) ?? bodyForUpstream;
          bodyForUpstream = stripPreviousResponseId(bodyForUpstream) ?? bodyForUpstream;
         }
         if (rejectedReasoningCount(conversationKey) > 0) {
          bodyForUpstream = stripRejectedReasoning(bodyForUpstream, conversationKey) ?? bodyForUpstream;
         }
         if (rejectedReasoningIdsCount(conversationKey) > 0) {
          bodyForUpstream = stripRejectedReasoningIds(bodyForUpstream, conversationKey) ?? bodyForUpstream;
         }
        }
        if (issuerChanged && conversationKey !== null) {
         // These blobs belong to a backend this conversation is
         // leaving, so never replay them again.
         rememberRejectedReasoning(requestBody, conversationKey);
         log(
          "info",
          `reasoning issuer changed (${issuer ?? "direct"} -> ${servingRelay ?? "direct"}); sending history without caller-bound reasoning`,
          undefined,
          reqId,
         );
        }

        // One attempt, with its own header-wait timeout and
        // client-disconnect abort; the timer is cleared once headers
        // arrive so streams are not killed at the timeout ceiling.
        // Aborts caused by our own timeout are tagged
        // FF_INTERNAL_ABORT so stream-pipe never penalizes the relay.
        let servedIssuer: string | null = null;
        let issuerReported = false;
        const sendViaRelay = async (payload: Buffer): Promise<Response> => {
         const relayController = new AbortController();
         const relayTimeoutId = setTimeout(
          () => relayController.abort(upstreamTimeoutError()),
          UPSTREAM_HEADER_TIMEOUT_MS,
         );
         const abortRelayOnClientGone = () => {
          if (!res.writableEnded) {
           relayClientGone = true;
           relayController.abort();
          }
         };
         res.once("close", abortRelayOnClientGone);
         req.once("error", abortRelayOnClientGone);
         try {
          return await relayFetch(
           fullUrl,
           {
            method: req.method || "POST",
            headers: relayHeaders,
            body: payload,
            signal: relayController.signal,
           } as unknown as RequestInit,
           reqId,
           {
            preferred: typeof issuer === "string" ? issuer : undefined,
            spreadKey: conversationKey ?? reqId,
            onServed: (relay) => {
             servedIssuer = relay;
             issuerReported = true;
            },
           },
           (info) => audit?.attemptFailure(info),
          );
         } finally {
          clearTimeout(relayTimeoutId);
          res.off("close", abortRelayOnClientGone);
          req.off("error", abortRelayOnClientGone);
         }
        };

        let response = await sendViaRelay(bodyForUpstream);
        relayResponse = response;
        // Retry must stay available on every responses request: even a
        // proactively stripped body can still carry a blob the current
        // instance cannot read.
        if (responsesRequest) {
         response = await retryWithoutReasoningEncryption(
          response,
          requestBody,
          sendViaRelay,
          reqId,
          conversationKey,
         );
         relayResponse = response;
        }
        // Record the backend that actually served this turn. Reading
        // the sticky active relay here would be wrong now that
        // affinity deliberately leaves it untouched.
        if (
         responsesRequest &&
         conversationKey !== null &&
         response.ok &&
         issuerReported
        ) {
         rememberIssuerRelay(conversationKey, servedIssuer);
        }
        // Upstream degradation tracking: successes prove Zen reachable; a 403
        // free-tier gate feeds the health state machine only when the DIRECT
        // path produced it (servedIssuer === null). A relay-served 403 is
        // relay-shaped — relay.ts rolls it and marks the relay — so a salvaged
        // relay 403 must never flip the machine-wide gate.
        if (response.ok) {
         recordUpstreamSuccess("zen", { sessionKey, canary: isCanary });
        } else if (
         servedIssuer === null &&
         response.status === 403 &&
         (response.headers.get("content-type") ?? "").includes("application/json")
        ) {
         try {
          const gateText = await response.clone().text();
          recordUpstreamFailure("zen", 403, gateText);
          rememberGateRejection(parsedBody, target.pathname, 403, gateText, gateFingerprint);
         } catch { }
        }

        if (isStream && response.ok && response.body) {
         const ct =
          response.headers.get("content-type") ||
          "text/event-stream";
         res.writeHead(response.status, {
          "content-type": ct,
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
         });
         // Mid-stream failover (budget: exactly one re-fire): headers are
         // already sent, so a relay that FINs the SSE body without a terminal
         // marker cannot roll the usual pre-stream way. pipeUpstreamStream
         // invokes refire at most once, only for genuine upstream truncation
         // with the client still attached — client aborts and clean terminals
         // never re-fire. Public practice matches: gateways retry the request
         // (LiteLLM router fallbacks); SSE resume is not a thing (the API has
         // no range semantics). The host abandons partial tool calls on
         // incomplete turns, so the re-fired turn yields a fresh complete
         // answer instead of a dead stop.
         let midStreamRefires = 0;
         pipeUpstreamStream(
          Readable.fromWeb(
           response.body as unknown as WebReadableStream,
          ),
          res,
          req,
          reqId,
          servedIssuer ?? "direct",
          streamCloak,
          {
           upstreamContentType: response.headers.get("content-type"),
           audit: audit.active ? audit : undefined,
           refire: async (reason) => {
            if (midStreamRefires >= 1) return null;
            midStreamRefires += 1;
            const cutter = servedIssuer ?? "direct";
            const why =
             reason === "rate_limit"
              ? "rate-limited"
              : reason === "model"
               ? "model-failed"
               : "truncated";
            log(
             reason === "rate_limit" ? "info" : "warn",
             `responses stream ${why} on ${cutter === "direct" ? "direct upstream" : `relay ${cutter}`} — re-firing once on next relay`,
             { model: (parsedBody as Record<string, unknown> | null)?.model, path: req.url, relay: cutter, reason },
             reqId,
            );
            let retryRes: Response;
            // Mark the cutter BEFORE re-sending: candidate ordering partitions
            // healthy-first, so only a pre-marked (cooling) cutter guarantees
            // the re-fire rolls to a sibling instead of retrying the relay
            // that just dropped us. A 429 cools for the rate-limit window; a
            // truncation/model fault keeps the existing relay-rotation mark.
            // (If the re-fire itself finds nothing usable, the pipe
            // fallthrough may add its own mark on socket-error paths; bounded
            // by the 4x escalation cap.)
            if (cutter !== "direct") {
             markRelayFailure(
              cutter,
              reason === "rate_limit" ? 429 : 0,
              reason === "rate_limit"
               ? "upstream rate-limited mid-stream"
               : reason === "model"
                ? "upstream model failed mid-stream"
                : "stream truncated mid-stream",
             );
            }
            try {
             retryRes = await sendViaRelay(bodyForUpstream);
             if (responsesRequest) {
              retryRes = await retryWithoutReasoningEncryption(
               retryRes,
               requestBody,
               sendViaRelay,
               reqId,
               conversationKey,
              );
             }
            } catch {
             return null;
            }
            if (!retryRes.ok || !retryRes.body) {
             try {
              await retryRes.body?.cancel();
             } catch { }
             return null;
            }
            relayResponse = retryRes;
            recordUpstreamSuccess("zen", { sessionKey, canary: isCanary });
            if (responsesRequest && conversationKey !== null && retryRes.ok && issuerReported) {
             rememberIssuerRelay(conversationKey, servedIssuer);
            }
            return Readable.fromWeb(retryRes.body as unknown as WebReadableStream);
           },
          },
         );
        } else {
         if (!response.ok) {
          // Attribute the failure to the relay that actually served this turn,
          // not the machine-wide sticky/affinity primary, which may be a
          // different host entirely (logged the wrong relay before this).
          const servedRelay = servedIssuer ?? "direct";
          log("warn", `upstream ${response.status} for model ${String((parsedBody as Record<string, unknown> | null)?.model ?? "?")} via ${servedRelay === "direct" ? "direct upstream" : `relay ${servedRelay}`}`, { status: response.status, model: (parsedBody as Record<string, unknown> | null)?.model, path: req.url, relay: servedRelay }, reqId);
          // The host sees this status as the turn's verdict (e.g. a 400
          // rejecting the caller's tool schema); record it as such.
          audit?.attemptFailure({ attempt: 0, status: response.status, reason: "final-upstream-status" });
         }
         const rawUpstreamText = await response.text();
         let rawText = rawUpstreamText;
         let ct =
          response.headers.get("content-type") ||
          "application/json";
         if (response.ok && (ct.includes("text/event-stream") || looksLikeSse(rawText))) {
          rawText = convertSseToJson(rawText, target.pathname, callerHadTools, callerCaseRestore, callerFindGlob, callerInjected, callerArgSchemas);
          ct = "application/json";
         }
         const data = isRelayDisabledError(response.status, rawText)
          ? rawText
          : withFreeTierHint(response.status, withRateLimitHint(response.status, rawText));
         if (response.ok) auditFinalBody(audit, target.pathname, rawUpstreamText, data);
         res.writeHead(response.status, { "content-type": ct });
         res.end(data);
        }
        return; // relay handled successfully
       }
      } catch (e) {
       log(
        "warn",
        "opencode relay failed, falling back to direct upstream",
        { error: String(e) },
        reqId,
       );
       if (res.headersSent) return; // cannot recover mid-stream
       // The client is already gone (disconnect aborted the relay fetch):
       // a fresh direct fetch would be an orphan — nobody is listening.
       // Timeouts still fall through to the live direct path below.
       if (relayClientGone || res.destroyed || res.writableEnded) {
        try { await relayResponse?.body?.cancel(); } catch { }
        res.off("close", markRelayClientGone);
        req.off("error", markRelayClientGone);
        log("debug", "client gone during relay fetch, skipping direct fallback", { error: String(e) }, reqId);
        return;
       }
       res.off("close", markRelayClientGone);
       req.off("error", markRelayClientGone);
      }
     }

     // Direct path — send the fingerprinted body if modified, else raw bytes
     const directBody = bodyModified
      ? Buffer.from(JSON.stringify(parsedBody), "utf8")
      : Buffer.concat(bodyChunks);

     // Same backend-bound blobs as the relay path: leaving the issuing
     // relay for the direct route (or vice versa) makes the history
     // unreadable, so send it portable instead.
     const directConversationKey = responsesConversationKey(parsedBody);
     const directResponsesRequest = target.pathname.endsWith("/responses");
     const directIssuer = directResponsesRequest && directConversationKey !== null
      ? issuerRelayFor(directConversationKey)
      : undefined;
     const directIssuerChanged = directIssuer !== undefined && directIssuer !== null;
     let directBodyForUpstream: Buffer = directBody;
     if (directResponsesRequest && directConversationKey !== null) {
      if (directIssuerChanged) {
       directBodyForUpstream = stripReasoningEncryption(directBodyForUpstream) ?? directBodyForUpstream;
       directBodyForUpstream = stripPreviousResponseId(directBodyForUpstream) ?? directBodyForUpstream;
      }
      if (rejectedReasoningCount(directConversationKey) > 0) {
       directBodyForUpstream = stripRejectedReasoning(directBodyForUpstream, directConversationKey) ?? directBodyForUpstream;
      }
      if (rejectedReasoningIdsCount(directConversationKey) > 0) {
       directBodyForUpstream = stripRejectedReasoningIds(directBodyForUpstream, directConversationKey) ?? directBodyForUpstream;
      }
     }
     if (directIssuerChanged && directConversationKey !== null) {
      rememberRejectedReasoning(directBody, directConversationKey);
      log(
       "info",
       `reasoning issuer changed (${directIssuer} -> direct); sending history without caller-bound reasoning`,
       undefined,
       reqId,
      );
     }

     if (isDebugEnabled()) {
      log(
       "debug",
       `direct upstream ${target.hostname}${target.pathname} (${directBody.length}B)`,
       { model: parsedBody?.model, isKilo },
       reqId,
      );
     }

     const fwd = sanitizeHeaders(req.headers, target.hostname, sessionKey ?? undefined);
     fwd["connection"] = "keep-alive";

     // Default Zen chat lane: the openai-compat path (live CLI truth). The
     // plain /v1 path stays as the fallback when the compat lane answers
     // 404/405 (unknown to that gateway shape).
     const compatPath = zenUpstreamPathFor(target.pathname);
     const compatHref = `${OPENCODE_ORIGIN}${compatPath}`;
     const plainHref = target.href;
     const directHref = compatHref !== plainHref ? compatHref : plainHref;
     const directFallbackHref = compatHref !== plainHref ? plainHref : null;
     // Trace leg label: which stack originated the direct connection.
     let directLegLabel = "zen-direct-node";

     const sendDirect = async (payload: Buffer, href = directHref): Promise<Response> => {
      const headers = { ...fwd };
      if (payload.length > 0) {
       headers["content-length"] = String(payload.byteLength);
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(upstreamTimeoutError()), UPSTREAM_HEADER_TIMEOUT_MS);
      const onClientClose = () => {
       if (!res.writableEnded) controller.abort();
      };
      const onReqError = () => controller.abort();
      res.on("close", onClientClose);
      req.on("error", onReqError);
      try {
       // Opt-in Bun sidecar: same bytes, Bun-originated TLS. Any failure
       // degrades to the Node fetch below — still the direct leg
       // (servedIssuer null, no relay mark, no gate-prime beyond the
       // existing direct-only rule).
       if (zenTransport.mode === "bun-sidecar" && zenTransport.bunPath !== null) {
        try {
         const via = await fetchZenDirectViaSidecar(
          href,
          {
           method: req.method || "POST",
           headers: { ...headers },
           body: payload,
           headerTimeoutMs: UPSTREAM_HEADER_TIMEOUT_MS,
          },
          { runtimePath: zenTransport.bunPath, scriptPath: resolveZenSidecarScript(), signal: controller.signal },
         );
         directLegLabel = "zen-direct-bun";
         return via;
        } catch (sidecarErr) {
         directLegLabel = "zen-direct-node";
         if (controller.signal.aborted) throw sidecarErr;
         log("debug", `zen sidecar degraded to node fetch (${String(sidecarErr)})`, { error: String(sidecarErr) }, reqId);
        }
       }
       return await fetch(href, {
        method: req.method,
        headers,
        body: payload.length > 0 ? payload : undefined,
        signal: controller.signal,
       } as unknown as RequestInit);
      } finally {
       clearTimeout(timeoutId);
       res.off("close", onClientClose);
       req.off("error", onReqError);
      }
     };

     try {
      let upstreamRes = await sendDirect(directBodyForUpstream);
      // Plain-path fallback: the compat lane is the default, but when the
      // gateway answers 404/405 there the plain lane may still serve.
      if (
       directFallbackHref !== null &&
       (upstreamRes.status === 404 || upstreamRes.status === 405)
      ) {
       try { await upstreamRes.body?.cancel(); } catch { }
       log("info", `compat lane ${upstreamRes.status} — falling back to plain ${target.pathname}`, { status: upstreamRes.status, model: parsedBody?.model, path: target.pathname }, reqId);
       upstreamRes = await sendDirect(directBodyForUpstream, directFallbackHref);
      }
      // Version-drift auto-repair: a stale pinned UA can age out server-side
      // (426, or a 400/403 naming the client version — never the FreeTier
      // gate). Refresh once and resend once with rebuilt headers; when the
      // refresh is offline or changes nothing, the original verdict stands
      // with no extra upstream traffic. Single retry, direct lane only.
      // Only 400, 403, and 426 can ever match isStaleOpenCodeVersionError;
      // cloning a 200 OK response would buffer the entire SSE stream to EOF
      // before pipeUpstreamStream starts.
      if (upstreamRes.status === 400 || upstreamRes.status === 403 || upstreamRes.status === 426) {
       let staleText = "";
       try { staleText = await upstreamRes.clone().text(); } catch { }
       if (isStaleOpenCodeVersionError(upstreamRes.status, staleText)) {
        const beforeUa = fwd["User-Agent"];
        const freshUa = await refreshOpenCodeUserAgent();
        if (typeof freshUa === "string" && freshUa !== beforeUa) {
         log("warn", `stale opencode UA refused (${upstreamRes.status}) — repaired UA, retrying once`, { status: upstreamRes.status, model: parsedBody?.model, path: target.pathname }, reqId);
         try { await upstreamRes.body?.cancel(); } catch { }
         Object.assign(fwd, sanitizeHeaders(req.headers, target.hostname, sessionKey ?? undefined));
         fwd["connection"] = "keep-alive";
         upstreamRes = await sendDirect(directBodyForUpstream);
        }
       }
      }
      if (directResponsesRequest) {
       upstreamRes = await retryWithoutReasoningEncryption(
        upstreamRes,
        directBody,
        sendDirect,
        reqId,
        directConversationKey,
       );
      }
      // The direct route is its own backend: remember it so a later
      // switch back to relays ships a portable history.
      if (directResponsesRequest && directConversationKey !== null && upstreamRes.ok) {
       rememberIssuerRelay(directConversationKey, null);
      }
      if (upstreamRes.status >= 400) {
       log("warn", `direct upstream ${upstreamRes.status} for model ${String(parsedBody?.model ?? "?")} ${target.pathname}`, { status: upstreamRes.status, model: parsedBody?.model, path: target.pathname, leg: directLegLabel }, reqId);
       audit?.attemptFailure({ attempt: 0, status: upstreamRes.status, reason: "final-upstream-status" });
      }
      // Upstream degradation tracking, mirroring the relay path: successes
      // prove Zen reachable, 403 free-tier gates feed the health machine.
      if (upstreamRes.ok) {
       recordUpstreamSuccess("zen", { sessionKey, canary: isCanary });
      } else if (upstreamRes.status === 403 && (upstreamRes.headers.get("content-type") ?? "").includes("application/json")) {
       try {
        const gateText = await upstreamRes.clone().text();
        recordUpstreamFailure("zen", 403, gateText);
        rememberGateRejection(parsedBody, target.pathname, 403, gateText, gateFingerprint);
       } catch { }
      }

      // Natural 429: every relay plus direct is rate-limited — buffer the
      // JSON error and attach the deploy hint instead of piping it
      // through as a stream body. A FreeUsage shape 429 is our fingerprint's
      // fault (missing/wrong env block), not quota: it keeps the raw body
      // and a shape log instead of the quota hint.
      if (upstreamRes.status === 429) {
       const raw429 = await upstreamRes.text();
       if (isFreeUsageShapeError(429, raw429)) {
        log("warn", `direct upstream 429 FreeUsage shape verdict for model ${String(parsedBody?.model ?? "?")} — fingerprint/env fault, not quota`, { status: 429, model: parsedBody?.model, path: target.pathname }, reqId);
       }
       const data = withRateLimitHint(429, raw429);
       const ct429 = upstreamRes.headers.get("content-type") || "application/json";
       res.writeHead(429, { "content-type": ct429 });
       res.end(data);
       return;
      }
      // Gated upstream: a 403 free-tier gate is a final answer, not a
      // stream — buffer it and attach the recovery hint instead of
      // piping it through as a stream body.
     if (upstreamRes.status === 403) {
      const rawText403 = await upstreamRes.text();
       const data = withFreeTierHint(403, rawText403);
       const ct403 = upstreamRes.headers.get("content-type") || "application/json";
       res.writeHead(403, { "content-type": ct403 });
       res.end(data);
       return;
      }
      const outHeaders: Record<string, string> = {};
      for (const h of ["content-type", "cache-control", "x-request-id"] as const) {
       const v = upstreamRes.headers.get(h);
       if (v) outHeaders[h] = v;
      }
      outHeaders["x-content-type-options"] = "nosniff";
      outHeaders["connection"] = "keep-alive";
      const ka = upstreamRes.headers.get("keep-alive");
      if (ka) outHeaders["keep-alive"] = ka;

      if (isStream && upstreamRes.body) {
       // Force anti-buffer headers on the streaming leg: upstream rarely sends
       // them, and without them a downstream hop may buffer SSE chunks.
       outHeaders["cache-control"] = outHeaders["cache-control"] ?? "no-cache, no-transform";
       outHeaders["x-accel-buffering"] = "no";
       res.writeHead(upstreamRes.status, outHeaders);
       pipeUpstreamStream(
        Readable.fromWeb(upstreamRes.body as unknown as WebReadableStream),
        res,
        req,
        reqId,
        "direct",
        streamCloak,
        { upstreamContentType: upstreamRes.headers.get("content-type"), audit: audit?.active ? audit : undefined },
       );
      } else if (upstreamRes.body) {
       const rawUpstreamText = await upstreamRes.text();
       let rawText = rawUpstreamText;
       if (upstreamRes.ok && (outHeaders["content-type"]?.includes("text/event-stream") || looksLikeSse(rawText))) {
        rawText = convertSseToJson(rawText, target.pathname, callerHadTools, callerCaseRestore, callerFindGlob, callerInjected, callerArgSchemas);
        outHeaders["content-type"] = "application/json";
       }
       if (upstreamRes.ok) auditFinalBody(audit, target.pathname, rawUpstreamText, rawText);
       res.writeHead(upstreamRes.status, outHeaders);
       res.end(rawText);
      } else {
       res.writeHead(upstreamRes.status, outHeaders);
       res.end();
      }
     } catch (proxyErr) {
      log("error", "proxy socket error", { error: String(proxyErr) }, reqId);
      if (!res.headersSent) {
       res.writeHead(502, { "content-type": "application/json" });
       res.end(JSON.stringify({ error: "upstream error" }));
      } else if (!res.writableEnded) {
       res.end();
      }
     }
    }
   } catch (err) {
    log("error", "proxy error", { error: String(err) }, reqId);
    if (!res.headersSent) {
     res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: "internal error" }));
   }
  });
 });

 return new Promise<{ server: http.Server | null; port: number }>(
  (resolve, reject) => {
   let attempt = 0;
   let settled = false;

   const tryListen = async (port: number) => {
    server.removeAllListeners("error");
    server.once("error", async (err: NodeJS.ErrnoException) => {
     if (settled) return;
     if (err.code === "EADDRINUSE") {
      // Cold-start race: a sibling may be binding the base port
      // right now. Re-probe it for up to 3s before accepting a
      // walked port so parallel startups converge on :28180.
      if (await reprobeBasePortAlive(basePort, BASE_PORT_REPROBE_MS)) {
       settled = true;
       log(
        "info",
        `attached to running proxy on http://${HOST}:${basePort}`,
       );
       resolve({ server: null, port: basePort });
       return;
      }
      if (attempt < 20) {
       attempt++;
       log("warn", `port ${port} taken — trying ${port + 1}`);
       tryListen(port + 1);
       return;
      }
     }
     settled = true;
     log("error", "server error", { code: err.code, message: err.message });
     reject(err);
    });
    server.listen(port, HOST, () => {
     if (settled) return;
     settled = true;
     try {
      server.unref();
     } catch { }
     const addr = server.address();
     const realPort = addr && typeof addr === "object" ? addr.port : port;
     if (realPort !== basePort) {
      log("warn", `base port ${basePort} busy — proxy listening on walked port http://${HOST}:${realPort}`);
     } else {
      log("info", `proxy listening on http://${HOST}:${realPort}`);
     }
     resolve({ server, port: realPort });
    });
   };

   tryListen(basePort);
  },
 );
}

/**
 * Poll the base port until it answers or the budget expires. Returns true as
 * soon as the port is alive (caller attaches instead of walking).
 */
export async function reprobeBasePortAlive(port: number, timeoutMs: number): Promise<boolean> {
 const deadline = Date.now() + Math.max(0, timeoutMs);
 for (; ;) {
  if (await isProxyAlive(port)) return true;
  if (Date.now() >= deadline) return false;
  await new Promise<void>((r) => setTimeout(r, 200));
 }
}
