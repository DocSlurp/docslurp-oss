import { describe, expect, it } from "vitest";

import { isProjectUuid, slugifyProjectName, projectSlugProblem } from "../project-slug.js";

describe("project slugs", () => {
  it("slugifies names into URL-safe words", () => {
    expect(slugifyProjectName("  Légal Contracts — 2026! ")).toBe("legal-contracts-2026");
    expect(slugifyProjectName("Le\u0301gal \ufb01les \uff21\uff11")).toBe("legal-files-a1");
  });

  it("rejects reserved, UUID-shaped and malformed slugs", () => {
    expect(projectSlugProblem("amber-falcon-ridge")).toBeNull();
    for (const slug of ["default", "board", "invites", "Amber-Falcon", "a--b", "ab"]) {
      expect(projectSlugProblem(slug)).not.toBeNull();
    }
    const uuid = "4f9b2c1e-1d2a-4c3b-8e7f-0a1b2c3d4e5f";
    expect(isProjectUuid(uuid)).toBe(true);
    expect(projectSlugProblem(uuid)).not.toBeNull();
  });
});
