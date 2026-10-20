import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { claimPages, ensurePageRows, indexedPages, markPages, markPagesEmbedded, pageStateCounts } from "../deferred/page-ledger.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
const statements: string[] = [];

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 1);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('d1', 'o1', 'u1', 'w', 'run-1', 'a.pdf', 'application/pdf', 'k1', 'processing', 6);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, prepare: false, debug: (_c, query) => { statements.push(query); } });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`delete from document_page_states`);
});

const claim = (pages: number[], runId: string, ttlSeconds = 60) =>
  claimPages(sql, { documentId: "d1", pages, runId, ttlSeconds, reason: "query" });

describe("page ledger", () => {
  it("ensurePageRows is idempotent and preserves existing state", async () => {
    await ensurePageRows(sql, "d1", 4);
    await markPages(sql, "d1", [2], "indexed");
    await ensurePageRows(sql, "d1", 6);
    const rows = await db.query<{ page_number: number; state: string }>(
      `select page_number, state from document_page_states order by page_number`,
    );
    expect(rows.rows.map((r) => r.page_number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.rows.find((r) => r.page_number === 2)!.state).toBe("indexed");
  });

  it("claims fresh pages, then reports them awaiting for a second run", async () => {
    await ensurePageRows(sql, "d1", 6);
    expect(await claim([1, 2, 3], "run-a")).toEqual({ claimed: [1, 2, 3], awaiting: [], ready: [] });
    expect(await claim([2, 3, 4], "run-b")).toEqual({ claimed: [4], awaiting: [2, 3], ready: [] });
  });

  it("reports indexed pages as ready and omits blocked-pii pages", async () => {
    await ensurePageRows(sql, "d1", 6);
    await claim([1, 2, 3], "run-a");
    await markPages(sql, "d1", [1], "indexed", { costCredits: 0.5 });
    await markPages(sql, "d1", [2], "blocked-pii", { failureReason: "pii" });
    expect(await claim([1, 2, 3], "run-b")).toEqual({ claimed: [], awaiting: [3], ready: [1] });
    expect(await indexedPages(sql, "d1", [1, 2, 3])).toEqual([1]);
  });

  it("reclaims expired claims", async () => {
    await ensurePageRows(sql, "d1", 3);
    await claim([1, 2], "run-a", 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(await claim([1, 2], "run-b")).toEqual({ claimed: [1, 2], awaiting: [], ready: [] });
  });

  it("reclaims failed pages with attempts incremented until the limit", async () => {
    await ensurePageRows(sql, "d1", 3);
    await claim([1, 2], "run-a");
    await markPages(sql, "d1", [1, 2], "failed", { failureReason: "boom" });
    await db.exec(`update document_page_states set attempts = 3 where page_number = 2`);
    expect(await claim([1, 2], "run-b")).toEqual({ claimed: [1], awaiting: [], ready: [] });
    const row = await db.query<{ attempts: number }>(`select attempts from document_page_states where page_number = 1`);
    expect(row.rows[0]!.attempts).toBe(2);
  });

  it("lets the owning run re-claim its own pages", async () => {
    await ensurePageRows(sql, "d1", 3);
    await claim([1], "run-a");
    expect((await claim([1], "run-a")).claimed).toEqual([1]);
  });

  it("reports a page lost to a concurrent claimer as awaiting, not dropped", async () => {
    await ensurePageRows(sql, "d1", 3);
    let calls = 0;
    // Run A commits its claim while B's UPDATE is waiting on the row lock: B's UPDATE skips the
    // row (returns nothing) and B's follow-up SELECT must see A's claim.
    const racing = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        return sql`update document_page_states set state = 'claimed', claimed_by_run = 'run-a',
          claim_expires_at = now() + interval '60 seconds' where document_id = 'd1' and page_number = 1`.then(() => []);
      }
      return (sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...values);
    }) as unknown as Sql;
    const result = await claimPages(racing, { documentId: "d1", pages: [1], runId: "run-b", ttlSeconds: 60, reason: "query" });
    expect(result).toEqual({ claimed: [], awaiting: [1], ready: [] });
  });

  it("claims in a bounded number of statements", async () => {
    await ensurePageRows(sql, "d1", 6);
    statements.length = 0;
    await claimPages(sql, { documentId: "d1", pages: [1, 2, 3, 4], runId: "r", ttlSeconds: 30, reason: "query" });
    expect(statements.length).toBe(1); // nothing left to classify when all pages are claimed
  });

  it("summarizes counts per document", async () => {
    await ensurePageRows(sql, "d1", 4);
    await markPages(sql, "d1", [1, 2], "indexed");
    await db.exec(`update document_page_states set mapped = true where page_number in (1,3,4)`);
    // Text indexing never counts as page-embedded; only the page-embed stage stamps embedded_at.
    expect((await pageStateCounts(sql, ["d1"])).get("d1")!.embedded).toBe(0);
    await markPagesEmbedded(sql, "d1", [1], "m");
    const counts = await pageStateCounts(sql, ["d1", "missing"]);
    expect(counts.get("d1")).toEqual({ total: 4, indexed: 2, mapped: 3, embedded: 1 });
    expect(counts.get("missing")).toEqual({ total: 0, indexed: 0, mapped: 0, embedded: 0 });
  });
});
