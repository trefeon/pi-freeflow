/**
 * Resilient fetch for Cline endpoints on MITM boxes.
 *
 * Node's global fetch trusts only its bundled CA list, so antivirus TLS
 * interception (Kaspersky on Windows, corporate proxies anywhere) fails with
 * `self-signed certificate in certificate chain` while browsers and curl keep
 * working off the OS store. fetchWithSystemCA tries the global fetch first
 * and, only on chain/issuer cert errors, retries the same request through
 * node:https with the OS trust bundle appended. No verification is ever
 * disabled; the fallback just trusts the same roots the OS trusts.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHAIN_ERROR_CODES: Record<string, true> = {
 "SELF_SIGNED_CERT_IN_CHAIN": true,
 "UNABLE_TO_VERIFY_LEAF_SIGNATURE": true,
 "DEPTH_ZERO_SELF_SIGNED_CERT": true,
 "UNABLE_TO_GET_ISSUER_CERT": true,
 "UNABLE_TO_GET_ISSUER_CERT_LOCALLY": true,
};

function errorCode(value: unknown): string | undefined {
 if (value && typeof value === "object" && "code" in value) {
  const code = value.code;
  return typeof code === "string" ? code : undefined;
 }
 return undefined;
}

function errorCause(value: unknown): unknown {
 if (value && typeof value === "object" && "cause" in value) return value.cause;
 return undefined;
}

/** True when the failure is an OS-trust gap, not a real endpoint problem. */
export function isCertError(e: unknown): boolean {
 let cur: unknown = e;
 for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
  const code = errorCode(cur);
  if (code !== undefined && CHAIN_ERROR_CODES[code]) return true;
  cur = errorCause(cur);
 }
 const msg = e instanceof Error ? e.message : String(e ?? "");
 return /self[-\s]?signed certificate|unable to verify/i.test(msg);
}

const BUNDLE_CACHE = path.join(os.tmpdir(), "pi-freeflow-system-ca.pem");
const BUNDLE_TTL_MS = 24 * 60 * 60 * 1000;

function readPemFile(p: string): string[] {
 try {
  const raw = fs.readFileSync(p, "utf8");
  const blocks = raw.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g);
  return blocks ?? [];
 } catch {
  return [];
 }
}

function nodeExtraCa(): string[] {
 const p = (process.env.NODE_EXTRA_CA_CERTS || "").trim();
 return p ? readPemFile(p) : [];
}

function linuxBundle(): string[] {
 const candidates = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
 ];
 for (const p of candidates) {
  const blocks = readPemFile(p);
  if (blocks.length > 0) return blocks;
 }
 return [];
}

// Cert: drive is unavailable in some hosts; X509Store works everywhere.
const EXPORT_PS1 = [
 "$stores = @(",
 " [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine'),",
 " [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')",
 ")",
 "$pem = foreach ($s in $stores) {",
 " $s.Open('ReadOnly')",
 " foreach ($c in $s.Certificates) {",
 "  $b64 = [Convert]::ToBase64String($c.Export('Cert'))",
 "  '-----BEGIN CERTIFICATE-----'",
 "  for ($i = 0; $i -lt $b64.Length; $i += 64) { $b64.Substring($i, [Math]::Min(64, $b64.Length - $i)) }",
 "  '-----END CERTIFICATE-----'",
 " }",
 " $s.Close()",
 "}",
 "$pem | Out-File -FilePath $args[0] -Encoding ascii",
].join("\r\n");

function windowsBundle(): string[] {
 try {
  const stat = fs.statSync(BUNDLE_CACHE);
  if (Date.now() - stat.mtimeMs < BUNDLE_TTL_MS) {
   const cached = readPemFile(BUNDLE_CACHE);
   if (cached.length > 0) return cached;
  }
 } catch { }
 try {
  const script = `${BUNDLE_CACHE}.ps1`;
  fs.writeFileSync(script, EXPORT_PS1, "utf8");
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, BUNDLE_CACHE], {
   timeout: 30_000,
   windowsHide: true,
  });
  return readPemFile(BUNDLE_CACHE);
 } catch {
  return [];
 }
}

