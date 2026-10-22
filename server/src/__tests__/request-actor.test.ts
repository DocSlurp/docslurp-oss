import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "@docslurp/shared";
import type { ValidatedKey } from "../services/api-keys.js";

vi.mock("../lib/auth.js", () => ({
  appDbPool: { query: vi.fn() },
  auth: {
    api: {
      getSession: vi.fn()
    }
  }
}));

vi.mock("../services/api-keys.js", () => ({
  validateApiKey: vi.fn()
}));

vi.mock("../services/workspaces.js", () => ({ resolveWorkspaceRef: vi.fn(async () => null), findWorkspaceForInput: vi.fn(async (ref: { id?: string; slug?: string }) => ({ id: (ref.id ?? ref.slug)!, orgId: "org-1" })),
  getWorkspace: vi.fn(),
  ensureDefaultWorkspace: vi.fn(async () => ({ id: "ws-default" }))
}));

const { auth } = await import("../lib/auth.js");
const { validateApiKey } = await import("../services/api-keys.js");
const { getWorkspace } = await import("../services/workspaces.js");
const {
  actorHasAnyApiKeyScope,
  assertActorServerApiKey,
  ApiKeyWorkspaceNotAllowedError,
  assertActorWorkspaceOrgScope,
  loadActorScopedWorkspace,
  resolveActorWorkspaceId,
  resolveApiKeyActor,
  resolveBetterAuthSessionActor
} = await import("../lib/request-actor.js");

const validatedKey: ValidatedKey = {
  keyId: "key-1",
  userId: "user-1",
  orgId: "org-1",
  keyType: "server",
  allowedDomains: [],
  scopes: ["search"],
  rateLimitRpm: 60,
  rateLimitPpd: 10_000,
  rateLimits: [], workspaceIds: [],
};

const workspace = {
  id: "ws-1",
  orgId: "org-1",
  userId: "user-1"
} as WorkspaceRecord;

describe("request actor helpers", () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockReset();
    vi.mocked(validateApiKey).mockReset();
    vi.mocked(getWorkspace).mockReset();
  });

  it("resolves a Better Auth session actor from validated session headers", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User One" }
    } as never);

    const actor = await resolveBetterAuthSessionActor(new Headers());

    expect(actor).toEqual({
      type: "session",
      userId: "user-1",
      sessionId: "session-1",
      user: { id: "user-1", email: "user@example.com", name: "User One", isAdmin: false }
    });
  });

  it("wraps a validated bearer key as an API-key actor with request origin context", async () => {
    vi.mocked(validateApiKey).mockResolvedValue(validatedKey);

    const actor = await resolveApiKeyActor("Bearer dslp_test", {
      origin: "https://app.docslurp.dev",
      referer: "https://app.docslurp.dev/widget"
    });

    expect(validateApiKey).toHaveBeenCalledWith("dslp_test", {
      origin: "https://app.docslurp.dev",
      referer: "https://app.docslurp.dev/widget"
    });
    expect(actor).toEqual({ type: "apiKey", userId: "user-1", apiKey: validatedKey });
  });

  it("applies API-key scope and workspace organization capabilities through the actor", async () => {
    vi.mocked(getWorkspace).mockResolvedValue(workspace);
    const actor = { type: "apiKey" as const, userId: "user-1", apiKey: validatedKey };

    expect(actorHasAnyApiKeyScope(actor, ["search"])).toBe(true);
    expect(assertActorServerApiKey(actor)).toBeUndefined();
    await expect(loadActorScopedWorkspace("ws-1", actor)).resolves.toBe(workspace);
  });

  it("denies workspace access for a key without an organization", async () => {
    vi.mocked(getWorkspace).mockResolvedValue(workspace);
    await expect(loadActorScopedWorkspace("ws-1", { type: "apiKey", userId: "user-1", apiKey: { ...validatedKey, orgId: null } })).resolves.toBeNull();
  });

  it("denies API-key workspace loads outside the key organization", async () => {
    vi.mocked(getWorkspace).mockResolvedValue({
      ...workspace,
      orgId: "org-2"
    });

    await expect(loadActorScopedWorkspace("ws-1", {
      type: "apiKey",
      userId: "user-1",
      apiKey: validatedKey
    })).resolves.toBeNull();
  });

  describe("workspace allowlist (G-03)", () => {
    const bound = { type: "apiKey" as const, userId: "user-1", apiKey: { ...validatedKey, workspaceIds: ["ws-1"] } };

    it("loads only allowlisted workspaces", async () => {
      vi.mocked(getWorkspace).mockResolvedValue(workspace);
      await expect(loadActorScopedWorkspace("ws-1", bound)).resolves.toBe(workspace);
      vi.mocked(getWorkspace).mockResolvedValue({ ...workspace, id: "ws-2" });
      await expect(loadActorScopedWorkspace("ws-2", bound)).resolves.toBeNull();
    });

    it("rejects explicit workspaces outside the allowlist and defaults to an allowlisted one", async () => {
      await expect(resolveActorWorkspaceId(bound, "00000000-0000-4000-8000-000000000002")).rejects.toBeInstanceOf(ApiKeyWorkspaceNotAllowedError);
      await expect(resolveActorWorkspaceId(bound, null)).resolves.toBe("ws-1");
      const unrestricted = { type: "apiKey" as const, userId: "user-1", apiKey: validatedKey };
      await expect(resolveActorWorkspaceId(unrestricted, null)).resolves.toBe("ws-default");
    });

    it("checks the document's workspace, not the document id", () => {
      expect(() => assertActorWorkspaceOrgScope(bound, { id: "doc-1", workspaceId: "ws-1", orgId: "org-1" })).not.toThrow();
      expect(() => assertActorWorkspaceOrgScope(bound, { id: "doc-1", workspaceId: "ws-2", orgId: "org-1" })).toThrow(/not allowed/);
    });
  });
});
