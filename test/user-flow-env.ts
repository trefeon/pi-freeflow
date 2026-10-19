/**
 * User-flow test environment bootstrap (side-effect module).
 *
 * MUST be imported as the FIRST import of any suite that boots the real
 * extension (user-flow, onboarding, lifecycle, e2e-new-user). It derives the
 * proxy-port env key, the unsafe-relay env key, and the log-level env key from
 * src/config.ts / src/logger.ts source (never retyping redacted identifiers)
 * and sets them BEFORE src/config.ts is evaluated, so the extension's initial
 * proxy binds a dedicated test port instead of probing/reusing a possibly
 * running real daemon on 28180, and http loopback relays are accepted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configSrc = fs.readFileSync(path.join(rootDir, "src", "config.ts"), "utf8");
const loggerSrc = fs.readFileSync(path.join(rootDir, "src", "logger.ts"), "utf8");

// Proxy port env key (dot-access: `process.env.<KEY>_PORT`).
const portMatch = /process\.env\.([A-Z0-9_]+)_PORT/.exec(configSrc);
if (!portMatch) throw new Error("src/config.ts must read a *_PORT env var");

// Unsafe-relay env key is a quoted constant value (`ALLOW_UNSAFE_RELAY_ENV = "…"`).
const unsafeMatch = /ALLOW_UNSAFE_RELAY_ENV\s*=\s*"([^"]+)"/.exec(configSrc);
if (!unsafeMatch) throw new Error("src/config.ts must define ALLOW_UNSAFE_RELAY_ENV const");

// Log level env key (dot-access: `process.env.<KEY>_LOG_LEVEL`); forced to debug
// so the proxy's direct path still emits a per-request log line in tests.
const logLevelMatch = /process\.env\.([A-Z0-9_]+)_LOG_LEVEL/.exec(loggerSrc);
if (!logLevelMatch) throw new Error("src/logger.ts must read a *_LOG_LEVEL env var");

/** Alternate test port — never 28180, so a real daemon is not reused. */
export const TEST_PROXY_PORT = 29751;

// Disable detached-daemon spawn in tests — they use spawnFakeDaemon or in-process servers.
const dataDirMatch = /DATA_DIR_ENV\s*=\s*"([^"]+)"/.exec(configSrc);
if (!dataDirMatch) throw new Error("src/config.ts must define DATA_DIR_ENV");
process.env[dataDirMatch[1].replace("_DATA_DIR", "_DAEMON_SPAWN")] = "0";

// Re-route the proxy port, relax relay URL validation (http loopback relays),
// and enable debug logging so proxy requests are recorded in the sandbox log.
process.env[portMatch[1] + "_PORT"] = String(TEST_PROXY_PORT);
process.env[unsafeMatch[1]] = "1";
process.env[logLevelMatch[1] + "_LOG_LEVEL"] = "debug";

// Package version — read here (not imported) so this module stays free of any
// src/ static import that would evaluate src/config.ts before the env above.
// The sandbox daemon probe must answer with the exact version the extension
// pins, else the client treats it as a stale daemon and kills the port holder.
const pkgVersion = ((): string => {
 try {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  if (raw && typeof raw === "object" && "version" in raw) {
   const v = raw.version;
   if (typeof v === "string" && v) return v;
  }
 } catch { }
 return "0.0.0";
})();

const SANDBOX_DAEMON_PREFIX = `http://127.0.0.1:${TEST_PROXY_PORT}`;

const jsonResponse = (body: unknown): Response =>
 new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
 });

/**
 * URL-aware fetch stub for suites that boot the real extension — the same
 * shape test/host-compat.test.ts installs. The sandbox daemon port answers as
 * a live daemon (the unauthenticated GET /health identity shape plus the
 * token-gated /v1/models and /_health routes), so activation attaches to it
 * instead of binding an in-process fallback (which would outlive the test),
 * and the npm registry answers offline, so neither the background update
 * check nor the OpenCode UA lookup reaches the network. Loopback servers a
 * test binds itself are delegated to the real fetch.
 * Install per test: `t.mock.method(globalThis, "fetch", harnessFetchHandler())`.
 */
export function harnessFetchHandler(): typeof fetch {
 const realFetch = globalThis.fetch.bind(globalThis);
 return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url =
   typeof input === "string"
    ? input
    : input instanceof URL
     ? input.href
     : input.url;
  if (url.startsWith(SANDBOX_DAEMON_PREFIX)) {
   // Identity probe: isProxyAlive() recognises the stub daemon by service+port.
   if (url.endsWith("/health")) {
    return jsonResponse({ ok: true, service: "pi-freeflow", port: TEST_PROXY_PORT, version: pkgVersion });
   }
   if (url.endsWith("/v1/models")) return jsonResponse([]);
   if (url.endsWith("/_health")) return jsonResponse({ port: TEST_PROXY_PORT, version: pkgVersion, activeRequests: 0 });
   throw new Error("mocked offline");
  }
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) return realFetch(input, init);
  throw new Error("mocked offline");
 }) as typeof fetch;
}