let systemCaCache: string[] | null = null;

/** OS trust bundle: platform store plus NODE_EXTRA_CA_CERTS when set. */
export function systemCaBundle(): string[] {
 if (systemCaCache) return systemCaCache;
 const extra = nodeExtraCa();
 const platform = process.platform === "win32" ? windowsBundle() : linuxBundle();
 const seen = new Set<string>();
 systemCaCache = [...extra, ...platform].filter((b) => {
  if (seen.has(b)) return false;
  seen.add(b);
  return true;
 });
 return systemCaCache;
}

/** Test-only: drop the cached bundle so tests re-read the platform store. */
export function _resetSystemCaCacheForTest(): void {
 systemCaCache = null;
}

function toNodeHeaders(headers: HeadersInit | undefined): Record<string, string> {
 const out: Record<string, string> = {};
 if (!headers) return out;
 if (headers instanceof Headers) {
  headers.forEach((v, k) => { out[k] = v; });
 } else if (Array.isArray(headers)) {
  for (const [k, v] of headers) out[k] = v;
 } else {
  for (const [k, v] of Object.entries(headers)) out[k] = v;
 }
 return out;
}

function toNodeBody(body: BodyInit | undefined): string | undefined {
 if (body === undefined || body === null) return undefined;
 if (typeof body === "string") return body;
 if (body instanceof URLSearchParams) return body.toString();
 if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
 if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
 throw new Error("fetchWithSystemCA fallback supports string/form bodies only");
}

/**
 * Same request through node:https with the OS trust bundle. Only used after
 * the global fetch already failed with a cert error, so behavior on healthy
 * machines is byte-identical to today.
 */
export function requestViaNodeHttp(input: string, init?: RequestInit): Promise<Response> {
 const { promise, resolve, reject } = Promise.withResolvers<Response>();
 const url = new URL(input);
 const sender = url.protocol === "https:" ? httpsRequest : httpRequest;
 let body: string | undefined;
 try {
  body = toNodeBody(init?.body as BodyInit | undefined);
 } catch (e) {
  reject(e);
  return promise;
 }
 const headers = toNodeHeaders(init?.headers as HeadersInit | undefined);
 if (body !== undefined && !headers["content-length"] && !headers["Content-Length"]) {
  headers["content-length"] = String(Buffer.byteLength(body));
 }
 // undici's AbortSignal vs node:http's: structurally identical, and the
 // runtime accepts it — named const carries the one-line reason.
 const nodeSignal = init?.signal as never;
 const bundle = systemCaBundle();
 const req = sender(url, {
  method: init?.method ?? "GET",
  headers,
  ca: bundle.length > 0 ? bundle : undefined,
  signal: nodeSignal,
 }, (res) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => {
   const outHeaders = new Headers();
   for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) { for (const item of v) outHeaders.append(k, item); }
    else if (v !== undefined) outHeaders.set(k, v);
   }
   resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, headers: outHeaders }));
  });
 });
 req.on("error", reject);
 if (init?.signal && typeof (init.signal as AbortSignal).addEventListener === "function") {
  const s = init.signal as AbortSignal;
  if (s.aborted) req.destroy(new Error("fetchWithSystemCA fallback aborted"));
  else s.addEventListener("abort", () => req.destroy(new Error("fetchWithSystemCA fallback aborted")), { once: true });
 }
 if (body !== undefined) req.write(body);
 req.end();
 return promise;
}

/**
 * Drop-in fetch replacement for Cline endpoints: global fetch first, OS-trust
 * retry only on chain/issuer cert failures. Every other error passes through
 * untouched, so healthy machines see zero behavior change.
 */
export async function fetchWithSystemCA(input: string, init?: RequestInit): Promise<Response> {
 try {
  return await fetch(input, init);
 } catch (e) {
  if (!isCertError(e)) throw e;
  try {
   return await requestViaNodeHttp(input, init);
  } catch {
   throw e;
  }
 }
}
