import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();
const canManageWorkspaceMock = vi.fn();
const getWorkspaceAccessMock = vi.fn();

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    listen: vi.fn(),
    begin: vi.fn(),
  }),
}));

vi.mock("../services/organizations.js", () => ({
  canManageWorkspace: canManageWorkspaceMock,
  getWorkspaceAccess: getWorkspaceAccessMock,
}));

const {
  authorizeWorkspaceSecretAccess,
  listWorkspaceSecrets,
} = await import("../services/secrets.js");

describe("workspace secrets service access", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    canManageWorkspaceMock.mockReset();
    getWorkspaceAccessMock.mockReset();

    getWorkspaceAccessMock.mockResolvedValue({
      workspaceId: "ws-1",
      orgId: "org-1",
      workspaceOwnerUserId: "owner-1",
      orgRole: "admin",
      workspaceRole: null,
    });
    canManageWorkspaceMock.mockReturnValue(true);
  });

  it("authorizes secret access through workspace manage permissions", async () => {
    const authorization = await authorizeWorkspaceSecretAccess({
      workspaceId: "ws-1",
      userId: "user-1",
    });

    expect(authorization).toMatchObject({
      ok: true,
      grant: {
        workspaceId: "ws-1",
        userId: "user-1",
        orgId: "org-1",
      },
    });
    expect(getWorkspaceAccessMock).toHaveBeenCalledWith("ws-1", "user-1");
    expect(canManageWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      "user-1",
    );
  });

  it("does not read secrets when the actor cannot manage the workspace", async () => {
    canManageWorkspaceMock.mockReturnValue(false);

    await expect(
      listWorkspaceSecrets({ workspaceId: "ws-1", userId: "viewer-1" }),
    ).rejects.toThrow("Forbidden");
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("requires an explicit actor userId when no access grant is provided", async () => {
    await expect(
      listWorkspaceSecrets({
        workspaceId: "ws-1",
        userId: "",
      }),
    ).rejects.toThrow("Workspace secret access requires an actor userId");
    expect(getWorkspaceAccessMock).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("uses a pre-authorized grant without repeating workspace access checks", async () => {
    sqlMock.mockResolvedValue([
      {
        id: "secret-1",
        workspace_id: "ws-1",
        name: "OpenAI",
        type: "api_key",
        encrypted_value: "redacted",
        rotated_at: "2026-05-01T00:00:00.000Z",
        expires_at: null,
        last_used_at: null,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      },
    ]);

    const secrets = await listWorkspaceSecrets({
      access: {
        workspaceId: "ws-1",
        userId: "user-1",
        orgId: "org-1",
        access: {
          workspaceId: "ws-1",
          orgId: "org-1",
          workspaceOwnerUserId: "owner-1",
          orgRole: "admin",
          workspaceRole: null,
        },
      },
    });

    expect(getWorkspaceAccessMock).not.toHaveBeenCalled();
    expect(secrets).toEqual([
      expect.objectContaining({
        id: "secret-1",
        workspaceId: "ws-1",
        name: "OpenAI",
      }),
    ]);
  });
});
