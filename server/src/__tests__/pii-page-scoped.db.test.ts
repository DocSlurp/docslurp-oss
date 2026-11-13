import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

vi.mock("../config.js", async (original) => ({ ...await original<typeof import("../config.js")>(), env: { ...(await original<typeof import("../config.js")>()).env, s3Bucket: "bucket" } }));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let documents: typeof import("../services/documents.js");
let guard: typeof import("../services/pii-artifact-guard.js");
let readiness: typeof import("../services/page-image-readiness.js");

const DOC_A = "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b";
const DOC_B = "7d1c2b3a-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const page = (doc: string, n: number) => `s3://bucket/u/r/pages/${doc}/page-${n}.png`;
const render = (doc: string, n: number) => `s3://bucket/u/r/renders/${doc}/page-${n}-120.png`;
const figure = (doc: string, n: number) => `s3://bucket/u/r/doppler-figures/${doc}/p${n}.0.webp`;
const markdown = (doc: string) => `s3://bucket/u/r/markdown/${doc}.md`;
const source = (doc: string) => `s3://bucket/u/${doc}.pdf`;

const PAGE_SCOPED = (doc: string) => ({
  pii: {
    scope: "pages", withheldPages: [2], withheldPageCount: 1, pageCount: 3, action: "block_indexing", blocked: false,
    // pii-detect withholds the page image and figure of page 2, the source and unscanned parser output.
    withheldArtifactUris: [page(doc, 2), figure(doc, 2), source(doc)],
  },
});

function artifactsFor(doc: string) {
  return {
    [`${doc}:markdown`]: markdown(doc),
    ...Object.fromEntries([1, 2, 3].flatMap((n) => [
      [`${doc}:page-${n}`, page(doc, n)],
      // Renders written after the scan: not on the withheld list.
      [`${doc}:raster-v3-reader-120dpi-page-${n}`, render(doc, n)],
      [`${doc}:doppler-figure:p${n}.0`, figure(doc, n)],
    ])),
  };
}

/**
 * Page-scoped PII withholding at the serving layer, on a migrated database: the file proxy's authorization
 * (`userCanAccessArtifactUri`), page-image readiness and the search/chat hit filter. Negative cases: withheld pages
 * (including renders and figures written after the scan), whole-document blocking, malformed outcomes, another
 * tenant, a key bound to another organization and revoked membership.
 */
