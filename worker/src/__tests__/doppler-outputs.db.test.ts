import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DopplerOutputsError, dopplerOutputKeys, dopplerOutputsRecordFrom, flushDopplerOutputs, readDopplerOutputs, writeDopplerOutputs,
  type DopplerOutputsRecord, type DopplerOutputsScope,
} from "../db/doppler-outputs.js";
import {
  DocumentAssetLedgerError, flushAssetLedger, ledgerWriteForFailedFigures, ledgerWriteForMarkdownCommitted, markFigureLevelMarkdownComplete,
  writeDocumentAssetLedger, writeFigureLevel,
} from "../db/document-asset-ledger.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { Store } from "../db/store.js";

// The Doppler output record (migration 0190) and the first-pass Markdown mark on the extraction level, over a migrated
// database: org-scoped writes, keys only under the run's own artifact root, stale runs refused, malformed records refused
// before the database, and reads that skip a bad row instead of failing.
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;

const A: DopplerOutputsScope = { orgId: "org-a", projectId: "proj-a", documentId: "doc-a", runId: "run-a" };
const B: DopplerOutputsScope = { orgId: "org-b", projectId: "proj-b", documentId: "doc-b", runId: "run-b" };
const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'a', 'ua'), ('org-b', 'B', 'b', 'ub');
    insert into projects(id, org_id, user_id, name) values ('proj-a', 'org-a', 'ua', 'A'), ('proj-b', 'org-b', 'ub', 'B');
    insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, created_at) values
      (100, 'run-a-old', 'org-a', 'ua', 'proj-a', 'upload', 'completed', 'completed', '{}', 1, now() - interval '2 hours'),
      (100, 'run-a', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract', '{}', 1, now() - interval '1 hour'),
      (100, 'run-a-new', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract', '{}', 1, now()),
      (100, 'run-b', 'org-b', 'ub', 'proj-b', 'upload', 'processing', 'extract', '{}', 1, now());
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
      ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'processing', 3),
      ('doc-a2', 'org-a', 'ua', 'proj-a', 'run-a', 'a2.pdf', 'application/pdf', 'ka2', 'processing', 3),
      ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'kb', 'processing', 3);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await sql`delete from document_doppler_outputs`;
  await sql`delete from document_assets`;
  await sql`delete from document_extraction_levels`;
  await sql`update documents set run_id = 'run-a' where org_id = 'org-a'`;
});

function record(root: string, documentId: string, overrides: Partial<DopplerOutputsRecord> = {}): DopplerOutputsRecord {
  const keys = dopplerOutputKeys(root, documentId, "vm-pdf");
  return {
    extractor: "vm-pdf",
    servedBy: "vm",
    build: { reported: "doppler-1.4.0", version: "1.4.0", commit: "0cf2981" },
    markdown: { key: keys.markdown, sha256: SHA, bytes: 1234 },
    pageFacts: { status: "stored", key: keys.pageFacts, sha256: SHA2, bytes: 900, pagesKnown: 3, pagesFailed: 0, linesDropped: 0, complete: true },
    layoutFacts: { key: keys.layoutFacts, pages: 3 },
    engine: { pagesEmitted: 3, pagesFailed: 0, ms: 420, peakRssKiB: 51_200 },
    ocrPages: 1,
    ...overrides,
  };
}

const row = async (documentId: string) => (await sql<Array<Record<string, unknown>>>`
  select org_id, project_id, run_id, extractor, served_by, doppler_build, doppler_version, doppler_commit, markdown_key, markdown_sha256,
    markdown_bytes::int as markdown_bytes, page_facts_status, page_facts_key, page_facts_pages_known, layout_facts_key, layout_facts_pages,
    engine_ms::int as engine_ms, ocr_pages
  from document_doppler_outputs where document_id = ${documentId}`)[0];

async function refused(promise: Promise<unknown>, rule: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ rule });
}

