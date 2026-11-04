import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The response-cache key decision on its own: strict-privacy anywhere in scope,
 * or any lookup that cannot answer, means no key (no cache read or write).
 */

const privacyModes = vi.hoisted(() => new Map<string, unknown>());
const access = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../lib/privacy.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/privacy.js")>(),
  loadWorkspacePrivacyModeForCache: vi.fn(async (workspaceId: string) => {
    const mode = privacyModes.get(workspaceId);
    if (mode instanceof Error) throw mode;
    return mode ?? null;
  }),
}));
vi.mock("../services/organizations.js", () => ({
  getWorkspaceAccess: vi.fn(async (workspaceId: string) => {
    const entry = access.get(workspaceId);
    if (entry instanceof Error) throw entry;
    return entry ?? null;
  }),
}));
vi.mock("../db.js", () => ({ sql: vi.fn(async () => { throw new Error("no database in this test"); }) }));

const { responseCacheKey } = await import("../search/response-cache.js");
const { loadWorkspacePrivacyModeForCache } = await vi.importActual<typeof import("../lib/privacy.js")>("../lib/privacy.js");

const request = { q: "pump", workspace: "ws-a" };
const key = (workspaceIds: string[], overrides: Partial<Parameters<typeof responseCacheKey>[0]> = {}) =>
  responseCacheKey({ userId: "user-1", apiKeyId: "key-1", workspaceIds, request, ...overrides });

beforeEach(() => {
  privacyModes.clear();
  access.clear();
  for (const [id, org, mode] of [["ws-a", "org-1", "standard"], ["ws-b", "org-1", "local-only"], ["ws-strict", "org-1", "strict-privacy"], ["ws-other", "org-2", "standard"]] as const) {
    privacyModes.set(id, mode);
    access.set(id, { workspaceId: id, orgId: org });
  }
});

describe("responseCacheKey", () => {
  it("keys standard and local-only scopes on org, user, key, workspaces and the request", async () => {
    const value = await key(["ws-b", "ws-a"]);
    expect(value).not.toBeNull();
    expect(JSON.parse(value!)).toEqual([["org-1"], "user-1", "key-1", ["ws-a", "ws-b"], request]);
  });

  it("separates callers, keys, organizations and requests", async () => {
    const base = await key(["ws-a"]);
    const variants = await Promise.all([
      key(["ws-a"], { userId: "user-2" }),
      key(["ws-a"], { apiKeyId: null }),
      key(["ws-a"], { apiKeyId: "key-2" }),
      key(["ws-other"]),
      key(["ws-a"], { request: { ...request, tags: "x" } }),
    ]);
    for (const variant of variants) {
      expect(variant).not.toBeNull();
      expect(variant).not.toBe(base);
    }
  });

  it("refuses a strict-privacy workspace alone or anywhere in a mixed scope", async () => {
    expect(await key(["ws-strict"])).toBeNull();
    expect(await key(["ws-a", "ws-strict"])).toBeNull();
    expect(await key(["ws-strict", "ws-b", "ws-a"])).toBeNull();
  });

  it("fails closed when privacy or access cannot be resolved", async () => {
    privacyModes.delete("ws-a");
    expect(await key(["ws-a"])).toBeNull();
    privacyModes.set("ws-a", new Error("db down"));
    expect(await key(["ws-a"])).toBeNull();
    privacyModes.set("ws-a", "standard");
    access.delete("ws-a");
    expect(await key(["ws-a"])).toBeNull();
    access.set("ws-a", new Error("db down"));
    expect(await key(["ws-a"])).toBeNull();
    access.set("ws-a", { workspaceId: "ws-other", orgId: "org-2" });
    expect(await key(["ws-a"])).toBeNull();
  });

  it("refuses an empty scope or caller", async () => {
    expect(await key([])).toBeNull();
    expect(await key([""])).toBeNull();
    expect(await key(["ws-a"], { userId: " " })).toBeNull();
  });

  it("the real privacy loader answers null, not a substituted mode, when its query fails", async () => {
    expect(await loadWorkspacePrivacyModeForCache("ws-a")).toBeNull();
  });
});
