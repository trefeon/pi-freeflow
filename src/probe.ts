import { opencodeHeaders } from "./config.ts";

/**
 * Relay reachability probe: verifies a deployed relay answers requests
 * by issuing a minimal round trip through it and timing the response.
 */

export interface RelayProbeResult {
 ok: boolean;
 status: number;
 latencyMs: number;
 error?: string;
}

export interface RelayProbeOptions {
 /**
  * Probe mode:
  * - "models" (default): GET /v1/models (reachability probe)
  * - "chat": POST /zen/v1/chat/completions (verifies free tier inference & spoofing)
  */
 endpoint?: "models" | "chat";
 /** Model to use for chat probe (defaults to "nemotron-3.5-lightning-free") */
 model?: string;
 /** Timeout in milliseconds (defaults to 5000) */
 timeoutMs?: number;
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
export async function probeRelay(
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
    fetchUrl = "https://opencode.ai/zen/v1/chat/completions";
    method = "POST";
    headers["content-type"] = "application/json";
    body = JSON.stringify({
     model: opts?.model || "nemotron-3.5-lightning-free",
     max_tokens: 1,
     messages: [{ role: "user", content: "ping" }],
    });
   } else {
    fetchUrl = "https://opencode.ai/zen/v1/models";
   }
  } else {
   if (isChat) {
    fetchUrl = `${cleanUrl}/zen/v1/chat/completions`;
    method = "POST";
    headers["content-type"] = "application/json";
    headers["x-relay-target"] = "https://opencode.ai";
    headers["x-relay-path"] = "/zen/v1/chat/completions";
    body = JSON.stringify({
     model: opts?.model || "nemotron-3.5-lightning-free",
     max_tokens: 1,
     messages: [{ role: "user", content: "ping" }],
    });
   } else {
    fetchUrl = `${cleanUrl}/v1/models`;
    headers["x-relay-target"] = "https://opencode.ai";
    headers["x-relay-path"] = "/zen/v1/models";
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
