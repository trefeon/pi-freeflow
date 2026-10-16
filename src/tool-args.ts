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
 * Three families are mechanically decidable from the CALLER's own declared
 * schema, and this module repairs exactly those:
 *
 * - Prefix-glue salvage: an argument string carrying the tail of the previous
 *   call in front of the caller's own object is recovered (see parseArguments).
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

/**
 * Text ending in a bare numeric literal (`"timeout":18`, `"n":1.`, `"n":1e`).
 * A complete JSON value is never followed by a digit, so this can only be a
 * literal the model was still writing when the stream cut — see
 * {@link appendClosers}.
 */
const CUT_NUMBER_TAIL = /[\d.eE+-]$/;

/** Declared JSON Schema type, tolerating union types like ["array","null"]. */
function schemaType(schema: Record<string, unknown>): string {
  const declared = schema.type;
  if (typeof declared === "string") return declared;
  if (Array.isArray(declared)) {
    for (const entry of declared) if (entry === "object" || entry === "array") return entry;
    if (typeof declared[0] === "string") return declared[0];
  }
  // Strict-mode hosts wrap every optional property as
  // `anyOf: [<schema>, { type: "null" }]` with no top-level `type` (OMP
  // packages/ai/src/utils/schema/CONSTRAINTS.md:34-49; Pi
  // api/constrained-sampling.ts:118-123), so the declared shape lives on the
  // non-null branch. Without descending, every shape walker below sees such a
  // property as untyped — repairValue early-returns, promoteStringArray skips the
  // target, adoptDeclaredKeys finds no candidates — which left the whole repair
  // family inert on exactly the strict tools it exists for: OMP `todo` is
  // strict=true, every payload property is optional and therefore wrapped, and
  // the reported phases promotion never fired.
  const branch = nonNullBranch(schema);
  if (branch !== null) return schemaType(branch);
  return "";
}


/**
 * Does a value already satisfy the declared schema? Type, then required keys,
 * then each present property recursively. A present property the schema does
 * not declare is ignored (never fails): hosts decide their own extras policy,
 * and this only gates whether a promotion is safe.
 *
 * Deliberately reads five keywords — `type`, `enum`, `properties`, `items`,
 * `required` — and nothing else. `minItems`, `minLength`, `pattern`,
 * `additionalProperties` and `strict` are NOT enforced, on purpose: this
 * function only decides whether to hand the repaired value to the host, and
 * the host validates the same keywords itself. A payload that violates
 * `minItems` is rejected by the host whether or not the repair accepted it, so
 * enforcing it here could only ever DISABLE a repair that would have been
 * accepted downstream — strictly worse, never better. The trade-off this does
 * leave: repair never rescues a call whose only fault is a constraint like
 * `minItems`, because the shape was never the problem.
 */
/**
 * Is this property allowed to be absent?
 *
 * Both hosts rewrite a tool's schema for strict mode by listing EVERY property
 * key in `required` and wrapping each optional one in
 * `anyOf: [<schema>, { type: "null" }]` (OMP: packages/ai CONSTRAINTS.md:34-49;
 * Pi: core/constrained-sampling.ts:118-123). So "required" there does not mean
 * "must be present" — it means "must be addressable". Reading it literally made
 * this gate refuse every well-formed call on a strict tool, which silently
 * disabled the whole repair for `bash` and the strict edit modes: the glued
 * payload the host rejects is exactly the one this module exists to fix.
 */
function isNullableProperty(prop: unknown): boolean {
	if (prop === null || typeof prop !== "object" || Array.isArray(prop)) return false;
	const rec = prop as Record<string, unknown>;
	if (Array.isArray(rec.type)) return (rec.type as unknown[]).includes("null");
	const anyOf = rec.anyOf;
	if (Array.isArray(anyOf)) {
	for (const branch of anyOf) {
		if (branch !== null && typeof branch === "object" && !Array.isArray(branch) && (branch as Record<string, unknown>).type === "null") return true;
	}
	}
	return false;
}

