import { Hono, type Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Labelling project records with canEdit/canManage must stay O(1) per intake request (scale target: 10,000 small files):
 * one target project is one indexed access lookup, never a scan of every project the caller can reach, and repeated
 * labels in one request reuse it. Lists use the two set queries once.
 */
const access = vi.hoisted(() => ({
  getProjectAccess: vi.fn(async (_projectId: string, _userId: string) => ({ orgRole: "member", projectRole: "editor" })),
  listReprocessableProjectIds: vi.fn(async (_userId: string) => ["p1", "p2"]),
  listManageableProjectIds: vi.fn(async (_userId: string) => ["p1"]),
}));
vi.mock("../services/organizations.js", () => ({
  ...access,
  canEditProject: (granted: { projectRole?: string }) => granted.projectRole === "editor" || granted.projectRole === "admin",
  canManageProject: (granted: { projectRole?: string }) => granted.projectRole === "admin",
}));
const { withCanEdit, withPayloadCanEdit } = await import("../lib/reprocess-access.js");

function app(handler: (c: Context) => Promise<Response>) {
  const hono = new Hono();
  hono.use("*", async (c, next) => { c.set("sessionUser", { id: "u1" } as never); await next(); });
  hono.get("/", handler);
  return hono;
}

beforeEach(() => { for (const fn of Object.values(access)) fn.mockClear(); });

describe("project flags cost", () => {
  it("one target project: a single access lookup, no project-list scan, reused within the request", async () => {
    const body = await (await app(async (c) => {
      const first = await withPayloadCanEdit(c, { project: { id: "p1", orgId: "o1" }, run: { id: "r" } });
      const again = await withPayloadCanEdit(c, { result: { project: { id: "p1", orgId: "o1" } } });
      return c.json({ first, again });
    }).request("/")).json();
    expect(body.first.project).toMatchObject({ canEdit: true, canManage: false });
    expect(body.again.result.project).toMatchObject({ canEdit: true });
    expect(access.getProjectAccess).toHaveBeenCalledTimes(1);
    expect(access.getProjectAccess).toHaveBeenCalledWith("p1", "u1");
    expect(access.listReprocessableProjectIds).not.toHaveBeenCalled();
    expect(access.listManageableProjectIds).not.toHaveBeenCalled();
  });

  it("a list: the two set queries once, no per-project lookups", async () => {
    const body = await (await app(async (c) => c.json(await withCanEdit(c, [{ id: "p1", orgId: "o1" }, { id: "p2", orgId: "o1" }, { id: "p3", orgId: "o1" }]))).request("/")).json();
    expect(body.map((project: { canEdit: boolean; canManage: boolean }) => [project.canEdit, project.canManage])).toEqual([[true, true], [true, false], [false, false]]);
    expect(access.listReprocessableProjectIds).toHaveBeenCalledTimes(1);
    expect(access.listManageableProjectIds).toHaveBeenCalledTimes(1);
    expect(access.getProjectAccess).not.toHaveBeenCalled();
  });

  it("a payload without a project record costs nothing", async () => {
    await (await app(async (c) => c.json(await withPayloadCanEdit(c, { run: { id: "r" } }))).request("/")).json();
    expect(access.getProjectAccess).not.toHaveBeenCalled();
    expect(access.listReprocessableProjectIds).not.toHaveBeenCalled();
  });
});
