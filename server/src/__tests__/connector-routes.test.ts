import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectorTypes } from "@docslurp/shared";

const sqlMock = vi.fn();

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, {
    json: (value: unknown) => value,
  }),
}));

vi.mock("../lib/encryption.js", () => ({
  getRequiredEncryptionKey: () => Buffer.alloc(32, 7),
  sealSecret: (_env: string, plaintext: string) => `sealed:${Buffer.from(plaintext).toString("base64")}`,
  openSecret: (_env: string, stored: string) => Buffer.from(stored.replace(/^sealed:/, ""), "base64").toString("utf8"),
}));

vi.mock("../services/organizations.js", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "owner" })),
  canManageWorkspace: vi.fn(() => true),
}));

const { connectorsRoutes } = await import("../routes/connectors.js");
const { getConnectorAdapter } = await import("../services/connectors/index.js");

function buildApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as unknown as { set: (key: string, value: unknown) => void }).set("sessionUser", { id: "user-1" });
    await next();
  });
  app.route("/v1/workspaces", connectorsRoutes);
  return app;
}

function createConnector(type: string) {
  return buildApp().request("/v1/workspaces/ws-1/connectors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, name: "Source", credentials: { token: "x" } }),
  });
}

describe("connector creation", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  it.each(["sharepoint", "dropbox", "imap", "ftp"])("rejects %s, which has no sync adapter", async (type) => {
    const response = await createConnector(type);

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string; details: { issues: Array<{ path: string }> } } };
    expect(body.error).toMatchObject({ code: "invalid_request", message: "Invalid connector payload" });
    expect(body.error.details.issues.some((issue) => issue.path === "type")).toBe(true);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("creates a connector for a type with an adapter", async () => {
    sqlMock.mockResolvedValueOnce([
      {
        id: "conn-1",
        workspace_id: "ws-1",
        type: "s3",
        name: "Source",
        credentials_encrypted: "iv:tag:data",
        config: {},
        status: "active",
        last_sync_at: null,
        created_at: "2026-10-11T00:00:00.000Z",
        updated_at: "2026-10-11T00:00:00.000Z",
      },
    ]);

    const response = await createConnector("s3");

    expect(response.status).toBe(201);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("registers an adapter for every accepted connector type", () => {
    for (const type of connectorTypes) {
      expect(() => getConnectorAdapter(type)).not.toThrow();
    }
  });
});
