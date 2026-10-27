import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();

vi.mock("../db.js", () => ({
  sql: sqlMock
}));

const txMock = vi.fn();

const { recordApiKeyRequest } = vi.hoisted(() => ({ recordApiKeyRequest: vi.fn() }));
vi.mock("../services/api-key-usage.js", () => ({ recordApiKeyRequest }));

vi.mock("../services/organizations.js", () => ({
  ensurePersonalOrganization: vi.fn(),
  getOrganization: vi.fn(),
  withOrganizationLock: vi.fn(async (_orgId: string, _userId: string, operation: (tx: unknown, actor: { role: string }) => unknown) => operation(txMock, { role: "owner" })),
  OrganizationError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
}));

const { apiKeyTypeFromPrefix, ApiKeyTypeChangeError, assertClientKeySensitiveScopes, createApiKey, rotateApiKey, updateApiKey, validateApiKey } = await import("../services/api-keys.js");
const organizations = await import("../services/organizations.js");

function buildKeyRow(rawKey: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    user_id: "user-1",
    org_id: "org-1",
    key_hash: hashKey(rawKey),
    name: "CLI key",
    key_type: "server",
    allowed_domains: [],
    scopes: ["ingest"],
    rate_limit_rpm: 60,
    rate_limit_ppd: 10,
    last_used_at: null,
    created_at: new Date().toISOString(),
    revoked_at: null,
    ...overrides
  };
}

function hashKey(rawKey: string) {
  return createHash("sha256").update(rawKey).digest("hex");
}

describe("validateApiKey", () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it("rejects keys without an organization binding", async () => {
    const rawKey = "dslp_unscoped";
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { org_id: null })]);
    expect(await validateApiKey(rawKey)).toBeNull();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it.each(["null", "invalid-origin"])("does not replace explicit opaque/invalid origin %s with an allowed referer", async (origin) => {
    const rawKey = "dslp_client";
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { key_type: "client", allowed_domains: ["app.docslurp.dev"] })]);
    expect(await validateApiKey(rawKey, { origin, referer: "https://app.docslurp.dev/page" })).toBeNull();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("authenticates with a single query and buffers usage bookkeeping", async () => {
    const rawKey = "dslp_limited";
    const rule = { metric: "spend", limit: 500, windowSeconds: 86_400 };
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { rate_limits: [rule] })]);

    const validated = await validateApiKey(rawKey);

    // Daily page caps and other limits are enforced by the rate-limit middleware.
    expect(validated).toMatchObject({ keyId: "key-1", rateLimits: [rule] });
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(recordApiKeyRequest).toHaveBeenCalledWith("key-1");
  });

  it("ignores malformed stored limits instead of failing authentication", async () => {
    const rawKey = "dslp_malformed_limits";
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { rate_limits: [{ metric: "bogus", limit: -1 }] })]);

    expect(await validateApiKey(rawKey)).toMatchObject({ keyId: "key-1", rateLimits: [] });
  });

  it("rejects a client key when the request origin is not allowlisted", async () => {
    const rawKey = "dslp_client_locked";
    const keyRow = buildKeyRow(rawKey, {
      key_type: "client",
      allowed_domains: ["app.docslurp.dev"],
      scopes: ["search"],
      rate_limit_ppd: 10000
    });

    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join(" ");

      if (text.includes("select * from api_keys")) {
        return [keyRow];
      }

      return [];
    });

    const validated = await validateApiKey(rawKey, {
      origin: "https://evil.example"
    });

    expect(validated).toBeNull();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a client key when the origin matches an allowed parent domain", async () => {
    const rawKey = "dslp_client_allowed";
    const keyRow = buildKeyRow(rawKey, {
      key_type: "client",
      allowed_domains: ["docslurp.dev"],
      scopes: ["search"],
      rate_limit_ppd: 10000
    });

    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join(" ");

      if (text.includes("select * from api_keys")) {
        return [keyRow];
      }

      if (text.includes("select coalesce(sum(request_count)")) {
        return [{ request_count: 1, page_count: 0 }];
      }

      if (text.includes("select coalesce(sum(page_count)")) {
        return [{ page_count: 0, request_count: 0 }];
      }

      return [];
    });

    const validated = await validateApiKey(rawKey, {
      origin: "https://app.docslurp.dev"
    });

    expect(validated).toMatchObject({
      keyId: "key-1",
      keyType: "client",
      allowedDomains: ["docslurp.dev"],
      scopes: ["search"]
    });
  });
  it.each([
    [{ referer: "https://docslurp.io/docs/sdk" }, true],
    [{}, false],
    [{ origin: "null", referer: "https://docslurp.io/docs" }, false],
    [{ origin: "https://other.example", referer: "https://docslurp.io/docs" }, false],
    [{ origin: "https://docslurp.io.other.example" }, false],
  ])("checks Origin first and uses Referer only when Origin is absent: %j", async (context, accepted) => {
    const rawKey = "dslp_docs_client";
    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const text = strings.join(" ");
      if (text.includes("select * from api_keys")) return [buildKeyRow(rawKey, { key_type: "client", allowed_domains: ["docslurp.io"], scopes: ["search"] })];
      if (text.includes("coalesce(sum")) return [{ request_count: 0, page_count: 0 }];
      return [];
    });
    expect(Boolean(await validateApiKey(rawKey, context))).toBe(accepted);
  });

});