/**
 * Does a value already satisfy the declared schema? Type, then required keys,
 * then each present property recursively. A present property the schema does
 * not declare is ignored (never fails): hosts decide their own extras policy,
 * and this only gates whether a promotion is safe.
 *
 * Deliberately reads `type`, `enum`, `properties`, `items`, `required` — and
 * nothing else. `minItems`, `minLength`, `pattern`, `additionalProperties` and
 * `strict` are NOT enforced, on purpose: this function only decides whether to
 * hand the repaired value to the host, and the host validates the same
 * keywords itself. A payload that violates `minItems` is rejected by the host
 * whether or not the repair accepted it, so enforcing it here could only ever
 * DISABLE a repair the host would otherwise have accepted — strictly worse,
 * never better. The trade-off this leaves: repair never rescues a call whose
 * only fault is a constraint like `minItems`, because the shape was never the
 * problem.
 */
function matchesSchema(value: unknown, schema: Record<string, unknown>, depth: number): boolean {
 if (depth > MAX_DEPTH) return false;
 // A value the declaration explicitly allows is a match before any shape is
 // read: the walkers now descend through the strict-mode nullable wrapper, so
 // a legitimately-null value would otherwise be REJECTED by that descent.
 if (value === null && isNullableProperty(schema)) return true;
 const resolved = effectiveSchema(schema);
 const type = schemaType(schema);
 if (type === "array") {
  if (!Array.isArray(value)) return false;
  const items = resolved.items;
  if (items === null || typeof items !== "object" || Array.isArray(items)) return true;
  return value.every((element) => matchesSchema(element, items as Record<string, unknown>, depth + 1));
 }
 if (type === "object") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const props = resolved.properties;
  const declared = props !== null && typeof props === "object" && !Array.isArray(props) ? (props as Record<string, unknown>) : null;
  if (Array.isArray(resolved.required)) {
   for (const key of resolved.required) {
    if (typeof key !== "string" || key in rec) continue;
    // Strict-mode hosts list every key here and mark the optional ones nullable,
    // so a nullable key that is absent is correct, not a violation.
    if (declared !== null && isNullableProperty(declared[key])) continue;
    return false;
   }
  }
  if (declared === null) return true;
  for (const [key, entry] of Object.entries(rec)) {
   const propSchema = declared[key];
   if (propSchema === null || typeof propSchema !== "object" || Array.isArray(propSchema)) continue;
   if (!matchesSchema(entry, propSchema as Record<string, unknown>, depth + 1)) return false;
  }
  return true;
 }
 if (type === "string") return typeof value === "string";
 if (type === "number") return typeof value === "number" && Number.isFinite(value);
 if (type === "boolean") return typeof value === "boolean";
 if (Array.isArray(resolved.enum)) return resolved.enum.some((member) => member === value);
 return true;
}

/** The spellings free models use for "no value" when the slot is nullable. */
const NULL_SENTINELS = new Set(["null", "none", "undefined", "nil", "n/a"]);

function isNullSentinel(text: string): boolean {
	return NULL_SENTINELS.has(text.trim().toLowerCase());
}

/** The non-null branch of a nullable declaration, or null when it is not one. */
function nonNullBranch(prop: Record<string, unknown>): Record<string, unknown> | null {
	const anyOf = prop.anyOf;
	if (!Array.isArray(anyOf)) return null;
	for (const branch of anyOf) {
		if (branch === null || typeof branch !== "object" || Array.isArray(branch)) continue;
		const rec = branch as Record<string, unknown>;
		if (rec.type === "null") continue;
		return rec;
	}
	return null;
}

/**
 * The node a shape keyword (`properties`, `items`, …) lives on. Strict hosts
 * wrap an optional property as `anyOf: [<schema>, { type: "null" }]` — a
 * wrapper node with no `type` of its own — so shape reads must descend to its
 * non-null branch. A node that declares its own `type` keeps it: any `anyOf`
 * beside it is conjunctive, not a wrapper.
 */
