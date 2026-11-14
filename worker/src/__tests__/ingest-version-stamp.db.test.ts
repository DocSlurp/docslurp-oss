import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_INGEST_VERSION, defaultPipelineFeatures, INGEST_CAPABILITIES, PARSE_SOURCE_SCAN_VERSION } from "@docslurp/shared";

import {
  completingDocumentStamp,
  runReusesExtraction,
  runStamp,
  runStampsIngestVersion,
  stampDocumentIngestVersion,
  stampRunIngestVersion,
} from "../db/ingest-version.js";
import { startMigratedPostgres } from "../test/migrated-postgres.js";

/**
 * Ingest version stamping (db/ingest-version.ts). Capabilities are measured from rows the stamping run stored, never
 * assumed; a run that reused extraction, and a deduplicated copy, carry the source document's version instead.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
const SHA = "b".repeat(64);
const ALL = ["parseSourceDecision", "pageFacts", "figureLedger"];

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
    ('d-superseded', 'org', 'u', 'proj', 'run', 'f.pdf', 'application/pdf', 'k6', 'completed', 1),
    ('d-source', 'org', 'u', 'proj', 'run-old', 's.pdf', 'application/pdf', 'k7', 'completed', 1),
    ('d-reused', 'org', 'u', 'proj', 'run', 'r.pdf', 'application/pdf', 'k8', 'completed', 1),
    ('d-dedup', 'org', 'u', 'proj', 'run', 'x.pdf', 'application/pdf', 'k9', 'completed', 1),
    ('d-other', 'org-2', 'u', 'proj-2', 'run-other', 'e.pdf', 'application/pdf', 'k5', 'completed', 1),
    ('d-foreign-source', 'org-2', 'u', 'proj-2', 'run-other', 'g.pdf', 'application/pdf', 'k10', 'completed', 1)`;
  await sql`insert into document_page_facts (document_id, page_number, run_id) values ('d-full', 1, 'run')`;
  await sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status)
    values ('d-full', 'org', 'proj', 'run', true, 'complete')`;
  await sql`update documents set superseded_at = now() where id = 'd-superseded'`;
  await sql`update documents set reused_from_document_id = 'd-source' where id = 'd-reused'`;
  await sql`update documents set deduped_from_document_id = 'd-source' where id = 'd-dedup'`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  await sql`update documents set ingest_version = 0, ingest_capabilities = '{}' where id <> 'd-source'`;
  await sql`update documents set ingest_version = 1, ingest_capabilities = '{pageFacts}' where id = 'd-source'`;
  await sql`update documents set parse_source_scan_version = ${PARSE_SOURCE_SCAN_VERSION}, parse_source_sha256 = ${SHA} where id = 'd-full'`;
  await sql`update document_page_facts set run_id = 'run' where document_id = 'd-full'`;
  await sql`update document_extraction_levels set run_id = 'run' where document_id = 'd-full'`;
  await sql`update project_runs set ingest_version = 0, ingest_capabilities = '{}'`;
});

const versions = async () => Object.fromEntries((await sql<{ id: string; ingest_version: number; ingest_capabilities: string[] }[]>`
  select id, ingest_version, ingest_capabilities from documents order by id`).map((row) => [row.id, [row.ingest_version, row.ingest_capabilities]]));
const runVersion = async (id: string) => (await sql<{ ingest_version: number; ingest_capabilities: string[] }[]>`
  select ingest_version, ingest_capabilities from project_runs where id = ${id}`)[0];

describe("stampDocumentIngestVersion (alone)", () => {
  it("stamps one document of the run with only the capabilities it stored", async () => {
    await stampDocumentIngestVersion(sql, "run", "extracted", ["d-bare"]);
    const all = await versions();
    expect(all["d-bare"]).toEqual([CURRENT_INGEST_VERSION, []]);
    expect(all["d-full"]).toEqual([0, []]);
  });

  it("stamps the run's finished documents, never failed, superseded or another run's", async () => {
    await stampDocumentIngestVersion(sql, "run", "extracted");
    const all = await versions();
    expect(all["d-full"]).toEqual([CURRENT_INGEST_VERSION, ALL]);
    expect(all["d-bare"]).toEqual([CURRENT_INGEST_VERSION, []]);
    expect(all["d-pii"]).toEqual([CURRENT_INGEST_VERSION, []]);
    expect(all["d-failed"]).toEqual([0, []]);
    expect(all["d-superseded"]).toEqual([0, []]);
    expect(all["d-other"]).toEqual([0, []]);
  });

  it("does not count a figure ledger or page facts from another run, or a decision from an older scan", async () => {
    await sql`update document_extraction_levels set run_id = 'run-old' where document_id = 'd-full'`;
    await stampDocumentIngestVersion(sql, "run", "extracted", ["d-full"]);
    expect((await versions())["d-full"]).toEqual([CURRENT_INGEST_VERSION, ["parseSourceDecision", "pageFacts"]]);
    await sql`update document_page_facts set run_id = 'run-old' where document_id = 'd-full'`;
    await stampDocumentIngestVersion(sql, "run", "extracted", ["d-full"]);
    expect((await versions())["d-full"]).toEqual([CURRENT_INGEST_VERSION, ["parseSourceDecision"]]);
    await sql`update documents set parse_source_scan_version = ${PARSE_SOURCE_SCAN_VERSION - 1} where id = 'd-full'`;
    await stampDocumentIngestVersion(sql, "run", "extracted", ["d-full"]);
    expect((await versions())["d-full"]).toEqual([CURRENT_INGEST_VERSION, []]);
  });

  it("a deduplicated copy inherits its source even in a run that extracted", async () => {
    await stampDocumentIngestVersion(sql, "run", "extracted", ["d-dedup"]);
    expect((await versions())["d-dedup"]).toEqual([1, ["pageFacts"]]);
  });
});

describe("reuse runs keep the source document's version (F1)", () => {
  it("an inherited stamp copies the source's version and capabilities, adding only a parse decision measured on the row", async () => {
    await sql`update documents set ingest_version = 0, ingest_capabilities = '{}' where id = 'd-source'`;
    await stampDocumentIngestVersion(sql, "run", "inherited", ["d-reused"]);
    expect((await versions())["d-reused"]).toEqual([0, []]);
    await sql`update documents set ingest_version = 1, ingest_capabilities = '{figureLedger,pageFacts}' where id = 'd-source'`;
    await sql`update documents set parse_source_scan_version = ${PARSE_SOURCE_SCAN_VERSION}, parse_source_sha256 = ${SHA} where id = 'd-reused'`;
    await stampDocumentIngestVersion(sql, "run", "inherited", ["d-reused"]);
    expect((await versions())["d-reused"]).toEqual([1, ["figureLedger", "pageFacts", "parseSourceDecision"]]);
    await sql`update documents set parse_source_scan_version = null, parse_source_sha256 = null where id = 'd-reused'`;
  });

  it("a document with no source, or a source in another organization, inherits nothing (version 0)", async () => {
    await stampDocumentIngestVersion(sql, "run", "inherited", ["d-bare"]);
    expect((await versions())["d-bare"]).toEqual([0, []]);
    await sql`update documents set ingest_version = 1, ingest_capabilities = '{pageFacts}' where id = 'd-foreign-source'`;
    await sql`update documents set reused_from_document_id = 'd-foreign-source' where id = 'd-bare'`;
    try {
      await stampDocumentIngestVersion(sql, "run", "inherited", ["d-bare"]);
      expect((await versions())["d-bare"]).toEqual([0, []]);
    } finally {
      await sql`update documents set reused_from_document_id = null where id = 'd-bare'`;
    }
  });

  it("a plan that reuses intake, prep or extraction output inherits; reusing only index stages, or none, extracts", () => {
    expect(runReusesExtraction(defaultPipelineFeatures)).toBe(false);
    expect(runReusesExtraction(null)).toBe(false);
    expect(runReusesExtraction({ ...defaultPipelineFeatures, restartFromStage: "embed" })).toBe(true);
    expect(runReusesExtraction({ ...defaultPipelineFeatures, restartFromStage: "page-index" })).toBe(true);
    expect(runReusesExtraction({ ...defaultPipelineFeatures, stageSubset: ["embed"] })).toBe(true);
    // Restarting from the first stage reuses nothing.
    expect(runReusesExtraction({ ...defaultPipelineFeatures, restartFromStage: "quarantine" })).toBe(false);
  });
});

describe("completingDocumentStamp (alone)", () => {
  const complete = (id: string, mode: "extracted" | "inherited") =>
    sql`update documents d set updated_at = now() ${completingDocumentStamp(sql, "run", mode)} where d.id = ${id}`;

  it("stamps a document of this run that is not superseded", async () => {
    await complete("d-full", "extracted");
    expect((await versions())["d-full"]).toEqual([CURRENT_INGEST_VERSION, ALL]);
  });

  it("keeps the version of a superseded document or one owned by another run", async () => {
    await sql`update documents set ingest_version = 1, ingest_capabilities = '{pageFacts}' where id in ('d-superseded', 'd-source')`;
    await complete("d-superseded", "extracted");
    await complete("d-source", "extracted");
    const all = await versions();
    expect(all["d-superseded"]).toEqual([1, ["pageFacts"]]);
    expect(all["d-source"]).toEqual([1, ["pageFacts"]]);
  });

  it("inherits in a reuse run", async () => {
    await complete("d-reused", "inherited");
    expect((await versions())["d-reused"]).toEqual([1, ["pageFacts"]]);
  });
});

describe("run stamps (alone)", () => {
  it("runStamp gives an extracting run the build's version and capabilities", async () => {
    await sql`update project_runs set updated_at = now() ${runStamp(sql, "extracted")} where id = 'run'`;
    expect(await runVersion("run")).toEqual({ ingest_version: CURRENT_INGEST_VERSION, ingest_capabilities: [...INGEST_CAPABILITIES] });
    expect(await runVersion("run-other")).toEqual({ ingest_version: 0, ingest_capabilities: [] });
  });

  it("runStamp leaves a reuse run at 0", async () => {
    await sql`update project_runs set updated_at = now() ${runStamp(sql, "inherited")} where id = 'run'`;
    expect(await runVersion("run")).toEqual({ ingest_version: 0, ingest_capabilities: [] });
  });

  it("stampRunIngestVersion stamps the run and its documents in one statement", async () => {
    await stampRunIngestVersion(sql, "run");
    expect(await runVersion("run")).toMatchObject({ ingest_version: CURRENT_INGEST_VERSION });
    expect((await versions())["d-full"]).toEqual([CURRENT_INGEST_VERSION, ALL]);
    expect(runStampsIngestVersion("materialize")).toBe(false);
    expect(runStampsIngestVersion("upload")).toBe(true);
  });
});
