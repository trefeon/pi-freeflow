/**
 * Full-schema fidelity for the OMP `todo` caller tool across all three wire
 * APIs. Previous tests only used a tiny `{ op }` stub, so a regression that
 * dropped `description`, emptied `parameters`, stripped/added `strict`, or
 * flattened the nested `list`/`items` shape would slip through — and the
 * model would then emit `todo op:init` without a `list`, surfacing as
 * `Errors: Missing list for init operation`. Ground truth is the real OMP
 * schema (reference/oh-my-pi/.../tools/todo.ts:69-88), inlined below as a
 * literal (never imported from reference/).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
 canonicalizeTool,
 toAnthropicTool,
 toChatTool,
 toResponsesTool,
 translateToolsForPath,
} from "../src/tool-translation.ts";

const TODO_DESCRIPTION = "apply a single todo operation";
const OP_ENUM = ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"];

/** Real OMP todo parameters: op enum + phased list + task/phase/items/reason. */
function todoParameters(): Record<string, unknown> {
 return {
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
      items: {
       type: "array",
       items: { type: "string", description: "task content" },
       minItems: 1,
       description: "tasks for this phase",
      },
     },
     required: ["phase", "items"],
    },
   },
   task: { type: "string", description: "task content" },
   phase: { type: "string", description: "phase name" },
   items: {
    type: "array",
    items: { type: "string", description: "task content" },
    description: "tasks for single-phase init or append",
   },
   reason: { type: "string", description: "blocker note (block op)" },
  },
  required: ["op"],
 };
}

function chatTodo(strict: boolean): Record<string, unknown> {
 return {
  type: "function",
  function: { name: "todo", description: TODO_DESCRIPTION, parameters: todoParameters() },
  strict,
 };
}

function responsesTodo(strict: boolean): Record<string, unknown> {
 return {
  type: "function",
  name: "todo",
  description: TODO_DESCRIPTION,
  parameters: todoParameters(),
  strict,
 };
}

function anthropicTodo(strict: boolean): Record<string, unknown> {
 return {
  name: "todo",
  description: TODO_DESCRIPTION,
  input_schema: todoParameters(),
  strict,
 };
}

const PATHS = ["/v1/chat/completions", "/v1/responses", "/v1/messages"] as const;

function wireName(tool: Record<string, unknown>): string {
 if (typeof tool.name === "string") return tool.name;
 const fn = tool.function as Record<string, unknown>;
 return fn.name as string;
}

function wireSchema(tool: Record<string, unknown>): Record<string, unknown> {
 if ("input_schema" in tool) return tool.input_schema as Record<string, unknown>;
 if ("parameters" in tool) return tool.parameters as Record<string, unknown>;
 return (tool.function as Record<string, unknown>).parameters as Record<string, unknown>;
}

function wireDescription(tool: Record<string, unknown>): string {
 if (typeof tool.description === "string") return tool.description;
 return (tool.function as Record<string, unknown>).description as string;
}

test("todo full schema: canonicalize keeps description/parameters/strict on every wire shape", () => {
 for (const tool of [chatTodo(true), responsesTodo(false), anthropicTodo(true)]) {
  const canon = canonicalizeTool(tool);
  assert.ok(canon, "todo is a function tool, never dropped");
  assert.equal(canon.name, "todo");
  assert.equal(canon.description, TODO_DESCRIPTION);
  assert.deepEqual(canon.parameters, todoParameters());
  const props = (canon.parameters.properties as Record<string, unknown>);
  assert.deepEqual((props.op as Record<string, unknown>).enum, OP_ENUM);
  const list = props.list as Record<string, unknown>;
  const entry = (list.items as Record<string, unknown>).properties as Record<string, unknown>;
  assert.equal((entry.phase as Record<string, unknown>).description, "phase name");
  assert.equal(((entry.items as Record<string, unknown>).items as Record<string, unknown>).description, "task content");
 }
 assert.equal(canonicalizeTool(chatTodo(true))?.strict, true);
 assert.equal(canonicalizeTool(responsesTodo(false))?.strict, false);
});

test("todo full schema: converters carry description/parameters/strict verbatim", () => {
 const canon = canonicalizeTool(chatTodo(true))!;
 assert.deepEqual(toChatTool(canon).function, {
  name: "todo",
  description: TODO_DESCRIPTION,
  parameters: canon.parameters,
 });
 assert.equal((toChatTool(canon) as Record<string, unknown>).strict, true);
 const responses = toResponsesTool(canonicalizeTool(responsesTodo(false))!);
 assert.equal(responses.name, "todo");
 assert.equal(responses.description, TODO_DESCRIPTION);
 assert.deepEqual(responses.parameters, todoParameters());
 assert.equal(responses.strict, false);
 const anthropic = toAnthropicTool(canon);
 assert.equal(anthropic.name, "todo");
 assert.deepEqual(anthropic.input_schema, todoParameters());
 assert.equal(anthropic.strict, true);
});

test("todo full schema: translateToolsForPath is lossless on all three paths", () => {
 const callers = [chatTodo(true), responsesTodo(false), anthropicTodo(true)] as Array<Record<string, unknown>>;
 for (const path of PATHS) {
  for (const caller of callers) {
   const [out] = translateToolsForPath([caller], path);
   assert.equal(wireName(out), "todo", `${path}: canonical name survives verbatim`);
   assert.equal(wireDescription(out), TODO_DESCRIPTION, `${path}: description survives`);
   assert.deepEqual(wireSchema(out), todoParameters(), `${path}: nested list/items shape intact`);
   assert.equal(out.strict, (caller.strict ?? (caller.function as Record<string, unknown> | undefined)?.strict), `${path}: strict survives`);
  }
 }
});

test("todo full schema: re-translate is idempotent and dedupe keeps the single todo", () => {
 for (const path of PATHS) {
  const once = translateToolsForPath([chatTodo(true)], path);
  const twice = translateToolsForPath(once, path);
  assert.equal(twice.length, 1, `${path}: re-translate adds zero tools`);
  assert.deepEqual(twice[0], once[0]);
  // todo alongside other tools: first-seen-wins never collapses the todo away.
  const mixed = translateToolsForPath(
   [chatTodo(true), { type: "function", function: { name: "bash", description: "b", parameters: { type: "object" } } }],
   path,
  );
  assert.equal(mixed.length, 2, `${path}: nothing dropped`);
  assert.ok(mixed.some((t) => wireName(t) === "todo"), `${path}: todo kept`);
  assert.deepEqual(wireSchema(mixed.find((t) => wireName(t) === "todo")!), todoParameters());
 }
});