function effectiveSchema(schema: Record<string, unknown>): Record<string, unknown> {
	if (schema.type !== undefined || schema.anyOf === undefined) return schema;
	const branch = nonNullBranch(schema);
	return branch === null ? schema : effectiveSchema(branch);
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
  const resolved = effectiveSchema(schema);
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
   const items = resolved.items;
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
  const props = resolved.properties;
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
   // A strict host makes optional keys `anyOf: [T, null]`, and free models
   // routinely answer that slot with the SENTINEL AS TEXT — `"timeout":"null"`,
   // `"pty":"None"` (measured across 4 of 37 catalog models). The host rejects
   // the call because a string is not a number and not null.
   //
   // Restricted to non-string inner types on purpose: when T is `string`,
   // `"null"` could be a genuine value and rewriting it would destroy data.
   // With T = number/boolean/object/array the property can never legitimately
   // hold a bare string, so collapsing a null sentinel loses nothing and makes
   // the call one the host accepts.
   if (typeof entry === "string" && isNullSentinel(entry)) {
    const nonNull = nonNullBranch(propSchema as Record<string, unknown>);
    if (nonNull !== null && schemaType(nonNull) !== "string") {
     out[key] = null;
     changed = true;
     continue;
    }
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
  const props = effectiveSchema(schema).properties;
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
  const props = effectiveSchema(schema).properties;
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
  const resolved = effectiveSchema(schema);
  const props = resolved.properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) return args;
  const declared = props as Record<string, Record<string, unknown>>;
  const required = new Set(
   Array.isArray(resolved.required) ? resolved.required.filter((key): key is string => typeof key === "string") : [],
  );
  const out = { ...args };
  let moved = false;
  for (const [targetName, targetSchema] of Object.entries(declared)) {
   if (schemaType(targetSchema) !== "array") continue;
   const targetItems = effectiveSchema(targetSchema).items;
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
     const sourceItems = effectiveSchema(sourceSchema).items;
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
    // The consumed source goes unless its absence would violate the schema.
    // Strict mode puts EVERY key in `required` ("must be addressable", not
    // "must be present"), so raw membership cannot pin it: a nullable listing
    // is optional and the consumed source is dropped. A genuinely required
    // source is kept — and the matchesSchema gate below would refuse the drop.
    if (!required.has(sourceName) || isNullableProperty(declared[sourceName])) delete out[sourceName];
    break;
   }
  }
  return moved ? out : args;
}

/**
 * Per-request map of caller tool name (lowercased) to the schema its
 * arguments are repaired against. Every tool that declares object parameters
 * is kept, NOT only those with an object/array property: the prefix-glue
 * salvage in {@link parseArguments} needs only the caller's own schema to
 * confirm the recovered object, and it fires most often on scalar-only tools.
 * `bash` is the live case — OMP's `bashSchemaBase` declares only `command`,
 * `timeout`, `cwd`, `pty` (reference/oh-my-pi tools/bash.ts:327), so a
 * structural-only filter left the most-used tool unrepairable and the host
 * rejected the glued payload outright.
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
  schemas.set(canon.name.trim().toLowerCase(), canon.parameters);
 }
 return schemas;
}


/**
 * Parse a tool-call argument string, salvaging one that arrives with a leading
 * fragment of the *previous* call spliced onto its front.
 *
 * Observed live on space-bunny-free: a model that emitted a call, saw the
 * result, then opened its next call by echoing the tail of the old one. The
 * stream carried a single tool call, so keying fragments by call id cannot
 * separate them, and the host rejected the payload:
 *
 *   `,"timeout":400}{"i":"…","command":"…"}`
 *   `]}]}{"i":"Planning research phases","op":"init",…}`
 *
 * Both are one complete JSON object with junk in front of it. Only strings that
 * do not parse as-is are considered, and only a position that yields a complete
 * object is accepted, so a well-formed call never reaches this path.
 *
 * A second live shape (2026-10-13) carried BOTH faults at once — the previous
 * call's tail in front AND the closing brace missing — so the scan also offers
 * the candidate with its closers appended. That offer is made only at the first
 * brace and only when a fragment precedes it; see appendClosers.
 *
 * Returns undefined when nothing salvageable is present.
 */
function parseArguments(argsJson: string): { value: Record<string, unknown>; salvaged: boolean } | undefined {
  try {
    const value = JSON.parse(argsJson);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return { value: value as Record<string, unknown>, salvaged: false };
  } catch {
    // fall through to the salvage scan
  }
 // Only a brace that OPENS a top-level object can start the caller's call: a
 // brace nested inside an already-unterminated object belongs to that outer
 // object, so promoting it would drop the declared key that wraps it
 // (`{"opts":{"a":1` must not salvage to `{"a":1}`).
 for (const start of topLevelObjectStarts(argsJson)) {
  const candidate = argsJson.slice(start);
  const i = start;
  // Two shapes to try, in order: the candidate as written, then the candidate
  // with its missing closers appended. The closer is only offered at the FIRST
  // brace and only when something precedes it — that fragment is the evidence
  // the model was mid-call and lost the tail. A bare `{"op":"init"` stays
  // refused, and so does an inner `{"phase":…` inside an already-truncated
  // object, which is why this is not offered at every brace.
  const candidates = i === 0 ? [candidate] : [candidate, appendClosers(candidate)];
  for (const attempt of candidates) {
   if (attempt === undefined) continue;
   try {
    const value = JSON.parse(attempt);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
     return { value: value as Record<string, unknown>, salvaged: true };
    }
   } catch {
    // not a start position; try the next brace
   }
  }
 }
 return undefined;
}

