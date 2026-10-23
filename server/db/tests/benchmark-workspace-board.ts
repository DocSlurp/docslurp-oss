import postgres from "postgres";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { deepStrictEqual } from "node:assert";
import { startMigratedPostgres } from "@docslurp/worker/testing";

const database = await startMigratedPostgres();
const sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
try {
  await sql`insert into "user" (id, name, email) values ('u', 'Benchmark', 'benchmark@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Benchmark', 'benchmark', 'u')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Benchmark')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values ('r', 'o', 'u', 'w', 'bulk-upload', 'completed', 'embed', '{}'::jsonb)`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
    select 'd' || i, 'o', 'u', 'w', 'r', i || '.pdf', 'application/pdf', i::text, 'completed'
    from generate_series(1, 20) i`;
  await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
    select 'c' || i, 'd' || (1 + i % 20), 'r', 'u', i,
      (select string_agg(md5(i::text || ':' || j::text), ' ') from generate_series(1, 32) j)
    from generate_series(1, 20000) i`;
  const source = readFileSync(new URL("../../src/services/workspace-board-telemetry.ts", import.meta.url), "utf8");
  const candidate = source.split('const rows = await sql<WorkspaceBoardSummaryRow[]>`')[1].split('`;')[0]
    .replace('${sql.json(workspaceIds)}', `'["w"]'`)
    .replace('${attributedUsage(null)}', 'usage_attribution');
  const baseline = candidate
    .replace('sum(docs.chunk_text_bytes)', 'sum(octet_length(c.text))')
    .replace('sum(docs.stored_page_text_bytes)', 'sum(octet_length(p.text))')
    .replace('as chunk_bytes\n      from documents docs', 'as chunk_bytes\n      from documents docs\n      join document_chunks c on c.document_id = docs.id')
    .replace('as page_bytes\n      from documents docs', 'as page_bytes\n      from documents docs\n      join document_pages p on p.document_id = docs.id');
  const runs: Array<{ pair: number; arm: string; ms: number }> = [];
  for (let pair = -1; pair < 5; pair++) {
    const order = pair % 2 === 0 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    const outputs: Record<string, unknown> = {};
    for (const arm of order) {
      const start = performance.now();
      outputs[arm] = Array.from(await sql.unsafe(arm === 'baseline' ? baseline : candidate));
      if (pair >= 0) runs.push({ pair, arm, ms: performance.now() - start });
    }
    deepStrictEqual(outputs.candidate, outputs.baseline);
  }
  const legacyMigration = readFileSync(new URL("../migrations/0063_document_chunk_page_counters.sql", import.meta.url), "utf8");
  const legacyInsert = legacyMigration.split("--> statement-breakpoint").find(statement => statement.includes("CREATE OR REPLACE FUNCTION count_document_chunks_inserted()"))!;
  const insertRuns: Array<{ pair: number; arm: string; ms: number }> = [];
  for (let pair = -1; pair < 5; pair++) {
    for (const arm of pair % 2 === 0 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      try {
        await sql.begin(async (tx) => {
          if (arm === 'baseline') await tx.unsafe(legacyInsert);
          const start = performance.now();
          await tx`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
            select 'insert-benchmark-' || i, 'd' || (1 + i % 20), 'r', 'u', 20000 + i,
              (select string_agg(md5(i::text || ':' || j::text), ' ') from generate_series(1, 32) j)
            from generate_series(1, 2000) i`;
          if (pair >= 0) insertRuns.push({ pair, arm, ms: performance.now() - start });
          throw new Error('benchmark rollback');
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'benchmark rollback') throw error;
      }
    }
  }
  const [bytes] = await sql`select sum(chunk_text_bytes)::text as bytes, sum(chunk_count)::text as chunks from documents`;
  console.log(JSON.stringify({ runtime: process.version, fixture: { documents: 20, ...bytes }, outputEqual: true, runs, insertRuns }, null, 2));
  for (const [arm, query] of [['baseline', baseline], ['candidate', candidate]]) {
    console.log(JSON.stringify({ arm, plan: await sql.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query) }));
  }
} finally { await sql.end(); await database.stop(); }
