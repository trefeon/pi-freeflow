/**
 * Bun-native fetch sidecar for the Zen direct leg (opt-in, see zen-transport.ts).
 *
 * Runs under Bun so the TLS stack that originates the connection is Bun's,
 * not Node's. Framing over stdio, no ports, no temp files, no argv bodies:
 * - stdin: one JSON frame {url,method,headers,bodyB64,headerTimeoutMs}.
 * - stdout: one JSON header line {status,headers} then raw response bytes.
 * - stderr: log-only, never echoes headers or body bytes.
 * Asserts-and-strips x-relay-auth: the Zen direct leg never carries relay auth.
 */

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
let frame: Record<string, unknown>;
try {
 frame = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
} catch {
 console.error("zen-sidecar: bad stdin frame");
 process.exit(2);
}
if (typeof frame["url"] !== "string") {
 console.error("zen-sidecar: bad url");
 process.exit(2);
}
const targetUrl = frame["url"] as string;
let target: URL;
try {
 target = new URL(targetUrl);
} catch {
 console.error("zen-sidecar: bad url");
 process.exit(2);
}
// Production Zen is https-only; http is accepted solely for loopback
// offline tests (mirrors the relay ALLOW_UNSAFE_RELAY precedent). Match the
// hostname exactly: a prefix test would also accept localhost.example.com.
const httpLoopback = target.protocol === "http:" &&
 (target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "[::1]");
if (target.protocol !== "https:" && !httpLoopback) {
 console.error("zen-sidecar: bad url");
 process.exit(2);
}
if (target.username !== "" || target.password !== "") {
 console.error("zen-sidecar: bad url");
 process.exit(2);
}
const headersIn: Record<string, string> = {};
if (frame["headers"] !== null && typeof frame["headers"] === "object") {
 for (const [k, v] of Object.entries(frame["headers"] as Record<string, unknown>)) {
  if (k.toLowerCase() === "x-relay-auth") continue;
  if (typeof v === "string") headersIn[k] = v;
 }
}
const method = typeof frame["method"] === "string" && frame["method"] !== "" ? frame["method"] as string : "POST";
const body = typeof frame["bodyB64"] === "string" && (frame["bodyB64"] as string) !== ""
 ? Buffer.from(frame["bodyB64"] as string, "base64")
 : undefined;
const timeoutMs = typeof frame["headerTimeoutMs"] === "number" && (frame["headerTimeoutMs"] as number) > 0
 ? frame["headerTimeoutMs"] as number
 : 300_000;
// Optional per-leg CONNECT proxy. The TLS handshake below still runs in this
// Bun process against the real target — the proxy only carries the TCP
// connection, which is what keeps the free-tier transport fingerprint while
// the egress address changes (issue #137). Only http/https proxies are
// accepted; credentials belong in proxy headers, never the URL.
let proxyOption: { url: string; headers: Record<string, string>; respectNoProxy: false } | undefined;
const proxyFrame = frame["proxy"];
if (proxyFrame !== null && typeof proxyFrame === "object") {
 const rawProxyUrl = (proxyFrame as Record<string, unknown>)["url"];
 if (typeof rawProxyUrl !== "string") {
  console.error("zen-sidecar: bad proxy url");
  process.exit(2);
 }
 let proxyUrl: URL;
 try {
  proxyUrl = new URL(rawProxyUrl);
 } catch {
  console.error("zen-sidecar: bad proxy url");
  process.exit(2);
 }
 if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
  console.error("zen-sidecar: bad proxy scheme");
  process.exit(2);
 }
 if (proxyUrl.username !== "" || proxyUrl.password !== "") {
  console.error("zen-sidecar: proxy credentials must use headers");
  process.exit(2);
 }
 const proxyHeaders: Record<string, string> = {};
 const rawProxyHeaders = (proxyFrame as Record<string, unknown>)["headers"];
 if (rawProxyHeaders !== null && typeof rawProxyHeaders === "object") {
  for (const [k, v] of Object.entries(rawProxyHeaders as Record<string, unknown>)) {
   if (typeof v === "string") proxyHeaders[k] = v;
  }
 }
 proxyOption = { url: proxyUrl.toString(), headers: proxyHeaders, respectNoProxy: false };
}
// Header budget only: clear it once the response headers arrive so a long
// SSE body is never cut at the header deadline. The bridge owns the same
// deadline and kills this child if headers never come.
const controller = new AbortController();
const headerTimer = setTimeout(() => controller.abort(new Error("header timeout")), timeoutMs);
let res: Response;
try {
 const fetchInit: Record<string, unknown> = {
  method,
  headers: headersIn,
  body: body as unknown as BodyInit | undefined,
  signal: controller.signal,
 };
 if (proxyOption !== undefined) fetchInit["proxy"] = proxyOption;
 res = await fetch(targetUrl, fetchInit as unknown as RequestInit);
} catch (e) {
 clearTimeout(headerTimer);
 const err = e as { name?: string; code?: string; status?: number };
 // Structured failure frame on stdout: the bridge keys retries and
 // transport-capability caching off the code (ERR_PROXY_TUNNEL means the
 // relay answered but refuses to tunnel, which is not a network fault).
 process.stdout.write(`${JSON.stringify({
  error: { name: err?.name ?? "error", code: err?.code ?? "fetch-error", status: typeof err?.status === "number" ? err.status : undefined },
 })}\n`);
 console.error(`zen-sidecar: fetch failed: ${err?.name ?? "error"}`);
 process.exit(3);
}
clearTimeout(headerTimer);
const out: Record<string, string> = {};
res.headers.forEach((v, k) => { out[k] = v; });
process.stdout.write(`${JSON.stringify({ status: res.status, headers: out })}\n`);
// A closed stdout means the bridge is gone; stop quietly instead of crashing
// on EPIPE while the body is still streaming.
process.stdout.on("error", () => process.exit(0));
process.stdout.on("close", () => process.exit(0));
try {
 if (res.body) {
  for await (const c of res.body) {
   if (!process.stdout.write(c)) {
    await new Promise<void>((resolveDrain) => process.stdout.once("drain", resolveDrain));
   }
  }
 }
} catch (e) {
 console.error(`zen-sidecar: body failed: ${e instanceof Error ? e.name : "error"}`);
 process.exitCode = 4;
}
