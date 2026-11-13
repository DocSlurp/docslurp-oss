/**
 * Native search scope bench: a synthetic project of DOCS documents (CHUNKS chunks each)
 * in a throwaway, migrated Postgres database and a local LanceDB directory.
 *
 *   DATABASE_URL=postgres://…/docslurp_bench LANCEDB_URI=/path/to/dir \
 *     pnpm --filter @docslurp/server exec tsx scripts/perf-search/scope-bench.ts
 *
 * Measures, per search (vector leg, and the BM25 leg), the cached eligible set plus the
 * LanceDB query, as the native path runs them:
 * - "before": IN-list prefilter of every document, no documentId index, every run_events
 *   hint reloads the eligible set (SEARCH_LANCE_SCOPE_EXCLUDE_MAX=0, SEARCH_ELIGIBLE_DEBOUNCE_MS=0);
 * - "after": NOT IN the known out-of-scope documents (none for an unfiltered search) plus the
 *   documentId guard, a documentId BTREE, and debounced run_events hints;
 * each idle and while a run_events hint fires every HINT_MS (a bulk ingest), and the cost of
 * one eligible-set reload. Also a small filtered scope (10 documents) with and without the index.
 * Never point it at a database you care about: it inserts DOCS documents.
 */
import * as lancedb from "@lancedb/lancedb";
import { VectorNamespaceManager, resolveLanceDbConfig } from "@docslurp/shared";
import postgres from "postgres";

const DOCS = Number(process.env.DOCS ?? 10_000);
const CHUNKS = Number(process.env.CHUNKS ?? 4);
const DIM = Number(process.env.DIM ?? 768);
const QUERIES = Number(process.env.QUERIES ?? 60);
const HINT_MS = Number(process.env.HINT_MS ?? 100);
const MODEL = "bench/embed";
const ORG = "bench-org";
const PROJECT = "bench-project";
const WORDS = ["pump", "valve", "seal", "torque", "bearing", "gasket", "filter", "impeller", "coupling", "flange", "rotor", "shaft", "earnings", "expansion", "harbor", "orbit"];

let seed = 11;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const vector = () => Array.from({ length: DIM }, () => rand() - 0.5);
const quantile = (values: number[], q: number) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0; };
const fmt = (values: number[]) => `p50 ${quantile(values, 0.5).toFixed(1)} ms, p95 ${quantile(values, 0.95).toFixed(1)} ms`;

const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

