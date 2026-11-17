import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { finalizePageExtracts, pageExtractStatements, recordPageExtracts, type PageExtractState } from "../pipeline/page-extracts.js";

/**
 * Page extract finalization under real concurrency (needs a real, migrated, throwaway Postgres; PGlite serves one
 * session):
 *
 *   TEST_DATABASE_URL=postgres://… pnpm --filter worker test -- page-extracts-concurrency
 *
 * A document's completion (its documents UPDATE, then finalization), a query-time materialization of a newer run (the
 * documents row FOR NO KEY UPDATE, then finalization of its pages) and a checkpoint rewriting the completing run's rows
 * race, many times: no deadlock, no unique violation, exactly one final per page, and the newer run's pages stay its own.
 */
const realUrl = process.env.TEST_DATABASE_URL;
const PAGES = 50;
const MATERIALIZED = 25;
const ROUNDS = 25;

let sql: postgres.Sql<Record<string, unknown>>;
const id = randomBytes(4).toString("hex");
const ORG = `org-pe-${id}`;
const PROJECT = `proj-pe-${id}`;
const USER = `user-pe-${id}`;
const RUN = `run-pe-${id}`;
const MAT = `mat-pe-${id}`;
const DOC = `doc-pe-${id}`;

describe.skipIf(!realUrl)("page extract finalization under real concurrency", () => {
  beforeAll(async () => {
    sql = postgres(realUrl!, { max: 4, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
    await sql`insert into "user"(id, name, email) values (${USER}, 'A', ${`${USER}@example.com`})`;
    await sql`insert into organizations(id, name, slug, created_by_user_id) values (${ORG}, 'A', ${ORG}, ${USER})`;
    await sql`insert into projects(id, org_id, user_id, name) values (${PROJECT}, ${ORG}, ${USER}, 'A')`;
    await sql`insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, created_at) values
      (100, ${RUN}, ${ORG}, ${USER}, ${PROJECT}, 'upload', 'processing', 'index', '{}', now() - interval '1 hour'),
      (100, ${MAT}, ${ORG}, ${USER}, ${PROJECT}, 'materialize', 'processing', 'materialize', '{}', now())`;
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
      values (${DOC}, ${ORG}, ${USER}, ${PROJECT}, ${RUN}, 'a.pdf', 'application/pdf', 'k', 'processing', ${PAGES})`;
    const run = rowsFor(RUN, Array.from({ length: PAGES }, (_, i) => i + 1), "extract", "text-layer");
    const mat = rowsFor(MAT, Array.from({ length: MATERIALIZED }, (_, i) => i + 1), "vision", "vision");
    await sql.begin(async (tx) => {
      for (const statement of pageExtractStatements(tx as unknown as typeof sql, [...run, ...mat], [])) await statement;
    });
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from documents where id = ${DOC}`;
    await sql`delete from project_runs where id in (${RUN}, ${MAT})`;
    await sql`delete from projects where id = ${PROJECT}`;
    await sql`delete from organizations where id = ${ORG}`;
    await sql`delete from "user" where id = ${USER}`;
    await sql.end();
  });

  function rowsFor(runId: string, pages: number[], pass: "extract" | "vision", method: "text-layer" | "vision") {
    const state: PageExtractState = { run: { id: runId, orgId: ORG, projectId: PROJECT }, pendingPageExtracts: [], pendingPageExtractTags: [] };
    recordPageExtracts(state, { id: DOC }, pages.map((pageNumber) => ({ pageNumber, pass, method, engine: "vm-pdf" })));
    return state.pendingPageExtracts;
  }

  it("completion, materialization and a checkpoint race without deadlock, leaving one final per page", async () => {
    const rewrite = rowsFor(RUN, Array.from({ length: PAGES }, (_, i) => i + 1), "extract", "text-layer");
    for (let round = 0; round < ROUNDS; round += 1) {
      await sql`update document_page_extracts set is_final = false, superseded_by_pass = null where document_id = ${DOC}`;
      const completion = sql.begin(async (tx) => {
        const client = tx as unknown as typeof sql;
        await client`update documents set updated_at = now() where id = ${DOC}`;
        for (const statement of finalizePageExtracts(client, { orgId: ORG, runId: RUN, documentIds: [DOC] })) await statement;
      });
      const materialize = sql.begin(async (tx) => {
        const client = tx as unknown as typeof sql;
        await client`select 1 from documents where id = ${DOC} for no key update`;
        for (const statement of finalizePageExtracts(client, { orgId: ORG, runId: MAT, documentIds: [DOC],
          pages: Array.from({ length: MATERIALIZED }, (_, i) => i + 1) })) await statement;
      });
      const checkpoint = sql.begin(async (tx) => {
        const client = tx as unknown as typeof sql;
        await client`select 1`;
        for (const statement of pageExtractStatements(client, rewrite, [])) await statement;
      });
      const outcomes = await Promise.allSettled(round % 2 ? [materialize, completion, checkpoint] : [completion, materialize, checkpoint]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
      const finals = await sql<{ page_number: number; run_id: string; n: number }[]>`
        select page_number, min(run_id) as run_id, count(*)::int as n from document_page_extracts
        where document_id = ${DOC} and is_final group by page_number order by page_number`;
      expect(finals).toHaveLength(PAGES);
      for (const row of finals) {
        expect(row.n).toBe(1);
        // The materialization is the newer run: its pages are its own whichever transaction went first.
        expect(row.run_id).toBe(row.page_number <= MATERIALIZED ? MAT : RUN);
      }
    }
  }, 120_000);
});