describe("writing the Doppler output record", () => {
  it("records every output's key under the run's own root and Doppler's measured fields", async () => {
    await writeDopplerOutputs(sql, A, record("ua/run-a", "doc-a"));
    expect(await row("doc-a")).toEqual({
      org_id: "org-a", project_id: "proj-a", run_id: "run-a", extractor: "vm-pdf", served_by: "vm", doppler_build: "doppler-1.4.0",
      doppler_version: "1.4.0", doppler_commit: "0cf2981", markdown_key: "ua/run-a/markdown/doc-a.vm-pdf.md", markdown_sha256: SHA,
      markdown_bytes: 1234, page_facts_status: "stored", page_facts_key: "ua/run-a/doppler/doc-a/images/page-facts.jsonl",
      page_facts_pages_known: 3, layout_facts_key: "ua/run-a/page-layout-facts/doc-a.json", layout_facts_pages: 3, engine_ms: 420, ocr_pages: 1,
    });
    // A re-run of the same run replaces the record in place.
    await writeDopplerOutputs(sql, A, record("ua/run-a", "doc-a", { pageFacts: { status: "absent" }, layoutFacts: null }));
    expect(await row("doc-a")).toMatchObject({ page_facts_status: "absent", page_facts_key: null, layout_facts_key: null });
    expect((await sql`select count(*)::int as n from document_doppler_outputs`)[0]!.n).toBe(1);
  });

  it("refuses another organization's scope, project or document and writes nothing", async () => {
    // org-b's scope naming org-a's document.
    await refused(writeDopplerOutputs(sql, { ...B, documentId: "doc-a" }, record("ub/run-b", "doc-a")), "scope-mismatch");
    // org-a's document under org-b's run.
    await refused(writeDopplerOutputs(sql, { ...A, runId: "run-b" }, record("ub/run-b", "doc-a")), "scope-mismatch");
    // The right document under the wrong project.
    await refused(writeDopplerOutputs(sql, { ...A, projectId: "proj-b" }, record("ua/run-a", "doc-a")), "scope-mismatch");
    expect((await sql`select count(*)::int as n from document_doppler_outputs`)[0]!.n).toBe(0);
  });

  it("refuses keys outside the run's root or the document's own folder", async () => {
    const theirs = dopplerOutputKeys("ub/run-b", "doc-b", "vm-pdf");
    const sibling = dopplerOutputKeys("ua/run-a", "doc-a2", "vm-pdf");
    // Another organization's run root.
    await refused(writeDopplerOutputs(sql, A, record("ua/run-a", "doc-a", { markdown: { key: theirs.markdown.replace("doc-b", "doc-a"), sha256: SHA, bytes: 1 } })), "key-mismatch");
    // Another document's page facts in the same run.
    await refused(writeDopplerOutputs(sql, A, record("ua/run-a", "doc-a", {
      pageFacts: { status: "stored", key: sibling.pageFacts, sha256: SHA2, bytes: 1, pagesKnown: 1, pagesFailed: 0, linesDropped: 0, complete: true },
    })), "key-mismatch");
    // Another extractor's Markdown object.
    await refused(writeDopplerOutputs(sql, A, record("ua/run-a", "doc-a", { markdown: { key: "ua/run-a/markdown/doc-a.pandoc.md", sha256: SHA, bytes: 1 } })), "key-mismatch");
    // Another document's layout facts.
    await refused(writeDopplerOutputs(sql, A, record("ua/run-a", "doc-a", { layoutFacts: { key: sibling.layoutFacts, pages: 1 } })), "key-mismatch");
    expect((await sql`select count(*)::int as n from document_doppler_outputs`)[0]!.n).toBe(0);
  });

  it("refuses a run that is not the document's current one, and never lets an older run replace a newer record", async () => {
    await refused(writeDopplerOutputs(sql, { ...A, runId: "run-a-old" }, record("ua/run-a-old", "doc-a")), "stale-write");
    await sql`update documents set run_id = 'run-a-new' where id = 'doc-a'`;
    await writeDopplerOutputs(sql, { ...A, runId: "run-a-new" }, record("ua/run-a-new", "doc-a"));
    await sql`update documents set run_id = 'run-a' where id = 'doc-a'`;
    await refused(writeDopplerOutputs(sql, A, record("ua/run-a", "doc-a")), "stale-write");
    expect(await row("doc-a")).toMatchObject({ run_id: "run-a-new" });
  });

  it("refuses a malformed record before the database: free text, bad hashes, out-of-vocabulary values, unsafe keys", async () => {
    const good = record("ua/run-a", "doc-a");
    const bad: Array<Partial<DopplerOutputsRecord>> = [
      { extractor: "Doppler <script>" },
      { servedBy: "batch" as never },
      { build: { reported: "has spaces in it", version: null, commit: null } },
      { build: { reported: null, version: "v1", commit: null } },
      { build: { reported: null, version: null, commit: "NOT-HEX" } },
      { markdown: { ...good.markdown, sha256: "abc" } },
      { markdown: { ...good.markdown, bytes: -1 } },
      { markdown: { ...good.markdown, key: "ua/run-a/markdown/../../ub/run-b/markdown/doc-b.vm-pdf.md" } },
      { markdown: { ...good.markdown, key: "/ua/run-a/markdown/doc-a.vm-pdf.md" } },
      { pageFacts: { status: "maybe" as never } },
      { pageFacts: { status: "stored" } as never },
      { pageFacts: { status: "absent", key: good.markdown.key } as never },
      { layoutFacts: { key: good.layoutFacts!.key, pages: 1.5 } },
      { ocrPages: -3 },
    ];
    for (const overrides of bad) {
      await expect(writeDopplerOutputs(sql, A, { ...good, ...overrides })).rejects.toBeInstanceOf(DopplerOutputsError);
    }
    expect((await sql`select count(*)::int as n from document_doppler_outputs`)[0]!.n).toBe(0);
  });

  it("the database refuses a key outside the document's own folder even when written directly", async () => {
    await expect(sql`
      insert into document_doppler_outputs (document_id, org_id, project_id, run_id, extractor, served_by, markdown_key, markdown_sha256,
        markdown_bytes, page_facts_status, page_facts_key, page_facts_sha256, page_facts_bytes)
      values ('doc-a', 'org-a', 'proj-a', 'run-a', 'vm-pdf', 'vm', 'ua/run-a/markdown/doc-a.vm-pdf.md', ${SHA}, 1, 'stored',
        'ua/run-a/doppler/doc-a2/images/page-facts.jsonl', ${SHA}, 1)`).rejects.toThrow();
    // A row naming org-b with org-a's document fails the composite foreign key.
    await expect(sql`
      insert into document_doppler_outputs (document_id, org_id, project_id, run_id, extractor, served_by, markdown_key, markdown_sha256,
        markdown_bytes, page_facts_status)
      values ('doc-a', 'org-b', 'proj-b', 'run-b', 'vm-pdf', 'vm', 'ub/run-b/markdown/doc-a.vm-pdf.md', ${SHA}, 1, 'absent')`).rejects.toThrow();
  });
});

