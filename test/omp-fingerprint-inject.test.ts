import test from "node:test";
import assert from "node:assert/strict";
import {
 COMPAT_TOOL_DESCRIPTION,
 OMP_FINGERPRINT_DEFS,
 OPENCODE_FINGERPRINT_TOOLS,
 canonicalizeTool,
 injectFingerprintTools,
 isOmpLikeCaller,
} from "../src/tool-translation.ts";
import { enforceOpencodeFingerprint, sseToResponsesJson } from "../src/opencode-fingerprint.ts";

function responsesTool(name: string, description: string, parameters: unknown): Record<string, unknown> {
 return { type: "function", name, description, parameters: parameters as Record<string, unknown> };
}

function paramsOf(tool: Record<string, unknown>): Record<string, unknown> {
 return tool.parameters as Record<string, unknown>;
}

test("isOmpLikeCaller: OMP markers and glob-without-find detect, Pi does not", () => {
 assert.equal(isOmpLikeCaller(["ask", "glob"]), true);
 assert.equal(isOmpLikeCaller(["todo"]), true);
 assert.equal(isOmpLikeCaller(["task"]), true);
 assert.equal(isOmpLikeCaller(["hub"]), true);
 assert.equal(isOmpLikeCaller(["lsp"]), true);
 assert.equal(isOmpLikeCaller(["glob"]), true, "glob without find is OMP-like");
 assert.equal(isOmpLikeCaller(["find", "ls"]), false, "Pi find+ls stays Pi");
 assert.equal(isOmpLikeCaller(["find", "bash"]), false);
 assert.equal(isOmpLikeCaller([]), false);
 assert.equal(isOmpLikeCaller(["read", "bash"]), false);
});

test("OMP_FINGERPRINT_DEFS: real schemas for all six slots, never the COMPAT text", () => {
 assert.deepEqual(Object.keys(OMP_FINGERPRINT_DEFS).sort(), [...OPENCODE_FINGERPRINT_TOOLS].sort());
 for (const name of OPENCODE_FINGERPRINT_TOOLS) {
  const def = OMP_FINGERPRINT_DEFS[name];
  assert.ok(def.description && !def.description.includes("never be invoked"), `${name}: real description`);
  const params = def.parameters as { type?: unknown; properties?: unknown; required?: unknown };
  assert.equal(params.type, "object", `${name}: object schema`);
  assert.ok(params.properties && typeof params.properties === "object", `${name}: non-empty properties`);
  assert.ok(Object.keys(params.properties as Record<string, unknown>).length > 0, `${name}: executable params`);
 }
});

test("injectFingerprintTools: partial OMP [ask,glob] on responses yields real schemas, no COMPAT text", () => {
 const askParams = { type: "object", properties: { question: { type: "string" } }, required: ["question"] };
 const globParams = { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] };
 const tools = [
  responsesTool("ask", "Ask a question", askParams),
  responsesTool("glob", "Find files", globParams),
 ];
 const out = injectFingerprintTools(tools, "/v1/responses");
 assert.equal(out.length, 7, "ask + glob + 5 injected (bash/grep/read/edit/write)");
 const names = out.map((t) => String(t.name));
 for (const n of ["bash", "grep", "read", "edit", "write"]) assert.ok(names.includes(n), `injected ${n}`);
 for (const t of out) {
  assert.equal(t.type, "function");
  assert.ok(typeof t.name === "string");
  assert.ok(!String(t.description).includes("never be invoked"), `${t.name}: no COMPAT description`);
 }
 const read = out.find((t) => t.name === "read")!;
 assert.deepEqual(paramsOf(read), OMP_FINGERPRINT_DEFS.read.parameters, "injected read carries the real schema");
 const ask = out.find((t) => t.name === "ask")!;
 assert.equal(ask.description, "Ask a question", "caller tools untouched");
 assert.deepEqual(paramsOf(ask), askParams);
});

test("injectFingerprintTools: Pi callers keep empty placeholders; explicit ompLike overrides", () => {
 const pi = [responsesTool("find", "Find files", { type: "object", properties: { p: { type: "string" } } })];
 const piOut = injectFingerprintTools(pi, "/v1/responses");
 assert.equal(piOut.length, 7, "find is not a fingerprint slot: 1 caller + 6 placeholders");
 for (const t of piOut) {
  if (String(t.name) === "find") continue;
  assert.equal(t.description, COMPAT_TOOL_DESCRIPTION, `${t.name}: Pi keeps placeholder`);
  assert.deepEqual(paramsOf(t), { type: "object", properties: {} });
 }
 const forced = injectFingerprintTools(
  [responsesTool("find", "f", { type: "object" })],
  "/v1/responses",
  true,
 );
 assert.ok(
  forced.every((t) => !String(t.description).includes("never be invoked")),
  "explicit ompLike=true forces real defs",
 );
 const forcedPi = injectFingerprintTools([responsesTool("ask", "a", { type: "object" })], "/v1/responses", false);
 const injected = forcedPi.filter((t) => String(t.name) !== "ask");
 assert.ok(injected.length > 0 && injected.every((t) => t.description === COMPAT_TOOL_DESCRIPTION));
});

