import { describe, expect, it } from "vitest";
import { createMigratedDatabase, applyRemainingMigrations } from "@docslurp/worker/testing";

describe("verified direct-upload byte backfill", () => {
  it("repairs unmeasured bytes and corpus totals only with an exact completed, confirmed ownership receipt", async () => {
    const db = await createMigratedDatabase({ stopBefore: "backfill_verified_upload_source_bytes" });
    try {
      await db.exec(`
        insert into "user" (id, name, email) values ('u', 'Test', 'bytes-a@example.test'), ('u2', 'Other', 'bytes-b@example.test');
        insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Test', 'bytes-a', 'u'), ('o2', 'Other', 'bytes-b', 'u2');
        insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Test'), ('w2', 'o2', 'u2', 'Other'), ('w3', 'o', 'u', 'Another workspace');
        insert into upload_sessions (id, user_id, org_id, workspace_id, status) values
          ('s', 'u', 'o', 'w', 'confirmed'), ('pending', 'u', 'o', 'w', 'uploading'),
          ('other-org', 'u2', 'o2', 'w2', 'confirmed'), ('other-user', 'u2', 'o', 'w', 'confirmed'),
          ('other-workspace', 'u', 'o', 'w3', 'confirmed');
        insert into upload_session_files (id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, status) values
          ('trusted', 's', 'a.txt', 'text/plain', 42, 'trusted', 'single', 'completed'),
          ('known', 's', 'a.txt', 'text/plain', 42, 'known', 'single', 'completed'),
          ('unfinished', 's', 'a.txt', 'text/plain', 42, 'unfinished', 'single', 'uploading'),
          ('unconfirmed', 'pending', 'a.txt', 'text/plain', 42, 'unconfirmed', 'single', 'completed'),
          ('mismatch', 's', 'a.txt', 'text/plain', 42, 'different-key', 'single', 'completed'),
          ('cross-org', 'other-org', 'a.txt', 'text/plain', 42, 'cross-org', 'single', 'completed'),
          ('cross-user', 'other-user', 'a.txt', 'text/plain', 42, 'cross-user', 'single', 'completed'),
          ('cross-workspace', 'other-workspace', 'a.txt', 'text/plain', 42, 'cross-workspace', 'single', 'completed'),
          ('measured', 's', 'a.txt', 'text/plain', 42, 'measured-zero', 'single', 'completed'),
          ('conflict-a', 's', 'a.txt', 'text/plain', 42, 'conflict', 'single', 'completed'),
          ('conflict-b', 's', 'a.txt', 'text/plain', 84, 'conflict', 'single', 'completed');
        insert into documents (id, user_id, org_id, workspace_id, filename, mime_type, source_key, status, file_size, metadata)
          select id, 'u', 'o', 'w', 'a.txt', 'text/plain', id, 'completed',
            case when id = 'known' then 99 else 0 end,
            case when id = 'measured-zero' then '{"sourceSizeMeasured":true}'::jsonb
              else '{"sourceSizeMeasured":false,"keep":"metadata"}'::jsonb end
          from unnest(array['trusted','known','unfinished','unconfirmed','mismatch','cross-org','cross-user','cross-workspace','measured-zero','conflict']) id;
      `);
      const before = await db.query<{ bytes: string }>("select file_size::text as bytes from documents where id = 'trusted'");
      expect(before.rows[0]?.bytes).toBe("0");
      await applyRemainingMigrations(db, "backfill_verified_upload_source_bytes");
      const result = await db.query<{ id: string; bytes: string; measured: string | null; keep: string | null }>(`
        select id, file_size::text as bytes, metadata->>'sourceSizeMeasured' as measured, metadata->>'keep' as keep
        from documents order by id`);
      expect(result.rows.find(row => row.id === 'trusted')).toEqual({ id: 'trusted', bytes: '42', measured: 'true', keep: 'metadata' });
      expect(result.rows.find(row => row.id === 'known')?.bytes).toBe('99');
      for (const row of result.rows.filter(row => !['trusted', 'known'].includes(row.id))) expect(row.bytes, row.id).toBe('0');
      const corpus = await db.query<{ bytes: string }>("select source_bytes::text as bytes from workspace_corpus_stats where workspace_id = 'w'");
      expect(corpus.rows[0]?.bytes).toBe('141');
    } finally { await db.close(); }
  }, 120_000);
});