describe("reading the Doppler output records", () => {
  it("returns one organization's rows only and skips a row that does not validate", async () => {
    await writeDopplerOutputs(sql, A, record("ua/run-a", "doc-a"));
    await writeDopplerOutputs(sql, B, record("ub/run-b", "doc-b"));
    // A row the database accepts but the reader cannot vouch for (stored facts without their page counts).
    await sql`
      insert into document_doppler_outputs (document_id, org_id, project_id, run_id, extractor, served_by, markdown_key, markdown_sha256,
        markdown_bytes, page_facts_status, page_facts_key, page_facts_sha256, page_facts_bytes)
      values ('doc-a2', 'org-a', 'proj-a', 'run-a', 'vm-pdf', 'vm', 'ua/run-a/markdown/doc-a2.vm-pdf.md', ${SHA}, 1, 'stored',
        'ua/run-a/doppler/doc-a2/images/page-facts.jsonl', ${SHA}, 1)`;
    const page = await readDopplerOutputs(sql, { orgId: "org-a" });
    expect(page.rows.map((r) => r.documentId)).toEqual(["doc-a"]);
    expect(page.skipped).toBe(1);
    expect(page.rows[0]).toMatchObject({ extractor: "vm-pdf", build: { commit: "0cf2981" }, pageFacts: { status: "stored", pagesKnown: 3 } });
    const other = await readDopplerOutputs(sql, { orgId: "org-b", documentIds: ["doc-a", "doc-b"] });
    expect(other.rows.map((r) => r.documentId)).toEqual(["doc-b"]);
    await expect(readDopplerOutputs(sql, { orgId: "org a; drop" })).rejects.toBeInstanceOf(DopplerOutputsError);
  });
});

