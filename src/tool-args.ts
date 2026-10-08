/**
 * Schema-driven repair for model-emitted tool-call arguments.
 *
 * Free models reliably lose tool-argument fidelity once a request carries a
 * full agent tool inventory. Probed live 2026-10-08 against OpenCode Zen with
 * the real OMP `todo` schema: at one tool the same model emits the canonical
 * `list: [{ phase, items }]`, but at ~70 tools it delivered structured phases
 * JSON-encoded into the flat string list, with each inner array wrapped as
 * `items: { item: [...] }`. Sibling free models invented whole vocabularies
 * (`phases` / `name` / `tasks`) the schema never declared.
 *
 * Two families are mechanically decidable from the CALLER's own declared
 * schema, and this module repairs exactly those:
 *
 * - Envelope unwrap: a declared array that arrives wrapped in a single-key
 *   object (`items: { item: [...] }`) is unwrapped.
 * - JSON-string decode: a declared object/array that arrives as a JSON string
 *   is parsed. Declared `string` properties are never decoded.
 * - Structured promotion: a declared object-array property left ABSENT, with a
 *   declared string-array property whose every element parses to an object that
 *   validates against the object-array's item schema, is promoted across.
 *   Every element must validate, so one JSON-looking task label never moves.
 *
 * Invented vocabulary is deliberately NOT repaired: renaming `phases` to `list`
 * is a naming coincidence, not a schema fact, and a generic proxy that guesses
 * it would corrupt the next tool. Those calls ride verbatim and surface the
 * host's own schema error. This mirrors the reference upstream, which also
 * declines to fake a legal-looking argument packet
 * (channel-pack/src/sse.ts normalizeToolArguments / isTruncatedArguments).
 *
 * Arguments change only when the result matches the declared schema, so
 * well-formed calls come back byte-identical and truncated JSON is never
 * completed.
 */

import { canonicalizeTool } from "./tool-translation.ts";

/** Bound on recursive repair/validation; real host schemas nest 3-4 deep. */
const MAX_DEPTH = 8;

/** Declared JSON Schema type, tolerating union types like ["array","null"]. */
function schemaType(schema: Record<string, unknown>): string {
  const declared = schema.type;
  if (typeof declared === "string") return declared;
  if (Array.isArray(declared)) {
    for (const entry of declared) if (entry === "object" || entry === "array") return entry;
    if (typeof declared[0] === "string") return declared[0];
  }
  return "";
}

/** A schema property worth repairing: it holds an object or an array. */
function structuralProperty(schema: Record<string, unknown>): boolean {
  const type = schemaType(schema);
  return type === "object" || type === "array";
}

/**
 * Does a value already satisfy the declared schema? Type, then required keys,
 * then each present property recursively. A present property the schema does
 * not declare is ignored (never fails): hosts decide their own extras policy,
 * and this only gates whether a promotion is safe.
 */
function matchesSchema(value: unknown, schema: Record<string, unknown>, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const type = schemaType(schema);
  if (type === "array") {
   if (!Array.isArray(value)) return false;
   const items = schema.items;
   if (items === null || typeof items !== "object" || Array.isArray(items)) return true;
   return value.every((element) => matchesSchema(element, items as Record<string, unknown>, depth + 1));
  }
  if (type === "object") {
   if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
   const rec = value as Record<string, unknown>;
   if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
     if (typeof key === "string" && !(key in rec)) return false;
    }
   }
   const props = schema.properties;
   if (props === null || typeof props !== "object" || Array.isArray(props)) return true;
   for (const [key, entry] of Object.entries(rec)) {
    const propSchema = (props as Record<string, unknown>)[key];
    if (propSchema === null || typeof propSchema !== "object" || Array.isArray(propSchema)) continue;
    if (!matchesSchema(entry, propSchema as Record<string, unknown>, depth + 1)) return false;
   }
   return true;
  }
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (Array.isArray(schema.enum)) return schema.enum.some((member) => member === value);
  return true;
}

/**
 * Repair one value against its declared schema: decode a JSON-string object or
 * array, unwrap a single-key envelope around an array, then recurse into array
 * items and object properties. Returns the input untouched when nothing
 * applies, so callers can gate re-serialization on `changed`.
 */
