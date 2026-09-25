/**
 * Regression tests for relay-template backslash escaping (issue #25).
 * The worker core is generated inside a String.raw outer literal, so
 * backslashes in src/deploy.ts are written singly and reach the deployed
 * output verbatim (doubling them would corrupt the guards again).
 * These tests execute the generated code: syntax via `node --check` and
 * guard behavior by running the generated functions.
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
 buildCloudflareRelayWorker,
 buildDenoRelayScript,
 buildVercelRelayWorker,
} from "../src/deploy.ts";

const BUILDERS = {
 vercel: buildVercelRelayWorker,
 cloudflare: buildCloudflareRelayWorker,
 deno: buildDenoRelayScript,
} as const;

/** Strip the platform wrapper so the shared core can run under `new Function`. */
function coreOf(src: string): string {
 for (const marker of ["\nexport const config", "\nexport default", "\nDeno.serve"]) {
  const at = src.indexOf(marker);
  if (at !== -1) return src.slice(0, at);
 }
 throw new Error("unknown relay template wrapper");
}

type RelayCore = {
 resolveRelayTarget: (target: string, relayPath: unknown) => { ok: boolean; url?: string; status?: number };
 isPrivateHostname: (h: unknown) => boolean;
 relayHandler: (req: { method: string; headers: Headers; body?: BodyInit | null }) => Promise<Response>;
};

function loadCore(src: string): RelayCore {
 const fn = new Function(`${coreOf(src)}; return { resolveRelayTarget, isPrivateHostname, relayHandler };`);
 return fn() as RelayCore;
}

for (const [label, build] of Object.entries(BUILDERS)) {
 for (const auth of ["", "s3cr3t-auth"]) {
  test(`${label} template (auth ${auth ? "set" : "empty"}) passes node --check`, () => {
   const dir = mkdtempSync(join(tmpdir(), "relay-check-"));
   const file = join(dir, `${label}.mjs`);
   writeFileSync(file, build(auth));
   const out = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
   assert.equal(out.status, 0, `${label}: node --check failed: ${out.stderr}`);
  });
 }
}

test("generated core keeps backslash guards intact", () => {
 const core = loadCore(buildVercelRelayWorker(""));
 // Backslash in x-relay-path is forbidden (would be a syntax error if unescaped).
 assert.deepEqual(core.resolveRelayTarget("https://opencode.ai", "/zen\\x"), { ok: false, status: 403, reason: "forbidden x-relay-path" });
 assert.deepEqual(core.resolveRelayTarget("https://opencode.ai", "/a@b"), { ok: false, status: 403, reason: "forbidden x-relay-path" });
 assert.equal(core.resolveRelayTarget("https://opencode.ai", "/zen/v1/models").ok, true);
});

test("generated core strips brackets and matches IPv4 private ranges", () => {
 const core = loadCore(buildVercelRelayWorker(""));
 assert.equal(core.isPrivateHostname("[::1]"), true, "bracket-strip");
 assert.equal(core.isPrivateHostname("[fd00::1]"), true, "bracketed IPv6 unique-local");
 assert.equal(core.isPrivateHostname("fe80::1"), true, "IPv6 link-local");
 assert.equal(core.isPrivateHostname("127.0.0.1"), true, "IPv4 loopback");
 assert.equal(core.isPrivateHostname("10.1.2.3"), true, "IPv4 10/8");
 assert.equal(core.isPrivateHostname("192.168.0.5"), true, "IPv4 192.168/16");
 assert.equal(core.isPrivateHostname("8.8.8.8"), false, "public IPv4 passes");
});

test("generated relayHandler strips a trailing slash before the whitelist check", async () => {
 const core = loadCore(buildVercelRelayWorker(""));
 const seen: string[] = [];
 const realFetch = globalThis.fetch;
 (globalThis as Record<string, unknown>).fetch = async (url: URL | string) => {
  seen.push(String(url));
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
 };
 try {
  const headers = new Headers({ "x-relay-target": "https://opencode.ai/", "x-relay-path": "/zen/v1/models" });
  const res = await core.relayHandler({ method: "GET", headers, body: null });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["https://opencode.ai/zen/v1/models"]);
 } finally {
  globalThis.fetch = realFetch;
 }
});
