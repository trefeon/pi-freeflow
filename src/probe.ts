import net from "node:net";
import {
 OPENCODE_API_URL,
 OPENCODE_OPENAI_COMPAT_PATH,
 OPENCODE_OPENAI_COMPAT_URL,
 opencodeHeaders,
} from "./config.ts";
import {
 enforceOpencodeFingerprint,
} from "./opencode-fingerprint.ts";
import type { KnownRelay } from "./types.ts";

/**
 * Relay reachability probe: verifies a deployed relay answers requests
 * by issuing a minimal round trip through it and timing the response.
 */

interface RelayProbeResult {
 ok: boolean;
 status: number;
 latencyMs: number;
 error?: string;
}

interface RelayProbeOptions {
 /**
  * Probe mode:
  * - "models" (default): GET /v1/models (reachability probe)
 * - "chat": POST /inference/openai/v1/chat/completions (verifies free tier inference & spoofing)
  */
 endpoint?: "models" | "chat";
 /** Model to use for chat probe (defaults to "nemotron-3.5-lightning-free") */
 model?: string;
 /** Timeout in milliseconds (defaults to 5000) */
 timeoutMs?: number;
 /**
  * Number of retry attempts when the probe returns !ok or throws.
  * Defaults to 0 (single attempt). Useful post-deploy for edge DNS propagation.
  */
 retries?: number;
 /** Delay between retries in milliseconds (defaults to 2000). */
 retryDelayMs?: number;
 /** Optional progress callback before each retry */
 onRetry?: (attempt: number, maxRetries: number, lastResult: RelayProbeResult) => void;
 /**
  * Plain-lane opt-out (chat endpoint only, default false): probe the plain
  * `/inference/v1/chat/completions` fallback instead of the default
  * `/inference/openai/v1/chat/completions` compat lane. The models endpoint
  * ignores this flag.
  */
 openaiCompat?: boolean;
}

/**
 * Probe a relay endpoint to confirm it is reachable.
 *
 * Sends a minimal request to `<url>/v1/models` carrying the x-relay-target /
 * x-relay-path headers the relay expects, timing the round trip. Never
 * throws: network failures, timeouts, and non-2xx statuses are all reported
 * on the returned result instead.
 *
 * The path mirrors the proxy's real relay contract (`relayFetch` in relay.ts):
 * `x-relay-target` is the upstream origin and `x-relay-path` the full path
 * including the `/zen` prefix — the workers only allow the exact origins
 * `https://opencode.ai` / `https://api.kilo.ai` and forward `target + path`.
 * @param auth Optional per-relay shared secret; sent as x-relay-auth so
 *   deployed relays (which enforce it) answer the probe instead of 401.
 */
