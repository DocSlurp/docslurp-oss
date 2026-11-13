import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURRENT_INGEST_VERSION, INGEST_CAPABILITIES, PARSE_SOURCE_SCAN_VERSION } from "@docslurp/shared";

import { runStampsIngestVersion, stampDocumentIngestVersion, stampRunIngestVersion } from "../db/ingest-version.js";
import { startMigratedPostgres } from "../test/migrated-postgres.js";

/** Ingest version stamping (db/ingest-version.ts): capabilities are measured from stored rows, never assumed. */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
const SHA = "b".repeat(64);

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  await sql`insert into "user"(id, name, email) values ('u', 'U', 'u@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('org', 'O', 'o', 'u'), ('org-2', 'O2', 'o2', 'u')`;
  await sql`insert into projects(id, org_id, user_id, name, is_default) values ('proj', 'org', 'u', 'P', true), ('proj-2', 'org-2', 'u', 'P2', true)`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values
    ('run', 'org', 'u', 'proj', 'upload', 'completed', 'completed', '{}'),
    ('run-old', 'org', 'u', 'proj', 'upload', 'completed', 'completed', '{}'),
    ('run-other', 'org-2', 'u', 'proj-2', 'upload', 'completed', 'completed', '{}')`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
    ('d-full', 'org', 'u', 'proj', 'run', 'a.pdf', 'application/pdf', 'k1', 'completed', 2),
    ('d-bare', 'org', 'u', 'proj', 'run', 'b.pdf', 'application/pdf', 'k2', 'completed', 1),
    ('d-pii', 'org', 'u', 'proj', 'run', 'c.pdf', 'application/pdf', 'k3', 'pii_blocked', 1),
    ('d-failed', 'org', 'u', 'proj', 'run', 'd.pdf', 'application/pdf', 'k4', 'failed', 1),
    ('d-other', 'org-2', 'u', 'proj-2', 'run-other', 'e.pdf', 'application/pdf', 'k5', 'completed', 1)`;
  await sql`update documents set parse_source_scan_version = ${PARSE_SOURCE_SCAN_VERSION}, parse_source_sha256 = ${SHA} where id = 'd-full'`;
  await sql`insert into document_page_facts (document_id, page_number, run_id) values ('d-full', 1, 'run')`;
  await sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status)
    values ('d-full', 'org', 'proj', 'run', true, 'complete')`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

const versions = async () => Object.fromEntries((await sql<{ id: string; ingest_version: number; ingest_capabilities: string[] }[]>`
  select id, ingest_version, ingest_capabilities from documents order by id`).map((row) => [row.id, [row.ingest_version, row.ingest_capabilities]]));

describe("stampDocumentIngestVersion", () => {
  it("stamps one document of the run with only the capabilities it stored", async () => {
    await stampDocumentIngestVersion(sql, "run", ["d-bare"]);
    expect((await versions())["d-bare"]).toEqual([CURRENT_INGEST_VERSION, []]);
    expect((await versions())["d-full"]).toEqual([0, []]);
  });

  it("stamps the run's finished documents, never failed ones or another run's", async () => {
    await stampDocumentIngestVersion(sql, "run");
    expect(await versions()).toEqual({
      "d-bare": [CURRENT_INGEST_VERSION, []],
      "d-failed": [0, []],
      "d-full": [CURRENT_INGEST_VERSION, ["parseSourceDecision", "pageFacts", "figureLedger"]],
      "d-other": [0, []],
      "d-pii": [CURRENT_INGEST_VERSION, []],
    });
  });

  it("does not count a figure ledger from another run or a decision from an older scan", async () => {
    await sql`update document_extraction_levels set run_id = 'run-old' where document_id = 'd-full'`;
    await sql`update documents set parse_source_scan_version = ${PARSE_SOURCE_SCAN_VERSION - 1} where id = 'd-full'`;
    await stampDocumentIngestVersion(sql, "run", ["d-full"]);
    expect((await versions())["d-full"]).toEqual([CURRENT_INGEST_VERSION, ["pageFacts"]]);
  });

  it("does not count page facts another run left", async () => {
    await sql`update document_page_facts set run_id = 'run-old' where document_id = 'd-full'`;
    await stampDocumentIngestVersion(sql, "run", ["d-full"]);
    expect((await versions())["d-full"]).toEqual([CURRENT_INGEST_VERSION, []]);
    await sql`update document_page_facts set run_id = 'run' where document_id = 'd-full'`;
  });
});

describe("stampRunIngestVersion", () => {
  it("stamps the run with the build's capabilities and skips materialize runs", async () => {
    await stampRunIngestVersion(sql, "run");
    const [run] = await sql<{ ingest_version: number; ingest_capabilities: string[] }[]>`select ingest_version, ingest_capabilities from project_runs where id = 'run'`;
    expect(run).toEqual({ ingest_version: CURRENT_INGEST_VERSION, ingest_capabilities: [...INGEST_CAPABILITIES] });
    const [other] = await sql<{ ingest_version: number }[]>`select ingest_version from project_runs where id = 'run-other'`;
    expect(other!.ingest_version).toBe(0);
    expect(runStampsIngestVersion("materialize")).toBe(false);
    expect(runStampsIngestVersion("upload")).toBe(true);
  });
});
