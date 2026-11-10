import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();
const canManageProjectMock = vi.fn();
const getProjectAccessMock = vi.fn();

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    listen: vi.fn(),
    begin: vi.fn(),
  }),
}));

vi.mock("../services/organizations.js", () => ({
  canManageProject: canManageProjectMock,
  getProjectAccess: getProjectAccessMock,
}));

const {
  authorizeProjectSecretAccess,
  listProjectSecrets,
} = await import("../services/secrets.js");

describe("project secrets service access", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    canManageProjectMock.mockReset();
    getProjectAccessMock.mockReset();

    getProjectAccessMock.mockResolvedValue({
      projectId: "ws-1",
      orgId: "org-1",
      projectOwnerUserId: "owner-1",
      orgRole: "admin",
      projectRole: null,
    });
    canManageProjectMock.mockReturnValue(true);
  });

  it("authorizes secret access through project manage permissions", async () => {
    const authorization = await authorizeProjectSecretAccess({
      projectId: "ws-1",
      userId: "user-1",
    });

    expect(authorization).toMatchObject({
      ok: true,
      grant: {
        projectId: "ws-1",
        userId: "user-1",
        orgId: "org-1",
      },
    });
    expect(getProjectAccessMock).toHaveBeenCalledWith("ws-1", "user-1");
    expect(canManageProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      "user-1",
    );
  });

  it("does not read secrets when the actor cannot manage the project", async () => {
    canManageProjectMock.mockReturnValue(false);

    await expect(
      listProjectSecrets({ projectId: "ws-1", userId: "viewer-1" }),
    ).rejects.toThrow("Forbidden");
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("requires an explicit actor userId when no access grant is provided", async () => {
    await expect(
      listProjectSecrets({
        projectId: "ws-1",
        userId: "",
      }),
    ).rejects.toThrow("Project secret access requires an actor userId");
    expect(getProjectAccessMock).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("uses a pre-authorized grant without repeating project access checks", async () => {
    sqlMock.mockResolvedValue([
      {
        id: "secret-1",
        project_id: "ws-1",
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

    const secrets = await listProjectSecrets({
      access: {
        projectId: "ws-1",
        userId: "user-1",
        orgId: "org-1",
        access: {
          projectId: "ws-1",
          orgId: "org-1",
          projectOwnerUserId: "owner-1",
          orgRole: "admin",
          projectRole: null,
        },
      },
    });

    expect(getProjectAccessMock).not.toHaveBeenCalled();
    expect(secrets).toEqual([
      expect.objectContaining({
        id: "secret-1",
        projectId: "ws-1",
        name: "OpenAI",
      }),
    ]);
  });
});
