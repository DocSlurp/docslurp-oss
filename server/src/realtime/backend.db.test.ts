import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
let sql: postgres.Sql;
let stop: () => Promise<void>;
let backend: typeof import("./backend.js").realtimeBackend;
beforeAll(async () => {
  const database = await startMigratedPostgres(); stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  backend = (await import("./backend.js")).realtimeBackend;
  await sql`insert into "user"(id,name,email) values ('owner','Owner','owner@example.test'),('member','Member','member@example.test'),('stranger','Stranger','stranger@example.test')`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values ('org','Org','realtime-org','owner'),('foreign','Foreign','realtime-foreign','stranger')`;
  await sql`insert into org_memberships(org_id,user_id,role) values ('org','owner','owner'),('org','member','member'),('foreign','stranger','owner') on conflict do nothing`;
  await sql`insert into workspaces(id,org_id,user_id,name) values ('workspace','org','owner','Private'),('foreign-w','foreign','stranger','Foreign')`;
  await sql`insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,job_id) values
    ('run-a','org','owner','workspace','upload','processing','vision-extract','parent'),
    ('run-b','org','owner','workspace','reindex','completed','completed','parent')`;
}, 60_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
it("denies cross-tenant runs, workspaces, documents and billing", async () => {
  for (const resource of [
    { kind: "run", runId: "run-a" }, { kind: "workspace", workspaceId: "workspace" },
    { kind: "documents", workspaceId: "workspace", page: 0 }, { kind: "billing", orgId: "org" },
  ] as const) {
    expect(await backend.authorize("stranger", resource)).toBeNull();
    await expect(backend.project("stranger", resource)).rejects.toThrow("forbidden");
  }
});
it("allows activity but redacts inaccessible workspaces and denies member billing", async () => {
  expect(await backend.project("member", { kind: "activity", orgId: "org" })).toEqual({ runs: [], truncated: false });
  expect(await backend.authorize("member", { kind: "billing", orgId: "org" })).toBeNull();
  const activity = await backend.project("owner", { kind: "activity", orgId: "org" }) as { runs: Array<{ id: string; jobId: string }> };
  expect(activity.runs.map(r => r.id).sort()).toEqual(["run-a", "run-b"]);
  expect(activity.runs.every(r => r.jobId === "parent")).toBe(true);
});
it("projects bounded documents, settings, stage state and attributed billing", async () => {
  expect(await backend.project("owner", { kind: "documents", workspaceId: "workspace", page: 0 })).toMatchObject({ documents: [], totalCount: 0, limit: 50, truncated: false });
  expect(await backend.project("owner", { kind: "workspace", workspaceId: "workspace" })).toMatchObject({ id: "workspace", name: "Private" });
  expect(await backend.project("owner", { kind: "run", runId: "run-a" })).toMatchObject({ run: { id: "run-a", status: "processing", jobId: "parent" }, stages: [] });
  expect(await backend.project("owner", { kind: "billing", orgId: "org" })).toMatchObject({ orgId: "org", credits: { available: expect.any(Number) } });
});
it("revokes billing on downgrade and workspace access on membership removal", async () => {
  await sql`update org_memberships set role='member' where user_id='owner' and org_id='org'`;
  expect(await backend.authorize("owner", { kind: "billing", orgId: "org" })).toBeNull();
  await sql`delete from org_memberships where user_id='owner' and org_id='org'`;
  expect(await backend.authorize("owner", { kind: "run", runId: "run-a" })).toBeNull();
});
