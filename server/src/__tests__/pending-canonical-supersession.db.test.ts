import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres, createMigratedDatabase, applyRemainingMigrations } from "@docslurp/worker/testing";
import { createRunLifecycle } from "../services/run-lifecycle.js";
import type { SqlClient } from "../db.js";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let availability: typeof import("../search/session-setup.js").loadSearchAvailability;
beforeAll(async () => {
  const db = await startMigratedPostgres();
  stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  ({ loadSearchAvailability: availability } = await import("../search/session-setup.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'Test', 'pending@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Test', 'pending', 'u')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Test')`;
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

describe("canonical replacement of failed-run pending history", () => {
  it("retires an unflagged queued old document and restores exact search availability when its replacement completes", async () => {
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
      values ('old', 'o', 'u', 'w', 'upload', 'failed', 'embed', '{}'::jsonb),
        ('new', 'o', 'u', 'w', 'upload', 'processing', 'index', '{}'::jsonb)`;
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, canonical_id, page_count, created_at)
      values ('old-doc', 'o', 'u', 'w', 'old', 'a.txt', 'text/plain', 'old-key', 'queued', '/a.txt', 4, '2026-01-01'),
        ('new-doc', 'o', 'u', 'w', 'new', 'a.txt', 'text/plain', 'new-key', 'queued', '/a.txt', 4, '2026-01-02')`;
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
      values ('new-doc-000', 'new-doc', 'new', 'u', 0, 'replacement')`;
    await sql`update documents set status = 'completed' where id = 'new-doc'`;
    expect(await sql`select status, superseded_by_document_id as replacement from documents where id = 'old-doc'`)
      .toEqual([{ status: 'cancelled', replacement: 'new-doc' }]);
    expect(await availability({ workspaceId: 'w' })).toMatchObject({
      total_documents: 1, total_pages: 4, searchable_documents: 1, searchable_pages: 4,
    });
    expect(await sql`select count(*)::int as n from documents where workspace_id = 'w'`).toEqual([{ n: 2 }]);
  });

  it("preserves an active cancelling run until it ends, then retires its replaced queued history", async () => {
    await sql`insert into workspaces (id, org_id, user_id, name) values ('active-w', 'o', 'u', 'Active')`;
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, control_state)
      values ('active-old', 'o', 'u', 'active-w', 'upload', 'processing', 'embed', '{}'::jsonb, 'cancel_requested'),
        ('active-new', 'o', 'u', 'active-w', 'upload', 'processing', 'index', '{}'::jsonb, null)`;
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, canonical_id, created_at)
      values ('active-old-doc', 'o', 'u', 'active-w', 'active-old', 'a.txt', 'text/plain', 'old-key', 'queued', '/a.txt', '2026-01-01'),
        ('active-new-doc', 'o', 'u', 'active-w', 'active-new', 'a.txt', 'text/plain', 'new-key', 'completed', '/a.txt', '2026-01-02')`;
    expect(await sql`select status, superseded_at from documents where id = 'active-old-doc'`).toEqual([{ status: 'queued', superseded_at: null }]);
    const lifecycle = createRunLifecycle({ sql: sql as unknown as SqlClient, startWorkflow: vi.fn(async () => {}), failureThreshold: 3 });
    await lifecycle.fail('active-old', { stage: 'embed', message: 'worker ended', fromStatuses: ['processing'] });
    expect(await sql`select status, superseded_by_document_id as replacement from documents where id = 'active-old-doc'`)
      .toEqual([{ status: 'cancelled', replacement: 'active-new-doc' }]);
  });

  it("never guesses replacements across organizations, workspaces, canonical source identities or older versions", async () => {
    await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o2', 'Other', 'pending-other', 'u')`;
    await sql`insert into workspaces (id, org_id, user_id, name) values ('scope-w', 'o', 'u', 'Scope'), ('scope-other', 'o2', 'u', 'Other')`;
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
      values ('scope-old', 'o', 'u', 'scope-w', 'upload', 'failed', 'embed', '{}'::jsonb),
        ('scope-new', 'o', 'u', 'scope-w', 'upload', 'processing', 'index', '{}'::jsonb),
        ('scope-foreign', 'o2', 'u', 'scope-other', 'upload', 'processing', 'index', '{}'::jsonb)`;
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, canonical_id, created_at)
      values ('scope-target', 'o', 'u', 'scope-w', 'scope-old', 'a.txt', 'text/plain', 'target', 'queued', '/dir-a/a.txt', '2026-01-03'),
        ('scope-foreign-doc', 'o2', 'u', 'scope-other', 'scope-foreign', 'a.txt', 'text/plain', 'foreign', 'completed', '/dir-a/a.txt', '2026-01-04'),
        ('scope-other-source', 'o', 'u', 'scope-w', 'scope-new', 'a.txt', 'text/plain', 'other-source', 'completed', '/dir-b/a.txt', '2026-01-04'),
        ('scope-older', 'o', 'u', 'scope-w', 'scope-new', 'a.txt', 'text/plain', 'older', 'completed', '/dir-a/a.txt', '2026-01-02')`;
    expect(await sql`select status, superseded_at from documents where id = 'scope-target'`).toEqual([{ status: 'queued', superseded_at: null }]);
  });

  it("backfills preexisting unflagged queued history to the newest completed version without touching active work", async () => {
    const db = await createMigratedDatabase({ stopBefore: 'retire_replaced_pending_versions' });
    try {
      await db.exec(`
        insert into "user" (id, name, email) values ('u', 'Test', 'retro@example.test');
        insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Test', 'retro', 'u');
        insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Test');
        insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, control_state) values
          ('old', 'o', 'u', 'w', 'upload', 'failed', 'embed', '{}', null),
          ('new', 'o', 'u', 'w', 'upload', 'completed', 'completed', '{}', null),
          ('active', 'o', 'u', 'w', 'upload', 'processing', 'embed', '{}', 'cancel_requested');
        insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, canonical_id, created_at, lexical_searchable_at) values
          ('old-doc', 'o', 'u', 'w', 'old', 'a.txt', 'text/plain', 'old', 'queued', '/a.txt', '2026-01-01', now()),
          ('active-doc', 'o', 'u', 'w', 'active', 'a.txt', 'text/plain', 'active', 'queued', '/a.txt', '2026-01-01', null),
          ('unmatched', 'o', 'u', 'w', 'old', 'b.txt', 'text/plain', 'unmatched', 'queued', '/b.txt', '2026-01-01', null),
          ('replacement-one', 'o', 'u', 'w', 'new', 'a.txt', 'text/plain', 'new1', 'completed', '/a.txt', '2026-01-02', null),
          ('replacement-two', 'o', 'u', 'w', 'new', 'a.txt', 'text/plain', 'new2', 'completed', '/a.txt', '2026-01-03', null);
      `);
      expect((await db.query<{ superseded_at: null }>("select superseded_at from documents where id = 'old-doc'")).rows[0]?.superseded_at).toBeNull();
      await applyRemainingMigrations(db, 'retire_replaced_pending_versions');
      const result = await db.query<{ id: string; status: string; replacement: string | null; lexical: boolean }>(
        'select id, status, superseded_by_document_id as replacement, lexical_searchable_at is not null as lexical from documents order by id');
      expect(result.rows.find(row => row.id === 'old-doc')).toEqual({ id: 'old-doc', status: 'cancelled', replacement: 'replacement-two', lexical: false });
      expect(result.rows.find(row => row.id === 'active-doc')?.status).toBe('queued');
      expect(result.rows.find(row => row.id === 'unmatched')?.status).toBe('queued');
      expect(result.rows).toHaveLength(5);
    } finally { await db.close(); }
  }, 120_000);

});