describe("flushing queued records after the checkpoint", () => {
  it("writes only documents whose Markdown slot committed, in a run with a scope, and never fails the run", async () => {
    const pending = new Map<string, DopplerOutputsRecord>([
      ["doc-a", record("ua/run-a", "doc-a")],
      ["doc-a2", record("ua/run-a", "doc-a2")],
    ]);
    const slots: Record<string, string> = { "doc-a:markdown": "s3://b/ua/run-a/markdown/doc-a.vm-pdf.md" };
    const state = {
      run: { id: "run-a", orgId: "org-a", projectId: "proj-a" },
      artifactLedger: { readDocument: (documentId: string, slot: string) => slots[`${documentId}:${slot}`] },
      pendingDopplerOutputs: pending,
    };
    const outcomes = await flushDopplerOutputs(state, (scope, rec) => writeDopplerOutputs(sql, scope, rec));
    expect(Object.fromEntries(outcomes)).toEqual({ "doc-a": "written", "doc-a2": "no-markdown" });
    expect(pending.size).toBe(0);
    // A refused write is an outcome, not an exception.
    slots["doc-a2:markdown"] = "x";
    const crossed = await flushDopplerOutputs({ ...state, pendingDopplerOutputs: new Map([["doc-a2", record("ub/run-b", "doc-a2")]]) },
      (scope, rec) => writeDopplerOutputs(sql, scope, rec));
    expect(crossed.get("doc-a2")).toBe("refused");
    const noScope = await flushDopplerOutputs({ ...state, run: { id: "run-a" }, pendingDopplerOutputs: new Map([["doc-a", record("ua/run-a", "doc-a")]]) },
      async () => { throw new Error("must not write"); });
    expect(noScope.get("doc-a")).toBe("no-scope");
  });

  it("builds a record from Doppler's facts run line, keeping only a dotted version and a hex commit", () => {
    const keys = dopplerOutputKeys("ua/run-a", "doc-a", "vm-pdf");
    const built = dopplerOutputsRecordFrom({
      extractor: "vm-pdf", servedBy: "first-pass", reportedBuild: "not a build!",
      markdown: { key: keys.markdown, sha256: SHA, bytes: 10 },
      pageFacts: { status: "stored", key: keys.pageFacts, sha256: SHA2, bytes: 5, facts: {
        run: { version: "1.4.0", commit: "0cf2981abc", totalMs: 99, peakRssKiB: 1000, pagesEmitted: 3, pagesFailed: 1 },
        summary: { pagesKnown: 2, pagesFailed: 1, linesDropped: 0, complete: true },
      } },
      layoutFacts: null, ocrPages: 0,
    });
    expect(built).toMatchObject({ build: { reported: null, version: "1.4.0", commit: "0cf2981abc" }, engine: { ms: 99, pagesFailed: 1 }, pageFacts: { status: "stored", pagesKnown: 2 } });
    // A stored status without its object is recorded as a failed write, never as stored.
    const noObject = dopplerOutputsRecordFrom({
      extractor: "vm-pdf", servedBy: "vm", reportedBuild: undefined, markdown: { key: keys.markdown, sha256: SHA, bytes: 10 },
      pageFacts: { status: "stored" }, layoutFacts: null, ocrPages: 0,
    });
    expect(noObject.pageFacts.status).toBe("failed");
  });
});

