import test from "node:test";
import assert from "node:assert/strict";
import {
 OMP_FINGERPRINT_DEFS,
 canonicalizeTool,
 isOmpLikeCaller,
} from "../src/tool-translation.ts";
import { withFingerprintTools } from "./_fingerprint.ts";
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

test("OMP_FINGERPRINT_DEFS: real schemas for five slots, edit excluded (no static host-executable schema)", () => {
 assert.deepEqual(Object.keys(OMP_FINGERPRINT_DEFS).sort(), ["bash", "glob", "grep", "read", "write"]);
 for (const name of Object.keys(OMP_FINGERPRINT_DEFS) as Array<keyof typeof OMP_FINGERPRINT_DEFS>) {
  const def = OMP_FINGERPRINT_DEFS[name];
  assert.ok(def.description && !def.description.includes("never be invoked"), `${name}: real description`);
  const params = def.parameters as { type?: unknown; properties?: unknown; required?: unknown };
  assert.equal(params.type, "object", `${name}: object schema`);
  assert.ok(params.properties && typeof params.properties === "object", `${name}: non-empty properties`);
  assert.ok(Object.keys(params.properties as Record<string, unknown>).length > 0, `${name}: executable params`);
 }
 // OMP GlobTool's pattern carrier is `path` (optional), never required `pattern`.
 const globProps = (OMP_FINGERPRINT_DEFS.glob.parameters as { properties: Record<string, unknown> }).properties;
 assert.ok("path" in globProps, "injected glob carries path");
 assert.ok(!("pattern" in globProps), "injected glob has no pattern prop");
 assert.ok(!("required" in (OMP_FINGERPRINT_DEFS.glob.parameters as Record<string, unknown>)), "injected glob is all-optional");
});

test("fingerprint injection: partial OMP [ask,glob] on responses yields the verbatim 11-roster", () => {
 const askParams = { type: "object", properties: { question: { type: "string" } }, required: ["question"] };
 const globParams = { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] };
 const tools = [
  responsesTool("ask", "Ask a question", askParams),
  responsesTool("glob", "Find files", globParams),
 ];
 const out = withFingerprintTools(tools, "/v1/responses");
 assert.equal(out.length, 12, "ask + glob + 10 injected roster slots");
 const names = out.map((t) => String(t.name));
 for (const n of ["bash", "edit", "grep", "read", "skill", "task", "todowrite", "webfetch", "websearch", "write"]) {
  assert.ok(names.includes(n), `injected ${n}`);
 }
 for (const t of out) {
  assert.equal(t.type, "function");
  assert.ok(typeof t.name === "string");
  assert.ok(!String(t.description).includes("never be invoked"), `${t.name}: verbatim CLI def, never a placeholder`);
  const params = paramsOf(t) as { properties?: Record<string, unknown> };
  assert.ok(params.properties && Object.keys(params.properties).length > 0, `${t.name}: executable params`);
 }
 const glob = out.find((t) => t.name === "glob")!;
 assert.equal(glob.description, "Find files", "caller-declared glob keeps its own schema, never the injected def");
 assert.deepEqual(paramsOf(glob), globParams);
 const ask = out.find((t) => t.name === "ask")!;
 assert.equal(ask.description, "Ask a question", "caller tools untouched");
 assert.deepEqual(paramsOf(ask), askParams);
});
test("fingerprint injection: Pi caller tools ride verbatim beside the 11-roster", () => {
 const pi = [responsesTool("find", "Find files", { type: "object", properties: { p: { type: "string" } } })];
 const piOut = withFingerprintTools(pi, "/v1/responses");
 assert.equal(piOut.length, 12, "find passes through; the 11 roster slots inject beside it");
 const find = piOut.find((t) => String(t.name) === "find")!;
 assert.equal(find.description, "Find files", "caller find untouched");
 for (const t of piOut) {
  if (String(t.name) === "find") continue;
  assert.ok(!String(t.description).includes("never be invoked"), `${t.name}: verbatim CLI def`);
  const params = paramsOf(t) as { properties?: Record<string, unknown> };
  assert.ok(params.properties && Object.keys(params.properties).length > 0, `${t.name}: executable params`);
 }
});

