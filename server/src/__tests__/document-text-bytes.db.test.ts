import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let summaries: typeof import("../services/workspace-board-telemetry.js").listWorkspaceBoardSummaries;

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  ({ listWorkspaceBoardSummaries: summaries } = await import("../services/workspace-board-telemetry.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'Test', 'bytes@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Test', 'bytes', 'u')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Bytes'), ('other', 'o', 'u', 'Other')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values ('r', 'o', 'u', 'w', 'bulk-upload', 'completed', 'embed', '{}'::jsonb)`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
    values ('a', 'o', 'u', 'w', 'r', 'a.pdf', 'application/pdf', 'a', 'completed'),
      ('b', 'o', 'u', 'w', 'r', 'b.pdf', 'application/pdf', 'b', 'completed'),
      ('foreign', 'o', 'u', 'other', 'r', 'c.pdf', 'application/pdf', 'c', 'completed')`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });

async function exact() {
  const rows = await sql`select d.id, d.chunk_count, d.stored_page_count, d.chunk_text_bytes, d.stored_page_text_bytes,
    (select count(*)::int from document_chunks c where c.document_id = d.id) as chunks,
    (select count(*)::int from document_pages p where p.document_id = d.id) as pages,
    (select coalesce(sum(octet_length(c.text)), 0)::text from document_chunks c where c.document_id = d.id) as chunk_bytes,
    (select coalesce(sum(octet_length(p.text)), 0)::text from document_pages p where p.document_id = d.id) as page_bytes
    from documents d`;
  for (const row of rows) {
    expect([row.chunk_count, row.stored_page_count, row.chunk_text_bytes, row.stored_page_text_bytes], row.id)
      .toEqual([row.chunks, row.pages, row.chunk_bytes, row.page_bytes]);
  }
  const [legacy] = await sql`select
    (select coalesce(sum(octet_length(c.text)), 0) from document_chunks c join documents d on d.id = c.document_id
      where d.workspace_id = 'w' and d.status = 'completed' and d.superseded_at is null) +
    (select coalesce(sum(octet_length(p.text)), 0) from document_pages p join documents d on d.id = p.document_id
      where d.workspace_id = 'w' and d.status = 'completed' and d.superseded_at is null) as bytes`;
  expect((await summaries(['w'])).get('w')?.indexedBytes).toBe(Number(legacy.bytes));
}

describe("exact document text byte counters", () => {
  it("preserves byte totals through batched inserts, upserts, moves, edits, corpus changes and deletes", async () => {
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
      values ('c1', 'a', 'r', 'u', 0, '漢字🙂'), ('c2', 'a', 'r', 'u', 1, 'ascii'), ('cf', 'foreign', 'r', 'u', 0, 'private')`;
    await sql`insert into document_pages (id, document_id, run_id, user_id, page_number, text)
      values ('p1', 'a', 'r', 'u', 1, 'é'), ('p2', 'b', 'r', 'u', 2, 'page')`;
    await exact();
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
      values ('c1', 'b', 'r', 'u', 0, 'longer replacement'), ('c3', 'b', 'r', 'u', 3, '')
      on conflict (id) do update set document_id = excluded.document_id, text = excluded.text`;
    await sql`update document_pages set document_id = 'b', text = 'new🙂' where id = 'p1'`;
    await exact();
    await sql`update document_chunks set text = 'short' where document_id = 'b'`;
    await sql`update document_pages set text = '' where id = 'p2'`;
    await sql`update document_chunks set metadata = '{"unchangedText":true}'`;
    await exact();
    await sql`update documents set superseded_at = now() where id = 'a'`;
    await exact();
    await sql`update documents set status = 'failed' where id = 'b'`;
    await exact();
    await sql`update documents set superseded_at = null, status = 'completed'`;
    await exact();
    await expect(sql.begin(async (tx) => {
      await tx`update document_chunks set text = 'rolled back'`;
      await tx`delete from document_pages`;
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    await exact();
    await sql`delete from document_chunks where id = 'c2'`;
    await sql`delete from document_pages where id = 'p2'`;
    await exact();
    await sql`delete from documents where id = 'b'`;
    await exact();
  });

  it("backfills existing content exactly and can safely rerun", async () => {
    await sql`update documents set chunk_text_bytes = 99, stored_page_text_bytes = 99`;
    const { readFileSync } = await import("node:fs");
    const migration = readFileSync(new URL("../../db/migrations/0072_document_text_byte_counters.sql", import.meta.url), "utf8");
    await sql.begin(async (tx) => {
      for (const statement of migration.split("--> statement-breakpoint")) await tx.unsafe(statement);
    });
    await exact();
  });
});
