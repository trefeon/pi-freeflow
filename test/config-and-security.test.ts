/**
 * Unit tests for configuration security and zero hardcoded credentials
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
 ALLOWED_METHODS,
 ALLOWED_PATH_PATTERN,
 DEFAULT_PORT,
 LEGACY_PORT,
 OPENCODE_USER_AGENT,
 OPENCODE_USER_AGENT_ENV,
 OPENCODE_VERSION_CACHE_ENV,
 OPENCODE_VERSION_FALLBACK,
 OPENCODE_VERSION_FLOOR,
 PATH_TRAVERSAL_PATTERN,
 STRIP_HEADERS,
 _resetLiveOpenCodeVersionForTest,
 createOpenCodeId,
 createOpenCodeRequestId,
 createOpenCodeSessionId,
 getOpenCodeUserAgent,
 isSupportedOpenCodeVersion,
 opencodeHeaders,
 refreshOpenCodeUserAgent,
 resolvePort,
 toOpenCodeUserAgent,
} from "../src/config.ts";
import { sanitizeHeaders } from "../src/proxy.ts";

test("security whitelists allow only standard safe API paths", () => {
 assert.ok(ALLOWED_PATH_PATTERN.test("/v1/chat/completions"));
 assert.ok(ALLOWED_PATH_PATTERN.test("/v1/models"));
 assert.ok(ALLOWED_PATH_PATTERN.test("/v1/responses"));

 assert.equal(ALLOWED_PATH_PATTERN.test("/v2/secret"), false);
 assert.equal(ALLOWED_PATH_PATTERN.test("/admin"), false);
});

test("path traversal pattern catches dot-dot sequences", () => {
 assert.ok(PATH_TRAVERSAL_PATTERN.test("../etc/passwd"));
 assert.ok(PATH_TRAVERSAL_PATTERN.test("/v1/.."));
 assert.equal(PATH_TRAVERSAL_PATTERN.test("/v1/models"), false);
});

test("forbidden headers are stripped", () => {
 assert.ok(STRIP_HEADERS.has("authorization"));
 assert.ok(STRIP_HEADERS.has("cookie"));
 assert.ok(STRIP_HEADERS.has("x-real-ip"));
 assert.ok(STRIP_HEADERS.has("x-forwarded-for"));
});

test("zero hardcoded API keys exist in source tree", () => {
 const srcDir = path.join(import.meta.dirname, "..", "src");
 const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
 const lines: Array<{ file: string; line: string; num: number }> = [];
 for (const f of files) {
  const content = fs.readFileSync(path.join(srcDir, f), "utf8");
  content
   .split(/\r?\n/)
   .forEach((l, i) => lines.push({ file: f, line: l, num: i + 1 }));
 }

 // No assignment of a non-trivial literal to an api-key-like name.
 // The literal "placeholder" (buildProviderConfig's OMP registration
 // sentinel) is exempt — it is a marker, not a credential.
 for (const { file, line, num } of lines) {
  const match = /api[_-]?key\s*[=:]\s*["']([^"']{6,})["']/i.exec(line);
  if (!match || match[1] === "placeholder" || match[1] === "public") continue;
  assert.fail(`${file}:${num} must not hardcode an API key literal`);
 }

 // Every Bearer credential line must be a `${token}` interpolation of a
 // credential supplied at call time — nothing else may hardcode a secret.
 // (Kilo and Zen are keyless: no Authorization header is sent for either.)
 const bearerLines = lines.filter(({ line }) => /Bearer /.test(line));
 assert.ok(bearerLines.length > 0, "expected Bearer credential lines in src");
 for (const { file, line, num } of bearerLines) {
  assert.ok(
   line.includes("kilo-free") || line.includes("${token}"),
   `${file}:${num} hardcodes an unexpected Bearer credential`,
  );
 }
});

test("sanitizeHeaders never emits duplicate User-Agent headers", () => {
 const incoming = {
  host: "127.0.0.1:28180",
  "user-agent": "node",
  "content-type": "application/json",
 };
 const fwd = sanitizeHeaders(incoming, "opencode.ai");
 const uaKeys = Object.keys(fwd).filter((k) => k.toLowerCase() === "user-agent");
 assert.equal(uaKeys.length, 1);
 assert.equal(fwd[uaKeys[0]], OPENCODE_USER_AGENT);
});

test("resolvePort honors the source-derived env override and falls back to default 28180", () => {
 // Derive the env key from source instead of hardcoding it
 const configSrc = fs.readFileSync(
  path.join(import.meta.dirname, "..", "src", "config.ts"),
  "utf8",
 );
 const match = /process\.env\.([A-Z0-9_]+)_PORT/.exec(configSrc);
 assert.ok(match, "src/config.ts must read a *_PORT env var");
 const actualKey = match![1] + "_PORT";

 const original = process.env[actualKey];
 delete process.env[actualKey];
 try {
  assert.equal(resolvePort(), 28180, "default port without env override");
  process.env[actualKey] = "3001";
  assert.equal(resolvePort(), 3001, "env override wins");
 } finally {
  if (original !== undefined) {
   process.env[actualKey] = original;
  } else {
   delete process.env[actualKey];
  }
 }
});

test("LEGACY_PORT is defined as 18080 for backward compatibility", () => {
 assert.equal(LEGACY_PORT, 18080);
 assert.equal(DEFAULT_PORT, 28180);
});

test("OpenCode session and request IDs match required OpenCode schema", () => {
 const ses = createOpenCodeSessionId();
 assert.ok(ses.startsWith("ses_"), "session ID must start with ses_ prefix");
 assert.equal(ses.length, 30, "session ID must be ses_ prefix + 26 char identifier");

 const msg = createOpenCodeRequestId();
 assert.ok(msg.startsWith("msg_"), "request ID must start with msg_ prefix");
 assert.equal(msg.length, 30, "request ID must be msg_ prefix + 26 char identifier");

 const headers = opencodeHeaders();
 assert.equal(headers["User-Agent"], OPENCODE_USER_AGENT);
 assert.equal(headers["x-opencode-client"], "cli");
 assert.ok(typeof headers["x-opencode-project"] === "string" && headers["x-opencode-project"].length > 0);
 assert.ok(headers["x-opencode-session"].startsWith("ses_"));
 assert.ok(headers["x-opencode-request"].startsWith("msg_"));
});

test("OpenCode IDs match the upstream identifier algorithm vectors", () => {
 // Upstream packages/schema/src/identifier.ts: 6 bytes BE of
 // (BigInt(timestamp) * 0x1000n + counter), bitwise-NOT when descending,
 // then 14 random base62 chars. Fixed timestamps keep the counter deterministic.
 const asc = createOpenCodeId(false, 1_000_000);
 assert.equal(asc.length, 26, "identifier is 26 chars");
 assert.equal(asc.slice(0, 12), "0000f4240001", "ascending time part is the raw timestamp encoding");
 const desc = createOpenCodeId(true, 1_000_001);
 assert.equal(desc.length, 26);
 assert.equal(desc.slice(0, 12), "ffff0bdbeffe", "descending time part is the inverted encoding");
 for (const id of [asc, desc]) {
  assert.ok(/^[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id), `identifier shape: ${id}`);
 }
 // Ascending IDs decode back to the timestamp (upstream timestamp() helper).
 const decoded = Number(BigInt("0x" + asc.slice(0, 12)) / 0x1000n);
 assert.equal(decoded, 1_000_000, "ascending time part decodes to the timestamp");
 // Same-millisecond calls stay unique via the counter.
 const first = createOpenCodeId(false, 5_000_000);
 const second = createOpenCodeId(false, 5_000_000);
 assert.notEqual(first, second, "counter keeps same-millisecond IDs unique");
 assert.equal(first.slice(0, 12), "0004c4b40001");
 assert.equal(second.slice(0, 12), "0004c4b40002");
 assert.equal(Number(BigInt("0x" + second.slice(0, 12)) / 0x1000n), 5_000_000);
});

test("OpenCode UA floor and normalization", () => {
 assert.equal(OPENCODE_VERSION_FLOOR, "1.17.0");
 assert.ok(isSupportedOpenCodeVersion("1.17.0"), "floor itself is supported");
 assert.ok(isSupportedOpenCodeVersion("1.18.31"), "pinned fallback is supported");
 assert.ok(isSupportedOpenCodeVersion("9.9.9"), "newer versions are supported");
 assert.equal(isSupportedOpenCodeVersion("1.16.9"), false, "below-floor rejected");
 assert.equal(isSupportedOpenCodeVersion("local"), false, "dev-channel marker rejected");
 assert.equal(isSupportedOpenCodeVersion(""), false);
 assert.equal(isSupportedOpenCodeVersion(undefined), false);
 assert.equal(toOpenCodeUserAgent("1.18.31"), "opencode/1.18.31");
 assert.equal(toOpenCodeUserAgent("opencode/1.18.31"), "opencode/1.18.31");
 assert.equal(toOpenCodeUserAgent("1.0.0"), null, "below-floor override ignored");
 assert.equal(toOpenCodeUserAgent("  "), null);
});

test("OpenCode UA live/fallback/override precedence (offline-safe)", async () => {
 const savedAgent = process.env[OPENCODE_USER_AGENT_ENV];
 const savedCache = process.env[OPENCODE_VERSION_CACHE_ENV];
 const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-freeflow-ua-"));
 const cacheFile = path.join(sandbox, "version.json");
 try {
  delete process.env[OPENCODE_USER_AGENT_ENV];
  process.env[OPENCODE_VERSION_CACHE_ENV] = cacheFile;
  _resetLiveOpenCodeVersionForTest();
  // No cache on disk: pinned fallback, never throws.
  assert.equal(getOpenCodeUserAgent(), `opencode/${OPENCODE_VERSION_FALLBACK}`);
  // Env override wins over everything, bare or fully qualified.
  process.env[OPENCODE_USER_AGENT_ENV] = "9.9.9";
  assert.equal(getOpenCodeUserAgent(), "opencode/9.9.9");
  process.env[OPENCODE_USER_AGENT_ENV] = "opencode/8.8.8";
  assert.equal(getOpenCodeUserAgent(), "opencode/8.8.8");
  assert.equal(await refreshOpenCodeUserAgent(), "opencode/8.8.8", "override short-circuits refresh");
  // Below-floor override is ignored.
  process.env[OPENCODE_USER_AGENT_ENV] = "1.0.0";
  assert.equal(getOpenCodeUserAgent(), `opencode/${OPENCODE_VERSION_FALLBACK}`);
  delete process.env[OPENCODE_USER_AGENT_ENV];
  // Live refresh success: sync getter serves it, disk cache persists it.
  _resetLiveOpenCodeVersionForTest();
  const stubOk = (async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 })) as typeof fetch;
  assert.equal(await refreshOpenCodeUserAgent(stubOk), "opencode/9.9.9");
  assert.equal(getOpenCodeUserAgent(), "opencode/9.9.9");
  const persisted = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { version: string };
  assert.equal(persisted.version, "9.9.9");
  // Fresh disk cache serves the sync getter after an in-process reset.
  _resetLiveOpenCodeVersionForTest();
  assert.equal(getOpenCodeUserAgent(), "opencode/9.9.9", "fresh disk cache is live-UA material");
  // Below-floor fetch never replaces the fallback.
  const stubLow = (async () => new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 })) as typeof fetch;
  _resetLiveOpenCodeVersionForTest();
  fs.rmSync(cacheFile, { force: true });
  assert.equal(await refreshOpenCodeUserAgent(stubLow), `opencode/${OPENCODE_VERSION_FALLBACK}`);
  // Offline failure keeps the pinned fallback.
  const stubDown = (async () => { throw new Error("network down"); }) as typeof fetch;
  assert.equal(await refreshOpenCodeUserAgent(stubDown), `opencode/${OPENCODE_VERSION_FALLBACK}`);
  assert.equal(getOpenCodeUserAgent(), `opencode/${OPENCODE_VERSION_FALLBACK}`);
  // Stale disk cache is ignored.
  fs.writeFileSync(cacheFile, JSON.stringify({ version: "7.7.7", checkedAt: Date.now() - 7 * 60 * 60 * 1_000 }), "utf8");
  _resetLiveOpenCodeVersionForTest();
  assert.equal(getOpenCodeUserAgent(), `opencode/${OPENCODE_VERSION_FALLBACK}`, "stale disk cache ignored");
 } finally {
  if (savedAgent === undefined) delete process.env[OPENCODE_USER_AGENT_ENV];
  else process.env[OPENCODE_USER_AGENT_ENV] = savedAgent;
  if (savedCache === undefined) delete process.env[OPENCODE_VERSION_CACHE_ENV];
  else process.env[OPENCODE_VERSION_CACHE_ENV] = savedCache;
  _resetLiveOpenCodeVersionForTest();
  fs.rmSync(sandbox, { recursive: true, force: true });
 }
});
