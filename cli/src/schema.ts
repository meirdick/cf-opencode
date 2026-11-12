// `run --schema <file.json>`: the result the agent must end with, as a JSON Schema subset.
// The subset rules are the Worker's (worker/src/core/json-subset.ts); the Worker checks again and does the
// validation. This copy only lets `run` fail before it wakes anything.
import { readFileSync } from "node:fs";
import { CliError } from "./errors.js";

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
export const MAX_SCHEMA_CHARS = 8000;
export const SUBSET =
  "type, properties, required, items, enum, additionalProperties false (and title, description, $schema)";

/** Why the schema is outside the subset, or undefined. */
export function schemaProblem(schema: unknown, path = "$", depth = 0): string | undefined {
  if (depth > 32) return `${path}: nested deeper than 32`;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${path}: a schema is an object`;
  const s = schema as Record<string, unknown>;
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
    for (const [k, v] of Object.entries(s.properties)) {
      const e = schemaProblem(v, `${path}.properties.${k}`, depth + 1);
      if (e) return e;
    }
  }
  if (s.items !== undefined) return schemaProblem(s.items, `${path}.items`, depth + 1);
  return undefined;
}

/** Read and check a schema file. Every problem is one Failed line. */
export function readSchema(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new CliError(
      `cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? "error"})`,
      "check the path",
    );
  }
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch {
    throw new CliError(`${file} is not JSON`, "write the schema as one JSON object");
  }
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS)
    throw new CliError(`${file} is over ${MAX_SCHEMA_CHARS} characters`, "make the schema smaller");
  const why = schemaProblem(schema);
  if (why)
    throw new CliError(`${file} is outside the supported JSON Schema subset (${why})`, `use only ${SUBSET}`);
  return schema;
}

/** The lines added to the task's closing instruction. */
export function schemaInstruction(schema: unknown): string[] {
  return [
    "- After the `Result:` line, end your last message with one fenced ```json block whose content matches this JSON Schema. Put nothing after the block:",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ];
}
