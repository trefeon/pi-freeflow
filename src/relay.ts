/**
 * High-resiliency multi-cloud relay client and failover dispatcher
 */

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Agent } from "undici";
import { isDebugEnabled, log } from "./logger.ts";

export const agent = new Agent({ keepAliveTimeout: 30_000 });
/**
 * Node's global fetch runs on the node-process-bundled undici. Node 22/23
 * bundle undici 6.x/7.x whose dispatcher interface rejects an npm-undici 8.x
 * Agent passed as `dispatcher` (`invalid onRequestStart method`). Only attach
 * the custom dispatcher when the bundled undici major matches (Node 25+);
 * otherwise fall back to the built-in global dispatcher, which still pools
 * keep-alive connections, so the relay proxy works on Node 22/23 too.
 */
const bundledUndiciMajor = Number((process.versions.undici ?? "0").split(".")[0]);
export const canUseCustomDispatcher = bundledUndiciMajor >= 8;
import {
	getActiveRelayState,
	getOrderedRelayUrls,
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
 * Fetch a target URL through the active relay pool with rolling failover and direct fallback.
 *
 * @param url Full upstream destination URL (e.g. https://opencode.ai/zen/v1/chat/completions)
 * @param opts Standard fetch RequestInit options
 * @param reqId Optional correlation request ID for end-to-end tracing
 */
export async function relayFetch(
	url: string,
	opts: RequestInit = {},
	reqId?: string,
): Promise<Response> {
	const rid = reqId || randomUUID().slice(0, 8);
	const relayState = getActiveRelayState();

	if (!relayState.enabled) {
		log("debug", `relayFetch: direct (relay disabled) -> ${url}`, undefined, rid);
		return fetch(url, { ...opts, ...(canUseCustomDispatcher ? { dispatcher: agent } : {}) } as unknown as RequestInit);
	}
	const candidates = getOrderedRelayUrls();

	if (candidates.length === 0) {
		// Empty pool: skip straight to upstream instead of logging a misleading
		// "relays bypassed/exhausted" WARN on every request.
		log("debug", `relayFetch: direct (empty relay pool) -> ${url}`, undefined, rid);
		return fetch(url, { ...opts, ...(canUseCustomDispatcher ? { dispatcher: agent } : {}) } as unknown as RequestInit);
	}

	let lastResponse: Response | null = null;
	let lastError: unknown = null;
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
			const res = await fetch(targetUrl, { ...opts, headers, signal, ...(canUseCustomDispatcher ? { dispatcher: agent } : {}) } as unknown as RequestInit);
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

			if (isRetriableStatus(res.status)) {
				markRelayFailure(targetUrl, res.status);
				lastResponse?.body?.cancel().catch(() => {});
				lastResponse = res;
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
			if (relayState.url !== targetUrl) {
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

		const directRes = await fetch(url, { ...opts, headers: directHeaders, ...(canUseCustomDispatcher ? { dispatcher: agent } : {}) } as unknown as RequestInit);
		// lastResponse holds an unread body that would otherwise leak its socket
		// until GC; the salvage path below still needs it, so only cancel here.
		lastResponse?.body?.cancel().catch(() => {});
		return directRes;
	} catch (directErr) {
		const directElapsed = ((Date.now() - directStart) / 1000).toFixed(1);
		log("error", `direct fallback also failed in ${directElapsed}s`, {
			upstream: url,
			error: String(directErr),
		}, rid);
		if (lastResponse) {
			return lastResponse;
		}
		throw directErr || lastError;
	}
}
