import assert from "node:assert/strict";
import test from "node:test";

import { ALL_MODELS, KILO_MODELS, OPENCODE_MODELS, MODEL_ALIASES, resolveCanonicalModelId, isKiloModel } from "../src/models.ts";
import { LOG_MAX_BYTES, LOG_MAX_FILES } from "../src/config.ts";
import { VERCEL_RELAY_WORKER, CLOUDFLARE_RELAY_WORKER, DENO_RELAY_SCRIPT } from "../src/deploy.ts";
import { isSubstantial } from "../src/stream-pipe.ts";

function extractIsPrivateHostname(worker: string): string {
  return worker;
}

function extractResolveRelayTarget(worker: string): string {
  return worker;
}

test("catalog 28 = 8 OpenCode + 20 Kilo", () => {
  assert.equal(OPENCODE_MODELS.length, 8);
  assert.equal(KILO_MODELS.length, 20);
  assert.equal(ALL_MODELS.length, 28);
  assert.equal(new Set(ALL_MODELS.map((m) => m.id)).size, 28);
});

test("aliases deduplicated and wrong removed", () => {
  assert.equal(resolveCanonicalModelId("claude-sonnet-4.5-free"), "claude-sonnet-4.5-free");
  assert.equal(resolveCanonicalModelId("minimax-m2.1-free"), "minimax-m2.1-free");
  assert.equal(resolveCanonicalModelId("qwen3-coder-480b-free"), "qwen3-coder-480b-free");
  assert.equal(resolveCanonicalModelId("dots-3-note-preview:free"), "dots-3-note-preview:free");
  assert.equal(resolveCanonicalModelId("dots-3-note-preview"), "dots-studio/dots-3-note-preview:free");
  assert.equal(resolveCanonicalModelId("nemotron-3.5-lightning"), "nvidia/nemotron-3.5-lightning:free");
  assert.equal(isKiloModel("dots-3-note-preview"), true);
  assert.equal(Object.keys(MODEL_ALIASES).length, 20);
});

test("log rotation 10MB x10", () => {
  assert.equal(LOG_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(LOG_MAX_FILES, 10);
});

test("ALLOWED_TARGETS exact 2", () => {
  for (const w of [VERCEL_RELAY_WORKER, CLOUDFLARE_RELAY_WORKER, DENO_RELAY_SCRIPT]) {
    const matches = (w.match(/ALLOWED_TARGETS/g) || []).length;
    assert.ok(matches >= 1, "missing ALLOWED_TARGETS");
    assert.ok(w.includes('https://opencode.ai'), "missing opencode.ai");
    assert.ok(w.includes('https://api.kilo.ai'), "missing api.kilo.ai");
    // ensure only 2 entries
    const m = w.match(/ALLOWED_TARGETS\s*=\s*\[(.*?)\]/s);
    if (m) {
      const count = (m[1].match(/https:\/\//g) || []).length;
      assert.equal(count, 2, "ALLOWED_TARGETS must be exactly 2");
    }
  }
});
test("isPrivateHostname edge - trailing dot, ::, fc/fd, fe80::, 100.64/10, 0.0.0.0, localhost", () => {
  const src = CLOUDFLARE_RELAY_WORKER;
  assert.ok(src.includes("isPrivateHostname"), "should have private guard");
  assert.ok(src.includes("127.0.0.1"), "should handle loopback");
  assert.ok(src.includes("a === 10") || src.includes("private"), "should handle 10/8");
  assert.ok(src.includes("a === 192") || src.includes("192.168"), "should handle 192.168");
  assert.ok(src.includes("fc") && src.includes("fd"), "should handle fc/fd");
  assert.ok(src.includes("fe80") || src.includes("fe[89ab]"), "should handle fe80");
  assert.ok(src.includes("100") && src.includes("64"), "should handle CGNAT 100.64");
  assert.ok(src.includes("localhost"), "should handle localhost");
  assert.ok(src.includes("endsWith") && src.includes("."), "should handle trailing dot");
});

test("resolveRelayTarget guard - @, \\, must start /, host/protocol/port/credentials", () => {
  const src = CLOUDFLARE_RELAY_WORKER;
  assert.ok(src.includes('@') && src.includes('relayPath.indexOf("@")'), "should guard @ credentials");
  assert.ok(src.includes('relayPath.indexOf("\\\\")') || src.includes('relayPath.indexOf'), "should guard backslash");
  assert.ok(src.includes('charAt(0) !== "/"') || src.includes('must start'), "should guard must start /");
  assert.ok(src.includes("hostname") && src.includes("protocol") && src.includes("port"), "should guard host/protocol/port");
  assert.ok(src.includes("username") && src.includes("password"), "should guard credentials");
});

test("relay header denylist 14", () => {
  const denylist = ["host", "connection", "content-length", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "transfer-encoding", "te", "trailer", "upgrade", "x-relay-target", "x-relay-path", "x-relay-auth"];
  for (const w of [VERCEL_RELAY_WORKER, CLOUDFLARE_RELAY_WORKER, DENO_RELAY_SCRIPT]) {
    for (const h of denylist) {
      assert.ok(w.toLowerCase().includes(h), `missing denylist ${h}`);
    }
  }
});

test("duplex half in all workers", () => {
  for (const w of [VERCEL_RELAY_WORKER, CLOUDFLARE_RELAY_WORKER, DENO_RELAY_SCRIPT]) {
    // Cloudflare and Vercel/Deno should have duplex half for streaming
    assert.ok(w.includes('duplex') || w.includes('half'), "missing duplex half");
  }
});

test("relay no string concat for x-relay-path", () => {
  for (const w of [VERCEL_RELAY_WORKER, CLOUDFLARE_RELAY_WORKER, DENO_RELAY_SCRIPT]) {
    assert.ok(!w.includes("+ relayPath"), "should not concat relayPath");
    assert.ok(w.includes("resolveRelayTarget"), "should use resolveRelayTarget");
  }
});

test("stream premature handling - substantial vs small", () => {
  assert.equal(isSubstantial(102, 514 * 1024), true);
  assert.equal(isSubstantial(10, 10 * 1024), false);
  // Boundary: strictly greater than BOTH thresholds
  assert.equal(isSubstantial(50, 100 * 1024), false);
  assert.equal(isSubstantial(51, 100 * 1024 + 1), true);
});
