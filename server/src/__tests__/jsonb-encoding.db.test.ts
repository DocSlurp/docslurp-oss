import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * With the server's postgres.js client (`prepare: false`) a bare
 * `${JSON.stringify(x)}::jsonb` stores a jsonb STRING holding the JSON text, not
 * an object. These tests run the real services over the wire against a migrated
 * database and assert the stored jsonb type.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
const prepare = vi.fn();

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/source-metadata.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/source-metadata.js")>()),
    resolveSourceMetadata: prepare,
  }));
  vi.doMock("../lib/temporal.js", () => ({
    startPipelineWorkflow: vi.fn(), signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(),
    isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
  }));
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents) values ('o', 'O', 'o', 'u', 1000)`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'W')`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(() => { prepare.mockReset().mockResolvedValue({ pageCount: 1, sourceSha256: "abc" }); });

describe("jsonb values are stored as objects, not JSON strings", () => {
  it("stores documents.metadata as an object", async () => {
    const { createRunManifest } = await import("../services/run-manifest.js");
    await createRunManifest({
      userId: "u", workspaceId: "w", kind: "bulk-upload", pipeline: defaultPipelineFeatures,
      files: [{ filename: "a.pdf", mimeType: "application/pdf", sourceKey: "u/raw/a.pdf", metadata: { connectorFileId: "f1", connectorEtag: "e1" } }],
    });
    const rows = await sql`select jsonb_typeof(metadata) as t, metadata->>'connectorFileId' as id from documents`;
    expect(rows).toEqual([{ t: "object", id: "f1" }]);
  });

  it("stores audit_log.metadata as an object", async () => {
    const { appendAuditLog } = await import("../services/audit-log.js");
    await appendAuditLog({ orgId: "o", userId: "u", action: "test.action", resourceType: "test", metadata: { k: "v" } });
    expect(await sql`select jsonb_typeof(metadata) as t, metadata->>'k' as k from audit_log where action = 'test.action'`)
      .toEqual([{ t: "object", k: "v" }]);
  });

  it("migration 0058 unwraps string-encoded rows and leaves objects alone", async () => {
    await sql`delete from audit_log`;
    await sql`insert into audit_log (id, action, resource_type, metadata) values ('s1', 'a', 't', to_jsonb(${JSON.stringify({ k: 1 })}::text))`;
    await sql`insert into audit_log (id, action, resource_type, metadata) values ('s2', 'a', 't', ${sql.json({ k: 2 })})`;
    await sql`insert into audit_log (id, action, resource_type, metadata) values ('s3', 'a', 't', to_jsonb('not json'::text))`;
    expect(await sql`select id, jsonb_typeof(metadata) as t from audit_log order by id`)
      .toEqual([{ id: "s1", t: "string" }, { id: "s2", t: "object" }, { id: "s3", t: "string" }]);
    const migration = readFileSync(new URL("../../db/migrations/0058_jsonb_unwrap_string_objects.sql", import.meta.url), "utf8");
    await sql.unsafe(migration);
    expect(await sql`select id, jsonb_typeof(metadata) as t, metadata->>'k' as k from audit_log order by id`)
      .toEqual([{ id: "s1", t: "object", k: "1" }, { id: "s2", t: "object", k: "2" }, { id: "s3", t: "string", k: null }]);
  });
});
