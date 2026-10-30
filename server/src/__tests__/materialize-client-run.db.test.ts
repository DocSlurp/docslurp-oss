import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Materialize run creation against a migrated database: the source pipeline is read
 * from a document of the run's own workspace only (round 7 I2).
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let defaultMaterializeDeps: typeof import("../search/deferred/materialize-client.js").defaultMaterializeDeps;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({ startMaterializeWorkflow: vi.fn() }));
  ({ defaultMaterializeDeps } = await import("../search/deferred/materialize-client.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u')`;
  await sql`insert into workspaces (id, org_id, user_id, name, pipeline) values
    ('mine', 'o', 'u', 'Mine', ${sql.json({ quality: "fast" })}),
    ('theirs', 'o', 'u', 'Theirs', ${sql.json({ quality: "auto" })})`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values ('run-theirs', 'o', 'u', 'theirs', 'upload', 'completed', 'completed', ${sql.json({ quality: "good", privacyMode: "standard" })})`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
    values ('their-doc', 'o', 'u', 'theirs', 'run-theirs', 'a.pdf', 'application/pdf', 'k', 'completed', 3)`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });

describe("materialize run source pipeline", () => {
  it("never copies another workspace's document pipeline into the run", async () => {
    const id = await defaultMaterializeDeps.createRun({ orgId: "o", userId: "u", workspaceId: "mine", documentId: "their-doc", documents: 1, pages: 3 });
    const [run] = await sql<{ workspace_id: string; pipeline: Record<string, unknown> }[]>`select workspace_id, pipeline from workspace_runs where id = ${id}`;
    expect(run!.workspace_id).toBe("mine");
    expect(run!.pipeline).toMatchObject({ quality: "fast" });
    expect(run!.pipeline.quality).not.toBe("good");
  });

  it("uses the document's own run pipeline inside its workspace", async () => {
    const id = await defaultMaterializeDeps.createRun({ orgId: "o", userId: "u", workspaceId: "theirs", documentId: "their-doc", documents: 1, pages: 3 });
    const [run] = await sql<{ pipeline: Record<string, unknown> }[]>`select pipeline from workspace_runs where id = ${id}`;
    expect(run!.pipeline).toMatchObject({ quality: "good" });
  });
});
