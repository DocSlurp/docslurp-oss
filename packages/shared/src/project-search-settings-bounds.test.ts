import { describe, expect, it } from "vitest";

import { SEARCH_SETTINGS_MAX_BYTES, SEARCH_SETTINGS_MAX_ENTRIES, updateProjectSearchSettingsSchema } from "./project.js";

const parse = (input: unknown) => updateProjectSearchSettingsSchema.safeParse(input);

describe("search settings update bounds", () => {
  it("accepts settings at the entry limit", () => {
    const synonyms = Object.fromEntries(Array.from({ length: SEARCH_SETTINGS_MAX_ENTRIES }, (_, i) => [`t${i}`, ["x"]]));
    expect(parse({ synonyms }).success).toBe(true);
  });

  it("refuses more than the entry limit for synonyms, rankingRules and pinnedResults", () => {
    const n = SEARCH_SETTINGS_MAX_ENTRIES + 1;
    const record = Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, ["x"]]));
    expect(parse({ synonyms: record }).success).toBe(false);
    expect(parse({ rankingRules: record }).success).toBe(false);
    expect(parse({ pinnedResults: Array.from({ length: n }, (_, i) => ({ queryPattern: `q${i}`, documentId: "d" })) }).success).toBe(false);
  });

  it("refuses a field larger than the serialized size limit", () => {
    const big = "x".repeat(SEARCH_SETTINGS_MAX_BYTES);
    expect(parse({ rankingRules: { blob: big } }).success).toBe(false);
    expect(parse({ synonyms: { term: [big] } }).success).toBe(false);
    expect(parse({ rankingRules: { small: "ok" } }).success).toBe(true);
  });
});
