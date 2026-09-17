/**
 * High-resiliency multi-cloud relay client and failover dispatcher
 */

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { isDebugEnabled, log } from "./logger.ts";
import {
	getActiveRelayState,
	orderedRelayCandidates,
	getStatusUi,
	markRelayFailure,
	markRelaySuccess,
	shortRelayLabel,
	updateRelayStatusUi,
	withRelayState,
	validateRelayUrl,
} from "./relay-state.ts";

// Throttle user-facing roll notifications so a burst of failures surfaces
// one warning instead of a wall of identical toasts.
let lastRollNotify = 0;
const ROLL_NOTIFY_MS = 5 * 60 * 1_000;
/** Test-only: reset roll-notify throttle */
export function _resetRollNotifyForTest(): void { lastRollNotify = 0; }

/**
 * Determine if an HTTP status code indicates a temporary relay or upstream error
 * that warrants rolling to the next relay candidate.
 */
export function isRetriableStatus(status: number): boolean {
	return (
		status === 429 ||
		status === 408 ||
		status === 502 ||
		status === 503 ||
		status === 504 ||
		(status >= 520 && status <= 530)
	);
}

/**
 * Gated 402 roll predicate: a 402 is a relay-host failure only when it
 * carries the Vercel edge-error marker or a DEPLOYMENT_DISABLED body match.
 * Generic 402s (payment/quota) carry neither and must surface immediately.
 * Only x-vercel-error qualifies as an edge marker: Vercel stamps x-vercel-id
 * on EVERY function response, so keying on it would misroll a genuine
 * upstream quota 402 forwarded by a healthy Vercel-hosted relay — and
 * wrongly cool that relay down.
 */
function isRelayDeploymentDisabled(res: Response, bodyText: string | null): boolean {
	if (res.status !== 402) return false;
	if (Boolean(res.headers.get("x-vercel-error"))) return true;
	return bodyText !== null && bodyText.includes("DEPLOYMENT_DISABLED");
}
/**
 * Per-conversation reasoning affinity. Callers sending caller-bound reasoning
 * pass the relay that issued it; `onServed` reports the relay that actually
 * produced the response (`null` = direct fallback).
 */
export interface RelayAffinity {
	preferred?: string;
	onServed?: (relay: string | null) => void;
}

/**
 * Fetch a target URL through the active relay pool with rolling failover and direct fallback.
 *
 * @param url Full upstream destination URL (e.g. https://opencode.ai/zen/v1/chat/completions)
 * @param opts Standard fetch RequestInit options
 * @param reqId Optional correlation request ID for end-to-end tracing
 * @param affinity Per-conversation affinity: `preferred` is tried first when it
 *        is healthy (the caller is expected to send a body that relay can read),
 *        and `onServed` reports which relay actually produced the response —
 *        `null` for the direct fallback — so the caller does not have to infer
 *        the issuer from mutable global state.
 */
