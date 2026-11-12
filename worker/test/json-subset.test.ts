import { describe, expect, it } from "vitest";
import { checkSchema, lastJsonBlock, structuredResult, validate } from "../src/core/json-subset";

const schema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    files: { type: "array", items: { type: "string" } },
    level: { enum: ["low", "high"] },
    count: { type: "integer" },
    note: { type: ["string", "null"] },
  },
  required: ["ok", "files"],
  additionalProperties: false,
};

describe("checkSchema", () => {
  it("accepts the subset, annotations included", () => {
    expect(checkSchema(schema)).toBeUndefined();
    expect(checkSchema({ $schema: "x", title: "t", description: "d", type: "string" })).toBeUndefined();
  });

  it("refuses keywords outside the subset, with the path", () => {
    expect(checkSchema({ type: "object", properties: { a: { type: "string", minLength: 1 } } })).toBe(
      "$.properties.a: keyword minLength is not supported",
    );
    expect(checkSchema({ oneOf: [] })).toBe("$: keyword oneOf is not supported");
    expect(checkSchema({ items: { $ref: "#/x" } })).toBe("$.items: keyword $ref is not supported");
    expect(checkSchema({ additionalProperties: { type: "string" } })).toMatch(/may only be false/);
    expect(checkSchema({ type: "date" })).toMatch(/type must be one of/);
    expect(checkSchema({ enum: [] })).toMatch(/at least one value/);
    expect(checkSchema({ required: [1] })).toMatch(/list of property names/);
    expect(checkSchema([])).toBe("$: a schema is an object");
  });
});

describe("validate", () => {
  it("passes a matching value", () => {
    expect(validate({ ok: true, files: ["a"], level: "low", count: 2, note: null }, schema)).toEqual([]);
  });

  it("names each break, a few at most", () => {
    expect(validate({ ok: "yes", files: [1], level: "mid", count: 1.5, extra: 1 }, schema)).toEqual([
      "$.ok: expected boolean, got string",
      "$.files[0]: expected string, got number",
      '$.level: must be one of "low", "high"',
      "$.count: expected integer, got number",
      "$: extra is not allowed",
    ]);
    expect(validate({}, schema)).toEqual(["$: ok is required", "$: files is required"]);
    expect(validate([], schema)).toEqual(["$: expected object, got array"]);
  });

  it("compares enum values as JSON, key order aside", () => {
    expect(validate({ b: 1, a: 2 }, { enum: [{ a: 2, b: 1 }] })).toEqual([]);
  });
});

describe("json block", () => {
  const text = 'Done.\n```json\n{"ok": false}\n```\nResult: x\n```json\n{"ok": true, "files": []}\n```\n';

  it("takes the last fenced json block", () => {
    expect(lastJsonBlock(text)).toBe('{"ok": true, "files": []}');
    expect(lastJsonBlock("```js\n1\n```")).toBeUndefined();
  });

  it("gives structured, or one structuredError line", () => {
    expect(structuredResult(text, schema)).toEqual({ structured: { ok: true, files: [] } });
    expect(structuredResult("no block", schema)).toEqual({
      structuredError: "the last message has no ```json block",
    });
    expect(structuredResult("```json\n{oops}\n```", schema)).toMatchObject({
      structuredError: expect.stringMatching(/^the json block is not JSON/),
    });
    expect(structuredResult('```json\n{"ok": 1, "files": []}\n```', schema)).toEqual({
      structuredError: "the json block does not match the schema: $.ok: expected boolean, got number",
    });
  });
});
