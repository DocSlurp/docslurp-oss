import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: { type: "session", userId: "actor" } as any, getOrganization: vi.fn(), details: vi.fn(), access: vi.fn(), invite: vi.fn(), accept: vi.fn(), create: vi.fn(), list: vi.fn(), deleteOrganization: vi.fn() }));
vi.mock("../services/tenant-offboarding.js", () => {
  class OffboardingError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
  }
  return { OffboardingError, deleteOrganization: mocks.deleteOrganization };
});
vi.mock("../lib/request-actor.js", () => ({ getRequestActor: () => mocks.actor }));
vi.mock("../services/api-keys.js", () => ({ listOrganizationApiKeys: vi.fn(), revokeOrganizationApiKeys: vi.fn() }));
vi.mock("../services/organizations.js", () => {
  class OrganizationError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
  }
  return { OrganizationError, getOrganization: mocks.getOrganization, getOrganizationDetails: mocks.details, getOrganizationAccess: mocks.access,
    inviteOrganizationMember: mocks.invite, acceptOrganizationInvite: mocks.accept, listOrganizationInvites: vi.fn(), revokeOrganizationInvite: vi.fn(),
    createOrganization: mocks.create, listOrganizations: mocks.list,
    listOrganizationMembers: vi.fn(), removeOrganizationMember: vi.fn(), updateOrganization: vi.fn(), updateOrganizationMemberRole: vi.fn() };
});
const { organizationsRoutes } = await import("../routes/organizations.js");
const { OrganizationError } = await import("../services/organizations.js");
const app = new Hono().route("/v1/organizations", organizationsRoutes);
const keyActor = (scopes: string[], orgId = "org", keyType = "server") => ({ type: "apiKey", userId: "actor", apiKey: { orgId, keyType, scopes } });
beforeEach(() => { vi.clearAllMocks(); mocks.actor = { type: "session", userId: "actor" }; });

describe("organization public route contracts", () => {
  it("keeps records and detail snapshots on distinct routes", async () => {
    mocks.getOrganization.mockResolvedValue({ id: "org", name: "Team" });
    mocks.details.mockResolvedValue({ organization: { id: "org" }, access: {}, counts: { members: 2, workspaces: 1 } });
    expect(await (await app.request("/v1/organizations/org")).json()).toEqual({ id: "org", name: "Team" });
    expect(await (await app.request("/v1/organizations/org/details")).json()).toHaveProperty("counts.workspaces", 1);
  });
  it("returns typed membership conflict rather than generic 400/500", async () => {
    mocks.invite.mockRejectedValue(new OrganizationError(409, "membership_exists", "Already exists"));
    const response = await app.request("/v1/organizations/org/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "Target@Example.com" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Already exists", code: "membership_exists" });
    expect(mocks.invite).toHaveBeenCalledWith("org", "actor", { email: "target@example.com", role: "member", expiresInDays: 7 });
  });
  it("invites by email and returns the accept link without user details (G-02)", async () => {
    mocks.invite.mockResolvedValue({ invite: { id: "inv", email: "target@example.com", role: "member", status: "pending" }, token: "tok" });
    const response = await app.request("/v1/organizations/org/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "target@example.com", role: "member" }) });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.inviteUrl).toMatch(/\/app\/invites\/tok\?kind=organization$/);
    expect(JSON.stringify(body)).not.toContain("name");
  });
  it("no longer adds members by user ID", async () => {
    const response = await app.request("/v1/organizations/org/members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberUserId: "target" }) });
    expect(response.status).toBe(404);
  });
  it("accepts invites only for the signed-in session", async () => {
    mocks.accept.mockResolvedValue({ orgId: "org", userId: "actor", role: "member", createdAt: "now" });
    expect((await app.request("/v1/organizations/invites/tok/accept", { method: "POST" })).status).toBe(200);
    expect(mocks.accept).toHaveBeenCalledWith("tok", "actor");
    mocks.actor = keyActor(["organizations:manage"]);
    expect((await app.request("/v1/organizations/invites/tok/accept", { method: "POST" })).status).toBe(403);
  });
  it("overrides supplied creation actor", async () => {
    mocks.create.mockResolvedValue({ id: "new" });
    const response = await app.request("/v1/organizations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Team", userId: "victim" }) });
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({ name: "Team", userId: "actor" });
  });
  it("rejects empty metadata updates", async () => {
    const response = await app.request("/v1/organizations/org", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(400);
  });
  it.each([keyActor(["ingest"]), keyActor(["organizations:manage"], "org", "client")])("denies unscoped/client keys", async actor => {
    mocks.actor = actor;
    expect((await app.request("/v1/organizations/org/details")).status).toBe(403);
    expect(mocks.details).not.toHaveBeenCalled();
  });
  it("hides other orgs and denies read keys on mutations", async () => {
    mocks.actor = keyActor(["organizations:read"]);
    expect((await app.request("/v1/organizations/other/details")).status).toBe(404);
    expect((await app.request("/v1/organizations/org/leave", { method: "POST" })).status).toBe(403);
  });
  it("reports read-only capabilities for a read key even when its owner is privileged", async () => {
    mocks.actor = keyActor(["organizations:read"]);
    mocks.access.mockResolvedValue({ orgId: "org", userId: "actor", role: "owner", capabilities: { read: true, update: true, manageMembers: true, manageOwners: true, manageApiKeys: true, leave: true } });
    const response = await app.request("/v1/organizations/org/access");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ capabilities: { read: true, update: false, manageMembers: false, manageOwners: false, manageApiKeys: false, leave: false } });
  });
  it("limits key organization listing to its bound organization", async () => {
    mocks.actor = keyActor(["organizations:manage"]);
    mocks.getOrganization.mockResolvedValue({ id: "org" });
    expect(await (await app.request("/v1/organizations")).json()).toEqual({ organizations: [{ id: "org" }] });
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("deletes an organization only for a signed-in session, with the actor and confirmation", async () => {
    mocks.deleteOrganization.mockResolvedValue({ orgId: "org", workspaces: 1, documents: 2, runsCancelled: 0 });
    const init = { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "Team" }) };
    const response = await app.request("/v1/organizations/org", init);
    expect(response.status).toBe(200);
    expect(mocks.deleteOrganization).toHaveBeenCalledWith({ orgId: "org", userId: "actor", confirmation: "Team" });

    mocks.actor = keyActor(["organizations:manage"]);
    expect((await app.request("/v1/organizations/org", init)).status).toBe(403);
    expect(mocks.deleteOrganization).toHaveBeenCalledTimes(1);
  });
  it("requires a confirmation to delete an organization", async () => {
    const response = await app.request("/v1/organizations/org", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(400);
    expect(mocks.deleteOrganization).not.toHaveBeenCalled();
  });
});