async function probeRelayOnce(
 url: string,
 auth?: string,
 opts?: RelayProbeOptions,
): Promise<RelayProbeResult> {
 const cleanUrl = url.trim().replace(/\/+$/, "");
 const isDirectOpenCode =
  cleanUrl === "https://opencode.ai" ||
  cleanUrl === "opencode" ||
  cleanUrl === "direct";
 const isChat = opts?.endpoint === "chat";
 const timeout = opts?.timeoutMs ?? (isChat ? 15_000 : 5_000);
 const start = Date.now();

 try {
  const headers: Record<string, string> = {
   ...opencodeHeaders(),
   ...(auth ? { "x-relay-auth": auth } : {}),
  };

  let fetchUrl: string;
  let method = "GET";
  let body: string | undefined;

  if (isDirectOpenCode) {
   if (isChat) {
    // Live default: the openai-compat lane; openaiCompat:false forces the
    // plain /v1 lane (fallback coverage). Usage accounting rides the body on
    // both via enforceOpencodeFingerprint; the lanes differ by path only.
    const plain = opts?.openaiCompat === false;
    fetchUrl = plain ? `${OPENCODE_API_URL}/chat/completions` : OPENCODE_OPENAI_COMPAT_URL;
    method = "POST";
    headers["content-type"] = "application/json";
    const probePayload: Record<string, unknown> = {
     model: opts?.model || "nemotron-3.5-lightning-free",
     max_tokens: 1,
     stream: true,
     messages: [{ role: "user", content: "ping" }],
    };
    // The proxy's own enforcement, not a subset of it: a probe that skipped the
    // env block would answer 429 for a lane that actually serves traffic.
    enforceOpencodeFingerprint(probePayload, "/v1/chat/completions");
    body = JSON.stringify(probePayload);
    } else {
    fetchUrl = `${OPENCODE_API_URL}/models`;
    }
  } else {
   if (isChat) {
    const plain = opts?.openaiCompat === false;
    fetchUrl = plain ? `${cleanUrl}/inference/v1/chat/completions` : `${cleanUrl}${OPENCODE_OPENAI_COMPAT_PATH}`;
    method = "POST";
    headers["content-type"] = "application/json";
    headers["x-relay-target"] = "https://opencode.ai";
    headers["x-relay-path"] = plain ? "/inference/v1/chat/completions" : OPENCODE_OPENAI_COMPAT_PATH;
    const probePayload: Record<string, unknown> = {
     model: opts?.model || "nemotron-3.5-lightning-free",
     max_tokens: 1,
     stream: true,
     messages: [{ role: "user", content: "ping" }],
    };
    enforceOpencodeFingerprint(probePayload, "/v1/chat/completions");
    body = JSON.stringify(probePayload);
   } else {
    fetchUrl = `${cleanUrl}/v1/models`;
    headers["x-relay-target"] = "https://opencode.ai";
    headers["x-relay-path"] = "/inference/v1/models";
   }
  }

  const res = await fetch(fetchUrl, {
   method,
   headers,
   body,
   signal: AbortSignal.timeout(timeout),
  });
  return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
 } catch (e) {
  return {
   ok: false,
   status: 0,
   latencyMs: Date.now() - start,
   error: (e as Error)?.message || String(e),
  };
 }
}

export async function probeRelay(
 url: string,
 auth?: string,
 opts?: RelayProbeOptions,
): Promise<RelayProbeResult> {
 const retries = Math.max(0, opts?.retries ?? 0);
 const retryDelay = Math.max(10, opts?.retryDelayMs ?? 2000);

 for (let attempt = 0; attempt <= retries; attempt++) {
  if (attempt > 0) {
   const { promise, resolve } = Promise.withResolvers<void>();
   setTimeout(resolve, retryDelay);
   await promise;
  }
  const result = await probeRelayOnce(url, auth, opts);
  if (result.ok || attempt === retries) {
   return result;
  }
  opts?.onRetry?.(attempt + 1, retries, result);
 }
 return { ok: false, status: 0, latencyMs: 0, error: "Probe failed" };
}

export interface RelayEgressResult {
 url: string;
 label?: string;
 ok: boolean;
 status: number;
 latencyMs: number;
 ip?: string;
 egressKey?: string;
 colo?: string;
 loc?: string;
 error?: string;
}

export interface PoolEgressReport {
 entries: RelayEgressResult[];
 sharedGroups: Array<{ egressKey: string; relays: RelayEgressResult[] }>;
}

/** Parse Cloudflare `/cdn-cgi/trace` key=value text into structured fields. */
export function parseTraceResponse(text: string): { ip?: string; colo?: string; loc?: string } {
 const out: { ip?: string; colo?: string; loc?: string } = {};
 for (const line of String(text || "").split(/\r?\n/)) {
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  const k = line.slice(0, eq).trim();
  const v = line.slice(eq + 1).trim();
  if (!v) continue;
  if (k === "ip") out.ip = v;
  else if (k === "colo") out.colo = v;
  else if (k === "loc") out.loc = v;
 }
 return out;
}