describe("typed key prefixes", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    txMock.mockReset();
  });

  it("reads the claimed type from dslp_pub_/dslp_priv_ and treats older keys as untyped", () => {
    expect(apiKeyTypeFromPrefix("dslp_pub_abc")).toBe("client");
    expect(apiKeyTypeFromPrefix("dslp_priv_abc")).toBe("server");
    expect(apiKeyTypeFromPrefix("dslp_abc")).toBeNull();
  });

  it("never authenticates a key whose prefix disagrees with its stored type", async () => {
    const rawKey = "dslp_pub_mismatched";
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { key_type: "server" })]);
    expect(await validateApiKey(rawKey)).toBeNull();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to change a key's type in place", async () => {
    sqlMock.mockResolvedValue([{ org_id: "org-1" }]);
    txMock.mockResolvedValue([buildKeyRow("dslp_pub_widget", { key_type: "client", allowed_domains: ["docslurp.dev"], scopes: ["search"] })]);
    await expect(updateApiKey("key-1", "user-1", { keyType: "server" })).rejects.toBeInstanceOf(ApiKeyTypeChangeError);
    expect(txMock).toHaveBeenCalledTimes(1);
  });

  it.each([["client", "dslp_pub_"], ["server", "dslp_priv_"]])("rotates a %s key under its own prefix", async (keyType, prefix) => {
    const existing = buildKeyRow("old", { key_type: keyType, allowed_domains: keyType === "client" ? ["docslurp.dev"] : [], scopes: ["search"] });
    sqlMock.mockResolvedValue([{ org_id: "org-1" }]);
    txMock.mockResolvedValueOnce([existing]).mockResolvedValueOnce([existing]);
    const rotated = await rotateApiKey("key-1", "user-1");
    expect(rotated?.rawKey.startsWith(prefix)).toBe(true);
    expect(rotated?.rawKey).toMatch(new RegExp(`^${prefix}[0-9a-f]{64}$`));
  });
});

describe("client key scopes and workspace allowlists (G-03)", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    txMock.mockReset();
    Object.assign(txMock, { array: (value: unknown) => value, json: (value: unknown) => value });
    vi.mocked(organizations.getOrganization).mockResolvedValue({ id: "org-1" } as never);
  });

  it("creates client keys search-only by default", async () => {
    txMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("insert into api_keys")) {
        return [buildKeyRow("x", { key_type: "client", allowed_domains: ["docslurp.dev"], scopes: values[7], workspace_ids: values[11] })];
      }
      return [];
    });
    const { key } = await createApiKey("user-1", "Widget", { orgId: "org-1", keyType: "client", allowedDomains: ["docslurp.dev"] });
    expect(key.scopes).toEqual(["search"]);
    expect(key.workspaceIds).toEqual([]);
  });

  it("requires an opt-in and a workspace allowlist for ingest or artifacts on client keys", () => {
    expect(() => assertClientKeySensitiveScopes("client", ["search", "ingest"], ["ws-1"], false)).toThrow(/search-only by default/);
    expect(() => assertClientKeySensitiveScopes("client", ["artifacts"], [], true)).toThrow(/limited to specific workspaces/);
    expect(() => assertClientKeySensitiveScopes("client", ["ingest", "artifacts"], ["ws-1"], true)).not.toThrow();
    expect(() => assertClientKeySensitiveScopes("server", ["ingest", "artifacts"], [], false)).not.toThrow();
    // Web tools spend credits on the open web: opt-in and workspace-bound, like ingest.
    expect(() => assertClientKeySensitiveScopes("client", ["search", "web"], ["ws-1"], false)).toThrow(/search-only by default/);
    expect(() => assertClientKeySensitiveScopes("client", ["search", "web"], [], true)).toThrow(/limited to specific workspaces/);
    expect(() => assertClientKeySensitiveScopes("client", ["search", "web"], ["ws-1"], true)).not.toThrow();
    // Chat is a plain opt-in scope for answer widgets, not a sensitive one.
    expect(() => assertClientKeySensitiveScopes("client", ["search", "chat"], [], false)).not.toThrow();
  });

  it("rejects allowlisted workspaces outside the key's org", async () => {
    txMock.mockResolvedValue([]);
    await expect(createApiKey("user-1", "Bound", { orgId: "org-1", workspaceIds: ["ws-elsewhere"] })).rejects.toThrow(/Workspace not found/);
  });

  it("strips ingest and artifacts from legacy client keys that have no allowlist", async () => {
    const rawKey = "dslp_pub_legacy";
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { key_type: "client", allowed_domains: ["docslurp.dev"], scopes: ["ingest", "search", "artifacts"], workspace_ids: [] })]);
    expect((await validateApiKey(rawKey, { origin: "https://docslurp.dev" }))?.scopes).toEqual(["search"]);
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { key_type: "client", allowed_domains: ["docslurp.dev"], scopes: ["ingest", "search"], workspace_ids: ["ws-1"] })]);
    expect(await validateApiKey(rawKey, { origin: "https://docslurp.dev" })).toMatchObject({ scopes: ["ingest", "search"], workspaceIds: ["ws-1"] });
  });
});