export async function relayFetch(
	url: string,
	opts: RequestInit = {},
	reqId?: string,
	affinity: RelayAffinity = {},
): Promise<Response> {
	const rid = reqId || randomUUID().slice(0, 8);
	const relayState = getActiveRelayState();

	if (!relayState.enabled) {
		log("debug", `relayFetch: direct (relay disabled) -> ${url}`, undefined, rid);
		affinity.onServed?.(null);
		return fetch(url, opts as unknown as RequestInit);
	}
	const candidates = orderedRelayCandidates(affinity.preferred);

	if (candidates.length === 0) {
		// Empty pool: skip straight to upstream instead of logging a misleading
		// "relays bypassed/exhausted" WARN on every request.
		log("debug", `relayFetch: direct (empty relay pool) -> ${url}`, undefined, rid);
		affinity.onServed?.(null);
		return fetch(url, opts as unknown as RequestInit);
	}

	let lastResponse: Response | null = null;
	let lastError: unknown = null;
	/** Relay that produced `lastResponse`, for accurate issuer reporting. */
	let lastResponseRelay: string | null = null;
	const u = new URL(url);
	const relayTarget = `${u.protocol}//${u.host}`;
	const relayPath = `${u.pathname}${u.search}`;

	const bodySizeKB =
		typeof opts.body === "string"
			? (opts.body.length / 1024).toFixed(1)
			: Buffer.isBuffer(opts.body)
				? (opts.body.length / 1024).toFixed(1)
				: "0";

	log("info", `request starting (${bodySizeKB}KB payload) -> ${url}`, undefined, rid);
	if (isDebugEnabled()) {
		try {
			const bodyPreview = typeof opts.body === "string" ? opts.body.slice(0, 1200) : "";
			const modelMatch = bodyPreview.match(/"model"\s*:\s*"([^"]+)"/);
			const streamMatch = bodyPreview.match(/"stream"\s*:\s*(true|false)/);
			log("debug", "request detail", {
				model: modelMatch?.[1],
				stream: streamMatch?.[1],
				sizeKB: bodySizeKB,
				relayTarget,
				relayPath,
				candidates: candidates.length,
			}, rid);
		} catch {}
	}

	for (let i = 0; i < candidates.length; i++) {
		const targetUrl = candidates[i];
		const attemptStart = Date.now();
		try {
			// SSRF guard: reject private/loopback/non-https candidates the same
			// way a deployed relay worker rejects an inbound x-relay-target.
			const candidateCheck = validateRelayUrl(targetUrl);
			if (!candidateCheck.ok) {
				log(
					"warn",
					`relay ${targetUrl} skipped — ${candidateCheck.reason}`,
					{ upstream: url },
					rid,
				);
				continue;
			}
			let targetHost = "opencode.ai";
			try {
				if (targetUrl) targetHost = new URL(targetUrl).host;
			} catch {}

			const headers = new Headers(opts.headers);
			headers.set("x-relay-target", relayTarget);
			headers.set("x-relay-path", relayPath);
			headers.set("host", targetHost);
			headers.set("x-request-id", rid);
			// Per-relay shared secret set by /freeflow deploy. Legacy entries
			// without auth keep working: no header at all.
			const entry = getActiveRelayState().relays.find(
				(r) => r.url === targetUrl.trim(),
			);
			if (entry?.auth) {
				headers.set("x-relay-auth", entry.auth);
			}

			const signal = opts.signal || AbortSignal.timeout(300_000);
			const res = await fetch(targetUrl, { ...opts, headers, signal } as unknown as RequestInit);
			const elapsed = ((Date.now() - attemptStart) / 1000).toFixed(1);
			// Vercel 504 Gateway Timeout on heavy prompts (>50KB or >25s):
			// Fast fallback directly to upstream instead of cycling through multiple 25s timeouts.
			if (res.status === 504) {
				markRelayFailure(targetUrl, 504, "Gateway Timeout (25s exceeded)");
				res.body?.cancel().catch(() => {});
				log(
					"warn",
					`relay ${targetUrl} hit HTTP 504 Gateway Timeout in ${elapsed}s (prompt evaluation exceeded Vercel 25s limit) — fast fallback to direct upstream`,
					{ upstream: url, sizeKB: bodySizeKB },
					rid,
				);
				const now = Date.now();
				if (now - lastRollNotify > ROLL_NOTIFY_MS) {
					lastRollNotify = now;
					const ui = getStatusUi();
					if (ui?.notify) {
						ui.notify(`relay ${shortRelayLabel(targetUrl)} hit HTTP 504 — falling back to direct`, "warning");
					}
				}
				break;
			}
			// Relay payload cap hit (413: request exceeds host payload limit):
			// Not a relay health signal, so no failure marking — try the next
			// relay (a different host may accept it), else the direct fallback.
			if (res.status === 413) {
				lastResponse?.body?.cancel().catch(() => {});
				lastResponse = res;
				lastResponseRelay = targetUrl;
				log(
					"warn",
					`relay ${targetUrl} hit HTTP 413 payload limit in ${elapsed}s — trying next path`,
					{ upstream: url, sizeKB: bodySizeKB },
					rid,
				);
				const now = Date.now();
				if (now - lastRollNotify > ROLL_NOTIFY_MS) {
					lastRollNotify = now;
					const ui = getStatusUi();
					if (ui?.notify) {
						ui.notify(`relay ${shortRelayLabel(targetUrl)} hit payload limit — trying next path`, "warning");
					}
				}
				continue;
			}

			// Relay host infrastructure 404 (e.g. Vercel DEPLOYMENT_NOT_FOUND or non-JSON 404):
			// When a relay URL is deleted, misconfigured, or has no deployment, Vercel/Cloudflare
			// returns edge 404. This is a relay failure, not an upstream API response.
			const isRelayEdge404 =
				res.status === 404 &&
				(Boolean(res.headers.get("x-vercel-error")) ||
					Boolean(res.headers.get("x-vercel-id")) ||
					res.headers.get("server")?.toLowerCase().includes("vercel") ||
					!res.headers.get("content-type")?.includes("json"));

			if (isRelayEdge404) {
				markRelayFailure(targetUrl, 404, "Deployment or route not found on relay host");
				lastResponse?.body?.cancel().catch(() => {});
				lastResponse = res;
				lastResponseRelay = targetUrl;
				log(
					"warn",
					`relay ${targetUrl} returned edge 404 (deployment missing or route not found) — rolling to next relay`,
					{ upstream: url },
					rid,
				);
				const now = Date.now();
				if (now - lastRollNotify > ROLL_NOTIFY_MS) {
					lastRollNotify = now;
					const ui = getStatusUi();
					if (ui?.notify) {
						ui.notify(`relay ${shortRelayLabel(targetUrl)} failed (HTTP 404) — rolled to next relay`, "warning");
					}
				}
				continue;
			}
			// Relay deployment disabled (402 DEPLOYMENT_DISABLED from Vercel):
			// A disabled deployment is a relay-host failure, so roll to the next
			// relay. A blanket 402 must NOT roll: generic 402s are payment/quota
			// verdicts that must surface immediately, so gate strictly on Vercel
			// edge markers or a DEPLOYMENT_DISABLED body match and otherwise fall
			// through to the terminal path below. The body is peeked via a clone so
			// the downstream stream stays intact; on any clone/read failure decide
			// on headers alone (headerless failure reads as a generic 402).
			if (res.status === 402) {
				let disabledBody: string | null = null;
				try {
					disabledBody = (await res.clone().text()).slice(0, 8192);
				} catch {
					disabledBody = null;
				}
				if (isRelayDeploymentDisabled(res, disabledBody)) {
					markRelayFailure(targetUrl, 402, "Deployment disabled (DEPLOYMENT_DISABLED) on relay host");
					lastResponse?.body?.cancel().catch(() => {});
					lastResponse = res;
					lastResponseRelay = targetUrl;
					log(
						"warn",
						`relay ${targetUrl} returned 402 DEPLOYMENT_DISABLED in ${elapsed}s — rolling to next relay`,
						{ upstream: url },
						rid,
					);
					const now = Date.now();
					if (now - lastRollNotify > ROLL_NOTIFY_MS) {
						lastRollNotify = now;
						const ui = getStatusUi();
						if (ui?.notify) {
							ui.notify(`relay ${shortRelayLabel(targetUrl)} failed (HTTP 402) — rolled to next relay`, "warning");
						}
					}
					continue;
				}
			}
			if (isRetriableStatus(res.status)) {
				markRelayFailure(targetUrl, res.status);
				lastResponse?.body?.cancel().catch(() => {});
				lastResponse = res;
				lastResponseRelay = targetUrl;
				log(
					"warn",
					`relay ${targetUrl} returned HTTP ${res.status} in ${elapsed}s — rolling to next relay`,
					{ upstream: url, status: res.status },
					rid,
				);
				const now = Date.now();
				if (now - lastRollNotify > ROLL_NOTIFY_MS) {
					lastRollNotify = now;
					const ui = getStatusUi();
					if (ui?.notify) {
						ui.notify(`relay ${shortRelayLabel(targetUrl)} failed (HTTP ${res.status}) — rolled to next relay`, "warning");
					}
				}
				continue;
			}

			markRelaySuccess(targetUrl, Date.now() - attemptStart);

			// SUCCESS or non-retriable client error (e.g. 200, 404):
			// If we switched to a different relay because previous failed, update sticky active relay!
			//
			// Exception: a winner that is the caller's preferred (affinity) relay
			// was reached on the first attempt, so the sticky primary never failed
			// a roll and must not be rewritten. Without this, two conversations
			// pinned to different issuers would flip the machine-wide primary on
			// every turn, churning the state file and re-shuffling every other
			// session's candidate order.
			const affinityServed =
				Boolean(affinity.preferred) &&
				targetUrl.trim() === (affinity.preferred ?? "").trim();
			if (relayState.url !== targetUrl && !affinityServed) {
				log("info", `active relay auto-switched to ${targetUrl}`, {
					previous: relayState.url,
				}, rid);
				// CAS: re-apply the sticky-active switch to the freshest disk state at
				// write time so a concurrent session's pool edit is never clobbered.
				withRelayState((s) => {
					s.url = targetUrl;
					return s;
				});
			}

			log("info", `relay ${targetUrl} succeeded (HTTP ${res.status} in ${elapsed}s)`, undefined, rid);
			if (isDebugEnabled()) {
				log("debug", "relay headers", {
					status: res.status,
					contentType: res.headers.get("content-type"),
					via: res.headers.get("via") || res.headers.get("x-vercel-id") || "direct",
				}, rid);
			}

			updateRelayStatusUi(targetUrl);
			affinity.onServed?.(targetUrl);
			return res;
		} catch (err) {
			// Client abort: do not mark the relay failed — the client cancelled the
			// request, the relay itself is not at fault. Propagate immediately.
			if ((err as Error)?.name === "AbortError") {
				throw err;
			}
			const elapsed = ((Date.now() - attemptStart) / 1000).toFixed(1);
			lastError = err;
			const errMsg = (err as Error)?.message || String(err);
			markRelayFailure(targetUrl, 0, errMsg);
			log(
				"warn",
				`relay ${targetUrl} fetch error in ${elapsed}s — rolling to next relay`,
				{ upstream: url, error: errMsg },
				rid,
			);
			continue;
		}
	}

	// Full fallback: attempt direct fetch to upstream
	const directStart = Date.now();
	try {
		log("warn", "relays bypassed/exhausted — attempting direct fetch to upstream", {
			upstream: url,
			sizeKB: bodySizeKB,
		}, rid);

		const directHeaders = new Headers(opts.headers);
		directHeaders.delete("x-relay-target");
		directHeaders.delete("x-relay-path");
		directHeaders.set("host", u.host);
		directHeaders.set("x-request-id", rid);

		const directRes = await fetch(url, { ...opts, headers: directHeaders } as unknown as RequestInit);
		// lastResponse holds an unread body that would otherwise leak its socket
		// until GC; the salvage path below still needs it, so only cancel here.
		lastResponse?.body?.cancel().catch(() => {});
		affinity.onServed?.(null);
		return directRes;
	} catch (directErr) {
		const directElapsed = ((Date.now() - directStart) / 1000).toFixed(1);
		log("error", `direct fallback also failed in ${directElapsed}s`, {
			upstream: url,
			error: String(directErr),
		}, rid);
		if (lastResponse) {
			// Salvaged relay response: report the relay that produced it so the
			// caller keeps accurate affinity.
			affinity.onServed?.(lastResponseRelay);
			return lastResponse;
		}
		throw directErr || lastError;
	}
}
