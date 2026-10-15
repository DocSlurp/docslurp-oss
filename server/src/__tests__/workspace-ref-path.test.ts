import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const UUID = "4f9b2c1e-1d2a-4c3b-8e7f-0a1b2c3d4e5f";
const ensureDefaultWorkspace = vi.fn(async ({ orgId }: { orgId?: string | null }) => ({ id: `ws-default-${orgId ?? "personal"}` }));
const resolveWorkspaceRef = vi.fn(async (ref: string) => {
  if (ref === "amber-falcon-ridge" || ref === UUID) return { id: UUID, slug: "amber-falcon-ridge", renamedFrom: null };
  if (ref === "legal-contracts") return { id: UUID, slug: "amber-falcon-ridge", renamedFrom: "legal-contracts" };
  if (ref.startsWith("ws-default-")) return { id: ref, slug: "quiet-river-otter", renamedFrom: null };
  return null;
});
vi.mock("../services/workspaces.js", () => ({ ensureDefaultWorkspace, resolveWorkspaceRef, getWorkspace: vi.fn() }));

const { workspaceRefPath } = await import("../middleware/workspace-ref-path.js");
const { setRequestActor, getRequestActor } = await import("../lib/request-actor.js");

function app() {
  const workspaces = new Hono()
    .get("/board", (c) => c.json({ board: true }))
    .post("/invites/:token/accept", (c) => c.json({ accepted: c.req.param("token") }))
    .get("/:workspaceId/state", (c) => c.json({ workspaceId: c.req.param("workspaceId"), userId: getRequestActor(c).userId }))
    .post("/:workspaceId", async (c) => c.json({ workspaceId: c.req.param("workspaceId"), body: await c.req.json() }));
  const server = new Hono();
  server.use("*", async (c, next) => {
    setRequestActor(c, { type: "session", userId: "user-1", sessionId: "s", user: { id: "user-1", email: "", name: "" } });
    await next();
  });
  const refs = workspaceRefPath([workspaces]);
  server.use("/v1/workspaces/:workspaceRef", refs);
  server.use("/v1/workspaces/:workspaceRef/*", refs);
  server.route("/v1/workspaces", workspaces);
  return server;
}

describe("workspace references in REST paths", () => {
  it("serves slugs with the same actor and reports the canonical identity", async () => {
    const response = await app().request("/v1/workspaces/amber-falcon-ridge/state");
    expect(await response.json()).toEqual({ workspaceId: UUID, userId: "user-1" });
    expect(response.headers.get("X-DocSlurp-Workspace-Slug")).toBe("amber-falcon-ridge");
    expect(response.headers.get("X-DocSlurp-Workspace-Id")).toBe(UUID);
    expect(response.headers.get("X-DocSlurp-Workspace-Renamed-From")).toBeNull();
  });

  it("keeps former slugs working after a rename and says so", async () => {
    const response = await app().request("/v1/workspaces/legal-contracts/state");
    expect(await response.json()).toMatchObject({ workspaceId: UUID });
    expect(response.headers.get("X-DocSlurp-Workspace-Renamed-From")).toBe("legal-contracts");
    expect(response.headers.get("X-DocSlurp-Workspace-Slug")).toBe("amber-falcon-ridge");
  });

  it("resolves default per org and forwards request bodies", async () => {
    const server = app();
    const state = await server.request("/v1/workspaces/default/state?orgId=org-9");
    expect(await state.json()).toMatchObject({ workspaceId: "ws-default-org-9" });
    const aliased = await server.request("/v1/workspaces/default", { method: "POST", body: JSON.stringify({ name: "x" }) });
    expect(await aliased.json()).toEqual({ workspaceId: "ws-default-personal", body: { name: "x" } });
  });

  it("does not reveal workspace identity when the route denies access", async () => {
    const workspaces = new Hono().get("/:workspaceId/state", (c) => c.json({ error: "Workspace not found" }, 404));
    const server = new Hono();
    server.use("*", async (c, next) => {
      setRequestActor(c, { type: "session", userId: "outsider", sessionId: "s", user: { id: "outsider", email: "", name: "" } });
      await next();
    });
    const refs = workspaceRefPath([workspaces]);
    server.use("/v1/workspaces/:workspaceRef/*", refs);
    server.route("/v1/workspaces", workspaces);
    const response = await server.request("/v1/workspaces/amber-falcon-ridge/state");
    expect(response.status).toBe(404);
    expect(response.headers.get("X-DocSlurp-Workspace-Id")).toBeNull();
    expect(response.headers.get("X-DocSlurp-Workspace-Slug")).toBeNull();
  });

  it("leaves UUIDs, static routes and unknown references to the normal routes", async () => {
    const server = app();
    expect(await (await server.request(`/v1/workspaces/${UUID}/state`)).json()).toMatchObject({ workspaceId: UUID });
    expect(await (await server.request("/v1/workspaces/board")).json()).toEqual({ board: true });
    expect(await (await server.request("/v1/workspaces/invites/tok/accept", { method: "POST" })).json()).toEqual({ accepted: "tok" });
    expect(resolveWorkspaceRef).not.toHaveBeenCalledWith("invites");
    expect(await (await server.request("/v1/workspaces/no-such-slug/state")).json()).toMatchObject({ workspaceId: "no-such-slug" });
  });
});
