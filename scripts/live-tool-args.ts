/**
 * Live probe: what do free models ACTUALLY emit for a nested-array tool arg?
 *
 * OPT-IN diagnostic, never part of `npm test`. Sends the real OMP `todo`
 * schema (inlined literal, matching test/tool-translation-todo-full-schema)
 * through the local proxy and prints the RAW arguments string each model
 * returns, so argument malformation can be observed rather than assumed.
 *
 * Usage: node --experimental-strip-types --import ./test/setup.mjs scripts/live-tool-args.ts [model ...]
 *
 * Env:
 *   FF_FULL=1        send the full host tool inventory (the density that
 *                    triggers malformation; a lone tool stays canonical)
 *   FF_STREAM=1      ask for a streamed reply and reassemble it like a host
 *   FF_PATH=/v1/...  force the wire shape (default: the model's own)
 *   FF_TIMEOUT_MS=N  per-request budget (default 90000)
 */
import { startProxy } from "../src/proxy.ts";
import { ALL_HOST_TOOL_NAMES, injectFingerprintTools, translateToolsForPath } from "../src/tool-translation.ts";
import { MODEL_MAP } from "../src/models.ts";

const PORT = 29483;
const OP_ENUM = ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"];

/** Real OMP todo parameters (mirrors the full-schema test fixture). */
const TODO_PARAMS = {
 type: "object",
 properties: {
  op: { type: "string", enum: OP_ENUM, description: "operation to apply" },
  list: {
   type: "array",
   description: "phased task list (init)",
   items: {
    type: "object",
    properties: {
     phase: { type: "string", description: "phase name" },
     items: { type: "array", items: { type: "string", description: "task content" }, minItems: 1 },
    },
    required: ["phase", "items"],
   },
  },
  task: { type: "string", description: "task content" },
  phase: { type: "string", description: "phase name" },
  items: { type: "array", items: { type: "string", description: "task content" } },
  reason: { type: "string", description: "blocker note (block op)" },
 },
 required: ["op"],
};

const TODO_DESC = "apply a single todo operation";
const PROMPT =
 "Call the todo tool exactly once with op=init to record a two-phase plan: " +
 "phase 'Research' with tasks 'Map repo structure' and 'Trace auth flow', then " +
 "phase 'Synthesis' with task 'Write summary'. Do not write any text.";

/** Pull the raw tool-call arguments string out of a proxy JSON response. */
function argsFrom(json: unknown): { name: string; args: string } | null {
 if (!json || typeof json !== "object") return null;
 const rec = json as Record<string, unknown>;
 if (Array.isArray(rec.output)) {
  for (const item of rec.output as Array<Record<string, unknown>>) {
   if (item?.type === "function_call") {
    return { name: String(item.name ?? ""), args: String(item.arguments ?? "") };
   }
  }
 }
 const choices = rec.choices;
 if (Array.isArray(choices)) {
  for (const ch of choices as Array<Record<string, unknown>>) {
   const msg = ch?.message as Record<string, unknown> | undefined;
   const calls = msg?.tool_calls;
   if (Array.isArray(calls)) {
    const fn = (calls[0] as Record<string, unknown>)?.function as Record<string, unknown> | undefined;
    if (fn) return { name: String(fn.name ?? ""), args: String(fn.arguments ?? "") };
   }
  }
 }
 const content = rec.content;
 if (Array.isArray(content)) {
  for (const blk of content as Array<Record<string, unknown>>) {
   if (blk?.type === "tool_use") return { name: String(blk.name ?? ""), args: JSON.stringify(blk.input ?? null) };
  }
 }
 return null;
}

/** Classify an emitted argument payload against the intended shape. */
function classify(args: string): string {
 let v: unknown;
 try {
  v = JSON.parse(args);
 } catch {
  return "UNPARSEABLE";
 }
 if (!v || typeof v !== "object" || Array.isArray(v)) return "NOT-AN-OBJECT";
 const rec = v as Record<string, unknown>;
 const notes: string[] = [];
 if (Array.isArray(rec.list)) notes.push("list:array");
 if (rec.list !== undefined && !Array.isArray(rec.list)) notes.push(`list:${typeof rec.list}`);
 if (Array.isArray(rec.items)) {
  const first = rec.items[0];
  notes.push(`items:array<${typeof first}>`);
  if (typeof first === "string" && first.trim().startsWith("{")) notes.push("JSON-STRING-IN-ITEMS");
 } else if (rec.items !== undefined) {
  notes.push(`items:${typeof rec.items}`);
  if (rec.items && typeof rec.items === "object") {
   const keys = Object.keys(rec.items as object).join("|");
   notes.push(`items.OBJKEYS=${keys}`);
  }
 }
 if (Array.isArray(rec.list)) {
  for (const entry of rec.list as Array<Record<string, unknown>>) {
   if (entry && typeof entry === "object" && entry.items !== undefined && !Array.isArray(entry.items)) {
    notes.push(`NESTED-items:${typeof entry.items}(${Object.keys(entry.items as object).join("|")})`);
   }
  }
 }
 if (rec.op !== "init") notes.push(`op:${String(rec.op)}`);
 return notes.length > 0 ? notes.join(" ") : "canonical";
}

/**
 * Reassemble a streamed reply the way a host does: concatenate every argument
 * fragment per tool-call index, so the probe sees exactly what OMP would.
 */
