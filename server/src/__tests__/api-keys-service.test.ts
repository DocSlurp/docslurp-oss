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

const { apiKeyTypeFromPrefix, ApiKeyTypeChangeError, ClientKeyOriginNotAllowedError, ClientKeyWorkspacesRequiredError, createApiKey, rotateApiKey, updateApiKey, validateApiKey } = await import("../services/api-keys.js");
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

/** True when the key authenticates; false only for the browser-key website refusal (anything else fails the test). */
async function originAccepted(rawKey: string, context: { origin?: string | null; referer?: string | null }): Promise<boolean> {
  try {
    return Boolean(await validateApiKey(rawKey, context));
  } catch (error) {
    if (error instanceof ClientKeyOriginNotAllowedError) return false;
    throw error;
  }
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
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { key_type: "client", allowed_domains: ["app.docslurp.dev"], workspace_ids: ["ws-1"] })]);
    await expect(validateApiKey(rawKey, { origin, referer: "https://app.docslurp.dev/page" })).rejects.toMatchObject({ status: 403, code: "client_key_origin_not_allowed" });
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
    expect(recordApiKeyRequest).toHaveBeenCalledWith("key-1", expect.any(Number), null);
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

    // A distinct, actionable refusal rather than the generic invalid-key answer.
    await expect(validateApiKey(rawKey, { origin: "https://evil.example" })).rejects.toBeInstanceOf(ClientKeyOriginNotAllowedError);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a client key when the origin is a subdomain of an explicit *. entry", async () => {
    const rawKey = "dslp_client_allowed";
    const keyRow = buildKeyRow(rawKey, {
      key_type: "client",
      allowed_domains: ["*.docslurp.dev"],
      workspace_ids: ["ws-1"],
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
      allowedDomains: ["*.docslurp.dev"],
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
      if (text.includes("select * from api_keys")) return [buildKeyRow(rawKey, { key_type: "client", allowed_domains: ["docslurp.io"], scopes: ["search"], workspace_ids: ["ws-1"] })];
      if (text.includes("coalesce(sum")) return [{ request_count: 0, page_count: 0 }];
      return [];
    });
    expect(await originAccepted(rawKey, context)).toBe(accepted);
  });

  it.each([
    // Exact host: either scheme, any port; never a subdomain, a suffix trick or a trailing dot.
    [["docslurp.io"], "https://docslurp.io", true],
    [["docslurp.io"], "http://docslurp.io:8080", true],
    [["docslurp.io"], "https://app.docslurp.io", false],
    [["docslurp.io"], "https://evil-docslurp.io", false],
    [["docslurp.io"], "https://docslurp.io.evil.example", false],
    [["docslurp.io"], "https://docslurp.io.", false],
    [["docslurp.io"], "chrome-extension://docslurp.io", false],
    // Subdomains only with an explicit wildcard, which does not cover the apex.
    [["*.docslurp.io"], "https://app.docslurp.io", true],
    [["*.docslurp.io"], "https://a.b.docslurp.io", true],
    [["*.docslurp.io"], "https://docslurp.io", false],
    // Scheme and port are matched when the entry names them.
    [["https://docslurp.io"], "http://docslurp.io", false],
    [["https://docslurp.io"], "https://docslurp.io:443", true],
    [["docslurp.io:8443"], "https://docslurp.io:8443", true],
    [["docslurp.io:8443"], "https://docslurp.io", false],
    [["http://localhost:4321"], "http://localhost:4321", true],
    [["http://localhost:4321"], "http://localhost:4322", false],
    // A stored public suffix never matches (it names no single owner).
    [["github.io"], "https://victim.github.io", false],
    [["*.github.io"], "https://anyone.github.io", false],
    // Case and IDN: both sides go through URL parsing.
    [["DocSlurp.IO"], "https://docslurp.io", true],
    [["bücher.example"], "https://xn--bcher-kva.example", true],
  ])("matches allowlist %j against Origin %s → %s", async (allowed, origin, accepted) => {
    const rawKey = "dslp_pub_origin_matrix";
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { key_type: "client", allowed_domains: allowed, scopes: ["search"], workspace_ids: ["ws-1"] })]);
    expect(await originAccepted(rawKey, { origin })).toBe(accepted);
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
    Object.assign(txMock, { array: (value: unknown) => value, json: (value: unknown) => value });
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

  it("creates client keys search-only by default, bound to the named workspaces", async () => {
    txMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("insert into api_keys")) {
        return [buildKeyRow("x", { key_type: "client", allowed_domains: values[6], scopes: values[7], workspace_ids: values[11] })];
      }
      if (text.includes("from workspaces w")) return [{ id: "ws-1" }];
      return [];
    });
    const { key } = await createApiKey("user-1", "Widget", { orgId: "org-1", keyType: "client", allowedDomains: ["*.DocSlurp.dev", "https://docs.example.com:8443/"], workspaceIds: ["ws-1"] });
    expect(key.scopes).toEqual(["search"]);
    expect(key.workspaceIds).toEqual(["ws-1"]);
    expect(key.allowedDomains).toEqual(["*.docslurp.dev", "https://docs.example.com:8443"]);
  });

  it("refuses to create or save a browser key without a workspace allowlist", async () => {
    txMock.mockImplementation(async (strings: TemplateStringsArray) => strings.join("?").includes("from workspaces w") ? [{ id: "ws-1" }] : []);
    await expect(createApiKey("user-1", "Widget", { orgId: "org-1", keyType: "client", allowedDomains: ["docslurp.dev"] }))
      .rejects.toMatchObject({ status: 400, code: "client_key_workspaces_required" });
    await expect(createApiKey("user-1", "Widget", { orgId: "org-1", keyType: "client", allowedDomains: ["docslurp.dev"], workspaceIds: [] }))
      .rejects.toMatchObject({ code: "client_key_workspaces_required" });
    // A legacy key with none must name workspaces on its next save, and a save cannot empty the list.
    sqlMock.mockResolvedValue([{ org_id: "org-1" }]);
    txMock.mockResolvedValueOnce([buildKeyRow("dslp_pub_legacy", { key_type: "client", allowed_domains: ["docslurp.dev"], scopes: ["search"], workspace_ids: [] })]);
    await expect(updateApiKey("key-1", "user-1", { name: "Renamed" })).rejects.toMatchObject({ code: "client_key_workspaces_required" });
    txMock.mockResolvedValueOnce([buildKeyRow("dslp_pub_bound", { key_type: "client", allowed_domains: ["docslurp.dev"], scopes: ["search"], workspace_ids: ["ws-1"] })]);
    await expect(updateApiKey("key-1", "user-1", { workspaceIds: [] })).rejects.toMatchObject({ code: "client_key_workspaces_required" });
    // The fix: a save that adds workspaces to the legacy key (here with new websites too) succeeds.
    txMock.mockReset();
    Object.assign(txMock, { array: (value: unknown) => value, json: (value: unknown) => value });
    txMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("for update")) return [buildKeyRow("dslp_pub_legacy", { key_type: "client", allowed_domains: ["docslurp.dev"], scopes: ["search"], workspace_ids: [] })];
      if (text.includes("from workspaces w")) return [{ id: "ws-1" }];
      if (text.includes("update api_keys set")) return [buildKeyRow("dslp_pub_legacy", { key_type: "client", allowed_domains: values[1], scopes: ["search"], workspace_ids: ["ws-1"] })];
      return [];
    });
    await expect(updateApiKey("key-1", "user-1", { workspaceIds: ["ws-1"], allowedDomains: ["*.docslurp.dev"] })).resolves.toMatchObject({ workspaceIds: ["ws-1"] });
  });

  it.each(["github.io", "*.github.io", "vercel.app", "https://netlify.app", "co.uk", "com", "*.com", "pages.dev:443",
    // Private-section PSL entries a curated list missed.
    "*.s3.us-east-1.amazonaws.com", "*.blob.core.windows.net", "*.gitbook.io", "*.eu.org", "foo.ck"])("refuses public-suffix-only allowed domain %s at key creation", async (domain) => {
    txMock.mockImplementation(async (strings: TemplateStringsArray) => strings.join("?").includes("from workspaces w") ? [{ id: "ws-1" }] : []);
    await expect(createApiKey("user-1", "Widget", { orgId: "org-1", keyType: "client", allowedDomains: [domain], workspaceIds: ["ws-1"] }))
      .rejects.toMatchObject({ status: 400, code: "invalid_allowed_domain" });
  });

  it.each(["myname.github.io", "*.example.co.uk", "localhost:4321", "127.0.0.1:3000", "docs.example.com", "mybucket.s3.us-east-1.amazonaws.com", "www.ck"])("accepts an owned domain %s", async (domain) => {
    txMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("insert into api_keys")) return [buildKeyRow("x", { key_type: "client", allowed_domains: values[6], scopes: values[7], workspace_ids: values[11] })];
      return text.includes("from workspaces w") ? [{ id: "ws-1" }] : [];
    });
    await expect(createApiKey("user-1", "Widget", { orgId: "org-1", keyType: "client", allowedDomains: [domain], workspaceIds: ["ws-1"] })).resolves.toBeDefined();
  });

  it.each(["ftp://docslurp.io", "docslurp.io/path", "doc*slurp.io", "user@docslurp.io"])("refuses a malformed allowed domain %s", async (domain) => {
    txMock.mockImplementation(async (strings: TemplateStringsArray) => strings.join("?").includes("from workspaces w") ? [{ id: "ws-1" }] : []);
    await expect(createApiKey("user-1", "Widget", { orgId: "org-1", keyType: "client", allowedDomains: [domain], workspaceIds: ["ws-1"] }))
      .rejects.toMatchObject({ code: "invalid_allowed_domain" });
  });

  it.each([["ingest"], ["artifacts"], ["web"], ["workspaces:manage"], ["organizations:read"], ["search", "ingest"]])("refuses a browser key asking for server scope %j, even with the old opt-in", async (...scopes) => {
    txMock.mockImplementation(async (strings: TemplateStringsArray) => strings.join("?").includes("from workspaces w") ? [{ id: "ws-1" }] : []);
    await expect(createApiKey("user-1", "Widget", { orgId: "org-1", keyType: "client", allowedDomains: ["docs.example.com"], workspaceIds: ["ws-1"], scopes, allowClientSensitiveScopes: true }))
      .rejects.toMatchObject({ status: 400, code: "invalid_key_scope" });
  });

  it("rejects allowlisted workspaces outside the key's org", async () => {
    txMock.mockResolvedValue([]);
    await expect(createApiKey("user-1", "Bound", { orgId: "org-1", workspaceIds: ["ws-elsewhere"] })).rejects.toThrow(/Workspace not found/);
  });

  it("refuses a legacy browser key with no workspace allowlist instead of widening it to the whole org", async () => {
    const rawKey = "dslp_pub_legacy";
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { key_type: "client", allowed_domains: ["docslurp.dev"], scopes: ["ingest", "search", "artifacts"], workspace_ids: [] })]);
    const refused = validateApiKey(rawKey, { origin: "https://docslurp.dev" });
    await expect(refused).rejects.toBeInstanceOf(ClientKeyWorkspacesRequiredError);
    await expect(validateApiKey(rawKey, { origin: "https://docslurp.dev" })).rejects.toThrow(/workspaceIds/);
    // The website check comes first.
    await expect(validateApiKey(rawKey, { origin: "https://evil.example" })).rejects.toBeInstanceOf(ClientKeyOriginNotAllowedError);
    sqlMock.mockResolvedValue([buildKeyRow(rawKey, { key_type: "client", allowed_domains: ["docslurp.dev"], scopes: ["ingest", "search"], workspace_ids: ["ws-1"] })]);
    // Bound to workspaces, but a browser key still never gets server scopes: legacy ingest is dropped.
    expect(await validateApiKey(rawKey, { origin: "https://docslurp.dev" })).toMatchObject({ scopes: ["search"], workspaceIds: ["ws-1"] });
  });
});
