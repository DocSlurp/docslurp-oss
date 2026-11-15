import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import type { RequestActor } from "../lib/request-actor.js";
let sql: postgres.Sql;
let stop: () => Promise<void>;
let service: typeof import("../services/settings-publication.js");
let failSearch = false;
beforeAll(async () => {
  const db = await startMigratedPostgres(); stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: null }));
  vi.doMock("../services/search-controls.js", async () => {
    const actual = await vi.importActual<typeof import("../services/search-controls.js")>("../services/search-controls.js");
    return { ...actual, upsertProjectSearchSettings: async (...args: Parameters<typeof actual.upsertProjectSearchSettings>) => {
      await actual.upsertProjectSearchSettings(...args);
      if (failSearch) throw new Error("injected search failure");
    } };
  });
  service = await import("../services/settings-publication.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
async function fixture() {
  const id = randomUUID(); const userId = randomUUID();
  await sql`insert into "user"(id,name,email) values (${userId},'Owner',${userId+'@example.com'})`;
  await sql`insert into organizations(id,name,slug,created_by_user_id,credit_balance_cents) values (${id},'Org',${id},${userId},10000)`;
  await sql`insert into org_memberships(org_id,user_id,role) values (${id},${userId},'owner')`;
  await sql`insert into projects(id,org_id,user_id,name,pipeline) values (${id},${id},${userId},'Project',${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))})`;
  const actor: RequestActor = { type: "session", userId, sessionId: randomUUID(), user: { id: userId, email: userId+'@example.com', name: 'Owner' } };
  const snapshot = await service.readSettingsSnapshot(actor, id);
  return { actor, projectId: id, snapshot };
}
function input(f: Awaited<ReturnType<typeof fixture>>) {
  return { requestId: randomUUID(), expected: f.snapshot.revision, project: { pipeline: { preserveCode: false }, monthlyBudgetCents: null }, search: { chat: { enabled: false }, retrievalDefaults: { graphHops: null } } };
}
it("publishes sparse false/null values and retries without duplicate effects", async () => {
  const f = await fixture(); const body = input(f);
  const first = await service.publishSettings({ ...f, input: body });
  expect(first.snapshot.project.pipeline).toMatchObject({ preserveCode: false, preserveTables: true });
  expect(first.snapshot.settings.chat).toMatchObject({ enabled: false, citations: true });
  const retry = await service.publishSettings({ ...f, input: body });
  expect(retry).toMatchObject({ replayed: true, snapshot: first.snapshot });
  expect(await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`).toEqual([{ n: 1 }]);
  await expect(service.publishSettings({ ...f, input: { ...body, search: {} } })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
});
it("rolls back pipeline, both revisions and receipts when search persistence fails", async () => {
  const f = await fixture(); failSearch = true;
  try { await expect(service.publishSettings({ ...f, input: input(f) })).rejects.toThrow('injected search failure'); }
  finally { failSearch = false; }
  expect(await service.readSettingsSnapshot(f.actor, f.projectId)).toEqual(f.snapshot);
  expect(await sql`select count(*)::int n from project_settings_publications where project_id=${f.projectId}`).toEqual([{ n: 0 }]);
  expect(await sql`select count(*)::int n from project_runs where project_id=${f.projectId}`).toEqual([{ n: 0 }]);
});
it("rejects stale project revisions", async () => {
  const f = await fixture(); await sql`update projects set updated_at=now() where id=${f.projectId}`;
  await expect(service.publishSettings({ ...f, input: input(f) })).rejects.toMatchObject({ status: 409 });
});
it("rejects a search first-insert race even when the project row did not change", async () => {
  const f = await fixture();
  await sql`insert into project_search_settings(project_id,user_id) values (${f.projectId},${f.actor.userId})`;
  await expect(service.publishSettings({ ...f, input: input(f) })).rejects.toMatchObject({ status: 409 });
});
it("rejects cross-tenant actors and read-only members", async () => {
  const f = await fixture(), other = await fixture();
  await expect(service.publishSettings({ actor: other.actor, projectId: f.projectId, input: input(f) })).rejects.toMatchObject({ status: 404 });
  await sql`delete from org_memberships where user_id=${other.actor.userId}`;
  await sql`insert into org_memberships(org_id,user_id,role) values (${f.projectId},${other.actor.userId},'member')`;
  await sql`insert into project_members(project_id,user_id,role) values (${f.projectId},${other.actor.userId},'viewer')`;
  await expect(service.publishSettings({ actor: other.actor, projectId: f.projectId, input: input(f) })).rejects.toMatchObject({ status: 403 });
});
it("rejects unknown keys, oversized instructions and execution controls", async () => {
  const f = await fixture(), body = input(f);
  await expect(service.publishSettings({ ...f, input: { ...body, surprise: true } })).rejects.toThrow();
  await expect(service.publishSettings({ ...f, input: { ...body, search: { chat: { searchInstructions: 'x'.repeat(100000) } } } })).rejects.toThrow();
  await expect(service.publishSettings({ ...f, input: { ...body, project: { pipeline: { stageSubset: ['embed'] } } } })).rejects.toThrow();
});