function repairValue(
  value: unknown,
  schema: Record<string, unknown>,
  depth: number,
): { value: unknown; changed: boolean } {
  if (depth > MAX_DEPTH) return { value, changed: false };
  const type = schemaType(schema);
  if (type !== "array" && type !== "object") return { value, changed: false };

  // Declared object/array that arrived as a JSON string: decode and retry.
  if (typeof value === "string") {
   const trimmed = value.trim();
   if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
     const parsed: unknown = JSON.parse(trimmed);
     if (parsed !== null && typeof parsed === "object") {
      const inner = repairValue(parsed, schema, depth + 1);
      return { value: inner.value, changed: true };
     }
    } catch {
     // Truncated or non-JSON prose: never complete it.
    }
   }
   return { value, changed: false };
  }

  if (type === "array") {
   // Single-key envelope around the real array: { item: [...] } -> [...]
   let candidate = value;
   if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && Array.isArray(entries[0][1])) candidate = entries[0][1];
   }
   if (candidate !== value) {
    const inner = repairValue(candidate, schema, depth + 1);
    return { value: inner.value, changed: true };
   }
   if (!Array.isArray(value)) return { value, changed: false };
   const items = schema.items;
   if (items === null || typeof items !== "object" || Array.isArray(items)) return { value, changed: false };
   let changed = false;
   const out = value.map((element) => {
    const repaired = repairValue(element, items as Record<string, unknown>, depth + 1);
    if (repaired.changed) changed = true;
    return repaired.value;
   });
   return { value: changed ? out : value, changed };
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
   return { value, changed: false };
  }
  const props = schema.properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
   return { value, changed: false };
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
   const propSchema = (props as Record<string, unknown>)[key];
   if (propSchema === null || typeof propSchema !== "object" || Array.isArray(propSchema)) {
    out[key] = entry;
    continue;
   }
   const repaired = repairValue(entry, propSchema as Record<string, unknown>, depth + 1);
   if (repaired.changed) changed = true;
   out[key] = repaired.value;
  }
  return { value: changed ? out : value, changed };
}

/**
 * Move an emitted object's unknown keys onto the declared properties it left
 * missing, but only when the mapping is FORCED: every unknown key must have
 * exactly one structurally compatible missing property (the single missing
 * string slot, the single missing array slot, ...). Nothing is matched by name
 * similarity, and an ambiguous element returns null so the caller discards it.
 *
 * This is what recovers the free models' invented parallel vocabulary — a
 * model that writes `{ name, tasks }` for a declared `{ phase, items }` is
 * mapped by role, not by guessing that `name` means `phase`.
 */
function adoptDeclaredKeys(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
 ): Record<string, unknown> | null {
  const props = schema.properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) return null;
  const declared = props as Record<string, Record<string, unknown>>;
  const unknownKeys = Object.keys(value).filter((key) => !(key in declared));
  // Nothing unknown: the element already states its intent, so leave it be.
  if (unknownKeys.length === 0) return null;
  const missing = Object.keys(declared).filter((key) => !(key in value));
  if (unknownKeys.length > missing.length) return null;
  const taken = new Set<string>();
  const targets = new Map<string, string>();
  for (const key of unknownKeys) {
   const raw = value[key];
   const want = Array.isArray(raw) ? "array" : raw !== null && typeof raw === "object" ? "object" : typeof raw;
   const candidates = missing.filter((name) => !taken.has(name) && schemaType(declared[name]) === want);
   if (candidates.length !== 1) return null;
   taken.add(candidates[0]);
   targets.set(key, candidates[0]);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[targets.get(key) ?? key] = entry;
  return out;
}

/** True when every key on the object is declared by the schema. */
function elementKeysDeclared(value: Record<string, unknown>, schema: Record<string, unknown>): boolean {
  const props = schema.properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) return false;
  return Object.keys(value).every((key) => key in (props as Record<string, unknown>));
}

/**
 * Move a model's misplaced phases into the declared object-array property it
 * left absent. Two source shapes are accepted, both reproduced live against
 * the free models: a declared string-array whose elements are JSON-encoded
 * phase objects, and an entirely undeclared property holding phase objects
 * under invented names. Either way EVERY element must end up validating
 * against the target item schema, so one JSON-looking task label or one
 * ambiguous element discards the whole move and the call rides through
 * untouched.
 */
function promoteStringArray(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  if (depth > MAX_DEPTH) return args;
  const props = schema.properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) return args;
  const declared = props as Record<string, Record<string, unknown>>;
  const required = new Set(
   Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [],
  );
  const out = { ...args };
  let moved = false;
  for (const [targetName, targetSchema] of Object.entries(declared)) {
   if (schemaType(targetSchema) !== "array") continue;
   const targetItems = targetSchema.items;
   if (targetItems === null || typeof targetItems !== "object" || Array.isArray(targetItems)) continue;
   if (schemaType(targetItems as Record<string, unknown>) !== "object") continue;
   if (targetName in out) continue;
   for (const [sourceName, sourceValue] of Object.entries(args)) {
    if (sourceName === targetName) continue;
    const sourceSchema = declared[sourceName];
    // A DECLARED source must be a scalar-item array: that is the only way a
    // string slot can legitimately hold an encoded structure. An UNDECLARED
    // source is the invented-vocabulary shape and is accepted as emitted.
    if (sourceSchema !== undefined) {
     if (schemaType(sourceSchema) !== "array") continue;
     const sourceItems = sourceSchema.items;
     if (sourceItems !== null && typeof sourceItems === "object" && !Array.isArray(sourceItems) &&
      schemaType(sourceItems as Record<string, unknown>) === "object") continue;
    }
    // A JSON-string source stands for the array it encodes.
    let source: unknown = sourceValue;
    if (typeof source === "string") {
     const trimmed = source.trim();
     if (!trimmed.startsWith("[")) continue;
     try {
      source = JSON.parse(trimmed);
     } catch {
      continue;
     }
    }
    if (!Array.isArray(source) || source.length === 0) continue;
    const promoted: unknown[] = [];
    let usable = true;
    for (const element of source) {
     let parsed: unknown = element;
     if (typeof parsed === "string") {
      try {
       parsed = JSON.parse(parsed);
      } catch {
       usable = false;
       break;
      }
     }
     if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      usable = false;
      break;
     }
     const item = parsed as Record<string, unknown>;
     const repaired = repairValue(item, targetItems as Record<string, unknown>, depth + 1);
     const shaped =
      repaired.value !== null && typeof repaired.value === "object" && !Array.isArray(repaired.value)
       ? (repaired.value as Record<string, unknown>)
       : item;
     const adopted = adoptDeclaredKeys(shaped, targetItems as Record<string, unknown>);
     const candidate = adopted ?? shaped;
     if (!elementKeysDeclared(candidate, targetItems as Record<string, unknown>)) {
      // Keys the schema never declares survived and could not be placed:
      // promoting would smuggle the model's invention into the host.
      usable = false;
      break;
     }
     if (!matchesSchema(candidate, targetItems as Record<string, unknown>, depth + 1)) {
      usable = false;
      break;
     }
     promoted.push(candidate);
    }
    if (!usable) continue;
    out[targetName] = promoted;
    moved = true;
    if (!required.has(sourceName)) delete out[sourceName];
    break;
   }
  }
  return moved ? out : args;
}

