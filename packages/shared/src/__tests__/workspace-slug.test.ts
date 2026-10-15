import { describe, expect, it } from "vitest";

import { isWorkspaceUuid, slugifyWorkspaceName, workspaceSlugProblem } from "../workspace-slug.js";

describe("workspace slugs", () => {
  it("slugifies names into URL-safe words", () => {
    expect(slugifyWorkspaceName("  Légal Contracts — 2026! ")).toBe("legal-contracts-2026");
  });

  it("rejects reserved, UUID-shaped and malformed slugs", () => {
    expect(workspaceSlugProblem("amber-falcon-ridge")).toBeNull();
    for (const slug of ["default", "board", "invites", "Amber-Falcon", "a--b", "ab"]) {
      expect(workspaceSlugProblem(slug)).not.toBeNull();
    }
    const uuid = "4f9b2c1e-1d2a-4c3b-8e7f-0a1b2c3d4e5f";
    expect(isWorkspaceUuid(uuid)).toBe(true);
    expect(workspaceSlugProblem(uuid)).not.toBeNull();
  });
});
