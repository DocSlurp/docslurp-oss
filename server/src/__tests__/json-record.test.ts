import { describe, expect, it } from "vitest";
import { jsonRecord } from "../lib/json-record.js";

describe("persisted JSON records", () => {
  it("preserves page anchors in native and previously string-encoded metadata", () => {
    const metadata = { pageNumbers: [7, 8], sourceTrace: { parser: "native" } };
    expect(jsonRecord(metadata)).toEqual(metadata);
    expect(jsonRecord(JSON.stringify(metadata))).toEqual(metadata);
  });
  it("rejects invalid JSON, arrays, and scalar values", () => {
    for (const value of [null, undefined, 5, "broken", "null", "[]", []]) {
      expect(jsonRecord(value)).toEqual({});
    }
  });
});
