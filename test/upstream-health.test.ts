/**
 * Upstream degradation health tests: free-tier gate detection, gate entry,
 * session novelty, chat failover model choice, and the 403 hint rewrite.
 *
 * Disk state is sandboxed by test/setup.mjs (DATA_DIR override); each test
 * additionally isolates the health file so cases never leak into each other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveUpstreamHealthPath } from "../src/config.ts";
import { isKiloModel } from "../src/models.ts";
import {
 _resetFreeTierHintForTest,
 _resetUpstreamHealthForTest,
 decideZenRoute,
 getUpstreamHealth,
 isFreeTierGate,
 isUnprovenSession,
 isUpstreamGated,
 pickFailoverModel,
 recordUpstreamFailure,
 recordUpstreamSuccess,
 rejectionFingerprint,
 rememberGateRejection,
 sessionKeyOf,
 wasGateRejected,
 withFreeTierHint,
} from "../src/upstream-health.ts";

const HEALTH_FILE = resolveUpstreamHealthPath();

const GATE_BODY = JSON.stringify({
 error: {
  code: "FreeTierError",
  message: "OpenCode's free tier can only be used from within OpenCode",
 },
});
const GATE_BODY_VARIANT =
 "Error from provider (Console): FreeTierError: " +
 "OpenCode's free tier can only be used from within OpenCode (ses_abc)";
const OTHER_403_BODY = JSON.stringify({
 error: { code: "Forbidden", message: "Forbidden" },
});
const PLAIN_TEXT_BODY = "Service Unavailable";

/** Start each case from a clean slate (memory + disk). */
function resetHealth(): void {
 try {
  fs.rmSync(HEALTH_FILE, { force: true });
 } catch { }
 _resetUpstreamHealthForTest();
 _resetFreeTierHintForTest();
}

/** Isolate the health disk file for the duration of one case. */
function withIsolatedHealthFiles(fn: () => void): void {
 const before = fs.existsSync(HEALTH_FILE)
  ? fs.readFileSync(HEALTH_FILE, "utf8")
  : null;
 resetHealth();
 try {
  fn();
 } finally {
  resetHealth();
  if (before !== null) {
   fs.writeFileSync(HEALTH_FILE, before, "utf8");
  } else {
   try {
    fs.rmSync(HEALTH_FILE, { force: true });
   } catch { }
  }
 }
}

// ── Gate detection ────────────────────────────────────────────────────

test("gate detection: 403 FreeTierError bodies are gates, incl. the provider-console variant", () => {
 withIsolatedHealthFiles(() => {
  assert.equal(isFreeTierGate(403, GATE_BODY), true);
  assert.equal(isFreeTierGate(403, GATE_BODY_VARIANT), true);
 });
});

test("gate detection: 429/500/other-403/non-JSON/null bodies are not gates", () => {
 withIsolatedHealthFiles(() => {
  assert.equal(isFreeTierGate(429, GATE_BODY), false);
  assert.equal(isFreeTierGate(500, GATE_BODY), false);
  assert.equal(isFreeTierGate(403, OTHER_403_BODY), false);
  assert.equal(isFreeTierGate(403, PLAIN_TEXT_BODY), false);
  assert.equal(isFreeTierGate(403, null), false);
  assert.equal(isFreeTierGate(403, undefined), false);
 });
});

// ── Gate entry ────────────────────────────────────────────────────────

test("gate enters after 2 consecutive zen 403s, not after 1", () => {
 withIsolatedHealthFiles(() => {
  recordUpstreamFailure("zen", 403, GATE_BODY);
  assert.equal(isUpstreamGated("zen"), false);
  recordUpstreamFailure("zen", 403, GATE_BODY);
  assert.equal(isUpstreamGated("zen"), true);
  const snap = getUpstreamHealth("zen");
  assert.equal(snap.gated, true);
  assert.ok(snap.consecutiveFreeTier403 >= 2);
  assert.ok(snap.firstGatedAt > 0);
  assert.ok(snap.lastTransitionAt > 0);
 });
});

