import { describe, expect, it } from "vitest";
import { canContributeToProject, canEditProject, type ProjectAccess } from "../services/organizations.js";

const userId = "user-1";

function access(overrides: Partial<ProjectAccess>): ProjectAccess {
  return {
    projectId: "ws-1",
    orgId: "org-1",
    projectOwnerUserId: "owner-1",
    isDefaultProject: false,
    orgRole: "member",
    projectRole: null,
    ...overrides,
  };
}

describe("project edit and contribute rights", () => {
  it("lets a plain org member add to the default project but not change its settings", () => {
    const member = access({ isDefaultProject: true });
    expect(canContributeToProject(member, userId)).toBe(true);
    expect(canEditProject(member, userId)).toBe(false);
  });

  it("lets an explicit viewer of the default project add to it but not change its settings", () => {
    const viewer = access({ isDefaultProject: true, projectRole: "viewer" });
    expect(canContributeToProject(viewer, userId)).toBe(true);
    expect(canEditProject(viewer, userId)).toBe(false);
  });

  it("gives no default-project rights to someone outside the org", () => {
    expect(canContributeToProject(access({ isDefaultProject: true, orgRole: null }), userId)).toBe(false);
  });

  it("does not extend default-project contribution to other projects", () => {
    expect(canContributeToProject(access({}), userId)).toBe(false);
  });

  it.each([
    access({ projectOwnerUserId: userId }),
    access({ orgRole: "admin" }),
    access({ orgRole: "owner" }),
    access({ projectRole: "editor" }),
    access({ projectRole: "admin" }),
  ])("lets owners, org admins and project editors edit and contribute (%#)", (granted) => {
    expect(canEditProject(granted, userId)).toBe(true);
    expect(canContributeToProject(granted, userId)).toBe(true);
  });
});
