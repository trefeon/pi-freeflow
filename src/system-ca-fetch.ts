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
import { randomBytes } from "node:crypto";
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

const BUNDLE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The OS trust bundle is a trust input, so it lives in a 0700 directory only
 * this process created (mkdtemp), never at a predictable path in the shared
 * temp dir where another local user could pre-plant a bundle or race the
 * exporter script. The directory is per process: the 24h cache survives every
 * call inside a run, and the daemon is long-lived.
 */
let bundleDir: string | null = null;

function privateBundleDir(): string {
 if (bundleDir !== null) {
  try {
   if (fs.statSync(bundleDir).isDirectory()) return bundleDir;
  } catch { }
  bundleDir = null;
 }
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-freeflow-ca-"));
 try {
  fs.chmodSync(dir, 0o700);
 } catch { }
 bundleDir = dir;
 return dir;
}

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
 // Private per-process dir; the 24h cache lives inside it, so a stale or
 // planted bundle at a shared temp path can never be trusted.
 const dir = privateBundleDir();
 const bundle = path.join(dir, "system-ca.pem");
 try {
  const stat = fs.statSync(bundle);
  if (Date.now() - stat.mtimeMs < BUNDLE_TTL_MS) {
   const cached = readPemFile(bundle);
   if (cached.length > 0) return cached;
  }
 } catch { }
 // Exporter script: unique 0600 name inside the private dir, executed by
 // absolute path and deleted straight after the run — nothing predictable is
 // left for another process to swap between write and exec (TOCTOU).
 const script = path.join(dir, `export-ca-${process.pid}-${randomBytes(6).toString("hex")}.ps1`);
 try {
  fs.writeFileSync(script, EXPORT_PS1, { encoding: "utf8", mode: 0o600 });
  try {
   fs.chmodSync(script, 0o600);
  } catch { }
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, bundle], {
   timeout: 30_000,
   windowsHide: true,
  });
  try {
   fs.chmodSync(bundle, 0o600);
  } catch { }
  return readPemFile(bundle);
 } catch {
  return [];
 } finally {
  try {
   fs.unlinkSync(script);
  } catch { }
 }
}

let systemCaCache: string[] | null = null;

/** OS trust bundle: platform store plus NODE_EXTRA_CA_CERTS when set. */
function systemCaBundle(): string[] {
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

/** toNodeBody failure: the request itself is unrepresentable, not a cert problem. */
class BodyNotSupportedError extends Error {}

function toNodeBody(body: BodyInit | undefined): string | undefined {
 if (body === undefined || body === null) return undefined;
 if (typeof body === "string") return body;
 if (body instanceof URLSearchParams) return body.toString();
 if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
 if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
 throw new BodyNotSupportedError("fetchWithSystemCA fallback supports string/form bodies only");
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
  } catch (fallbackErr) {
   // An unrepresentable body is a caller bug, not a trust gap: surfacing the
   // original cert error would send the caller chasing the OS store.
   if (fallbackErr instanceof BodyNotSupportedError) throw fallbackErr;
   throw e;
  }
 }
}