function callFromSse(sse: string, endpoint: string): { name: string; args: string } | null {
  const byIndex = new Map<number, { name: string; args: string }>();
  for (const block of sse.split(/\r?\n\r?\n/)) {
   const line = block.split(/\r?\n/).find((candidate) => candidate.startsWith("data:"));
   if (!line) continue;
   const data = line.slice(5).trim();
   if (data === "" || data === "[DONE]") continue;
   let parsed: Record<string, unknown>;
   try {
    parsed = JSON.parse(data) as Record<string, unknown>;
   } catch {
    continue;
   }
   if (endpoint === "/v1/chat/completions") {
    const choices = parsed.choices;
    if (!Array.isArray(choices)) continue;
    for (const choice of choices as Array<Record<string, unknown>>) {
     const delta = choice?.delta as Record<string, unknown> | undefined;
     const calls = delta?.tool_calls;
     if (!Array.isArray(calls)) continue;
     for (const tc of calls as Array<Record<string, unknown>>) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      const fn = tc.function as Record<string, unknown> | undefined;
      const entry = byIndex.get(idx) ?? { name: "", args: "" };
      if (typeof fn?.name === "string" && fn.name !== "") entry.name = fn.name;
      if (typeof fn?.arguments === "string") entry.args += fn.arguments;
      byIndex.set(idx, entry);
     }
    }
    continue;
   }
   if (endpoint === "/v1/messages") {
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const index = typeof parsed.index === "number" ? parsed.index : 0;
    if (type === "content_block_start") {
     const block = parsed.content_block as Record<string, unknown> | undefined;
     if (block?.type === "tool_use" && typeof block.name === "string") {
      byIndex.set(index, { name: block.name, args: "" });
     }
    } else if (type === "content_block_delta") {
     const delta = parsed.delta as Record<string, unknown> | undefined;
     if (typeof delta?.partial_json === "string") {
      const entry = byIndex.get(index) ?? { name: "", args: "" };
      entry.args += delta.partial_json;
      byIndex.set(index, entry);
     }
    }
    continue;
   }
   const type = typeof parsed.type === "string" ? parsed.type : "";
   const index = typeof parsed.output_index === "number" ? parsed.output_index : 0;
   if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = parsed.item as Record<string, unknown> | undefined;
    if (item?.type === "function_call" && typeof item.name === "string") {
     const entry = byIndex.get(index) ?? { name: "", args: "" };
     entry.name = item.name;
     if (type === "response.output_item.done" && typeof item.arguments === "string") entry.args = item.arguments;
     byIndex.set(index, entry);
    }
   } else if (type === "response.function_call_arguments.done" && typeof parsed.arguments === "string") {
    const entry = byIndex.get(index) ?? { name: "", args: "" };
    entry.args = parsed.arguments;
    byIndex.set(index, entry);
   }
  }
  for (const entry of byIndex.values()) {
   if (entry.name !== "" && entry.args !== "") return entry;
  }
  return null;
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const models = targets.length > 0 ? targets : ["muse-spark-1.3-contributor-free", "mimo-v2.6-flash-free"];
const { server, port } = await startProxy(PORT);
try {
 for (const model of models) {
  if (!MODEL_MAP.has(model)) {
   console.log(`${model.padEnd(38)} SKIP (not in MODEL_MAP)`);
   continue;
  }
  const override = process.env.FF_PATH;
  const endpoint = override ?? (MODEL_MAP.get(model)?.api === "openai-chat" ? "/v1/chat/completions" : "/v1/responses");
  // FF_FULL=1 mirrors the real caller: every OMP host tool plus the six
  // injected fingerprint slots, which is the tool-set density that triggers
  // the malformation (a lone todo tool stays canonical).
  const requested = process.env.FF_FULL === "1"
   ? [
     // `todo` is already in ALL_HOST_TOOL_NAMES: keeping its empty stub too
     // would win the first-seen-wins dedup and hide the real schema.
     ...[...ALL_HOST_TOOL_NAMES].filter((name) => name !== "todo").map((name) => ({ type: "function", name, description: `${name} tool`, parameters: { type: "object", properties: {} } })),
     { type: "function", name: "todo", description: TODO_DESC, parameters: TODO_PARAMS },
    ]
   : [{ type: "function", name: "todo", description: TODO_DESC, parameters: TODO_PARAMS }];
  const tools = injectFingerprintTools(translateToolsForPath(requested, endpoint), endpoint);
  // Zen accepts only tool_choice "auto", so the prompt alone must elicit the call.
  const payload =
   endpoint === "/v1/chat/completions"
    ? { model, messages: [{ role: "user", content: PROMPT }], stream: false, tools }
    : endpoint === "/v1/messages"
     ? { model, messages: [{ role: "user", content: PROMPT }], max_tokens: 4096, stream: false, tools }
     : { model, input: [{ role: "user", content: [{ type: "input_text", text: PROMPT }] }], stream: false, tools };
  const streaming = process.env.FF_STREAM === "1";
  (payload as Record<string, unknown>).stream = streaming;
  let text: string;
  try {
   const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(process.env.FF_TIMEOUT_MS ?? 90_000)),
   });
   text = await res.text();
   if (!res.ok) {
    console.log(`${model.padEnd(38)} HTTP ${res.status} ${text.slice(0, 150)}`);
    continue;
   }
  } catch (e) {
   console.log(`${model.padEnd(38)} FAILED ${(e as Error).message}`);
   continue;
  }
  const call = streaming ? callFromSse(text, endpoint) : argsFrom(JSON.parse(text));
  if (!call) {
   console.log(`${model.padEnd(38)} NO-TOOL-CALL ${text.slice(0, 150)}`);
   continue;
  }
  console.log(`${model.padEnd(38)}${streaming ? " stream" : ""} [${classify(call.args)}]`);
  console.log(`   raw: ${call.args.slice(0, 400)}`);
 }
} finally {
 await new Promise<void>((r) => {
  if (server === null) r();
  else server.close(() => r());
 });
}