/**
 * Offsets of every `{` that could open the caller's own object.
 *
 * Depth counts braces only, clamped at zero, and deliberately ignores string
 * state. The junk in front is itself a cut fragment: it usually ends
 * mid-string (`…/freelane-proxy"`), so string tracking would classify the whole
 * real call as "inside a string" and find no start at all — which is exactly
 * the live failure this scan has to recover from.
 *
 * A nested brace is a candidate only when no key precedes it: `{"opts":{"a":1}`
 * must NOT promote its inner `{"a":1}` (a `:` sits between, so the outer
 * object is a real one and its declared key would be dropped), while the
 * observed prefix junk `}{` must still reach the real call that follows it.
 */
function topLevelObjectStarts(text: string): number[] {
 const starts: number[] = [];
 const openAt: number[] = [];
 for (let i = 0; i < text.length; i++) {
  if (text[i] === "{") {
   if (openAt.length === 0 || !text.slice(openAt[openAt.length - 1] + 1, i).includes(":")) starts.push(i);
   openAt.push(i);
   continue;
  }
  if (text[i] === "}" && openAt.length > 0) openAt.pop();
 }
 return starts;
}

/**
 * Append the closers an unterminated JSON object is missing, or undefined when
 * that would mean guessing.
 *
 * Only ever called on a candidate that starts at a `{` preceded by a fragment
 * of the previous call, and only when the candidate's own contents already
 * end cleanly. Three refusals keep this honest:
 *
 * - Cut inside a string literal (an unterminated `"`) returns undefined. The
 *   value itself is incomplete, so any closing brace would silently shorten
 *   it — and these arguments carry shell commands.
 * - Cut inside a number literal returns undefined. `{"timeout":18` may have
 *   been `180`, `18.5`, or `18`; completing it hands the host a confident wrong
 *   value with nothing to signal the guess. (`timeout` is a declared number on
 *   both hosts' `bash`.)
 * - Nothing left open returns undefined, so a well-formed candidate never
 *   reaches this path.
 *
 * Appending a closer never adds or removes a value, so a caller whose payload
 * parsed to a complete object here is getting back exactly what the model
 * emitted, minus the previous call's echo.
 */
function appendClosers(text: string): string | undefined {
 const open: string[] = [];
 let inString = false;
 let escaped = false;
 for (const ch of text) {
  if (inString) {
   if (escaped) escaped = false;
   else if (ch === "\\") escaped = true;
   else if (ch === '"') inString = false;
   continue;
  }
  if (ch === '"') inString = true;
  else if (ch === "{" || ch === "[") open.push(ch === "{" ? "}" : "]");
  else if (ch === "}" || ch === "]") open.pop();
 }
 // Inside a string at the end: the value was cut mid-token, so refuse.
 if (inString || open.length === 0) return undefined;
 // A bare number at the end is a cut literal (`18` of `180`), so refuse.
 if (CUT_NUMBER_TAIL.test(text)) return undefined;
 return text + open.reverse().join("");
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
  const parsed = parseArguments(argsJson);
  // Nothing parses: truncated or non-JSON arguments. Paper over nothing.
  if (parsed === undefined) return argsJson;
  const rec = parsed.value;
  const repaired = repairValue(rec, schema, 0);
  const value = repaired.value === null || typeof repaired.value !== "object" || Array.isArray(repaired.value)
   ? rec
   : (repaired.value as Record<string, unknown>);
  const promoted = promoteStringArray(value, schema, 0);
  const result = promoted === value ? value : promoted;
  // A salvaged payload needs no further reshaping: what follows the junk is
  // already the caller's own object, and re-serializing it would be a change
  // the repair was never asked to make.
  if (parsed.salvaged) return matchesSchema(rec, schema, 0) ? JSON.stringify(rec) : argsJson;
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