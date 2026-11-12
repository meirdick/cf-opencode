// A small JSON Schema subset, for `cf-opencode run --schema`. No dependency: the Worker validates the agent's
// last JSON block against the schema the task carries, so every reader (CLI, notify receiver) gets the same
// answer. A schema that uses a keyword outside the subset is refused, so a check is never silently skipped.
//
// Subset: type (string, number, integer, boolean, object, array, null, or a list of these), properties,
// required, items (one schema), enum, additionalProperties (false only), and the annotations title,
// description and $schema, which do nothing.

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "additionalProperties",
  "title",
  "description",
  "$schema",
]);
/** A schema rides in each task record and in the prompt; keep both small. */
export const MAX_SCHEMA_CHARS = 8000;
const MAX_DEPTH = 32;
const MAX_ERRORS = 5;

type Schema = Record<string, unknown>;

/** Why the schema is outside the subset, or undefined when it is in it. */
export function checkSchema(schema: unknown, path = "$", depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return `${path}: nested deeper than ${MAX_DEPTH}`;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${path}: a schema is an object`;
  const s = schema as Schema;
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) return `${path}: keyword ${k} is not supported`;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.length === 0 || types.some((t) => typeof t !== "string" || !TYPES.has(t)))
      return `${path}: type must be one of ${[...TYPES].join(", ")}, or a list of them`;
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0))
    return `${path}: enum must be a list with at least one value`;
  if (
    s.required !== undefined &&
    (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string"))
  )
    return `${path}: required must be a list of property names`;
  if (s.additionalProperties !== undefined && s.additionalProperties !== false)
    return `${path}: additionalProperties may only be false`;
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties))
      return `${path}: properties must be an object`;
    for (const [k, v] of Object.entries(s.properties as Schema)) {
      const e = checkSchema(v, `${path}.properties.${k}`, depth + 1);
      if (e) return e;
    }
  }
  if (s.items !== undefined) {
    const e = checkSchema(s.items, `${path}.items`, depth + 1);
    if (e) return e;
  }
  return undefined;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  return typeOf(v) === t;
}

/** JSON equality for enum: same JSON text after sorting object keys. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Schema)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** Where the value breaks the schema, at most a few lines. Empty when it matches. The schema must pass checkSchema. */
export function validate(value: unknown, schema: unknown, path = "$"): string[] {
  const out: string[] = [];
  walk(value, schema as Schema, path, out);
  return out.slice(0, MAX_ERRORS);
}

function walk(v: unknown, s: Schema, path: string, out: string[]): void {
  if (out.length >= MAX_ERRORS) return;
  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    if (!types.some((t) => matchesType(v, t))) {
      out.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(v)}`);
      return;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => canonical(e) === canonical(v)))
    out.push(`${path}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Schema;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    // Own keys only: `"toString" in {}` is true, so `in` passed a required key the value does not have.
    for (const r of (s.required ?? []) as string[])
      if (!Object.hasOwn(o, r)) out.push(`${path}: ${r} is required`);
    for (const [k, sub] of Object.entries(props))
      if (Object.hasOwn(o, k)) walk(o[k], sub, `${path}.${k}`, out);
    if (s.additionalProperties === false)
      for (const k of Object.keys(o)) if (!Object.hasOwn(props, k)) out.push(`${path}: ${k} is not allowed`);
  }
  if (Array.isArray(v) && s.items)
    for (const [i, x] of v.entries()) walk(x, s.items as Schema, `${path}[${i}]`, out);
}

/** The body of the last fenced ```json block in the text, or undefined when there is none. */
export function lastJsonBlock(text: string): string | undefined {
  const re = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi;
  let last: string | undefined;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
  return last;
}

/** structured or structuredError for a finished task's last message. */
export function structuredResult(
  text: string | undefined,
  schema: unknown,
): { structured: unknown } | { structuredError: string } {
  const block = lastJsonBlock(text ?? "");
  if (block === undefined) return { structuredError: "the last message has no ```json block" };
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch (e) {
    return { structuredError: `the json block is not JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  let errors: string[];
  let size: number;
  try {
    errors = validate(value, schema);
    size = JSON.stringify(value).length;
  } catch {
    // The agent writes the block. A value nested deep enough to exhaust the stack (canonical() for enum) must
    // fail this check, not the task read that called it.
    return { structuredError: "the json block is nested too deep to check" };
  }
  if (errors.length > 0)
    return { structuredError: `the json block does not match the schema: ${errors.join("; ")}` };
  if (size > MAX_SCHEMA_CHARS)
    return { structuredError: `the json block is over ${MAX_SCHEMA_CHARS} characters` };
  return { structured: value };
}
