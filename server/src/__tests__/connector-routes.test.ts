import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectorTypes } from "@docslurp/shared";

const sqlMock = vi.fn();
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

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
    body: JSON.stringify({ type, name: "Source", credentials: { accessKeyId: "x", secretAccessKey: "x" }, config: { bucket: "docs" } }),
  });
}

describe("connector creation", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
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

  it.each(['https://127.0.0.1/', 'https://169.254.169.254/', 'http://10.0.0.1/', 'https://[::1]/', 'https://127.0.0.1.sslip.io/'])("rejects unsafe endpoints before persistence: %s", async (endpoint) => {
    const response = await buildApp().request('/v1/workspaces/ws-1/connectors', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 's3', name: 'Source', config: { bucket: 'docs', endpoint }, credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }),
    });
    expect(response.status).toBe(422);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("rejects a private Confluence base URL before persistence", async () => {
    const response = await buildApp().request('/v1/workspaces/ws-1/connectors', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'confluence', name: 'Source', config: {}, credentials: { baseUrl: 'https://169.254.169.254/', email: 'admin@example.com', apiToken: 'test' } }),
    });
    expect(response.status).toBe(422);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("rejects oversized config before persistence", async () => {
    const response = await buildApp().request('/v1/workspaces/ws-1/connectors', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 's3', name: 'Source', config: { bucket: 'docs', extra: 'x'.repeat(17000) }, credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }),
    });
    expect(response.status).toBe(422);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("validates a changed endpoint before any update", async () => {
    sqlMock.mockResolvedValueOnce([{ type: 's3', config: { bucket: 'docs' }, credentials_encrypted: `sealed:${Buffer.from(JSON.stringify({ accessKeyId: 'x', secretAccessKey: 'x' })).toString('base64')}` }]);
    const response = await buildApp().request('/v1/workspaces/ws-1/connectors/conn-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Changed', config: { bucket: 'docs', endpoint: 'https://127.0.0.1/' } }),
    });
    expect(response.status).toBe(422);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls[0][0].join('')).toContain('select');
  });

  it("registers an adapter for every accepted connector type", () => {
    for (const type of connectorTypes) {
      expect(() => getConnectorAdapter(type)).not.toThrow();
    }
  });
});