test("fingerprint injection: OMP sextet inventory gains only the 5 missing roster slots; idempotent and case-insensitive", () => {
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
 const out = withFingerprintTools(full, "/v1/responses");
 assert.equal(out.length, 8 + 5, "sextet inventory gains skill/task/todowrite/webfetch/websearch");
 const names = out.map((t) => String(t.name));
 for (const n of ["skill", "task", "todowrite", "webfetch", "websearch"]) assert.ok(names.includes(n), `injected ${n}`);
 const partial = [responsesTool("ask", "a", { type: "object" }), responsesTool("glob", "g", { type: "object" })];
 const once = withFingerprintTools(partial, "/v1/responses");
 const twice = withFingerprintTools(once, "/v1/responses");
 assert.equal(twice.length, once.length, "fingerprint-once: re-inject adds zero tools");
 const cased = [{ type: "function", function: { name: "Bash", description: "b" } }];
 assert.equal(withFingerprintTools(cased, "/v1/chat/completions").length, 11, "Bash satisfies bash");
 const canon = canonicalizeTool({ type: "function", name: "read", description: "r", parameters: OMP_FINGERPRINT_DEFS.read.parameters });
 assert.ok(canon && Object.keys(canon.parameters.properties as Record<string, unknown>).length > 0);
});

test("enforce: partial caller [ask,glob] on /v1/responses yields verbatim 11-roster fills, all cloaked", () => {
 const body: Record<string, unknown> = {
  model: "nemotron-3.5-super-vl-free",
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
 assert.deepEqual(r.injected, ["bash", "edit", "grep", "read", "skill", "task", "todowrite", "webfetch", "websearch", "write"]);
 const tools = body.tools as Array<Record<string, unknown>>;
 assert.equal(tools.length, 12);
 for (const t of tools) {
  const name = String(t.name);
  if (name === "ask" || name === "glob") continue;
  assert.ok(!String(t.description).includes("never be invoked"), `${name}: verbatim definition, never a placeholder`);
  const params = t.parameters as { properties?: Record<string, unknown> };
  assert.ok(params.properties && Object.keys(params.properties).length > 0, `${name}: executable params`);
 }
 const read = tools.find((t) => t.name === "read");
 assert.ok(read);
 const readParams = read.parameters;
 assert.ok(readParams && typeof readParams === "object" && "required" in readParams);
 assert.deepEqual(readParams.required, ["filePath"], "verbatim CLI read schema");
 const edit = tools.find((t) => t.name === "edit");
 assert.ok(edit);
 const editParams = edit.parameters;
 assert.ok(editParams && typeof editParams === "object" && "required" in editParams);
 assert.deepEqual(editParams.required, ["filePath", "oldString", "newString"], "edit rides real-or-drop: the real schema");
});

test("enforce: model calling injected read is cloaked (not the caller's tool)", () => {
 const body: Record<string, unknown> = {
  model: "nemotron-3.5-super-vl-free",
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
   { type: "function_call", id: "fc_read", name: "read", arguments: '{"filePath":"x"}' },
   { type: "function_call", id: "fc_ask", name: "ask", arguments: '{"q":"y"}' },
  ],
 };
 const sse = `event: response.completed\ndata: {"type":"response.completed","response":${JSON.stringify(response)}}`;
 const out = sseToResponsesJson(sse, true, r.caseRestore, r.findGlob, r.injected) as {
  output: Array<{ type: string; name?: string }>;
 };
 assert.deepEqual(
  out.output.map((o) => o.name),
  ["ask"],
  "injected read call is cloaked; the caller-owned ask call survives",
 );
});

test("enforce: caller sextet+extras gains only the 5 missing roster slots", () => {
 const body: Record<string, unknown> = {
  model: "nemotron-3.5-super-vl-free",
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
 assert.deepEqual(r.injected, ["skill", "task", "todowrite", "webfetch", "websearch"]);
 assert.equal(r.addedTools, true);
 assert.equal((body.tools as unknown[]).length, 13);
});

test("enforce: Pi find caller keeps verbatim def and the 10 missing roster slots", () => {
 const findParams = { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] };
 const body: Record<string, unknown> = {
  model: "big-pickle",
  stream: false,
  tools: [responsesTool("find", "Find files", findParams)],
 };
 const r = enforceOpencodeFingerprint(body, "/v1/responses");
 assert.ok(r.injected.includes("bash") && r.injected.includes("read"), "roster slots still injected");
 assert.ok(!r.injected.includes("glob"), "renamed find satisfies the glob slot");
 assert.equal(r.injected.length, 10, "find->glob covers one of eleven");
 const tools = body.tools as Array<Record<string, unknown>>;
 const glob = tools.find((t) => t.name === "glob");
 assert.ok(glob);
 assert.equal(glob.description, "Find files", "caller find description verbatim");
 assert.deepEqual(glob.parameters, findParams);
 const bash = tools.find((t) => t.name === "bash");
 assert.ok(bash);
 const bashParams = bash.parameters;
 assert.ok(bashParams && typeof bashParams === "object" && "properties" in bashParams, "verbatim CLI bash schema");
 const props = bashParams.properties;
 assert.ok(props && typeof props === "object" && "workdir" in props, "verbatim bash carries workdir, not the old path-only shape");
});