describe("the first pass's figure level learns that the Markdown committed", () => {
  const LA = { orgId: "org-a", projectId: "proj-a", documentId: "doc-a", runId: "run-a" };
  const level = async () => (await sql<Array<{ images_status: string; markdown_complete: boolean; run_id: string }>>`
    select images_status, markdown_complete, run_id from document_extraction_levels where document_id = 'doc-a'`)[0];

  it("marks a failed first-pass level written before the Markdown committed", async () => {
    // The first pass's figure step: its checkpoint did not hold the Markdown yet.
    await writeFigureLevel(sql, { scope: LA, markdownComplete: false, imagesStatus: "failed" });
    expect(await level()).toEqual({ images_status: "failed", markdown_complete: false, run_id: "run-a" });
    expect(await markFigureLevelMarkdownComplete(sql, LA)).toBe("marked");
    expect(await level()).toEqual({ images_status: "failed", markdown_complete: true, run_id: "run-a" });
    expect(await markFigureLevelMarkdownComplete(sql, LA)).toBe("unchanged");
  });

  it("levels a document whose figure write never landed, and a later figure write of the run keeps the mark", async () => {
    expect(await markFigureLevelMarkdownComplete(sql, LA)).toBe("leveled");
    expect(await level()).toEqual({ images_status: "failed", markdown_complete: true, run_id: "run-a" });
    // The first pass's own (level-only) write lands afterwards with markdownComplete false: the mark stays.
    await writeDocumentAssetLedger(sql, { scope: LA, level: { ...ledgerWriteForFailedFigures({ outcome: { exitCode: 6, build: "0cf2981" } }).level, markdownComplete: false }, assets: [], levelOnly: true });
    expect(await level()).toMatchObject({ markdown_complete: true });
    expect((await sql`select doppler_build from document_extraction_levels where document_id = 'doc-a'`)[0]!.doppler_build).toBe("0cf2981");
  });

  it("a newer run's level starts over; an older run's mark is refused", async () => {
    await writeFigureLevel(sql, { scope: LA, markdownComplete: true, imagesStatus: "failed" });
    await sql`update documents set run_id = 'run-a-new' where id = 'doc-a'`;
    await writeFigureLevel(sql, { scope: { ...LA, runId: "run-a-new" }, markdownComplete: false, imagesStatus: "failed" });
    expect(await level()).toEqual({ images_status: "failed", markdown_complete: false, run_id: "run-a-new" });
    await expect(markFigureLevelMarkdownComplete(sql, LA)).rejects.toMatchObject({ rule: "stale-write" });
    expect(await level()).toMatchObject({ markdown_complete: false });
  });

  it("refuses another organization's scope, and a queued mark without a committed Markdown slot writes nothing", async () => {
    await expect(markFigureLevelMarkdownComplete(sql, { ...LA, orgId: "org-b", projectId: "proj-b" })).rejects.toBeInstanceOf(DocumentAssetLedgerError);
    await expect(markFigureLevelMarkdownComplete(sql, { ...LA, runId: "run-b" })).rejects.toMatchObject({ rule: "scope-mismatch" });
    const state = {
      run: { id: "run-a", orgId: "org-a", projectId: "proj-a" },
      artifactLedger: { readDocument: () => undefined },
      pendingAssetLedger: new Map([["doc-a", ledgerWriteForMarkdownCommitted()]]),
    };
    const outcomes = await flushAssetLedger(state as never, (write) => writeDocumentAssetLedger(sql, write));
    expect(outcomes.get("doc-a")).toBe("refused");
    expect(await level()).toBeUndefined();
    // With the slot committed, the same queued write lands.
    const committed = { ...state, artifactLedger: { readDocument: () => "s3://b/ua/run-a/markdown/doc-a.vm-pdf.md" }, pendingAssetLedger: new Map([["doc-a", ledgerWriteForMarkdownCommitted()]]) };
    expect((await flushAssetLedger(committed as never, (write) => writeDocumentAssetLedger(sql, write))).get("doc-a")).toBe("written");
    expect(await level()).toEqual({ images_status: "failed", markdown_complete: true, run_id: "run-a" });
  });
});
