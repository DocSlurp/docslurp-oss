import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The bounded lexical query (services/search.ts rankedLexicalChunks) against
 * migrated Postgres: it ranks like the unbounded query it replaced when the
 * matches fit the candidate cap, and ranks at most the cap when they do not.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let search: typeof import("../services/search.js");

const WORDS = ["contract", "renewal", "termination", "invoice", "payment", "notice", "liability", "warranty"];

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  search = await import("../services/search.js");

  await sql.unsafe("set session_replication_role = replica");
  await sql`
    insert into documents (id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, org_id)
    select 'doc-' || g, 'u1', case when g <= 8 then 'ws-a' else 'ws-b' end, 'run-1', 'f' || g || '.pdf', 'application/pdf', 'k', 'completed', 'org1'
    from generate_series(1, 10) g
  `;
  // Deterministic text: chunk i repeats word (i % 8) i % 5 + 1 times plus a shared word.
  const rows = Array.from({ length: 400 }, (_, i) => ({
    id: `c-${i}`, document_id: `doc-${(i % 10) + 1}`, run_id: "run-1", user_id: "u1", chunk_index: i,
    text: `${Array.from({ length: (i % 5) + 1 }, () => WORDS[i % 8]).join(" ")} payment ${i % 3 === 0 ? "renewal notice" : "schedule"}`,
    page_number: 1, token_estimate: 10,
  }));
  await sql`insert into document_chunks ${sql(rows)}`;
  await sql.unsafe("set session_replication_role = origin");
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await stop?.();
});

const where = () => sql`exists (select 1 from documents scope_document where scope_document.id = c.document_id and scope_document.workspace_id = 'ws-a') and d.status = 'completed' and d.superseded_at is null`;

async function unboundedRanking(tsquery: string, limit: number): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select c.id
    from document_chunks c join documents d on d.id = c.document_id
    where ${where()} and c.ts_content @@ to_tsquery('english', ${tsquery})
    order by ts_rank_cd(c.ts_content, to_tsquery('english', ${tsquery})) desc, c.id
    limit ${limit}
  `;
  return rows.map((row) => row.id);
}

describe("bounded lexical search", () => {
  it("ranks like the unbounded query when matches fit the candidate cap", async () => {
    const tsquery = "renewal | termination";
    const rows = await search.rankedLexicalChunks(sql as never, {
      where: where() as never, parser: "tsquery", query: tsquery, limit: 15, candidates: 1_000,
    });
    expect(rows.map((row) => row.id)).toEqual(await unboundedRanking(tsquery, 15));
    expect(rows.map((row) => Number(row.rank))).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
    expect(rows[0]).toMatchObject({ text: expect.any(String), filename: expect.any(String) });
  });

  it("ranks at most the candidate cap and stays inside the scope", async () => {
    // "payment" matches every chunk in ws-a (320 of them).
    const rows = await search.rankedLexicalChunks(sql as never, {
      where: where() as never, parser: "tsquery", query: "payment", limit: 10, candidates: 50,
    });
    expect(rows).toHaveLength(10);
    const docs = new Set(rows.map((row) => row.document_id));
    expect([...docs].every((id) => Number(String(id).slice(4)) <= 8)).toBe(true);
  });

  it("reads SEARCH_LEXICAL_CANDIDATES", () => {
    expect(search.lexicalCandidateLimit({})).toBe(1_000);
    expect(search.lexicalCandidateLimit({ SEARCH_LEXICAL_CANDIDATES: "5000" })).toBe(5_000);
    expect(search.lexicalCandidateLimit({ SEARCH_LEXICAL_CANDIDATES: "1" })).toBe(50);
  });
});
