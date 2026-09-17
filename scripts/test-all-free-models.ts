/**
 * Harness-accuracy validation of every free model in pi-freeflow.
 *
 * Drives the local proxy exactly as the OMP / Pi harness does, and checks the
 * four capabilities an agent and its subagents actually depend on:
 *   1. streaming text response
 *   2. tool-call emission
 *   3. follow-up turn that replays the tool result (the agent loop)
 *   4. reasoning passthrough where the model declares it
 *
 * Read-only: starts a short-lived proxy and touches no on-disk state.
 */

import { startProxy } from "../src/proxy.ts";
import { OPENCODE_MODELS, KILO_MODELS, ALL_MODELS } from "../src/models.ts";
import { opencodeHeaders } from "../src/config.ts";
import type { ModelDef } from "../src/types.ts";

const TEST_PORT = 29480;
/** Slow free models (nemotron 3.5 lightning) legitimately need minutes. */
const REQUEST_TIMEOUT_MS = 300_000;
/** Agent harnesses always budget generously; reasoning eats from this. */
const MAX_OUTPUT_TOKENS = 8_000;

const TOOLS = [
 {
  type: "function",
  function: {
   name: "get_weather",
   description: "Get the current weather for a city",
   parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
   },
  },
 },
];

interface Capability {
 stream: boolean;
 toolCall: boolean;
 agentLoop: boolean;
 reasoning: boolean;
 ttfbMs: number;
 totalMs: number;
 status: number;
 detail: string;
}

const delay = (ms: number): Promise<void> => {
 const { promise, resolve } = Promise.withResolvers<void>();
 setTimeout(resolve, ms);
 return promise;
};

function isResponses(model: ModelDef): boolean {
 return model.api === "openai-responses";
}

function endpointFor(port: number, model: ModelDef): string {
 return isResponses(model)
  ? `http://127.0.0.1:${port}/v1/responses`
  : `http://127.0.0.1:${port}/v1/chat/completions`;
}

interface StreamOutcome {
 status: number;
 text: string;
 reasoning: string;
 toolName: string | null;
 toolArgs: string;
 ttfbMs: number;
 totalMs: number;
 error?: string;
}

/** Parse an SSE stream and extract text / reasoning / tool-call signals. */
async function readStream(res: Response, start: number, responses: boolean): Promise<StreamOutcome> {
 const outcome: StreamOutcome = {
  status: res.status,
  text: "",
  reasoning: "",
  toolName: null,
  toolArgs: "",
  ttfbMs: -1,
  totalMs: 0,
 };
 const reader = res.body?.getReader();
 if (!reader) {
  outcome.error = "no response body";
  return outcome;
 }
 const decoder = new TextDecoder();
 let buffer = "";
 for (; ;) {
  const { done, value } = await reader.read();
  if (done) break;
  if (outcome.ttfbMs === -1) outcome.ttfbMs = Date.now() - start;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
   const trimmed = line.trim();
   if (!trimmed.startsWith("data:")) continue;
   const dataStr = trimmed.slice(5).trim();
   if (!dataStr || dataStr === "[DONE]") continue;
   let parsed: Record<string, unknown>;
   try {
    parsed = JSON.parse(dataStr) as Record<string, unknown>;
   } catch {
    continue;
   }
   if (responses) {
    const type = parsed.type;
    if (type === "response.output_text.delta" && typeof parsed.delta === "string") {
     outcome.text += parsed.delta;
    }
    if (type === "response.reasoning_summary_text.delta" && typeof parsed.delta === "string") {
     outcome.reasoning += parsed.delta;
    }
    if (type === "response.output_item.done") {
     const item = parsed.item as Record<string, unknown> | undefined;
     if (item?.type === "function_call") {
      outcome.toolName = typeof item.name === "string" ? item.name : null;
      outcome.toolArgs = typeof item.arguments === "string" ? item.arguments : "";
     }
    }
   } else {
    const choices = parsed.choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
    if (!delta) continue;
    if (typeof delta.content === "string") outcome.text += delta.content;
    if (typeof delta.reasoning_content === "string") outcome.reasoning += delta.reasoning_content;
    if (typeof delta.reasoning === "string") outcome.reasoning += delta.reasoning;
    const calls = delta.tool_calls;
    if (Array.isArray(calls) && calls.length > 0) {
     const fn = (calls[0] as Record<string, unknown>).function as Record<string, unknown> | undefined;
     if (fn) {
      if (typeof fn.name === "string" && fn.name) outcome.toolName = fn.name;
      if (typeof fn.arguments === "string") outcome.toolArgs += fn.arguments;
     }
    }
   }
  }
 }
 outcome.totalMs = Date.now() - start;
 return outcome;
}