/**
 * Per-request map of caller tool name (lowercased) to the schema its
 * arguments are repaired against. Only tools whose parameters declare at least
 * one object or array property are kept: those are the only ones a repair can
 * act on, and an empty map means the request streams byte-identically.
 *
 * Keyed by CALLER name, which is what arrives downstream after the casing and
 * find->glob restores. Injected fingerprint placeholders are absent by
 * construction, so they are never repaired.
 */
export function buildArgRepairSchemas(tools: unknown[]): Map<string, Record<string, unknown>> {
  const schemas = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
   const canon = canonicalizeTool(tool);
   if (canon === null) continue;
   const props = canon.parameters.properties;
   if (props === null || typeof props !== "object" || Array.isArray(props)) continue;
   const hasStructural = Object.values(props as Record<string, unknown>).some(
    (prop) => prop !== null && typeof prop === "object" && !Array.isArray(prop) && structuralProperty(prop as Record<string, unknown>),
   );
   if (!hasStructural) continue;
   schemas.set(canon.name.trim().toLowerCase(), canon.parameters);
  }
  return schemas;
}

/**
 * Repair one tool call's arguments against its declared schema. `name` is the
 * downstream (restored) caller tool name. Returns the input string untouched
 * unless the repair produced a schema-valid result, so well-formed calls stay
 * byte-identical and truncated JSON is never completed.
 */
export function repairToolArguments(
  name: string,
  argsJson: string,
  schemas: ReadonlyMap<string, Record<string, unknown>> | undefined,
): string {
  if (schemas === undefined || schemas.size === 0) return argsJson;
  const schema = schemas.get(name.trim().toLowerCase());
  if (schema === undefined) return argsJson;
  let parsed: unknown;
  try {
   parsed = JSON.parse(argsJson);
  } catch {
   // Truncated or non-JSON arguments: paper over nothing.
   return argsJson;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return argsJson;
  const rec = parsed as Record<string, unknown>;
  const repaired = repairValue(rec, schema, 0);
  const value = repaired.value === null || typeof repaired.value !== "object" || Array.isArray(repaired.value)
   ? rec
   : (repaired.value as Record<string, unknown>);
  const promoted = promoteStringArray(value, schema, 0);
  const result = promoted === value ? value : promoted;
  if (!repaired.changed && promoted === value) return argsJson;
  if (!matchesSchema(result, schema, 0)) return argsJson;
  return JSON.stringify(result);
}

/**
 * Value-level repair for wire APIs that carry tool arguments already parsed
 * (Anthropic `tool_use.input`). Returns the input object untouched unless the
 * repair produced a schema-valid result, so a well-formed call keeps
 * reference identity and callers can skip re-serialization.
 */
export function repairToolArgumentsValue(
 name: string,
 args: unknown,
 schemas: ReadonlyMap<string, Record<string, unknown>> | undefined,
): unknown {
 if (schemas === undefined || schemas.size === 0) return args;
 const schema = schemas.get(name.trim().toLowerCase());
 if (schema === undefined) return args;
 if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
 const rec = args as Record<string, unknown>;
 const repaired = repairValue(rec, schema, 0);
 const value = repaired.value === null || typeof repaired.value !== "object" || Array.isArray(repaired.value)
  ? rec
  : (repaired.value as Record<string, unknown>);
 // Promotion must run even when shape repair was idle: the reported payload
 // is already correctly typed, it just carries the phases in the wrong slot.
 const promoted = promoteStringArray(value, schema, 0);
 const result = promoted === value ? value : promoted;
 if (result === args) return args;
 if (!matchesSchema(result, schema, 0)) return args;
 return result;
}