/** Normalize an IPv6 address (including RFC 5952 `::` compression) to its `/64` prefix. */
export function canonicalizeIpv6Block(ip: string): string {
 const clean = String(ip || "")
  .trim()
  .replace(/\/\d+$/, "")
  .replace(/^\[|\]$/g, "")
  .replace(/%.*$/, "");
 if (net.isIP(clean) !== 6) return "";
 let addr = clean;
 const lastColon = addr.lastIndexOf(":");
 if (lastColon >= 0 && addr.slice(lastColon + 1).includes(".")) {
  const octets = addr.slice(lastColon + 1).split(".").map(Number);
  if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
   const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
   const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
   addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
 }
 const [head, tail] = addr.split("::");
 const left = head ? head.split(":").filter(Boolean) : [];
 const right = tail !== undefined ? tail.split(":").filter(Boolean) : [];
 const missing = Math.max(0, 8 - left.length - right.length);
 const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
 const words = [0, 1, 2, 3].map((i) => (parseInt(groups[i] || "0", 16) || 0).toString(16));
 return `${words.join(":")}::/64`;
}

/** Canonical egress identity key: IPv6 `/64` prefix or exact IPv4 address. */
export function egressIdentityKey(ip: string): string {
 const clean = String(ip || "").trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
 const family = net.isIP(clean);
 if (family === 6) return canonicalizeIpv6Block(clean);
 if (family === 4) return clean;
 return "";
}

/**
 * Probe a relay's effective outbound egress identity via `opencode.ai/cdn-cgi/trace`.
 */
export async function probeRelayEgress(
 url: string,
 auth?: string,
 opts?: { timeoutMs?: number; label?: string },
): Promise<RelayEgressResult> {
 const cleanUrl = url.trim().replace(/\/+$/, "");
 const isDirectOpenCode =
  cleanUrl === "https://opencode.ai" ||
  cleanUrl === "opencode" ||
  cleanUrl === "direct";
 const timeout = opts?.timeoutMs ?? 5_000;
 const start = Date.now();
 try {
  const headers: Record<string, string> = {
   ...opencodeHeaders(),
   ...(auth ? { "x-relay-auth": auth } : {}),
  };
  let fetchUrl: string;
  if (isDirectOpenCode) {
   fetchUrl = "https://opencode.ai/cdn-cgi/trace";
  } else {
   fetchUrl = `${cleanUrl}/cdn-cgi/trace`;
   headers["x-relay-target"] = "https://opencode.ai";
   headers["x-relay-path"] = "/cdn-cgi/trace";
  }
  const res = await fetch(fetchUrl, {
   method: "GET",
   headers,
   signal: AbortSignal.timeout(timeout),
  });
  const latencyMs = Date.now() - start;
  if (!res.ok) {
   return { url: cleanUrl, label: opts?.label, ok: false, status: res.status, latencyMs };
  }
  const text = await res.text();
  const trace = parseTraceResponse(text);
  const ip = trace.ip;
  const egressKey = ip ? egressIdentityKey(ip) : undefined;
  return {
   url: cleanUrl,
   label: opts?.label,
   ok: true,
   status: res.status,
   latencyMs,
   ...(ip ? { ip } : {}),
   ...(egressKey ? { egressKey } : {}),
   ...(trace.colo ? { colo: trace.colo } : {}),
   ...(trace.loc ? { loc: trace.loc } : {}),
  };
 } catch (e) {
  return {
   url: cleanUrl,
   label: opts?.label,
   ok: false,
   status: 0,
   latencyMs: Date.now() - start,
   error: (e as Error)?.message || String(e),
  };
 }
}

/**
 * Probe every relay in a pool concurrently and group relays sharing an egress IP or `/64` block.
 */
export async function probePoolEgress(
 relays: readonly KnownRelay[],
 opts?: { timeoutMs?: number },
): Promise<PoolEgressReport> {
 const entries = await Promise.all(
  relays.map((r) => probeRelayEgress(r.url, r.auth, { timeoutMs: opts?.timeoutMs, label: r.label })),
 );
 const groups = new Map<string, RelayEgressResult[]>();
 for (const entry of entries) {
  if (!entry.egressKey) continue;
  const bucket = groups.get(entry.egressKey) ?? [];
  bucket.push(entry);
  groups.set(entry.egressKey, bucket);
 }
 const sharedGroups: Array<{ egressKey: string; relays: RelayEgressResult[] }> = [];
 for (const [egressKey, members] of groups) {
  if (members.length > 1) sharedGroups.push({ egressKey, relays: members });
 }
 return { entries, sharedGroups };
}
