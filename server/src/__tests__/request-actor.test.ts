import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "@docslurp/shared";
import type { ValidatedKey } from "../services/api-keys.js";

vi.mock("../lib/auth.js", () => ({
  appDbPool: { query: vi.fn(async () => ({ rows: [] })) },
  auth: {
    api: {
      getSession: vi.fn()
    }
  }
}));

vi.mock("../services/api-keys.js", () => ({
  validateApiKey: vi.fn()
}));

vi.mock("../services/projects.js", () => ({ resolveProjectRef: vi.fn(async () => null), findProjectForInput: vi.fn(async (ref: { id?: string; slug?: string }) => ({ id: (ref.id ?? ref.slug)!, orgId: "org-1" })),
  getProject: vi.fn(),
  ensureDefaultProject: vi.fn(async () => ({ id: "ws-default" }))
}));

const { auth } = await import("../lib/auth.js");
const { validateApiKey } = await import("../services/api-keys.js");
const { getProject } = await import("../services/projects.js");
const {
  actorHasAnyApiKeyScope,
  assertActorServerApiKey,
  ApiKeyProjectNotAllowedError,
  assertActorProjectOrgScope,
  loadActorScopedProject,
  resolveActorProjectId,
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
  rateLimits: [], projectIds: [],
};

const project = {
  id: "ws-1",
  orgId: "org-1",
  userId: "user-1"
} as ProjectRecord;

describe("request actor helpers", () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockReset();
    vi.mocked(validateApiKey).mockReset();
    vi.mocked(getProject).mockReset();
  });

  it("resolves a Better Auth session actor from validated session headers", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      headers: new Headers(),
      response: {
        session: { id: "session-1", userId: "user-1" },
        user: { id: "user-1", email: "user@example.com", name: "User One" }
      }
    } as never);

    const actor = await resolveBetterAuthSessionActor(new Headers());

    expect(actor).toEqual({
      type: "session",
      userId: "user-1",
      sessionId: "session-1",
      user: { id: "user-1", email: "user@example.com", name: "User One", isAdmin: false },
      mfaVerified: false,
      mfaPolicyBlocked: false
    });
  });

  it("hands Better Auth's refreshed session cookie to the caller", async () => {
    const refreshed = new Headers();
    refreshed.append("set-cookie", "better-auth.session_token=renewed; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax");
    vi.mocked(auth.api.getSession).mockResolvedValue({
      headers: refreshed,
      response: { session: { id: "session-1", userId: "user-1" }, user: { id: "user-1", email: "user@example.com", name: "User One" } }
    } as never);
    const responseHeaders = new Headers();

    await resolveBetterAuthSessionActor(new Headers(), responseHeaders);

    expect(vi.mocked(auth.api.getSession)).toHaveBeenCalledWith(expect.objectContaining({ returnHeaders: true }));
    expect(responseHeaders.getSetCookie()).toEqual(refreshed.getSetCookie());
  });

  it("returns no actor when there is no session", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({ headers: new Headers(), response: null } as never);
    expect(await resolveBetterAuthSessionActor(new Headers())).toBeNull();
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

  it("applies API-key scope and project organization capabilities through the actor", async () => {
    vi.mocked(getProject).mockResolvedValue(project);
    const actor = { type: "apiKey" as const, userId: "user-1", apiKey: validatedKey };

    expect(actorHasAnyApiKeyScope(actor, ["search"])).toBe(true);
    expect(assertActorServerApiKey(actor)).toBeUndefined();
    await expect(loadActorScopedProject("ws-1", actor)).resolves.toBe(project);
  });

  it("denies project access for a key whose organization is blank", async () => {
    vi.mocked(getProject).mockResolvedValue(project);
    await expect(loadActorScopedProject("ws-1", { type: "apiKey", userId: "user-1", apiKey: { ...validatedKey, orgId: "" } })).resolves.toBeNull();
  });

  it("denies API-key project loads outside the key organization", async () => {
    vi.mocked(getProject).mockResolvedValue({
      ...project,
      orgId: "org-2"
    });

    await expect(loadActorScopedProject("ws-1", {
      type: "apiKey",
      userId: "user-1",
      apiKey: validatedKey
    })).resolves.toBeNull();
  });

  describe("project allowlist (G-03)", () => {
    const bound = { type: "apiKey" as const, userId: "user-1", apiKey: { ...validatedKey, projectIds: ["ws-1"] } };

    it("loads only allowlisted projects", async () => {
      vi.mocked(getProject).mockResolvedValue(project);
      await expect(loadActorScopedProject("ws-1", bound)).resolves.toBe(project);
      vi.mocked(getProject).mockResolvedValue({ ...project, id: "ws-2" });
      await expect(loadActorScopedProject("ws-2", bound)).resolves.toBeNull();
    });

    it("rejects explicit projects outside the allowlist and defaults to an allowlisted one", async () => {
      await expect(resolveActorProjectId(bound, "00000000-0000-4000-8000-000000000002")).rejects.toBeInstanceOf(ApiKeyProjectNotAllowedError);
      await expect(resolveActorProjectId(bound, null)).resolves.toBe("ws-1");
      const unrestricted = { type: "apiKey" as const, userId: "user-1", apiKey: validatedKey };
      await expect(resolveActorProjectId(unrestricted, null)).resolves.toBe("ws-default");
    });

    it("checks the document's project, not the document id", () => {
      expect(() => assertActorProjectOrgScope(bound, { id: "doc-1", projectId: "ws-1", orgId: "org-1" })).not.toThrow();
      expect(() => assertActorProjectOrgScope(bound, { id: "doc-1", projectId: "ws-2", orgId: "org-1" })).toThrow(/not allowed/);
    });
  });
});
