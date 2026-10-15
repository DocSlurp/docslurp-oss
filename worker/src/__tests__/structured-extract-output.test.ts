import { describe, expect, it } from "vitest";

import {
  findStructuredField,
  parseStructuredFields,
} from "../stages/structured-extract.js";

describe("parseStructuredFields", () => {
  it("accepts the requested structured envelope", () => {
    expect(parseStructuredFields('{"fields":{"name":{"value":"Ada","confidence":0.9}}}'))
      .toEqual({ name: { value: "Ada", confidence: 0.9 } });
  });

  it("unwraps fenced JSON and primitive field values", () => {
    expect(parseStructuredFields('```json\n{"fields":{"name":"Ada","id":"483920"}}\n```'))
      .toEqual({ name: { value: "Ada" }, id: { value: "483920" } });
  });

  it("extracts a JSON object surrounded by provider prose", () => {
    expect(parseStructuredFields('Result:\n{"name":"Ada"}\nDone.'))
      .toEqual({ name: { value: "Ada" } });
  });

  it("accepts generic label-value lists and human-readable labels", () => {
    const fields = parseStructuredFields(
      '[{"label":"Vessel Name","value":"Argo"},{"name":"Registration Code","text":"483920"}]',
    );
    expect(findStructuredField(fields, "vessel_name")).toEqual({
      value: "Argo",
      confidence: undefined,
      evidence: undefined,
    });
    expect(findStructuredField(fields, "registration_code")?.value).toBe("483920");
  });

  it("fails closed for malformed output", () => {
    expect(parseStructuredFields("not json")).toEqual({});
  });
});