describe("page-scoped PII serving", () => {
  beforeAll(async () => {
    const database = await startMigratedPostgres();
    stop = database.stop;
    sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
    vi.doMock("../db.js", () => ({ sql }));
    await sql`insert into "user" (id, name, email) values ('ua', 'A', 'a@pii-pages.test'), ('ub', 'B', 'b@pii-pages.test')`;
    await sql`insert into organizations (id, name, slug, created_by_user_id) values ('oa', 'Org A', 'pii-pages-a', 'ua'), ('ob', 'Org B', 'pii-pages-b', 'ub')`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('oa', 'ua', 'owner'), ('ob', 'ub', 'owner')`;
    await sql`insert into projects (id, org_id, user_id, name) values ('pa', 'oa', 'ua', 'A'), ('pb', 'ob', 'ub', 'B')`;
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, artifacts) values
      ('ra', 'oa', 'ua', 'pa', 'bulk-upload', 'completed', 'completed', '{}', ${sql.json(artifactsFor(DOC_A))}),
      ('rb', 'ob', 'ub', 'pb', 'bulk-upload', 'completed', 'completed', '{}', ${sql.json(artifactsFor(DOC_B))})`;
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, metadata) values
      (${DOC_A}, 'oa', 'ua', 'pa', 'ra', 'a.pdf', 'application/pdf', ${`u/${DOC_A}.pdf`}, 'completed', 3, ${sql.json(PAGE_SCOPED(DOC_A))}),
      (${DOC_B}, 'ob', 'ub', 'pb', 'rb', 'b.pdf', 'application/pdf', ${`u/${DOC_B}.pdf`}, 'completed', 3, ${sql.json(PAGE_SCOPED(DOC_B))})`;
    documents = await import("../services/documents.js");
    guard = await import("../services/pii-artifact-guard.js");
    readiness = await import("../services/page-image-readiness.js");
  }, 120_000);
  afterAll(async () => { await sql?.end(); await stop?.(); });
  beforeEach(async () => {
    await sql`update documents set status = 'completed', metadata = ${sql.json(PAGE_SCOPED(DOC_A))} where id = ${DOC_A}`;
  });

  it("serves the clean pages' images, renders, figures and the rewritten Markdown", async () => {
    for (const uri of [page(DOC_A, 1), page(DOC_A, 3), render(DOC_A, 1), render(DOC_A, 3), figure(DOC_A, 3), markdown(DOC_A)]) {
      expect(await documents.userCanAccessArtifactUri(uri, "ua"), uri).toBe(true);
    }
  });

  it("refuses the withheld page's image, render (written after the scan), figure and the source", async () => {
    for (const uri of [page(DOC_A, 2), render(DOC_A, 2), figure(DOC_A, 2), source(DOC_A)]) {
      expect(await documents.userCanAccessArtifactUri(uri, "ua"), uri).toBe(false);
    }
  });

  it("refuses a render of a withheld page even if the worker's withheld list misses it", async () => {
    await sql`update documents set metadata = ${sql.json({ pii: { ...PAGE_SCOPED(DOC_A).pii, withheldArtifactUris: [] } })} where id = ${DOC_A}`;
    expect(await documents.userCanAccessArtifactUri(render(DOC_A, 2), "ua")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(page(DOC_A, 2), "ua")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(figure(DOC_A, 2), "ua")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(render(DOC_A, 1), "ua")).toBe(true);
  });

  it("fails closed: a blocked document or a malformed outcome serves no page", async () => {
    await sql`update documents set status = 'pii_blocked' where id = ${DOC_A}`;
    expect(await documents.userCanAccessArtifactUri(page(DOC_A, 1), "ua")).toBe(false);
    await sql`update documents set status = 'completed', metadata = ${sql.json({ pii: { scope: "pages", withheldPages: "2" } })} where id = ${DOC_A}`;
    expect(await documents.userCanAccessArtifactUri(page(DOC_A, 1), "ua")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(render(DOC_A, 3), "ua")).toBe(false);
  });

  it("another tenant never reaches the clean pages either", async () => {
    expect(await documents.userCanAccessArtifactUri(page(DOC_A, 1), "ub")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(page(DOC_A, 1), "ub", "ob")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(page(DOC_A, 1), "ua", "ob")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(page(DOC_B, 1), "ua")).toBe(false);
    // B's own withheld page stays withheld for B.
    expect(await documents.userCanAccessArtifactUri(page(DOC_B, 2), "ub")).toBe(false);
    expect(await documents.userCanAccessArtifactUri(page(DOC_B, 1), "ub")).toBe(true);
  });

  it("revoked membership serves nothing", async () => {
    await sql`delete from org_memberships where org_id = 'oa' and user_id = 'ua'`;
    expect(await documents.userCanAccessArtifactUri(page(DOC_A, 1), "ua")).toBe(false);
    await sql`insert into org_memberships (org_id, user_id, role) values ('oa', 'ua', 'owner')`;
  });

  it("page-image readiness reports a withheld page as unavailable, a clean one as ready", async () => {
    const resource = (pageNumber: number) => ({ kind: "page-image" as const, documentId: DOC_A, runId: "ra", pageNumber, quality: "reader" as const });
    expect((await readiness.readPageImageReadiness("ua", resource(1))).status).toBe("ready");
    expect((await readiness.readPageImageReadiness("ua", resource(2))).status).toBe("unavailable");
    await expect(readiness.readPageImageReadiness("ub", resource(1))).rejects.toThrow("not_found");
  });

  it("search and chat hits on a withheld page are dropped; the rest stay", async () => {
    const hit = (documentId: string, pageNumber: number | null, pageNumbers: number[] = []) =>
      ({ text: "x", score: 1, citation: { source: "document", documentId, filename: "a.pdf", pageNumber, pageNumbers, headingPath: [], chunkIndex: 0 } });
    const kept = await guard.filterPiiWithheldResults([
      hit(DOC_A, 1), hit(DOC_A, 2), hit(DOC_A, null, [1, 2]), hit(DOC_A, null), hit(DOC_A, 3), hit("missing-doc", 1),
    ]);
    expect(kept.map((result) => [result.citation.documentId, result.citation.pageNumber])).toEqual([[DOC_A, 1], [DOC_A, 3]]);
    await sql`update documents set status = 'pii_blocked' where id = ${DOC_A}`;
    expect(await guard.filterPiiWithheldResults([hit(DOC_A, 1)])).toEqual([]);
  });
});

describe("operator dry run (scripts/pii-page-scope-dry-run.sql)", () => {
  it("counts blocked documents a rescan would make partly available, changing nothing", async () => {
    const policy = (action: string) => sql.json({ piiPolicy: { enabled: true, action, patterns: ["ssn"] } });
    await sql`insert into projects (id, org_id, user_id, name, pipeline) values ('pdry', 'oa', 'ua', 'Dry', ${policy("block_indexing")}),
      ('pdoc', 'oa', 'ua', 'Dry doc', ${policy("block_document")})`;
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values
      ('rdry', 'oa', 'ua', 'pdry', 'bulk-upload', 'completed', 'completed', '{}'),
      ('rdoc', 'oa', 'ua', 'pdoc', 'bulk-upload', 'completed', 'completed', '{}')`;
    const docs: Array<[string, string, string, number, Array<number | null>]> = [
      ["dry-one-page-hit", "pdry", "rdry", 10, [4]],
      ["dry-every-page", "pdry", "rdry", 2, [1, 2]],
      ["dry-unpaged-hit", "pdry", "rdry", 5, [null]],
      ["dry-block-document", "pdoc", "rdoc", 10, [3]],
    ];
    for (const [id, project, run, pages, hits] of docs) {
      await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, metadata)
        values (${id}, 'oa', 'ua', ${project}, ${run}, ${`${id}.pdf`}, 'application/pdf', ${`u/${id}.pdf`}, 'pii_blocked', ${pages}, ${sql.json({ pii: { runId: run, blocked: true } })})`;
      for (const hit of hits) {
        await sql`insert into pii_detections (document_id, run_id, pattern_type, matched_prefix, page_number) values (${id}, ${run}, 'ssn', 'fp', ${hit})`;
      }
    }
    const query = readFileSync(new URL("../../../scripts/pii-page-scope-dry-run.sql", import.meta.url), "utf8");
    const rows = await sql.unsafe<{ verdict: string; documents: string; pages_that_would_be_served: string; pages_that_stay_withheld: string }[]>(query);
    const byVerdict = Object.fromEntries(rows.map((row) => [row.verdict, row]));
    expect(Number(byVerdict["partly-available:pages"]?.documents)).toBe(1);
    expect(Number(byVerdict["partly-available:pages"]?.pages_that_would_be_served)).toBe(9);
    expect(Number(byVerdict["partly-available:pages"]?.pages_that_stay_withheld)).toBe(1);
    expect(Number(byVerdict["stays-blocked:every-page"]?.documents)).toBe(1);
    expect(Number(byVerdict["stays-blocked:match-without-page"]?.documents)).toBe(1);
    expect(Number(byVerdict["stays-blocked:block_document"]?.documents)).toBe(1);
    // Read-only: nothing was rescanned or unblocked.
    const [{ blocked }] = await sql<{ blocked: number }[]>`select count(*)::int as blocked from documents where id like 'dry-%' and status = 'pii_blocked'`;
    expect(blocked).toBe(4);
  });
});