async function seedPostgres(): Promise<void> {
  const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from documents where project_id = ${PROJECT}`;
  if (count >= DOCS) return;
  await sql`insert into "user"(id,name,email) values ('bench-user','Bench','bench@example.test') on conflict do nothing`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values (${ORG},'Bench','bench-org','bench-user') on conflict do nothing`;
  await sql`insert into projects(id,org_id,user_id,name) values (${PROJECT},${ORG},'bench-user','Bench') on conflict do nothing`;
  await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage) values ('bench-run',${ORG},'bench-user',${PROJECT},'upload','completed','completed') on conflict do nothing`;
  await sql`insert into documents(id,user_id,org_id,project_id,run_id,filename,mime_type,source_key,status,page_count,chunk_count)
    select 'bench-doc-' || i, 'bench-user', ${ORG}, ${PROJECT}, 'bench-run', 'doc-' || i || '.pdf', 'application/pdf', 'k' || i, 'completed', 3, ${CHUNKS}
    from generate_series(0, ${DOCS - 1}) i on conflict do nothing`;
  await sql`insert into vector_indexes(id,document_id,backend,bucket,path,embedding_model,dimension)
    select 'bench-vi-' || i, 'bench-doc-' || i, 'lancedb', 'b', 'p', ${MODEL}, ${DIM} from generate_series(0, ${DOCS - 1}) i on conflict do nothing`;
}

async function openTable(): Promise<lancedb.Table> {
  const location = VectorNamespaceManager.getEmbeddingLocation(resolveLanceDbConfig().root, ORG, PROJECT, MODEL, DIM);
  const db = await lancedb.connect(location.uri);
  if ((await db.tableNames()).includes(location.table)) return await db.openTable(location.table);
  const rows = [];
  for (let d = 0; d < DOCS; d += 1) for (let c = 0; c < CHUNKS; c += 1) {
    rows.push({ id: `bench-doc-${d}-${c}`, documentId: `bench-doc-${d}`, chunkIndex: c, text: Array.from({ length: 40 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" "), vector: vector() });
  }
  const table = await db.createTable(location.table, rows);
  await table.createIndex("vector", { config: lancedb.Index.hnswSq({ distanceType: "l2", numPartitions: 1 }) });
  await table.createIndex("text", { config: lancedb.Index.fts({ withPosition: false }) });
  return table;
}

type Mode = { label: string; excludeMax: string; debounceMs: string };

async function main(): Promise<void> {
  await seedPostgres();
  const table = await openTable();
  const eligible = await import("../../src/search/eligible-documents.js");
  const lance = await import("../../src/search/lancedb.js");
  const queries = Array.from({ length: QUERIES }, () => vector());
  const terms = Array.from({ length: QUERIES }, (_, i) => `${WORDS[i % WORDS.length]} ${WORDS[(i * 7 + 3) % WORDS.length]}`);

  const reload: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    eligible.invalidateSearchProject(PROJECT);
    const started = performance.now();
    await eligible.loadEligibleDocuments({ projectId: PROJECT, embeddingModel: MODEL, dimension: DIM });
    reload.push(performance.now() - started);
  }
  console.log(`eligible-set reload (${DOCS} documents): ${fmt(reload)}`);

  async function search(i: number, leg: "vector" | "fts", scope?: string[]): Promise<{ ms: number; ids: string[] }> {
    const started = performance.now();
    const set = await eligible.loadEligibleDocuments({ projectId: PROJECT, embeddingModel: MODEL, dimension: DIM });
    const documentIds = scope ?? set.documents.filter((document) => document.vectorReady).map((document) => document.id);
    const excludedDocumentIds = eligible.excludedTableDocuments(set, documentIds);
    const hits = leg === "vector"
      ? await lance.lanceDbVectorSearch({ orgId: ORG, projectId: PROJECT, embeddingModel: MODEL, queryVector: queries[i % QUERIES]!, documentIds, excludedDocumentIds, limit: 20, hydrate: true })
      : (await lance.lanceDbFullTextSearch({ orgId: ORG, projectId: PROJECT, embeddingModel: MODEL, dimension: DIM, query: terms[i % QUERIES]!, documentIds, excludedDocumentIds, limit: 20 })).hits;
    return { ms: performance.now() - started, ids: hits.map((hit) => hit.id) };
  }

  async function run(mode: Mode, leg: "vector" | "fts", hints: boolean, scope?: (i: number) => string[]): Promise<string[][]> {
    process.env.SEARCH_LANCE_SCOPE_EXCLUDE_MAX = mode.excludeMax;
    process.env.SEARCH_ELIGIBLE_DEBOUNCE_MS = mode.debounceMs;
    eligible.resetEligibleDocumentCachesForTests();
    let reloads = 0;
    eligible.onSearchProjectInvalidated({ invalidate: () => { reloads += 1; }, active: () => false });
    for (let i = 0; i < 5; i += 1) await search(i, leg, scope?.(i)); // warm
    reloads = 0;
    const timer = hints ? setInterval(() => eligible.invalidateSearchProjectDebounced(PROJECT), HINT_MS) : null;
    const times: number[] = [];
    const results: string[][] = [];
    try {
      for (let i = 0; i < QUERIES; i += 1) {
        const { ms, ids } = await search(i, leg, scope?.(i));
        times.push(ms);
        results.push(ids);
      }
    } finally {
      if (timer) clearInterval(timer);
    }
    console.log(`${leg.padEnd(6)} ${mode.label.padEnd(7)} ${hints ? `hints/${HINT_MS}ms` : "idle     "} ${scope ? "10-doc scope" : "full scope  "}: ${fmt(times)}${hints ? `, set drops ${reloads}` : ""}`);
    return results;
  }

  const before: Mode = { label: "before", excludeMax: "0", debounceMs: "0" };
  const after: Mode = { label: "after", excludeMax: "256", debounceMs: "1000" };
  const small = (i: number) => Array.from({ length: 10 }, (_, k) => `bench-doc-${(i * 97 + k * 13) % DOCS}`);
  const hasDocIndex = async () => (await table.listIndices()).some((index) => index.columns.includes("documentId"));
  if (await hasDocIndex()) throw new Error("start from a table without the documentId index (delete LANCEDB_URI)");

  const exact: Record<string, string[][]> = {};
  for (const leg of ["vector", "fts"] as const) {
    exact[leg] = await run(before, leg, false);
    await run(before, leg, true);
    await run(before, leg, false, small);
  }
  await table.createIndex("documentId", { config: lancedb.Index.btree() });
  lance.resetLanceDbConnectionForTests();
  console.log("-- documentId BTREE created --");
  for (const leg of ["vector", "fts"] as const) {
    await run(before, leg, false);
    await run(before, leg, false, small);
    const planned = await run(after, leg, false);
    await run(after, leg, true);
    const overlap = planned.reduce((sum, ids, i) => sum + ids.filter((id) => exact[leg]![i]!.includes(id)).length, 0) / planned.reduce((sum, ids) => sum + ids.length, 0);
    console.log(`${leg} top-20 overlap after vs before: ${(overlap * 100).toFixed(1)}%`);
  }
  table.close();
  await sql.end();
  process.exit(0);
}

await main();
