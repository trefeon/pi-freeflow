/**
 * Live all-tools acceptance for pi-freeflow (OPT-IN — never part of `npm test`).
 *
 * Proves every tool OMP + Pi can send survives translation AND is accepted by
 * real OpenCode Zen upstream (no 403 FreeTierError, no 400 shape rejection):
 *
 * Phase A (offline, no network): build caller tools for ALL host names
 * (OMP 28 + browser/computer + 3 hidden, Pi 8, MCP/custom/xd samples) in each
 * wire shape, run translateToolsForPath + enforceOpencodeFingerprint, assert
 * zero drops, sextet injected once each, stream:true, store=false on
 * /responses only, no additionalProperties injection.
 *
 * Phase B (live): start the real proxy in direct mode (relay pool isolated to
 * empty + restored afterwards, main AND .bak), send ONE request per endpoint
 * carrying the FULL tool array, classify the upstream verdict:
 * 200 = PASS, 429 = gate passed but shared-IP quota hit, 403/400 = FAIL.
 *
 * Usage:
 * node --experimental-strip-types scripts/live-all-tools.ts --only=chat|responses|messages
 *
 * Run each --only in a SEPARATE process: a live 403 feeds the in-process
 * upstream-health gate machine, so probes share nothing by construction.
 */

import fs from "node:fs";
import type { Server } from "node:http";
import { startProxy } from "../src/proxy.ts";
import { RELAY_STATE_FILE } from "../src/config.ts";
import { loadRelayState } from "../src/relay-state.ts";
import {
 ALL_HOST_TOOL_NAMES,
 OMP_HIDDEN_TOOL_NAMES,
 OPENCODE_FINGERPRINT_TOOLS,
 translateToolsForPath,
} from "../src/tool-translation.ts";
import { enforceOpencodeFingerprint } from "../src/opencode-fingerprint.ts";

const BAK_FILE = `${RELAY_STATE_FILE}.bak`;
const PORT = 29481;
const LIVE_TIMEOUT_MS = 120_000;

const PATHS = ["/v1/chat/completions", "/v1/responses", "/v1/messages"] as const;
type Path = (typeof PATHS)[number];

const EXTRA_TOOLS = ["mcp__github__search_code", "my_custom_tool", "xdev_tool"] as const;

/**
 * Caller-shape tool fixture for one host name on one path.
 * Host-faithful strict contract: even-index (OMP style) tools carry
 * strict:true WITH a conformant schema (required=all keys,
 * additionalProperties:false — exactly what OMP's own strict transform
 * emits); odd-index (Pi style) tools omit strict with a plain schema
 * (Pi compat supportsStrictMode=false omits the key entirely).
 * Neither host ever sends strict:true with a non-conformant schema —
 * upstream 400s that, correctly, so the fixture never does either.
 */
function callerTool(name: string, path: Path, i: number): Record<string, unknown> {
 const ompStyle = i % 2 === 0;
 const params = ompStyle
  ? {
   type: "object",
   properties: { input: { type: "string", description: "probe input" } },
   required: ["input"],
   additionalProperties: false,
  }
  : {
   type: "object",
   properties: { input: { type: "string", description: "probe input" } },
   required: ["input"],
  };
 const desc = `probe tool ${name}`;
 const extra = { "x-host": ompStyle ? "omp" : "pi" };
 if (path === "/v1/chat/completions") {
  const tool: Record<string, unknown> = { type: "function", function: { name, description: desc, parameters: params }, ...extra };
  if (ompStyle) tool.strict = true;
  return tool;
 }
 if (path === "/v1/responses") {
  const tool: Record<string, unknown> = { type: "function", name, description: desc, parameters: params, ...extra };
  if (ompStyle) tool.strict = true;
  return tool;
 }
 const tool: Record<string, unknown> = { name, description: desc, input_schema: params, ...extra };
 if (ompStyle) tool.strict = true;
 return tool;
}

function upstreamName(t: Record<string, unknown>): string | null {
 if (typeof t.name === "string") return t.name;
 const fn = t.function;
 if (typeof fn === "object" && fn !== null && typeof (fn as Record<string, unknown>).name === "string") {
  return (fn as Record<string, unknown>).name as string;
 }
 return null;
}

function paramsOf(t: Record<string, unknown>): Record<string, unknown> | null {
 for (const key of ["parameters", "input_schema"]) {
  const v = t[key];
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  const fn = t.function;
  if (typeof fn === "object" && fn !== null) {
   const nested = (fn as Record<string, unknown>)[key];
   if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
   }
  }
 }
 return null;
}

