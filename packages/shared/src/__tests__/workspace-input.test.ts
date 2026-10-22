import { describe, expect, it } from "vitest";

import { parseWorkspaceInput, slugifyWorkspaceName } from "../workspace-slug.js";

describe("parseWorkspaceInput", () => {
  const uuid = "4f9b2c1e-1d2a-4c3b-8e7f-0a1b2c3d4e5f";

  it("treats omitted, blank and the default alias as the default workspace", () => {
    for (const value of [undefined, null, "", "   ", "default", " Default "]) {
      expect(parseWorkspaceInput(value)).toEqual({ kind: "default" });
    }
  });

  it("recognizes workspace UUIDs", () => {
    expect(parseWorkspaceInput(` ${uuid.toUpperCase()} `)).toEqual({ kind: "id", id: uuid });
  });

  it("matches names and slugs by their slug", () => {
    expect(parseWorkspaceInput("legal-contracts")).toEqual({ kind: "slug", slug: "legal-contracts", name: "legal-contracts" });
    expect(parseWorkspaceInput("Legal Contracts")).toEqual({ kind: "slug", slug: "legal-contracts", name: "Legal Contracts" });
    expect(parseWorkspaceInput("  Légal—Contracts!! ")).toEqual({ kind: "slug", slug: "legal-contracts", name: "Légal—Contracts!!" });
  });

  it("rejects input with nothing left after slugifying", () => {
    expect(parseWorkspaceInput("!!!")).toMatchObject({ kind: "invalid", input: "!!!" });
    expect(parseWorkspaceInput("——")).toMatchObject({ kind: "invalid" });
  });
});

describe("slugifyWorkspaceName", () => {
  it("lowercases, strips diacritics, collapses separators and trims hyphens", () => {
    expect(slugifyWorkspaceName("--Ünïcödé   Ñame__2026--")).toBe("unicode-name-2026");
    expect(slugifyWorkspaceName("a".repeat(70) + " b")).toHaveLength(63);
    expect(slugifyWorkspaceName(`${"a".repeat(62)} b`)).toBe("a".repeat(62));
  });
});
