import { describe, expect, it } from "vitest";

import { parseProjectInput, slugifyProjectName } from "../project-slug.js";

describe("parseProjectInput", () => {
  const uuid = "4f9b2c1e-1d2a-4c3b-8e7f-0a1b2c3d4e5f";

  it("treats omitted, blank and the default alias as the default project", () => {
    for (const value of [undefined, null, "", "   ", "default", " Default "]) {
      expect(parseProjectInput(value)).toEqual({ kind: "default" });
    }
  });

  it("recognizes project UUIDs", () => {
    expect(parseProjectInput(` ${uuid.toUpperCase()} `)).toEqual({ kind: "id", id: uuid });
  });

  it("matches names and slugs by their slug", () => {
    expect(parseProjectInput("legal-contracts")).toEqual({ kind: "slug", slug: "legal-contracts", name: "legal-contracts" });
    expect(parseProjectInput("Legal Contracts")).toEqual({ kind: "slug", slug: "legal-contracts", name: "Legal Contracts" });
    expect(parseProjectInput("  Légal—Contracts!! ")).toEqual({ kind: "slug", slug: "legal-contracts", name: "Légal—Contracts!!" });
  });

  it("rejects input with nothing left after slugifying", () => {
    expect(parseProjectInput("!!!")).toMatchObject({ kind: "invalid", input: "!!!" });
    expect(parseProjectInput("——")).toMatchObject({ kind: "invalid" });
  });
});

describe("slugifyProjectName", () => {
  it("lowercases, strips diacritics, collapses separators and trims hyphens", () => {
    expect(slugifyProjectName("--Ünïcödé   Ñame__2026--")).toBe("unicode-name-2026");
    expect(slugifyProjectName("a".repeat(70) + " b")).toHaveLength(63);
    expect(slugifyProjectName(`${"a".repeat(62)} b`)).toBe("a".repeat(62));
  });
});

describe("project_not_found envelope", () => {
  it("names the slug it looked for and drops unsafe slug details", async () => {
    const { publicApiErrorEnvelope } = await import("../api-error.js");
    const named = publicApiErrorEnvelope({ error: { code: "project_not_found", message: "x", details: { projectSlug: "legal-contracts" } } }, 404);
    expect(named?.error.message).toContain('"legal-contracts"');
    expect(named?.error.details).toEqual({ projectSlug: "legal-contracts" });
    const unsafe = publicApiErrorEnvelope({ error: { code: "project_not_found", message: "x", details: { projectSlug: "<script>" } } }, 404);
    expect(unsafe?.error.details).toBeUndefined();
    expect(unsafe?.error.message).not.toContain("<script>");
  });
});