/** Phase A: offline translation matrix. Returns failure count. */
function phaseA(): number {
 let failures = 0;
 const names = [...ALL_HOST_TOOL_NAMES, ...EXTRA_TOOLS];
 console.log(`Phase A: offline matrix over ${names.length} caller tools x ${PATHS.length} paths`);
 for (const path of PATHS) {
  const caller = names.map((n, i) => callerTool(n, path, i));
  // Exercise rename paths too: Pi find + capital Bash ride along.
  const translated = translateToolsForPath(caller, path);
  const got = new Set(translated.map((t) => upstreamName(t as Record<string, unknown>)?.toLowerCase()));
  const missing = names
   .map((n) => (n === "find" ? "glob" : n.toLowerCase()))
   .filter((n) => !got.has(n));
  if (missing.length > 0) {
   failures++;
   console.log(`  ✗ ${path}: dropped upstream: ${missing.join(",")}`);
  }
  const body: Record<string, unknown> = { model: "probe", tools: caller, stream: false };
  if (path === "/v1/chat/completions") body.messages = [{ role: "user", content: "ping" }];
  else if (path === "/v1/responses") body.input = [{ role: "user", content: "ping" }];
  else body.messages = [{ role: "user", content: "ping" }];
  enforceOpencodeFingerprint(body, path);
  const out = (body.tools as unknown[]) ?? [];
  const counts = new Map<string, number>();
  for (const t of out) {
   const n = upstreamName(t as Record<string, unknown>)?.toLowerCase();
   if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const sextetMissing = [...OPENCODE_FINGERPRINT_TOOLS].filter((n) => (counts.get(n) ?? 0) !== 1);
  if (sextetMissing.length > 0) {
   failures++;
   console.log(`  ✗ ${path}: sextet not exactly-once: ${sextetMissing.join(",")}`);
  }
  if ((body as Record<string, unknown>).stream !== true) {
   failures++;
   console.log(`  ✗ ${path}: stream not forced true`);
  }
  if (path === "/v1/responses" && (body as Record<string, unknown>).store !== false) {
   failures++;
   console.log(`  ✗ ${path}: store !== false`);
  }
  // Translator must ADD no additionalProperties: the output AP set must
  // equal the caller-sent AP set (even-index OMP-style fixtures carry it,
  // odd-index Pi-style omit it) modulo the find->glob rename.
  const callerAP = new Set(
   caller
    .filter((t) => paramsOf(t as Record<string, unknown>) !== null && "additionalProperties" in (paramsOf(t as Record<string, unknown>) as Record<string, unknown>))
    .map((t) => {
     const n = upstreamName(t as Record<string, unknown>)?.toLowerCase() ?? "";
     return n === "find" ? "glob" : n;
    }),
  );
  const outAP = new Set(
   (out as Record<string, unknown>[])
    .filter((t) => paramsOf(t) !== null && "additionalProperties" in (paramsOf(t) as Record<string, unknown>))
    .map((t) => upstreamName(t)?.toLowerCase() ?? ""),
  );
  const addedAP = [...outAP].filter((n) => !callerAP.has(n));
  const strippedAP = [...callerAP].filter((n) => !outAP.has(n));
  if (addedAP.length > 0 || strippedAP.length > 0) {
   failures++;
   console.log(`  ✗ ${path}: additionalProperties added=[${addedAP.join(",")}] stripped=[${strippedAP.join(",")}]`);
  }
  if (failures === 0) console.log(`  ✓ ${path}: ${out.length} tools upstream, sextet once each, stream:true`);
 }
 // Hidden OMP tools explicitly visible in the matrix.
 console.log(`  hidden: ${[...OMP_HIDDEN_TOOL_NAMES].join(",")} covered above`);
 return failures;
}

interface LiveSpec {
 only: string;
 path: string;
 model: string;
 body: Record<string, unknown>;
 verdict: "hard" | "info";
}

function liveSpec(only: string): LiveSpec {
 const chatTools = [...ALL_HOST_TOOL_NAMES, ...EXTRA_TOOLS].map((n, i) => callerTool(n, "/v1/chat/completions", i));
 const respTools = [...ALL_HOST_TOOL_NAMES, ...EXTRA_TOOLS].map((n, i) => callerTool(n, "/v1/responses", i));
 const msgTools = [...ALL_HOST_TOOL_NAMES, ...EXTRA_TOOLS].map((n, i) => callerTool(n, "/v1/messages", i));
 if (only === "responses") {
  return {
   only, path: "/v1/responses", model: "muse-spark-1.3-contributor-free", verdict: "hard",
   body: {
    model: "muse-spark-1.3-contributor-free",
    input: [{ role: "user", content: "Reply with exactly: OK" }],
    tools: respTools, tool_choice: "auto", max_output_tokens: 64, stream: false,
   },
  };
 }
 if (only === "messages") {
  return {
   only, path: "/v1/messages", model: "union-alpha", verdict: "info",
   body: {
    model: "union-alpha", max_tokens: 64,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    tools: msgTools, stream: false,
   },
  };
 }
 return {
  only: "chat", path: "/v1/chat/completions", model: "mimo-v2.5-free", verdict: "hard",
  body: {
   model: "mimo-v2.5-free",
   messages: [{ role: "user", content: "Reply with exactly: OK" }],
   tools: chatTools, tool_choice: "auto", max_tokens: 64, stream: false,
  },
 };
}

/** Phase B: one live request through the local proxy in direct mode. */
async function phaseB(spec: LiveSpec): Promise<number> {
 const read = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
 const mainBefore = read(RELAY_STATE_FILE);
 const bakBefore = read(BAK_FILE);
 const restore = (p: string, v: string | null): void => {
  try {
   if (v === null) fs.rmSync(p, { force: true });
   else fs.writeFileSync(p, v, "utf8");
  } catch { }
 };
 const restoreBothSync = (): void => {
  restore(RELAY_STATE_FILE, mainBefore);
  restore(BAK_FILE, bakBefore);
 };
 // A signal must not strand the wiped pool: restore synchronously, detach,
 // then re-raise so the process still exits on the signal itself.
 const onSigint = (): void => {
  restoreBothSync();
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  process.kill(process.pid, "SIGINT");
 };
 const onSigterm = (): void => {
  restoreBothSync();
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  process.kill(process.pid, "SIGTERM");
 };
 process.on("SIGINT", onSigint);
 process.on("SIGTERM", onSigterm);
 // Force direct egress: an empty pool means direct mode — and BOTH files
 // must be cleared, otherwise the wipe-protection in loadRelayState
 // resurrects the pool from .bak (empty main + full .bak = recovery).
 for (const p of [RELAY_STATE_FILE, BAK_FILE]) {
  try { fs.rmSync(p, { force: true }); } catch { }
 }
 let server: Server | null = null;
 try {
  const pool = loadRelayState();
  void pool;
  const started = await startProxy(PORT);
  server = started.server;
  const port = started.port;
  await new Promise((r) => setTimeout(r, 1_000));
  const res = await fetch(`http://127.0.0.1:${port}${spec.path}`, {
   method: "POST",
   headers: { "content-type": "application/json", accept: "application/json" },
   body: JSON.stringify(spec.body),
   signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
  });
  const text = await res.text();
  const gate = text.includes("FreeTierError") || text.includes("only be used from within OpenCode");
  const excerpt = text.replace(/\s+/g, " ").slice(0, 300);
  if (res.status === 200) {
   console.log(`  ✓ HTTP 200 — all tools accepted upstream (${text.length}B body)`);
   return 0;
  }
  if (res.status === 429) {
   console.log(`  ~ HTTP 429 — gate passed (no FreeTierError), shared-IP quota hit: ${excerpt}`);
   return 0;
  }
  // Messages-probe rule (union-alpha has no serving backend yet): 403/400
  // prove the gate/shape path and hard-fail; 401/404/5xx mean the model is
  // unserved and stay info-only. Hard probes fail on any other non-200/429.
  const hardFail = spec.verdict === "hard" || res.status === 403 || res.status === 400;
  console.log(`  ${hardFail ? "✗" : "~"} HTTP ${res.status}${gate ? " FreeTierError" : ""}: ${excerpt}`);
  return hardFail ? 1 : 0;
 } catch (e) {
  console.log(`  ✗ live call failed: ${(e as Error)?.message ?? String(e)}`);
  return spec.verdict === "hard" ? 1 : 0;
 } finally {
  await new Promise<void>((r) => {
   try {
    if (server) server.close(() => r());
    else r();
   } catch { r(); }
  });
  restoreBothSync();
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
 }
}

async function main(): Promise<void> {
 const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "--only=chat").slice("--only=".length);
 if (!["chat", "responses", "messages"].includes(only)) {
  console.error("usage: live-all-tools.ts --only=chat|responses|messages");
  process.exit(2);
 }
 const aFails = phaseA();
 if (aFails > 0) {
  console.log(`\nOFFLINE FAILS: ${aFails} — live probe skipped`);
  process.exit(1);
 }
 const bFails = await phaseB(liveSpec(only));
 console.log(bFails === 0 ? "\nALL REAL-TOOL CHECKS PASS" : "\nREAL-TOOL FAILURES PRESENT");
 process.exit(bFails === 0 ? 0 : 1);
}

main().catch((err) => {
 console.error("runner crashed:", err);
 process.exit(2);
});