test("non-gate failures never enter the gate", () => {
 withIsolatedHealthFiles(() => {
  recordUpstreamFailure("zen", 429, GATE_BODY);
  recordUpstreamFailure("zen", 500, GATE_BODY);
  recordUpstreamFailure("zen", 403, OTHER_403_BODY);
  assert.equal(isUpstreamGated("zen"), false);
 });
});

// ── Success semantics ─────────────────────────────────────────────────

test("plain success records the session key but never clears the gate", () => {
 withIsolatedHealthFiles(() => {
  recordUpstreamFailure("zen", 403, GATE_BODY);
  recordUpstreamFailure("zen", 403, GATE_BODY);
  assert.equal(isUpstreamGated("zen"), true);
  recordUpstreamSuccess("zen", { sessionKey: "sess-abc" });
  assert.equal(isUpstreamGated("zen"), true);
  assert.equal(sessionKeyOf({ prompt_cache_key: "sess-abc" }), "sess-abc");
  assert.equal(
   isUnprovenSession({ prompt_cache_key: "sess-abc" }, "/v1/responses"),
   false,
  );
 });
});

test("canary success clears the gate", () => {
 withIsolatedHealthFiles(() => {
  recordUpstreamFailure("zen", 403, GATE_BODY);
  recordUpstreamFailure("zen", 403, GATE_BODY);
  assert.equal(isUpstreamGated("zen"), true);
  recordUpstreamSuccess("zen", { sessionKey: "sess-abc", canary: true });
  assert.equal(isUpstreamGated("zen"), false);
  assert.equal(getUpstreamHealth("zen").gated, false);
 });
});

// ── Session novelty ───────────────────────────────────────────────────

test("responses bodies are unproven until their key is established", () => {
 withIsolatedHealthFiles(() => {
  assert.equal(
   isUnprovenSession({ prompt_cache_key: "unknown-1" }, "/v1/responses"),
   true,
  );
  assert.equal(isUnprovenSession({}, "/v1/responses"), true);
  assert.equal(
   isUnprovenSession({ input: [] }, "/zen/v1/responses"),
   true,
  );
  recordUpstreamSuccess("zen", { sessionKey: "resp-known-1" });
  assert.equal(
   isUnprovenSession(
    { prompt_cache_key: "resp-known-1" },
    "/v1/responses",
   ),
   false,
  );
 });
});

test("chat bodies are unproven only for fresh sessions", () => {
 withIsolatedHealthFiles(() => {
  assert.equal(
   isUnprovenSession(
    { messages: [{ role: "user", content: "hi" }] },
    "/v1/chat/completions",
   ),
   true,
  );
  assert.equal(
   isUnprovenSession({ messages: [] }, "/v1/chat/completions"),
   true,
  );
  assert.equal(
   isUnprovenSession(
    {
     messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
     ],
    },
    "/v1/chat/completions",
   ),
   false,
  );
  recordUpstreamSuccess("zen", { sessionKey: "chat-known-1" });
  assert.equal(
   isUnprovenSession(
    {
     messages: [{ role: "user", content: "hi" }],
     prompt_cache_key: "chat-known-1",
    },
    "/v1/chat/completions",
   ),
   false,
  );
 });
});

test("novelty fails open for null bodies", () => {
 withIsolatedHealthFiles(() => {
  assert.equal(isUnprovenSession(null, "/v1/responses"), false);
  assert.equal(isUnprovenSession(null, "/v1/chat/completions"), false);
  assert.equal(sessionKeyOf(null), null);
 });
});

// ── Chat routing ──────────────────────────────────────────────────────

test("chat routing passes proven sessions through while gated", () => {
 withIsolatedHealthFiles(() => {
  recordUpstreamFailure("zen", 403, GATE_BODY);
  recordUpstreamFailure("zen", 403, GATE_BODY);
  assert.equal(
   decideZenRoute(
    {
     messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
     ],
    },
    "/v1/chat/completions",
   ),
   "passthrough",
  );
 });
});

