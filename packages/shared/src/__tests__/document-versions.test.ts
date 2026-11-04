import { describe, expect, it } from "vitest";

import { documentVersionKey, DEFAULT_RETAINED_VERSIONS,
  effectiveRetainedVersions, normalizeSourcePath } from "../document-versions.js";

describe("normalizeSourcePath", () => {
  it("folds case, NFC, separators and slashes", () => {
    expect(normalizeSourcePath("  /Contracts\\\\2026//Q1/ ")).toBe("contracts/2026/q1");
    expect(normalizeSourcePath("Café/A")).toBe(normalizeSourcePath("Café/a"));
    expect(normalizeSourcePath("")).toBe("");
  });
  it("trims only ASCII slash/space/tab/CR/LF, keeping NBSP", () => {
    expect(normalizeSourcePath("\u00a0a/b")).toBe("\u00a0a/b");
    expect(normalizeSourcePath("\t\r\n /a/ \n")).toBe("a");
  });
  it("rejects parent segments and over-long paths", () => {
    expect(() => normalizeSourcePath("a/../b")).toThrow();
    expect(() => normalizeSourcePath("..\\x")).toThrow();
    expect(() => normalizeSourcePath("a".repeat(1025))).toThrow();
    expect(normalizeSourcePath("a".repeat(1024))).toHaveLength(1024);
    expect(normalizeSourcePath("a..b/c")).toBe("a..b/c");
  });
});

describe("documentVersionKey", () => {
  const base = { projectId: "w1", path: "Legal/2026", filename: "MSA.pdf" };
  it("is stable and normalization-insensitive", () => {
    expect(documentVersionKey(base)).toBe(documentVersionKey({ ...base, path: "/legal\\2026/", filename: "msa.PDF" }));
    expect(documentVersionKey(base)).toMatch(/^path:[0-9a-f]{32}$/);
  });
  it("folds ASCII case only", () => {
    const a = { projectId: "w1", path: "x" };
    expect(documentVersionKey({ ...a, filename: "\u00c4.pdf" })).not.toBe(documentVersionKey({ ...a, filename: "\u00e4.pdf" }));
    expect(normalizeSourcePath("\u00c4B")).toBe("\u00c4b");
  });
  it("separates folders and projects", () => {
    expect(documentVersionKey(base)).not.toBe(documentVersionKey({ ...base, path: "Legal/2025" }));
    expect(documentVersionKey(base)).not.toBe(documentVersionKey({ ...base, projectId: "w2" }));
  });
  it("canonicalId wins", () => {
    expect(documentVersionKey({ ...base, canonicalId: "drive:123" })).toBe("drive:123");
    expect(documentVersionKey({ ...base, canonicalId: "" })).toMatch(/^path:/);
  });
});

describe("effectiveRetainedVersions", () => {
  it("defaults to 2 for every org", () => {
    expect(DEFAULT_RETAINED_VERSIONS).toBe(2);
    expect(effectiveRetainedVersions({ orgSetting: null, projectSetting: null })).toBe(2);
  });
  it("falls back through project, org, default", () => {
    expect(effectiveRetainedVersions({ orgSetting: 5, projectSetting: null })).toBe(5);
    expect(effectiveRetainedVersions({ orgSetting: 5, projectSetting: 3 })).toBe(3);
    expect(effectiveRetainedVersions({ orgSetting: null, projectSetting: 1 })).toBe(1);
  });
  it("clamps to 1..100", () => {
    expect(effectiveRetainedVersions({ orgSetting: 0, projectSetting: null })).toBe(1);
    expect(effectiveRetainedVersions({ orgSetting: 500, projectSetting: null })).toBe(100);
  });
});
