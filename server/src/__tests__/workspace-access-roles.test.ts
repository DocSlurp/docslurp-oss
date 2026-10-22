import { describe, expect, it } from "vitest";
import { canContributeToWorkspace, canEditWorkspace, type WorkspaceAccess } from "../services/organizations.js";

const userId = "user-1";

function access(overrides: Partial<WorkspaceAccess>): WorkspaceAccess {
  return {
    workspaceId: "ws-1",
    orgId: "org-1",
    workspaceOwnerUserId: "owner-1",
    isDefaultWorkspace: false,
    orgRole: "member",
    workspaceRole: null,
    ...overrides,
  };
}

describe("workspace edit and contribute rights", () => {
  it("lets a plain org member add to the default workspace but not change its settings", () => {
    const member = access({ isDefaultWorkspace: true });
    expect(canContributeToWorkspace(member, userId)).toBe(true);
    expect(canEditWorkspace(member, userId)).toBe(false);
  });

  it("keeps an explicit viewer of the default workspace read-only", () => {
    const viewer = access({ isDefaultWorkspace: true, workspaceRole: "viewer" });
    expect(canContributeToWorkspace(viewer, userId)).toBe(false);
    expect(canEditWorkspace(viewer, userId)).toBe(false);
  });

  it("gives no default-workspace rights to someone outside the org", () => {
    expect(canContributeToWorkspace(access({ isDefaultWorkspace: true, orgRole: null }), userId)).toBe(false);
  });

  it("does not extend default-workspace contribution to other workspaces", () => {
    expect(canContributeToWorkspace(access({}), userId)).toBe(false);
  });

  it.each([
    access({ workspaceOwnerUserId: userId }),
    access({ orgRole: "admin" }),
    access({ orgRole: "owner" }),
    access({ workspaceRole: "editor" }),
    access({ workspaceRole: "admin" }),
  ])("lets owners, org admins and workspace editors edit and contribute (%#)", (granted) => {
    expect(canEditWorkspace(granted, userId)).toBe(true);
    expect(canContributeToWorkspace(granted, userId)).toBe(true);
  });
});
