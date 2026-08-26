/**
 * Single-port local HTTP proxy and dynamic upstream router for pi-freeflow
 *
 * Provides loopback proxying on port 18080 (shared across parent and subagents),
 * intelligent routing to OpenCode Zen and KiloCode Gateway, and failover support.
 */

import { randomUUID } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getAliveCatalog } from "./catalog.ts";
import {
	ALLOWED_METHODS,
	ALLOWED_PATH_PATTERN,
	HOST,
	KILO_CHAT_URL,
	PATH_TRAVERSAL_PATTERN,
	PORT,
	STRIP_HEADERS,
	UPSTREAM_OPENCODE,
	opencodeHeaders,
} from "./config.ts";
import { isDebugEnabled, log } from "./logger.ts";
import { KILO_MODEL_IDS, resolveCanonicalModelId } from "./models.ts";
// normalize removed — host pi-ai already normalizes thinking/reasoning before proxy
import { checkRateLimit } from "./rate-limiter.ts";
import { relayFetch } from "./relay.ts";
import { getActiveRelayState } from "./relay-state.ts";
import { pipeUpstreamStream } from "./stream-pipe.ts";
import type { Upstream } from "./types.ts";

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
 * Sanitize and inject standard headers before forwarding request to upstream.
 */
export function sanitizeHeaders(
	incoming: http.IncomingHttpHeaders,
	targetHost: string,
): Record<string, string> {
	const sanitized: Record<string, string> = {};
	for (const [key, value] of Object.entries(incoming)) {
		const lower = key.toLowerCase();
		if (STRIP_HEADERS.has(lower) || lower.startsWith(":")) continue;
		if (typeof value === "string") sanitized[lower] = value;
		else if (Array.isArray(value)) sanitized[lower] = value.join(", ");
	}
	sanitized.host = targetHost;
	// Drop the client's own user-agent so opencodeHeaders() cannot produce a
	// duplicate (case-differing) User-Agent pair — upstream resets connections
	// that send two conflicting User-Agent headers.
	delete sanitized["user-agent"];
	Object.assign(sanitized, opencodeHeaders());
	sanitized["accept-encoding"] = "identity";
	sanitized.connection = "keep-alive";
	return sanitized;
}

/**
 * Clamps reasoning_effort for upstream models with strict non-standard enums
 * (e.g. OpenCode x-preview strictly requires 'low', 'high', or 'max' and rejects 'medium' with 400).
 */
function sanitizeReasoningForModel(bodyObj: Record<string, unknown>): void {
	const model = String(bodyObj.model || "").toLowerCase();
	if (model.includes("x-preview")) {
		const effort = String(bodyObj.reasoning_effort || "").toLowerCase();
		if (effort === "medium") {
			bodyObj.reasoning_effort = "high";
		} else if (effort === "minimal") {
			bodyObj.reasoning_effort = "low";
		} else if (!effort || effort === "off" || effort === "none") {
			bodyObj.reasoning_effort = "low";
		}
	}
}
/**
 * Probe whether an existing pi-freeflow proxy daemon is running and responsive on a given port.
 */
export async function isProxyAlive(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://${HOST}:${port}/v1/models`, {
			signal: AbortSignal.timeout(500),
		});
		const ct = res.headers.get("content-type") || "";
		return res.ok && ct.includes("application/json");
	} catch {
		return false;
	}
}

/**
 * Start the local HTTP proxy daemon.
 *
 * Implements master/worker single-port reuse: if port 18080 is already held by a live
 * parent or sibling OMP session, resolves immediately with { server: null, port: 18080 }.
 */