test("injectFingerprintTools: full OMP inventory injects nothing; idempotent and case-insensitive", () => {
 const full = [
  responsesTool("ask", "a", { type: "object" }),
  responsesTool("read", "r", { type: "object" }),
  responsesTool("bash", "b", { type: "object" }),
  responsesTool("edit", "e", { type: "object" }),
  responsesTool("glob", "g", { type: "object" }),
  responsesTool("grep", "gr", { type: "object" }),
  responsesTool("write", "w", { type: "object" }),
  responsesTool("todo", "t", { type: "object" }),
 ];
 const before = full.length;
 assert.equal(injectFingerprintTools(full, "/v1/responses").length, before, "full inventory: injected=[]");
 const partial = [responsesTool("ask", "a", { type: "object" }), responsesTool("glob", "g", { type: "object" })];
 const once = injectFingerprintTools(partial, "/v1/responses");
 const twice = injectFingerprintTools(once, "/v1/responses");
 assert.equal(twice.length, once.length, "fingerprint-once: re-inject adds zero tools");
 const cased = [{ type: "function", function: { name: "Bash", description: "b" } }];
 assert.equal(injectFingerprintTools(cased, "/v1/chat/completions", true).length, 6, "Bash satisfies bash");
 const canon = canonicalizeTool({ type: "function", name: "read", description: "r", parameters: OMP_FINGERPRINT_DEFS.read.parameters });
 assert.ok(canon && Object.keys(canon.parameters.properties as Record<string, unknown>).length > 0);
});

test("enforce: partial OMP [ask,glob] on /v1/responses yields real schemas, empty cloak list", () => {
 const body: Record<string, unknown> = {
  model: "muse-spark-1.3-contributor-free",
  input: "hi",
  stream: false,
  tools: [
   responsesTool("ask", "Ask a question", { type: "object", properties: { q: { type: "string" } } }),
   responsesTool("glob", "Find files", { type: "object", properties: { pattern: { type: "string" } } }),
  ],
 };
 const r = enforceOpencodeFingerprint(body, "/v1/responses");
 assert.equal(r.callerHadTools, true);
 assert.equal(r.addedTools, true);
 assert.deepEqual(r.injected, [], "real definitions are never cloaked");
 assert.deepEqual([...r.injectedReal].sort(), ["bash", "edit", "grep", "read", "write"]);
 const tools = body.tools as Array<Record<string, unknown>>;
 assert.equal(tools.length, 7);
 for (const t of tools) {
  const name = String(t.name);
  assert.ok(!String(t.description).includes("never be invoked"), `${name}: no COMPAT description`);
  const params = t.parameters as { properties?: Record<string, unknown> };
  assert.ok(params.properties && Object.keys(params.properties).length > 0, `${name}: executable params`);
 }
 const read = tools.find((t) => t.name === "read");
 assert.ok(read);
 assert.deepEqual(read.parameters, OMP_FINGERPRINT_DEFS.read.parameters);
});

test("enforce: model calling injected read executes downstream (not cloaked)", () => {
 const body: Record<string, unknown> = {
  model: "muse-spark-1.3-contributor-free",
  input: "hi",
  stream: false,
  tools: [responsesTool("ask", "Ask", { type: "object" }), responsesTool("glob", "Find", { type: "object" })],
 };
 const r = enforceOpencodeFingerprint(body, "/v1/responses");
 const response = {
  id: "resp_omp",
  object: "response",
  status: "completed",
  output: [
   { type: "function_call", id: "fc_read", name: "read", arguments: '{"path":"x"}' },
   { type: "function_call", id: "fc_ask", name: "ask", arguments: '{"q":"y"}' },
  ],
 };
 const sse = `event: response.completed\ndata: {"type":"response.completed","response":${JSON.stringify(response)}}`;
 const out = sseToResponsesJson(sse, true, r.caseRestore, r.findGlob, r.injected) as {
  output: Array<{ type: string; name?: string }>;
 };
 assert.deepEqual(
  out.output.map((o) => o.name),
  ["read", "ask"],
  "injected read call survives cloak and executes downstream",
 );
});

test("enforce: full OMP inventory yields injected=[] and injectedReal=[]", () => {
 const body: Record<string, unknown> = {
  model: "muse-spark-1.3-contributor-free",
  input: "hi",
  stream: false,
  tools: [
   responsesTool("ask", "a", { type: "object" }),
   responsesTool("bash", "b", { type: "object" }),
   responsesTool("glob", "g", { type: "object" }),
   responsesTool("grep", "gr", { type: "object" }),
   responsesTool("read", "r", { type: "object" }),
   responsesTool("edit", "e", { type: "object" }),
   responsesTool("write", "w", { type: "object" }),
   responsesTool("todo", "t", { type: "object" }),
  ],
 };
 const r = enforceOpencodeFingerprint(body, "/v1/responses");
 assert.deepEqual(r.injected, []);
 assert.deepEqual(r.injectedReal, []);
 assert.equal(r.addedTools, false);
 assert.equal((body.tools as unknown[]).length, 8);
});

test("enforce: Pi find caller keeps empty placeholders and full cloak list", () => {
 const findParams = { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] };
 const body: Record<string, unknown> = {
  model: "big-pickle",
  stream: false,
  tools: [responsesTool("find", "Find files", findParams)],
 };
 const r = enforceOpencodeFingerprint(body, "/v1/responses");
 assert.deepEqual(r.injectedReal, [], "Pi serves no real definitions");
 assert.ok(r.injected.includes("bash") && r.injected.includes("read"), "Pi placeholders still cloaked");
 assert.ok(!r.injected.includes("glob"), "renamed find satisfies the glob slot");
 const tools = body.tools as Array<Record<string, unknown>>;
 const glob = tools.find((t) => t.name === "glob");
 assert.ok(glob);
 assert.equal(glob.description, "Find files", "caller find description verbatim");
 assert.deepEqual(glob.parameters, findParams);
 const bash = tools.find((t) => t.name === "bash");
 assert.ok(bash);
 assert.equal(bash.description, COMPAT_TOOL_DESCRIPTION);
});
