import assert from "node:assert/strict";
import test from "node:test";

import { ALL_MODELS, KILO_MODELS, OPENCODE_MODELS, CLINE_MODELS, OVH_MODELS, MODEL_ALIASES, resolveCanonicalModelId, isKiloModel } from "../src/models.ts";
import { LOG_MAX_BYTES, LOG_MAX_FILES } from "../src/config.ts";
import { VERCEL_RELAY_WORKER, CLOUDFLARE_RELAY_WORKER, DENO_RELAY_SCRIPT } from "../src/deploy.ts";
import { isSubstantial } from "../src/stream-pipe.ts";
import { loadRelayCore } from "./_relay-core.ts";

test("catalog 35 = 11 OpenCode + 15 Kilo + 1 Cline + 8 OVH", () => {
	assert.equal(OPENCODE_MODELS.length, 11);
	assert.equal(KILO_MODELS.length, 15);
	assert.equal(CLINE_MODELS.length, 1);
	assert.equal(OVH_MODELS.length, 8);
	assert.equal(ALL_MODELS.length, 35);
	assert.equal(new Set(ALL_MODELS.map((m) => m.id)).size, 35);
});

test("aliases deduplicated and wrong removed", () => {
 assert.equal(resolveCanonicalModelId("claude-sonnet-4.5-free"), "claude-sonnet-4.5-free");
 assert.equal(resolveCanonicalModelId("minimax-m2.1-free"), "minimax-m2.1-free");
 assert.equal(resolveCanonicalModelId("qwen3-coder-480b-free"), "qwen3-coder-480b-free");
 assert.equal(resolveCanonicalModelId("dots-3-note-preview:free"), "dots-3-note-preview:free");
 assert.equal(resolveCanonicalModelId("dots-3-note-preview"), "dots-studio/dots-3-note-preview:free");
 assert.equal(resolveCanonicalModelId("nemotron-3.5-lightning"), "nvidia/nemotron-3.5-lightning:free");
 assert.equal(resolveCanonicalModelId("deepseek-v4.1-flash"), "deepseek-v4.1-flash-free");
 assert.equal(isKiloModel("dots-3-note-preview"), true);
	assert.equal(Object.keys(MODEL_ALIASES).length, 30);
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
	const core = loadRelayCore(CLOUDFLARE_RELAY_WORKER);
	assert.equal(core.isPrivateHostname("127.0.0.1"), true, "IPv4 loopback");
	assert.equal(core.isPrivateHostname("0.0.0.0"), true, "IPv4 unspecified");
	assert.equal(core.isPrivateHostname("::"), true, "IPv6 unspecified/loopback prefix");
	assert.equal(core.isPrivateHostname("fc00::1"), true, "IPv6 ULA fc00::/7");
	assert.equal(core.isPrivateHostname("fd00::1"), true, "IPv6 ULA fd00::/8");
	assert.equal(core.isPrivateHostname("fe80::1"), true, "IPv6 link-local");
	assert.equal(core.isPrivateHostname("100.64.0.1"), true, "CGNAT 100.64/10");
	assert.equal(core.isPrivateHostname("localhost"), true, "localhost");
	assert.equal(core.isPrivateHostname("opencode.ai."), false, "a trailing dot is sanitized, not a new host");
	assert.equal(core.isPrivateHostname("api.kilo.ai"), false, "public upstream host");
});

test("resolveRelayTarget guard - @, \\, must start /, host/protocol/port/credentials", () => {
	const core = loadRelayCore(CLOUDFLARE_RELAY_WORKER);
	assert.equal(
		core.resolveRelayTarget("https://opencode.ai", "/zen/v1/models").ok,
		true,
		"the canonical upstream path resolves",
	);
	for (const relayPath of ["zen/v1/models", "/a@b", "/zen\\x", "/zen/\\x"]) {
		const verdict = core.resolveRelayTarget("https://opencode.ai", relayPath);
		assert.equal(verdict.ok, false, `${relayPath} must be rejected`);
		assert.equal(verdict.status, 403, `${relayPath} must be a 403`);
	}
	assert.equal(
		core.resolveRelayTarget("https://opencode.ai", "//evil.example.com/zen").reason,
		"forbidden x-relay-path (host mismatch)",
		"a resolved URL on another host is rejected",
	);
	assert.equal(
		core.resolveRelayTarget("https://user:pw@opencode.ai", "/zen").ok,
		false,
		"credentials embedded in the target are rejected",
	);
	assert.equal(
		core.resolveRelayTarget("https://opencode.ai:8443", "/zen").ok,
		true,
		"the target's own port is not a mismatch",
	);
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