/** Round 1: streaming request that asks the model to call a tool. */
async function probeStream(port: number, model: ModelDef): Promise<StreamOutcome> {
 const responses = isResponses(model);
 const start = Date.now();
 const body = responses
  ? {
   model: model.id,
   input: [{ role: "user", content: "What is the weather in Tokyo? Call the get_weather tool." }],
   tools: TOOLS,
   tool_choice: "auto",
   max_output_tokens: MAX_OUTPUT_TOKENS,
   stream: true,
   reasoning: { effort: "high" },
   include: ["reasoning.encrypted_content"],
  }
  : {
   model: model.id,
   messages: [{ role: "user", content: "What is the weather in Tokyo? Call the get_weather tool." }],
   tools: TOOLS,
   tool_choice: "auto",
   max_tokens: MAX_OUTPUT_TOKENS,
   stream: true,
   ...(model.reasoning ? { reasoning_effort: "high" } : {}),
  };
 try {
  const res = await fetch(endpointFor(port, model), {
   method: "POST",
   headers: { "content-type": "application/json", accept: "text/event-stream" },
   body: JSON.stringify(body),
   signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
   const text = await res.text();
   return {
    status: res.status,
    text: "",
    reasoning: "",
    toolName: null,
    toolArgs: "",
    ttfbMs: Date.now() - start,
    totalMs: Date.now() - start,
    error: text.slice(0, 200),
   };
  }
  return await readStream(res, start, responses);
 } catch (e) {
  return {
   status: 0,
   text: "",
   reasoning: "",
   toolName: null,
   toolArgs: "",
   ttfbMs: -1,
   totalMs: Date.now() - start,
   error: (e as Error)?.message || String(e),
  };
 }
}

/** Round 2: agent loop — replay the tool result and expect a final answer. */
async function probeAgentLoop(
 port: number,
 model: ModelDef,
 toolName: string,
 toolArgs: string,
): Promise<{ ok: boolean; status: number; text: string; ms: number; error?: string }> {
 const responses = isResponses(model);
 const start = Date.now();
 const toolCallId = "call_loop_1";
 const body = responses
  ? {
   model: model.id,
   input: [
    { role: "user", content: "What is the weather in Tokyo? Call the get_weather tool." },
    { type: "function_call", call_id: toolCallId, name: toolName, arguments: toolArgs },
    { type: "function_call_output", call_id: toolCallId, output: '{"tempC":21,"condition":"sunny"}' },
   ],
   tools: TOOLS,
   max_output_tokens: MAX_OUTPUT_TOKENS,
   stream: false,
   reasoning: { effort: "high" },
  }
  : {
   model: model.id,
   messages: [
    { role: "user", content: "What is the weather in Tokyo? Call the get_weather tool." },
    {
     role: "assistant",
     content: null,
     tool_calls: [
      {
       id: toolCallId,
       type: "function",
       function: { name: toolName, arguments: toolArgs || '{"city":"Tokyo"}' },
      },
     ],
    },
    { role: "tool", tool_call_id: toolCallId, content: '{"tempC":21,"condition":"sunny"}' },
   ],
   tools: TOOLS,
   max_tokens: MAX_OUTPUT_TOKENS,
   stream: false,
   ...(model.reasoning ? { reasoning_effort: "high" } : {}),
  };
 try {
  const res = await fetch(endpointFor(port, model), {
   method: "POST",
   headers: { "content-type": "application/json", accept: "application/json" },
   body: JSON.stringify(body),
   signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const ms = Date.now() - start;
  if (!res.ok) {
   return { ok: false, status: res.status, text: "", ms, error: (await res.text()).slice(0, 200) };
  }
  const json = (await res.json()) as Record<string, unknown>;
  let text = "";
  if (responses) {
   const output = json.output;
   if (Array.isArray(output)) {
    for (const item of output) {
     const entry = item as Record<string, unknown>;
     if (entry.type !== "message" || !Array.isArray(entry.content)) continue;
     for (const part of entry.content) {
      const piece = part as Record<string, unknown>;
      if (piece.type === "output_text" && typeof piece.text === "string") text += piece.text;
     }
    }
   }
  } else {
   const choices = json.choices;
   if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string") text = message.content;
   }
  }
  return { ok: text.trim().length > 0, status: res.status, text: text.trim().replace(/\s+/g, " "), ms };
 } catch (e) {
  return { ok: false, status: 0, text: "", ms: Date.now() - start, error: (e as Error)?.message || String(e) };
 }
}

async function validateModel(port: number, model: ModelDef): Promise<Capability> {
 const stream = await probeStream(port, model);
 const cap: Capability = {
  stream: stream.status === 200 && (stream.text.length > 0 || stream.toolName !== null),
  toolCall: stream.toolName === "get_weather",
  agentLoop: false,
  reasoning: stream.reasoning.length > 0,
  ttfbMs: stream.ttfbMs,
  totalMs: stream.totalMs,
  status: stream.status,
  detail: stream.error ?? "",
 };
 if (!cap.toolCall) {
  cap.detail = cap.detail || `no tool call (text ${stream.text.length}c, reason ${stream.reasoning.length}c)`;
  return cap;
 }
 await delay(1_000);
 const loop = await probeAgentLoop(port, model, stream.toolName ?? "get_weather", stream.toolArgs);
 cap.agentLoop = loop.ok;
 if (!loop.ok && !cap.detail) cap.detail = loop.error ?? `agent loop returned no text (HTTP ${loop.status})`;
 return cap;
}

async function main(): Promise<void> {
 const { server, port } = await startProxy(TEST_PORT);
 console.log(`proxy on :${port}`);
 console.log(
  `spoof headers: UA=${opencodeHeaders()["User-Agent"]} session=${opencodeHeaders()["x-opencode-session"]?.slice(0, 12)}…\n`,
 );

 const targets: ModelDef[] = [...OPENCODE_MODELS, ...KILO_MODELS];
 const rows: Array<{ id: string; vendor: string; cap: Capability }> = [];

 for (const model of targets) {
  const vendor = OPENCODE_MODELS.includes(model) ? "zen" : "kilo";
  process.stdout.write(`[${vendor}] ${model.id} … `);
  const cap = await validateModel(port, model);
  rows.push({ id: model.id, vendor, cap });
  const marks = `${cap.stream ? "S" : "-"}${cap.toolCall ? "T" : "-"}${cap.agentLoop ? "L" : "-"}${cap.reasoning ? "R" : "-"}`;
  const verdict = cap.stream && cap.toolCall && cap.agentLoop ? "PASS" : cap.stream ? "PARTIAL" : "FAIL";
  console.log(
   `${verdict} [${marks}] http=${cap.status} ttfb=${cap.ttfbMs}ms total=${cap.totalMs}ms${cap.detail ? ` — ${cap.detail}` : ""}`,
  );
  await delay(1_500);
 }

 await server.close();

 console.log("\n=== capability matrix (S=stream T=toolCall L=agentLoop R=reasoning) ===");
 for (const row of rows) {
  const c = row.cap;
  const marks = `${c.stream ? "S" : "-"}${c.toolCall ? "T" : "-"}${c.agentLoop ? "L" : "-"}${c.reasoning ? "R" : "-"}`;
  console.log(`${marks}  ${row.id}`);
 }

 const full = rows.filter((r) => r.cap.stream && r.cap.toolCall && r.cap.agentLoop);
 const partial = rows.filter((r) => r.cap.stream && !(r.cap.toolCall && r.cap.agentLoop));
 const dead = rows.filter((r) => !r.cap.stream);
 console.log(`\nagent-ready (stream+tool+loop): ${full.length}/${rows.length}`);
 for (const r of full) console.log(`  ✓ ${r.id}`);
 if (partial.length > 0) {
  console.log(`partial (streams but agent-loop unverified): ${partial.length}`);
  for (const r of partial) console.log(`  ~ ${r.id} — ${r.cap.detail}`);
 }
 if (dead.length > 0) {
  console.log(`unavailable: ${dead.length}`);
  for (const r of dead) console.log(`  ✗ ${r.id} — ${r.cap.detail}`);
 }

 console.log(`\n(ALL_MODELS catalog size: ${ALL_MODELS.length})`);
 process.exit(dead.length > 0 ? 1 : 0);
}

main().catch((err) => {
 console.error("runner crashed:", err);
 process.exit(1);
});