test("chat routing fails fresh sessions over while gated", () => {
 withIsolatedHealthFiles(() => {
  recordUpstreamFailure("zen", 403, GATE_BODY);
  recordUpstreamFailure("zen", 403, GATE_BODY);
  const route = decideZenRoute(
   { messages: [{ role: "user", content: "hi" }] },
   "/v1/chat/completions",
  );
  assert.ok(route === "canary" || route === "failover");
  const second = decideZenRoute(
   { messages: [{ role: "user", content: "hi" }] },
   "/v1/chat/completions",
  );
  assert.equal(second, "failover");
 });
});

test("chat routing passes everything through while ungated", () => {
 withIsolatedHealthFiles(() => {
  assert.equal(
   decideZenRoute(
    { messages: [{ role: "user", content: "hi" }] },
    "/v1/chat/completions",
   ),
   "passthrough",
  );
 });
});

// ── Failover model ────────────────────────────────────────────────────

test("failover model choice is a Kilo model", () => {
 withIsolatedHealthFiles(() => {
  const id = pickFailoverModel();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
  assert.equal(isKiloModel(id), true);
 });
});

// ── Hint rewrite ──────────────────────────────────────────────────────

test("403 gate bodies gain a hint; everything else passes through byte-identical", () => {
 withIsolatedHealthFiles(() => {
  const hinted = withFreeTierHint(403, GATE_BODY);
  const parsed = JSON.parse(hinted) as Record<string, unknown>;
  assert.equal(typeof parsed.hint, "string");
  assert.ok((parsed.hint as string).length > 0);

  assert.equal(withFreeTierHint(403, OTHER_403_BODY), OTHER_403_BODY);
  assert.equal(withFreeTierHint(429, GATE_BODY), GATE_BODY);
  assert.equal(withFreeTierHint(403, PLAIN_TEXT_BODY), PLAIN_TEXT_BODY);
  const ok = JSON.stringify({ ok: true });
  assert.equal(withFreeTierHint(200, ok), ok);
 });
});

// ── Gate-rejection memory (resume auto-fix) ─────────────────────────────

test("gate rejections are remembered by key, then forgotten on recovery", () => {
 withIsolatedHealthFiles(() => {
  const body = { model: "muse-spark-1.3-contributor-free", input: "hi", prompt_cache_key: "sess-resume-1" };
  assert.equal(wasGateRejected(body, "/v1/responses"), false);
  rememberGateRejection(body, "/v1/responses", 403, GATE_BODY);
  assert.equal(wasGateRejected(body, "/v1/responses"), true);
  assert.equal(
   wasGateRejected({ model: "muse-spark-1.3-contributor-free", input: "other" }, "/v1/responses"),
   false,
   "different sessions are unaffected",
  );
  recordUpstreamSuccess("zen", { canary: true });
  assert.equal(wasGateRejected(body, "/v1/responses"), false, "recovery drops rejection memory");
 });
});

test("keyless chat replays fingerprint by content; non-gates never prime", () => {
 withIsolatedHealthFiles(() => {
  const replay = {
   model: "big-pickle",
   messages: [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "again" },
   ],
  };
  assert.ok(typeof rejectionFingerprint(replay, "/v1/chat/completions") === "string");
  assert.equal(rejectionFingerprint(null, "/v1/chat/completions"), null);
  rememberGateRejection(replay, "/v1/chat/completions", 403, OTHER_403_BODY);
  assert.equal(wasGateRejected(replay, "/v1/chat/completions"), false, "non-gate verdicts never prime");
  rememberGateRejection(replay, "/v1/chat/completions", 500, GATE_BODY);
  assert.equal(wasGateRejected(replay, "/v1/chat/completions"), false, "non-403 statuses never prime");
  rememberGateRejection(replay, "/v1/chat/completions", 403, GATE_BODY);
  assert.equal(wasGateRejected(replay, "/v1/chat/completions"), true);
  assert.equal(
   wasGateRejected({ model: "big-pickle", messages: [{ role: "user", content: "fresh" }] }, "/v1/chat/completions"),
   false,
   "different content hashes differently",
  );
 });
});