export function startProxy(
	overridePort?: number,
): Promise<{ server: http.Server | null; port: number }> {
	const basePort = overridePort ?? PORT;

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
			res.writeHead(204, {
				"access-control-allow-origin": "*",
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"access-control-max-age": "86400",
			});
			res.end();
			return;
		}

		// Serve ONLY our registered free models. Never forward /v1/models to upstream
		// to prevent paid/proprietary upstream models from leaking into the model picker.
		// Use pathname check so /v1/models?query variants are also guarded (no leak).
		let reqPathname: string | null = null;
		try {
			reqPathname = new URL(req.url ?? "/", `http://${HOST}`).pathname;
		} catch {}
		if (req.method === "GET" && (reqPathname === "/v1/models" || reqPathname === "/v1/models/")) {
			const alive = getAliveCatalog();
			const body = JSON.stringify({
				object: "list",
				data: alive.map((m) => ({
					id: m.id,
					object: "model",
					created: 0,
					owned_by: m.source === "kilo" ? "kilocode" : "opencode",
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
			res.writeHead(403, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "forbidden" }));
			return;
		}

		// Buffer request body to inspect model ID for upstream routing
		const bodyChunks: Buffer[] = [];
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

		req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));

		req.on("end", async () => {
			const bodyStr = Buffer.concat(bodyChunks).toString();
			let isKilo = false;
			let parsedBody: Record<string, unknown> | null = null;

			try {
				parsedBody = JSON.parse(bodyStr);
				if (typeof parsedBody?.model === "string") {
					const canonical = resolveCanonicalModelId(parsedBody.model);
					parsedBody.model = canonical;
					if (KILO_MODEL_IDS.has(canonical)) {
						isKilo = true;
					}
				}
			} catch {}

			const upstream: Upstream = isKilo ? "kilo" : "opencode";
			const isStream = parsedBody?.stream === true;

			// Seamless sub-agent rate-limit: when relay pool is active, bypass
			// local per-IP quota (127.0.0.1 shared by all subagents) — upstream
			// quota is per-egress-IP and relayFetch already rolls on 429 across
			// 7 candidates until a response succeeds. Without this, parallel
			// subagents sharing the daemon would hit local 429 before relay failover.
			const relayPreview = getActiveRelayState();
			const willUseRelay = relayPreview.enabled && Boolean(relayPreview.url || relayPreview.relays.length > 0);
			if (!willUseRelay && !checkRateLimit(clientIP, upstream)) {
				res.writeHead(429, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "rate limit exceeded" }));
				return;
			}

			try {
				if (isKilo && parsedBody) {
					const kiloBodyObj = structuredClone(parsedBody);
					const response = await relayFetch(
						KILO_CHAT_URL,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Authorization: "Bearer kilo-free",
							},
							body: JSON.stringify(kiloBodyObj),
							signal: AbortSignal.timeout(300_000),
						},
						reqId,
					);

					if (isStream && response.ok && response.body) {
						const ct =
							response.headers.get("content-type") || "text/event-stream";
						res.writeHead(response.status, {
							"content-type": ct,
							"cache-control": "no-cache, no-transform",
							connection: "keep-alive",
							"x-accel-buffering": "no",
						});
						// Kilo is fetched directly (not via the relay pool), so pass undefined:
						// attributing kilo-side stream failures to an unrelated opencode relay
						// would mark a healthy relay as failed.
						pipeUpstreamStream(
							Readable.fromWeb(
								response.body as unknown as WebReadableStream,
							),
							res,
							req,
							reqId,
							undefined,
						);
					} else {
						const data = await response.text();
						const ct =
							response.headers.get("content-type") || "application/json";
						res.writeHead(response.status, { "content-type": ct });
						res.end(data);
					}
				} else {
					// OpenCode routing — relay when enabled, else direct upstream
					const relayState = getActiveRelayState();
					const shouldUseRelay =
						relayState.mode !== "off" &&
						relayState.enabled !== false &&
						Boolean(relayState.url || (relayState.relays && relayState.relays.length > 0));
					if (shouldUseRelay) {
						const fullUrl = `${UPSTREAM_OPENCODE}${req.url ?? "/"}`;
						const activeHost = relayState.url
							? new URL(relayState.url).host
							: "opencode.ai";
						const relayHeaders = sanitizeHeaders(req.headers, activeHost);

						try {
							if (parsedBody) {
								const relayBodyObj = structuredClone(parsedBody);
								sanitizeReasoningForModel(relayBodyObj as Record<string, unknown>);
								const relayBody = Buffer.from(JSON.stringify(relayBodyObj));
								const response = await relayFetch(
									fullUrl,
									{
										method: req.method || "POST",
										headers: relayHeaders,
										body: relayBody,
										signal: AbortSignal.timeout(300_000),
									},
									reqId,
								);

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
									pipeUpstreamStream(
										Readable.fromWeb(
											response.body as unknown as WebReadableStream,
										),
										res,
										req,
										reqId,
										relayState.url,
									);
								} else {
									const data = await response.text();
									const ct =
										response.headers.get("content-type") ||
										"application/json";
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
						}
					}

					// Direct path — with debug trace and thinking-aware normalization
					let directBody = Buffer.concat(bodyChunks);
					if (parsedBody) {
						const directBodyObj = structuredClone(parsedBody);
						sanitizeReasoningForModel(directBodyObj as Record<string, unknown>);
						directBody = Buffer.from(JSON.stringify(directBodyObj));
					}

					if (isDebugEnabled()) {
						log(
							"debug",
							`direct upstream ${target.hostname}${target.pathname} (${directBody.length}B)`,
							{ model: parsedBody?.model, isKilo },
							reqId,
						);
					}

					const fwd = sanitizeHeaders(req.headers, target.hostname);
					if (directBody.length > 0) {
						fwd["content-length"] = String(directBody.byteLength);
					}

					const proxy = https.request(
						{
							method: req.method,
							hostname: target.hostname,
							port: 443,
							path: target.pathname + target.search,
							headers: fwd,
						},
						(upstream) => {
							const outHeaders: Record<string, string> = {};
							for (const h of [
								"content-type",
								"cache-control",
								"x-request-id",
							]) {
								const val = upstream.headers[h];
								if (typeof val === "string") outHeaders[h] = val;
							}
							outHeaders["x-content-type-options"] = "nosniff";
							res.writeHead(upstream.statusCode ?? 502, outHeaders);
							if (isStream) {
								pipeUpstreamStream(upstream, res, req, reqId, "direct");
							} else {
								upstream.on("error", (streamErr) => {
									log(
										"error",
										"upstream stream error in direct proxy",
										{ error: String(streamErr) },
										reqId,
									);
									if (!res.writableEnded) res.end();
								});
								upstream.pipe(res);
							}
						},
					);

					proxy.on("error", (proxyErr) => {
						log(
							"error",
							"proxy socket error",
							{ error: String(proxyErr) },
							reqId,
						);
						if (!res.headersSent) {
							res.writeHead(502, { "content-type": "application/json" });
							res.end(JSON.stringify({ error: "upstream error" }));
						} else if (!res.writableEnded) {
							res.end();
						}
					});

					proxy.setTimeout(300_000, () => {
						proxy.destroy(new Error("timeout"));
					});

					// Premature client disconnect guard.
					// Node >= 19 emits req 'close' right after the request body 'end',
					// so destroying on req close/aborted kills every healthy upstream
					// socket milliseconds after creation. Only tear down when the
					// client response connection actually drops mid-flight.
					const destroyIfClientGone = () => {
						if (!res.writableEnded && !proxy.destroyed) proxy.destroy();
					};
					req.on("error", destroyIfClientGone);
					res.on("close", destroyIfClientGone);

					proxy.end(directBody);
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
				server.once("error", async (err: NodeJS.ErrnoException) => {
					if (settled) return;
					if (err.code === "EADDRINUSE") {
						// Re-check if the base port is alive (attached master race)
						if (await isProxyAlive(basePort)) {
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
					const addr = server.address();
					const realPort = addr && typeof addr === "object" ? addr.port : port;
					log("info", `proxy listening on http://${HOST}:${realPort}`);
					resolve({ server, port: realPort });
				});
			};

			tryListen(basePort);
		},
	);
}
