import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const UUID = "4f9b2c1e-1d2a-4c3b-8e7f-0a1b2c3d4e5f";
const ensureDefaultProject = vi.fn(async ({ orgId }: { orgId?: string | null }) => ({ id: `ws-default-${orgId ?? "personal"}` }));
const resolveProjectRef = vi.fn(async (ref: string) => {
  if (ref === "amber-falcon-ridge" || ref === UUID) return { id: UUID, slug: "amber-falcon-ridge", renamedFrom: null };
  if (ref === "legal-contracts") return { id: UUID, slug: "amber-falcon-ridge", renamedFrom: "legal-contracts" };
  if (ref.startsWith("ws-default-")) return { id: ref, slug: "quiet-river-otter", renamedFrom: null };
  return null;
});
vi.mock("../services/projects.js", () => ({ ensureDefaultProject, resolveProjectRef, getProject: vi.fn() }));

const { projectRefPath } = await import("../middleware/project-ref-path.js");
const { setRequestActor, getRequestActor } = await import("../lib/request-actor.js");

function app() {
  const projects = new Hono()
    .get("/board", (c) => c.json({ board: true }))
    .post("/invites/:token/accept", (c) => c.json({ accepted: c.req.param("token") }))
    .get("/:projectId/state", (c) => c.json({ projectId: c.req.param("projectId"), userId: getRequestActor(c).userId }))
    .post("/:projectId", async (c) => c.json({ projectId: c.req.param("projectId"), body: await c.req.json() }));
  const server = new Hono();
  server.use("*", async (c, next) => {
    setRequestActor(c, { type: "session", userId: "user-1", sessionId: "s", user: { id: "user-1", email: "", name: "" } });
    await next();
  });
  const refs = projectRefPath([projects]);
  server.use("/v1/projects/:projectRef", refs);
  server.use("/v1/projects/:projectRef/*", refs);
  server.route("/v1/projects", projects);
  return server;
}

describe("project references in REST paths", () => {
  it("serves slugs with the same actor and reports the canonical identity", async () => {
    const response = await app().request("/v1/projects/amber-falcon-ridge/state");
    expect(await response.json()).toEqual({ projectId: UUID, userId: "user-1" });
    expect(response.headers.get("X-DocSlurp-Project-Slug")).toBe("amber-falcon-ridge");
    expect(response.headers.get("X-DocSlurp-Project-Id")).toBe(UUID);
    expect(response.headers.get("X-DocSlurp-Project-Renamed-From")).toBeNull();
  });

  it("keeps former slugs working after a rename and says so", async () => {
    const response = await app().request("/v1/projects/legal-contracts/state");
    expect(await response.json()).toMatchObject({ projectId: UUID });
    expect(response.headers.get("X-DocSlurp-Project-Renamed-From")).toBe("legal-contracts");
    expect(response.headers.get("X-DocSlurp-Project-Slug")).toBe("amber-falcon-ridge");
  });

  it("resolves default per org and forwards request bodies", async () => {
    const server = app();
    const state = await server.request("/v1/projects/default/state?orgId=org-9");
    expect(await state.json()).toMatchObject({ projectId: "ws-default-org-9" });
    const aliased = await server.request("/v1/projects/default", { method: "POST", body: JSON.stringify({ name: "x" }) });
    expect(await aliased.json()).toEqual({ projectId: "ws-default-personal", body: { name: "x" } });
  });

  it("does not reveal project identity when the route denies access", async () => {
    const projects = new Hono().get("/:projectId/state", (c) => c.json({ error: "Project not found" }, 404));
    const server = new Hono();
    server.use("*", async (c, next) => {
      setRequestActor(c, { type: "session", userId: "outsider", sessionId: "s", user: { id: "outsider", email: "", name: "" } });
      await next();
    });
    const refs = projectRefPath([projects]);
    server.use("/v1/projects/:projectRef/*", refs);
    server.route("/v1/projects", projects);
    const response = await server.request("/v1/projects/amber-falcon-ridge/state");
    expect(response.status).toBe(404);
    expect(response.headers.get("X-DocSlurp-Project-Id")).toBeNull();
    expect(response.headers.get("X-DocSlurp-Project-Slug")).toBeNull();
  });

  it("leaves UUIDs, static routes and unknown references to the normal routes", async () => {
    const server = app();
    expect(await (await server.request(`/v1/projects/${UUID}/state`)).json()).toMatchObject({ projectId: UUID });
    expect(await (await server.request("/v1/projects/board")).json()).toEqual({ board: true });
    expect(await (await server.request("/v1/projects/invites/tok/accept", { method: "POST" })).json()).toEqual({ accepted: "tok" });
    expect(resolveProjectRef).not.toHaveBeenCalledWith("invites");
    expect(await (await server.request("/v1/projects/no-such-slug/state")).json()).toMatchObject({ projectId: "no-such-slug" });
  });
});
