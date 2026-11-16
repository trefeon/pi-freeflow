/**
 * Native-TLS relay transport for the OpenCode Zen free lane (issue #137).
 *
 * The Zen free tier gates on the transport stack below HTTP: a Bun-originated
 * ClientHello passes while Node/worker egress is refused (issue #120). A relay
 * that re-originates the request therefore cannot carry this lane, and the
 * old code disabled relays entirely whenever the Bun sidecar was active.
 *
 * This transport keeps the TLS handshake in the local Bun process and sends
 * only the TCP connection through a relay's CONNECT tunnel. Each relay URL is
 * one egress, so multi-relay failover still rotates upstream quota buckets
 * while the fingerprint stays Bun's. Relays that answer CONNECT with a
 * non-2xx (workers, static hosts) are remembered as tunnel-incapable for a
 * short TTL and skipped without a health mark — they are not broken, they
 * simply cannot carry a tunnel.
 */

import { log } from "./logger.ts";
import { RelayTransportUnavailable, type RelayAttemptTransport } from "./relay.ts";
import { getActiveRelayState } from "./relay-state.ts";
import {
 fetchZenDirectViaSidecar,
 resolveZenSidecarScript,
 type ZenTransportStatus,
} from "./zen-transport.ts";

/** How long a tunnel-capability verdict is trusted before re-probing. */
const CAPABILITY_TTL_MS = 10 * 60_000;

const capabilityCache = new Map<string, { capable: boolean; at: number }>();

/** Test-only: forget every cached tunnel-capability verdict. */
export function _resetZenRelayProxyCapabilityForTest(): void {
 capabilityCache.clear();
}

/** Cached capability: true = tunnels, false = refuses, null = unknown. */
function cachedCapability(url: string): boolean | null {
 const hit = capabilityCache.get(url);
 if (!hit) return null;
 if (Date.now() - hit.at > CAPABILITY_TTL_MS) {
  capabilityCache.delete(url);
  return null;
 }
 return hit.capable;
}

/** One-shot headers to a plain record the sidecar frame accepts. */
function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
 const out: Record<string, string> = {};
 if (!headers) return out;
 if (headers instanceof Headers) {
  headers.forEach((value, key) => { out[key] = value; });
 } else if (Array.isArray(headers)) {
  for (const [key, value] of headers) out[key] = String(value);
 } else {
  for (const [key, value] of Object.entries(headers)) {
   if (typeof value === "string") out[key] = value;
  }
 }
 return out;
}

/** Request body as a Buffer for the sidecar frame. */
function bodyToBuffer(body: BodyInit | null | undefined): Buffer {
 if (body === undefined || body === null) return Buffer.alloc(0);
 if (typeof body === "string") return Buffer.from(body, "utf8");
 if (Buffer.isBuffer(body)) return body;
 if (body instanceof Uint8Array) return Buffer.from(body);
 return Buffer.alloc(0);
}

/**
 * Build the relay transport for one request turn. Caller must hold a resolved
 * bun-sidecar `ZenTransportStatus`; the transport reuses that Bun binary and
 * the staged sidecar script, and never spawns a different runtime.
 */
export function createZenBunRelayTransport(
 zenTransport: ZenTransportStatus,
 reqId?: string,
 deps: { attemptImpl?: typeof fetchZenDirectViaSidecar } = {},
): RelayAttemptTransport {
 const attemptImpl = deps.attemptImpl ?? fetchZenDirectViaSidecar;
 if (zenTransport.mode !== "bun-sidecar" || zenTransport.bunPath === null) {
  throw new Error("zen relay transport requires a resolved bun-sidecar with a Bun path");
 }
 const bunPath = zenTransport.bunPath;
 const scriptPath = resolveZenSidecarScript();

 const attempt = async (
  candidateUrl: string,
  ctx: { url: string; opts: RequestInit; signal: AbortSignal; headerTimeoutMs: number },
 ): Promise<Response> => {
  const trimmed = candidateUrl.trim();
  if (cachedCapability(trimmed) === false) {
   throw new RelayTransportUnavailable(trimmed, "CONNECT tunnel refused (cached)");
  }
  const entry = getActiveRelayState().relays.find((relay) => relay.url.trim() === trimmed);
  const proxyHeaders: Record<string, string> = {};
  if (entry?.auth) proxyHeaders["x-relay-auth"] = entry.auth;
  const headers = headersToRecord(ctx.opts.headers);
  // The tunnel carries bytes straight to the upstream origin: relay-target
  // markers and the relay's own auth must never appear on the request.
  delete headers["x-relay-target"];
  delete headers["x-relay-path"];
  delete headers["x-relay-auth"];
  try {
   headers["host"] = new URL(ctx.url).host;
  } catch { /* keep the caller's host header */ }
  try {
   return await attemptImpl(
    ctx.url,
    {
     method: typeof ctx.opts.method === "string" && ctx.opts.method !== "" ? ctx.opts.method : "POST",
     headers,
     body: bodyToBuffer(ctx.opts.body),
     headerTimeoutMs: ctx.headerTimeoutMs,
     proxy: { url: trimmed, headers: proxyHeaders },
    },
    { runtimePath: bunPath, scriptPath, signal: ctx.signal },
   );
  } catch (err) {
   const detail = err as { code?: string; proxyStatus?: number };
   if (detail.code === "ERR_PROXY_TUNNEL") {
    capabilityCache.set(trimmed, { capable: false, at: Date.now() });
    const status = typeof detail.proxyStatus === "number" ? ` (${detail.proxyStatus})` : "";
    log(
     "debug",
     `relay ${trimmed} does not tunnel (CONNECT refused${status}) — skipping for Zen native-TLS routing`,
     { relay: trimmed, status: detail.proxyStatus },
     reqId,
    );
    throw new RelayTransportUnavailable(trimmed, `CONNECT refused${status}`);
   }
   throw err;
  }
 };

 const attemptDirect = async (ctx: { url: string; opts: RequestInit }): Promise<Response> => {
  const headers = headersToRecord(ctx.opts.headers);
  delete headers["x-relay-target"];
  delete headers["x-relay-path"];
  delete headers["x-relay-auth"];
  try {
   headers["host"] = new URL(ctx.url).host;
  } catch { /* keep the caller's host header */ }
  try {
   return await attemptImpl(
    ctx.url,
    {
     method: typeof ctx.opts.method === "string" && ctx.opts.method !== "" ? ctx.opts.method : "POST",
     headers,
     body: bodyToBuffer(ctx.opts.body),
     headerTimeoutMs: 0,
    },
    { runtimePath: bunPath, scriptPath, signal: ctx.opts.signal ?? undefined },
   );
  } catch (err) {
   // Same degradation as the proxy's own direct leg: a broken sidecar must
   // not fail the turn outright, and the Node attempt surfaces the authentic
   // upstream verdict. The log names the degradation so a gate-shaped answer
   // is never mistaken for a quota reading.
   log("debug", `zen relay direct leg degraded to node fetch (${String(err)})`, { error: String(err) }, reqId);
   return fetch(ctx.url, ctx.opts);
  }
 };

 return { attempt, attemptDirect };
}
