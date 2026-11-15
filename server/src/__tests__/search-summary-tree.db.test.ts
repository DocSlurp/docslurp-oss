import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import {
  LANCEDB_SUMMARIES_TABLE,
  SUMMARY_TREE_INCLUDE_CONTEXT_SHARE,
  normalizePipelineFeatures,
  resolveEmbeddingRoute,
  summaryTreeGuideSlots,
  summaryTreeSummarySchema,
  VectorNamespaceManager,
} from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The summary-tree retrieval leg (search/summary-tree.ts) against migrated Postgres and real local LanceDB tables.
 * Summary rows and tree state are seeded directly (`seedTree`): nothing here builds a summary or calls a model.
 *
 * Geometry: the query vector is the first basis vector. A chunk or summary is "hot" by how much of that vector it
 * carries, so each test knows the chunk legs' ranking and which summary is nearest without any embedding call.
 */
vi.mock("../lib/ai.js", async (original) => ({
  ...await original<typeof import("../lib/ai.js")>(),
  resolveOpenRouterApiKey: () => undefined,
  generateOpenRouterText: () => { throw new Error("Unexpected inference"); },
}));

/** Every read of a summaries table goes through this wrapper: counted, and slowed or failed on request. */
const summaryReads = vi.hoisted(() => ({ calls: [] as Array<{ projectId: string; documentIds: string[] }>, delayMs: 0, fail: false }));
vi.mock("../search/lancedb.js", async (original) => {
  const actual = await original<typeof import("../search/lancedb.js")>();
  return {
    ...actual,
    lanceDbSummarySearch: async (...args: Parameters<typeof actual.lanceDbSummarySearch>) => {
      summaryReads.calls.push({ projectId: args[0].projectId, documentIds: [...args[0].documentIds] });
      if (summaryReads.fail) throw new Error("summaries table unavailable");
      if (summaryReads.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, summaryReads.delayMs));
      return actual.lanceDbSummarySearch(...args);
    },
  };
});

const statements: string[] = [];
let sql: postgres.Sql;
let stop: () => Promise<void>;
let pglite: Awaited<ReturnType<typeof startMigratedPostgres>>["db"];
let lanceDir: string;
let search: typeof import("../services/search.js");
let eligible: typeof import("../search/eligible-documents.js");
let lance: typeof import("../search/lancedb.js");
let session: typeof import("../search/session.js");
let controls: typeof import("../services/search-controls.js");
let tree: typeof import("../search/summary-tree.js");

const route = resolveEmbeddingRoute(normalizePipelineFeatures(null).embedding);
const DIM = route.dimensions;
const SCOPE = { orgId: "org1", projectIds: "org", modeCeiling: null } as const;
const TREE_PIPELINE = normalizePipelineFeatures({ embed: true, indexVectors: true, summaryTree: { enabled: true } } as never);
const PLAIN_PIPELINE = normalizePipelineFeatures({ embed: true, indexVectors: true } as never);

/** A unit vector with `heat` of the query direction and the rest on its own axis. */
let axis = 1;
function vector(heat = 0): number[] {
  const out = new Array<number>(DIM).fill(0);
  out[0] = heat;
  out[axis] = Math.sqrt(1 - heat * heat);
  axis = axis + 1 < DIM ? axis + 1 : 1;
  return out;
}
const QUERY = (() => { const out = new Array<number>(DIM).fill(0); out[0] = 1; return out; })();

type ChunkRow = { id: string; documentId: string; chunkIndex: number; text: string; vector: number[] };
type SummaryRow = { id: string; documentId: string; runId: string; level: number; chunkStart: number; chunkEnd: number; pageStart: number; pageEnd: number; headingPath: string; text: string; vector: number[] };
const chunkRows = new Map<string, ChunkRow[]>();
const summaryRows = new Map<string, SummaryRow[]>();
const projectKey = (orgId: string, projectId: string) => `${orgId}/${projectId}`;

const FILLER = "the committee reviewed quarterly expansion plans and approved the budget for new offices across the region";

async function seedDocument(args: {
  orgId: string; projectId: string; userId: string; id: string; chunks: number; runId?: string;
  /** Heat of each chunk by index; others are cold. */
  hot?: Record<number, number>;
  text?: Record<number, string>;
}): Promise<void> {
  const runId = args.runId ?? `run-${args.projectId}`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status)
    values (${args.id}, ${args.orgId}, ${args.userId}, ${args.projectId}, ${runId}, ${`${args.id}.pdf`}, 'application/pdf', ${`k-${args.id}`}, 'completed')`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values (${`vi-${args.id}`}, ${args.id}, 'lancedb', 'b', 'p', ${route.model}, ${DIM})`;
  const rows = chunkRows.get(projectKey(args.orgId, args.projectId)) ?? [];
  for (let index = 0; index < args.chunks; index += 1) {
    const id = `${args.id}-${index}`;
    const text = args.text?.[index] ?? `${args.id} passage ${index}: ${FILLER}`;
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
      values (${id}, ${args.id}, ${runId}, ${args.userId}, ${index}, ${text}, ${["Section"]}, ${1 + Math.floor(index / 4)}, 24, ${sql.json({ overlapIndex: 0, pageNumbers: [1 + Math.floor(index / 4)] })})`;
    rows.push({ id, documentId: args.id, chunkIndex: index, text, vector: vector(args.hot?.[index] ?? 0) });
  }
  chunkRows.set(projectKey(args.orgId, args.projectId), rows);
}

type NodeSeed = { id: string; level?: number; chunkStart: number; chunkEnd: number; heat?: number; text?: string; registered?: boolean; rowRunId?: string };

/**
 * The seeding helper the tests share: a document's tree state row, its node registry rows and its rows in the
 * project's summaries table, as the build stage will leave them.
 */
async function seedTree(args: {
  orgId: string; projectId: string; documentId: string; nodes: NodeSeed[];
  status?: "pending" | "building" | "partial" | "ready" | "skipped"; runId?: string;
}): Promise<void> {
  const runId = args.runId ?? `run-${args.projectId}`;
  await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, embedding_model, dimension, node_count, built_at)
    values (${args.documentId}, ${args.orgId}, ${args.projectId}, ${runId}, ${args.status ?? "ready"}, ${route.model}, ${DIM}, ${args.nodes.length}, now())`;
  const rows = summaryRows.get(projectKey(args.orgId, args.projectId)) ?? [];
  for (const [ordinal, node] of args.nodes.entries()) {
    if (node.registered !== false) {
      await sql`insert into document_summary_tree_nodes (id, document_id, org_id, project_id, run_id, node_hash, level, ordinal, status, chunk_start, chunk_end, page_start, page_end)
        values (${node.id}, ${args.documentId}, ${args.orgId}, ${args.projectId}, ${runId}, ${`hash-${node.id}`}, ${node.level ?? 1}, ${ordinal}, 'ready', ${node.chunkStart}, ${node.chunkEnd}, 1, 2)`;
    }
    rows.push({
      id: node.id, documentId: args.documentId, runId: node.rowRunId ?? runId, level: node.level ?? 1,
      chunkStart: node.chunkStart, chunkEnd: node.chunkEnd, pageStart: 1, pageEnd: 2, headingPath: "Part One > Growth",
      text: node.text ?? `Summary ${node.id}: the section describes record growth and a new office opening in the region`,
      vector: vector(node.heat ?? 0),
    });
  }
  summaryRows.set(projectKey(args.orgId, args.projectId), rows);
}

/** (Re)writes every project's chunks and summaries tables from the seeded rows. */
async function writeLanceTables(): Promise<void> {
  for (const [key, rows] of chunkRows) {
    const [orgId, projectId] = key.split("/") as [string, string];
    const location = VectorNamespaceManager.getEmbeddingLocation(lanceDir, orgId, projectId, route.model, DIM);
    const db = await lancedb.connect(location.uri);
    if ((await db.tableNames()).includes(location.table)) await db.dropTable(location.table);
    (await db.createTable(location.table, rows.map((row) => ({ ...row })))).close();
    const summaries = summaryRows.get(key);
    if ((await db.tableNames()).includes(LANCEDB_SUMMARIES_TABLE)) await db.dropTable(LANCEDB_SUMMARIES_TABLE);
    if (summaries?.length) (await db.createTable(LANCEDB_SUMMARIES_TABLE, summaries.map((row) => ({ ...row })))).close();
    db.close();
  }
  lance.resetLanceDbConnectionForTests();
}

async function seedProject(orgId: string, projectId: string, userId: string, pipeline: unknown = TREE_PIPELINE): Promise<void> {
  await sql`insert into projects (id, org_id, user_id, name, pipeline) values (${projectId}, ${orgId}, ${userId}, ${projectId}, ${sql.json(pipeline as postgres.JSONValue)})`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values (${`run-${projectId}`}, ${orgId}, ${userId}, ${projectId}, 'bulk-upload', 'completed', 'completed', '{}')`;
}

/** Five section nodes over 40 chunks and a root; `hotNode` is the section nearest the query. */
function sectionNodes(documentId: string, hotNode = 3, heat = 0.9): NodeSeed[] {
  return [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `${documentId}-n${index}`, chunkStart: index * 8, chunkEnd: index * 8 + 7, heat: index === hotNode ? heat : 0 })),
    { id: `${documentId}-root`, level: 2, chunkStart: 0, chunkEnd: 39, heat: 0.4 },
  ];
}

beforeAll(async () => {
  lanceDir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "docslurp-summary-tree-search-"));
  vi.stubEnv("LANCEDB_URI", lanceDir);
  const database = await startMigratedPostgres();
  stop = database.stop;
  pglite = database.db;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {}, debug: (_connection, query) => { statements.push(query); } });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'tree@example.test'), ('v', 'Other', 'tree-other@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org1', 'Org', 'tree-one', 'u'), ('org2', 'Other', 'tree-two', 'v')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('org1', 'u', 'owner'), ('org2', 'v', 'owner')`;
  await seedProject("org1", "w", "u");
  await seedProject("org1", "w2", "u");
  await seedProject("org2", "x", "v");
  await seedProject("org1", "plain", "u", PLAIN_PIPELINE);

  // docB: the chunk legs' top ten for the query, in order docB-0 … docB-9.
  await seedDocument({ orgId: "org1", projectId: "w", userId: "u", id: "docB", chunks: 12,
    hot: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index, 0.95 - index * 0.01])) });
  // docA: cold chunks, so only the tree can surface them. Its section 24..31 is the nearest summary.
  await seedDocument({ orgId: "org1", projectId: "w", userId: "u", id: "docA", chunks: 40,
    text: { 29: `docA passage 29: turbine cavitation erosion appears in this passage ${FILLER}` } });
  await seedTree({ orgId: "org1", projectId: "w", documentId: "docA", nodes: [
    ...sectionNodes("docA"),
    // A summaries-table row no registry row vouches for (a build that never committed it).
    { id: "docA-orphan", chunkStart: 8, chunkEnd: 15, heat: 0.99, registered: false },
  ] });
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values ('run-old', 'org1', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}')`;
  // Chunk rows of an older run inside the hot range: never served.
  for (const index of [24, 25, 26]) {
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
      values (${`docA-old-${index}`}, 'docA', 'run-old', 'u', ${index}, 'OLD RUN TEXT', ${["Section"]}, 1, 4, ${sql.json({ overlapIndex: 0 })})`;
  }
  // An overlap chunk and a table-row chunk inside the range repeat text other chunks carry: not guided.
  await sql`update document_chunks set metadata = ${sql.json({ overlapIndex: 1 })} where id = 'docA-24'`;
  await sql`update document_chunks set metadata = ${sql.json({ overlapIndex: 0, tableGranularity: "row" })} where id = 'docA-25'`;

  // docD: one chunk hotter than all of docB and no tree, for results that span files.
  await seedDocument({ orgId: "org1", projectId: "w", userId: "u", id: "docD", chunks: 2, hot: { 0: 0.96 } });
  // Documents each destructive test owns.
  for (const id of ["docDel", "docSup", "docCor", "docPartial", "docStale", "docC"]) {
    await seedDocument({ orgId: "org1", projectId: "w", userId: "u", id, chunks: 40 });
  }
  await seedTree({ orgId: "org1", projectId: "w", documentId: "docDel", nodes: sectionNodes("docDel", 1, 0.97) });
  await seedTree({ orgId: "org1", projectId: "w", documentId: "docSup", nodes: sectionNodes("docSup", 1, 0.97) });
  await seedTree({ orgId: "org1", projectId: "w", documentId: "docCor", nodes: sectionNodes("docCor", 1, 0.97) });
  await seedTree({ orgId: "org1", projectId: "w", documentId: "docPartial", status: "partial", nodes: sectionNodes("docPartial", 1, 0.97) });
  // The tree is ready for the current run, but the table still holds the previous run's rows.
  await seedTree({ orgId: "org1", projectId: "w", documentId: "docStale", nodes: sectionNodes("docStale", 1, 0.97).map((node) => ({ ...node, rowRunId: "run-old" })) });
  await seedTree({ orgId: "org1", projectId: "w", documentId: "docC", nodes: sectionNodes("docC", 2, 0.8) });

  // The same content in another project of the organization, and in another organization.
  await seedDocument({ orgId: "org1", projectId: "w2", userId: "u", id: "docW2", chunks: 40 });
  await seedTree({ orgId: "org1", projectId: "w2", documentId: "docW2", nodes: sectionNodes("docW2", 3, 0.999) });
  await seedDocument({ orgId: "org2", projectId: "x", userId: "v", id: "docX", chunks: 40 });
  await seedTree({ orgId: "org2", projectId: "x", documentId: "docX", nodes: sectionNodes("docX", 3, 0.999) });
  // Foreign rows planted in project w's own summaries table: another project's and another organization's document.
  summaryRows.get(projectKey("org1", "w"))!.push(
    { id: "planted-w2", documentId: "docW2", runId: "run-w2", level: 1, chunkStart: 24, chunkEnd: 31, pageStart: 1, pageEnd: 2, headingPath: "", text: "PLANTED other project", vector: vector(0.9999) },
    { id: "planted-x", documentId: "docX", runId: "run-x", level: 1, chunkStart: 24, chunkEnd: 31, pageStart: 1, pageEnd: 2, headingPath: "", text: "PLANTED other organization", vector: vector(0.9999) },
  );
  // A project that never enabled the tree, with rows a search must never read.
  await seedDocument({ orgId: "org1", projectId: "plain", userId: "u", id: "docPlain", chunks: 40 });
  await seedTree({ orgId: "org1", projectId: "plain", documentId: "docPlain", nodes: sectionNodes("docPlain", 3, 0.9) });

  search = await import("../services/search.js");
  eligible = await import("../search/eligible-documents.js");
  lance = await import("../search/lancedb.js");
  session = await import("../search/session.js");
  controls = await import("../services/search-controls.js");
  tree = await import("../search/summary-tree.js");
  // One result per file is the project default; these tests turn it off except where they test it.
  for (const [projectId, userId] of [["w", "u"], ["x", "v"], ["plain", "u"]] as const) await setDefault(projectId, userId, {}, { dedupeByFilename: false });
  await writeLanceTables();
}, 240_000);

afterEach(async () => {
  await session.drainSearchSessionWrites();
  vi.unstubAllEnvs();
  vi.stubEnv("LANCEDB_URI", lanceDir);
  eligible.resetEligibleDocumentCachesForTests();
  tree.observeSummaryTreeLegs(null);
  summaryReads.calls.length = 0;
  summaryReads.delayMs = 0;
  summaryReads.fail = false;
});

afterAll(async () => {
  await sql?.end();
  await stop?.();
  lance?.resetLanceDbConnectionForTests();
  if (lanceDir) await rm(lanceDir, { recursive: true, force: true });
});

const baseOptions = {
  limit: 10, minScore: 0, useRerank: false, queryRewrite: false, selfQuery: false, parentRetrieval: false,
  useContextualCompression: false, useHyDE: false, stepback: false, iterativeMultiHop: false, useMmr: false,
  enableGraphExpansion: false, enableCommunityExpansion: false, queryVector: QUERY,
};

type RunOptions = Record<string, unknown> & { serve?: boolean; projectId?: string; userId?: string; scope?: unknown; query?: string; documentIds?: string[] };
async function run(options: RunOptions = {}) {
  const { serve = true, projectId = "w", userId = "u", scope = SCOPE, query = "qqqzzz", documentIds, ...rest } = options;
  vi.stubEnv("DOCSLURP_SUMMARY_TREE_SERVE", serve ? "on" : "off");
  const response = await search.hybridSearch(query, userId, {
    ...baseOptions, ...rest, filters: { projectId, ...(documentIds ? { documentIds } : {}), ...(rest.filters as object ?? {}) },
  } as never, scope as never);
  await session.drainSearchSessionWrites();
  return response;
}

const MAIN = ["docA", "docB"];
const ids = (response: Awaited<ReturnType<typeof run>>) => response.results.map((result) => `${result.citation.documentId}-${result.citation.chunkIndex}`);
const documentsOf = (response: Awaited<ReturnType<typeof run>>) => new Set(response.results.map((result) => result.citation.documentId));
/** A response without what differs between any two searches. */
function stable(response: Awaited<ReturnType<typeof run>>) {
  const { sessionId: _sessionId, timings: _timings, usageEvents: _usage, ...rest } = response as unknown as Record<string, unknown>;
  return JSON.parse(JSON.stringify(rest));
}
async function setDefault(projectId: string, userId: string, patch: Record<string, unknown>, top: Record<string, unknown> = {}): Promise<void> {
  const current = await controls.getProjectSearchSettings(projectId, userId);
  await controls.upsertProjectSearchSettings({ ...current, ...top, retrievalDefaults: { ...current.retrievalDefaults, ...patch } } as never);
}

describe("summary tree: guide", () => {
  it("returns real chunks only, placed after the chunk legs' protected prefix", async () => {
    const off = await run({ documentIds: MAIN });
    expect(ids(off)).toEqual(Array.from({ length: 10 }, (_, index) => `docB-${index}`));
    expect(off).not.toHaveProperty("summaryTree");
    expect(summaryReads.calls).toHaveLength(0);

    const guide = await run({ documentIds: MAIN, summaryTree: "guide" });
    const slots = summaryTreeGuideSlots(10);
    expect(slots).toBe(3);
    // The chunk legs' first seven results keep their positions; the tree's chunks take the last three.
    expect(ids(guide).slice(0, 10 - slots)).toEqual(ids(off).slice(0, 10 - slots));
    // Section 24..31 is the nearest summary. 24 is an overlap chunk and 25 a table row: not guided.
    expect(ids(guide).slice(10 - slots)).toEqual(["docA-26", "docA-27", "docA-28"]);
    expect(guide.results).toHaveLength(10);
    for (const result of guide.results) {
      expect(result.citation.source).toBe("document");
      expect(result.text).not.toMatch(/^Summary |OLD RUN|PLANTED/);
    }
    expect(guide.results.map((result) => result.score)).toEqual(Array.from({ length: 10 }, (_, index) => 1 / (1 + index)));
    expect(guide.summaryTree).toMatchObject({ requested: "guide", applied: "guide" });
    expect(guide.summaryTree).not.toHaveProperty("skipped");
    expect(guide).not.toHaveProperty("summaries");
    expect(guide.timings?.summaryTreeMs).toBeGreaterThanOrEqual(0);
    expect(guide.timings?.summaryTreeSkipped).toBeUndefined();
  });

  it("reads the summaries table once, scoped to the ready documents, and Postgres once", async () => {
    await run({ documentIds: MAIN, summaryTree: "guide" }); // warm
    summaryReads.calls.length = 0;
    statements.length = 0;
    const guide = await run({ documentIds: MAIN, summaryTree: "guide" });
    // docB has no tree: the prefilter is exactly the in-scope documents Postgres reports a ready tree for.
    expect(summaryReads.calls).toEqual([{ projectId: "w", documentIds: ["docA"] }]);
    expect(guide.timings?.summaryTreeFetch).toBe(1);
    expect(statements.filter((statement) => statement.includes("document_summary_tree_nodes"))).toHaveLength(1);
    // The eligible set is cached: no other statement names the tree tables.
    expect(statements.filter((statement) => statement.includes("document_summary_trees"))).toHaveLength(1);
  });

  it("picks the chunks of a range that match the query words", async () => {
    const guide = await run({ documentIds: ["docA"], summaryTree: "guide", query: "cavitation erosion", limit: 10 });
    expect(ids(guide)).toContain("docA-29");
    expect(guide.summaryTree).toMatchObject({ applied: "guide" });
  });

  it("uses the project's retrieval default, and the request's value over it", async () => {
    await setDefault("w", "u", { summaryTree: "guide" });
    try {
      const byDefault = await run({ documentIds: MAIN });
      expect(byDefault.summaryTree).toMatchObject({ requested: "guide", applied: "guide" });
      expect(ids(byDefault).slice(7)).toEqual(["docA-26", "docA-27", "docA-28"]);
      const overridden = await run({ documentIds: MAIN, summaryTree: "off" });
      expect(overridden).not.toHaveProperty("summaryTree");
      expect(ids(overridden)).toEqual(Array.from({ length: 10 }, (_, index) => `docB-${index}`));
    } finally {
      await setDefault("w", "u", { summaryTree: "off" });
    }
  });

  it("one result per file: never changes whether that control collapses the results", async () => {
    await setDefault("w", "u", {}, { dedupeByFilename: true });
    try {
      // Every chunk-leg result is from one file, so the control leaves all ten. A guided chunk from another file would
      // make it keep one result per file and drop nine of them: it is not placed.
      const off = await run({ documentIds: MAIN });
      expect(ids(off)).toEqual(Array.from({ length: 10 }, (_, index) => `docB-${index}`));
      const guide = await run({ documentIds: MAIN, summaryTree: "guide" });
      expect(guide.summaryTree).toMatchObject({ applied: "guide" });
      expect(ids(guide)).toEqual(ids(off));

      // Results that already span files are collapsed with or without the tree. The tree's chunk is then the result
      // of a file the top results do not cover: one chunk, never a second from the same file.
      const spanning = ["docA", "docB", "docD"];
      expect(ids(await run({ documentIds: spanning }))).toEqual(["docD-0", "docB-0"]);
      expect(ids(await run({ documentIds: spanning, summaryTree: "guide" }))).toEqual(["docD-0", "docB-0", "docA-26"]);

      // A tree of the file the results already come from guides within it, as without the control.
      const sameFileOff = await run({ documentIds: ["docA"] });
      const sameFile = await run({ documentIds: ["docA"], summaryTree: "guide" });
      expect(sameFile.results).toHaveLength(10);
      expect(ids(sameFile).slice(0, 7)).toEqual(ids(sameFileOff).slice(0, 7));
    } finally {
      await setDefault("w", "u", {}, { dedupeByFilename: false });
    }
  });
});

describe("summary tree: include", () => {
  it("returns labelled summaries beside chunk results, capped to the context share", async () => {
    const guide = await run({ documentIds: MAIN, summaryTree: "guide" });
    const include = await run({ documentIds: MAIN, summaryTree: "include" });
    expect(include.summaryTree).toMatchObject({ requested: "include", applied: "include" });
    // The results are the guide's: summaries never take a result position.
    expect(ids(include)).toEqual(ids(guide));
    const summaries = include.summaries!;
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0]).toMatchObject({ kind: "summary", id: "docA-n3", documentId: "docA", filename: "docA.pdf", level: 1, chunkStart: 24, chunkEnd: 31, headingPath: ["Part One", "Growth"] });
    for (const summary of summaries) {
      expect(summaryTreeSummarySchema.safeParse(summary).success).toBe(true);
      // Never shaped like a result: no text to quote, no citation to cite.
      expect(summary).not.toHaveProperty("text");
      expect(summary).not.toHaveProperty("citation");
      expect(summary.documentId).toBe("docA");
      expect(summary.id).not.toBe("docA-orphan");
    }
    const { estimateTextTokens } = await import("../search/token-estimate.js");
    const summaryTokens = summaries.reduce((sum, summary) => sum + estimateTextTokens(summary.summary), 0);
    const resultTokens = include.results.reduce((sum, result) => sum + estimateTextTokens(result.text), 0);
    expect(summaryTokens / (summaryTokens + resultTokens)).toBeLessThanOrEqual(SUMMARY_TREE_INCLUDE_CONTEXT_SHARE);
    // Six valid nodes matched; the cap kept fewer than all of them.
    expect(summaries.length).toBeLessThan(6);
    // No summary text ever appears as a result.
    for (const result of include.results) expect(result.text).not.toMatch(/^Summary /);
  });
});

describe("summary tree: tenant boundary", () => {
  it("never serves another project's or organization's nodes, even planted in this project's table", async () => {
    const include = await run({ summaryTree: "include" });
    expect(include.summaryTree).toMatchObject({ applied: "include" });
    for (const call of summaryReads.calls) {
      expect(call.projectId).toBe("w");
      expect(call.documentIds).not.toContain("docW2");
      expect(call.documentIds).not.toContain("docX");
      expect(call.documentIds).not.toContain("docPartial");
    }
    expect([...documentsOf(include)].filter((id) => id === "docW2" || id === "docX" || id === "docPlain")).toEqual([]);
    for (const summary of include.summaries ?? []) {
      expect(["docW2", "docX", "docPlain"]).not.toContain(summary.documentId);
      expect(summary.summary).not.toMatch(/PLANTED/);
    }
    // The other organization searches its own project and gets only its own nodes.
    summaryReads.calls.length = 0;
    const other = await run({ projectId: "x", userId: "v", scope: { orgId: "org2", projectIds: "org", modeCeiling: null }, summaryTree: "include" });
    expect(summaryReads.calls).toEqual([{ projectId: "x", documentIds: ["docX"] }]);
    expect([...documentsOf(other)]).toEqual(["docX"]);
    expect(other.summaries!.every((summary) => summary.documentId === "docX")).toBe(true);
  });

  it("refuses a caller whose scope does not cover the project, before any node is read", async () => {
    // Another organization's scope, and this organization's scope narrowed to a different project.
    await expect(run({ scope: { orgId: "org2", projectIds: "org", modeCeiling: null }, userId: "v", summaryTree: "include" })).rejects.toThrow();
    await expect(run({ scope: { orgId: "org1", projectIds: ["w2"], modeCeiling: null }, summaryTree: "include" })).rejects.toThrow();
    // A user of another organization with this organization's scope object.
    await expect(run({ userId: "v", summaryTree: "include" })).rejects.toThrow();
    expect(summaryReads.calls).toHaveLength(0);
  });

  it("holds a keyword-scoped key to keyword mode: the tree is not read", async () => {
    const response = await run({ documentIds: MAIN, summaryTree: "guide", scope: { orgId: "org1", projectIds: "org", modeCeiling: "keyword" } });
    expect(response.summaryTree).toMatchObject({ requested: "guide", applied: "off", skipped: "mode" });
    expect(summaryReads.calls).toHaveLength(0);
  });

  it("serves no node of a document deleted while every cache is warm and no hint arrived", async () => {
    const scope = ["docDel", "docB"];
    const before = await run({ documentIds: scope, summaryTree: "include" });
    expect(documentsOf(before)).toContain("docDel");
    expect(before.summaries!.some((summary) => summary.documentId === "docDel")).toBe(true);

    // The delete cascades the tree rows and chunks in Postgres; the summaries table still holds the rows (no sweep),
    // and nothing drops the cached eligible set (the notification is not delivered here).
    await sql`delete from documents where id = 'docDel'`;
    summaryReads.calls.length = 0;
    const after = await run({ documentIds: scope, summaryTree: "include" });
    // The cached set still named the document, so its rows came back from the table…
    expect(summaryReads.calls).toEqual([{ projectId: "w", documentIds: ["docDel"] }]);
    // …and the request-time Postgres check dropped every one of them.
    expect(after.timings?.summaryTreeInvalidDropped).toBe(1);
    expect(documentsOf(after)).not.toContain("docDel");
    expect(after.summaries).toEqual([]);
    expect(JSON.stringify(after.results)).not.toContain("docDel");
    expect(after.summaryTree).toMatchObject({ applied: "include" });
  });

  it("serves no node of a superseded document, warm or cold", async () => {
    const scope = ["docSup", "docB"];
    expect(documentsOf(await run({ documentIds: scope, summaryTree: "include" }))).toContain("docSup");
    await sql`update documents set superseded_at = now() where id = 'docSup'`;
    const warm = await run({ documentIds: scope, summaryTree: "include" });
    expect(documentsOf(warm)).not.toContain("docSup");
    expect(warm.summaries).toEqual([]);
    eligible.resetEligibleDocumentCachesForTests();
    summaryReads.calls.length = 0;
    const cold = await run({ documentIds: scope, summaryTree: "include" });
    // With a fresh eligible set the table is not even read.
    expect(summaryReads.calls).toHaveLength(0);
    expect(cold.summaryTree).toMatchObject({ applied: "off", skipped: "not-ready" });
    expect(cold).not.toHaveProperty("summaries");
  });

  it("serves no node of a corrected document, also when its tree was finished after the correction", async () => {
    const scope = ["docCor", "docB"];
    expect(documentsOf(await run({ documentIds: scope, summaryTree: "include" }))).toContain("docCor");
    // The correction reindex completed before the tree's `built_at`: the build was still running, or was retried,
    // resumed or backfilled afterwards. It read the run's extraction, not the corrected chunks.
    await sql`insert into document_corrections (id, document_id, run_id, user_id, corrected_markdown, reindex_completed_at)
      values ('cor1', 'docCor', 'run-w', 'u', 'fixed', now() - interval '1 minute')`;
    await sql`update document_summary_trees set built_at = now() where document_id = 'docCor'`;
    // Warm: the cached eligible set still says the tree is ready; the request-time check refuses every node.
    const warm = await run({ documentIds: scope, summaryTree: "include" });
    expect(documentsOf(warm)).not.toContain("docCor");
    expect(warm.summaries).toEqual([]);
    // Cold: the document is not a candidate and the table is not read.
    eligible.resetEligibleDocumentCachesForTests();
    summaryReads.calls.length = 0;
    const cold = await run({ documentIds: scope, summaryTree: "include" });
    expect(cold.summaryTree).toMatchObject({ applied: "off", skipped: "not-ready" });
    expect(cold).not.toHaveProperty("summaries");
    expect(summaryReads.calls).toHaveLength(0);
    // Building again later, with the chunk vectors reindexed too, changes nothing.
    await sql`update document_summary_trees set built_at = now() + interval '2 minutes' where document_id = 'docCor'`;
    await sql`update vector_indexes set created_at = now() + interval '2 minutes' where document_id = 'docCor'`;
    eligible.resetEligibleDocumentCachesForTests();
    const rebuilt = await run({ documentIds: scope, summaryTree: "include" });
    expect(documentsOf(rebuilt)).not.toContain("docCor");
    expect(rebuilt.summaryTree).toMatchObject({ applied: "off", skipped: "not-ready" });
    // A correction that was saved but never reindexed replaced no chunk and withdraws nothing.
    await sql`update document_corrections set reindex_completed_at = null where document_id = 'docCor'`;
    eligible.resetEligibleDocumentCachesForTests();
    expect(documentsOf(await run({ documentIds: scope, summaryTree: "include" }))).toContain("docCor");
  });

  it("does not serve partial, building, pending or skipped trees", async () => {
    for (const status of ["partial", "building", "pending", "skipped"]) {
      await sql`update document_summary_trees set status = ${status} where document_id = 'docPartial'`;
      eligible.resetEligibleDocumentCachesForTests();
      summaryReads.calls.length = 0;
      const response = await run({ documentIds: ["docPartial", "docB"], summaryTree: "include" });
      expect([status, response.summaryTree?.applied, response.summaryTree?.skipped]).toEqual([status, "off", "not-ready"]);
      expect(summaryReads.calls).toHaveLength(0);
      expect(documentsOf(response)).not.toContain("docPartial");
      expect(response.timings?.summaryTreeSkipped).toBe(1);
    }
    // A tree that stops being ready while the eligible set is cached: the Postgres check still refuses its nodes.
    await sql`update document_summary_trees set status = 'ready' where document_id = 'docPartial'`;
    eligible.resetEligibleDocumentCachesForTests();
    expect(documentsOf(await run({ documentIds: ["docPartial", "docB"], summaryTree: "guide" }))).toContain("docPartial");
    await sql`update document_summary_trees set status = 'building' where document_id = 'docPartial'`;
    const warm = await run({ documentIds: ["docPartial", "docB"], summaryTree: "include" });
    expect(documentsOf(warm)).not.toContain("docPartial");
    expect(warm.summaries).toEqual([]);
  });

  it("drops rows whose runId is not the document's current run, and a tree of another embedding space", async () => {
    const stale = await run({ documentIds: ["docStale", "docB"], summaryTree: "include" });
    expect(summaryReads.calls).toEqual([{ projectId: "w", documentIds: ["docStale"] }]);
    expect(stale.timings?.summaryTreeStaleDropped).toBe(1);
    // Every hit was stale, so Postgres was not asked about any.
    expect(stale.timings?.summaryTreeFetch).toBeUndefined();
    expect(documentsOf(stale)).not.toContain("docStale");
    expect(stale.summaries).toEqual([]);

    // A tree recorded for another embedding space is not ready for this search.
    await sql`update document_summary_trees set dimension = ${DIM + 1} where document_id = 'docC'`;
    try {
      eligible.resetEligibleDocumentCachesForTests();
      const other = await run({ documentIds: ["docC", "docB"], summaryTree: "guide" });
      expect(other.summaryTree).toMatchObject({ applied: "off", skipped: "not-ready" });
    } finally {
      await sql`update document_summary_trees set dimension = ${DIM} where document_id = 'docC'`;
    }
  });
});

describe("summary tree: the project default is a ceiling for callers who may not change it", () => {
  beforeAll(async () => {
    // Members of the project's organization without edit rights: a plain member the project is shared with as a
    // viewer, and (for contrast) a project editor.
    await sql`insert into "user" (id, name, email) values ('viewer', 'Viewer', 'tree-viewer@example.test'), ('editor', 'Editor', 'tree-editor@example.test')`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('org1', 'viewer', 'member'), ('org1', 'editor', 'member')`;
    await sql`insert into project_members (project_id, user_id, role) values ('w', 'viewer', 'viewer'), ('w', 'editor', 'editor')`;
  });
  afterEach(async () => { await setDefault("w", "u", { summaryTree: "off" }); });

  it("holds a viewer to the stored default: no summaries and no guide above it; an editor may ask for more", async () => {
    // Default off: the viewer's request for `include` or `guide` reads nothing of the tree.
    await setDefault("w", "u", { summaryTree: "off" });
    const plain = await run({ documentIds: MAIN, userId: "viewer" });
    for (const asked of ["include", "guide"] as const) {
      summaryReads.calls.length = 0;
      const refused = await run({ documentIds: MAIN, userId: "viewer", summaryTree: asked });
      expect(refused.summaryTree).toMatchObject({ requested: asked, applied: "off", skipped: "mode" });
      expect(refused).not.toHaveProperty("summaries");
      expect(summaryReads.calls).toHaveLength(0);
      expect(ids(refused)).toEqual(ids(plain));
    }
    // Default guide: `include` runs as guide. Real chunks, and never a summary.
    await setDefault("w", "u", { summaryTree: "guide" });
    const clamped = await run({ documentIds: MAIN, userId: "viewer", summaryTree: "include" });
    expect(clamped.summaryTree).toMatchObject({ requested: "include", applied: "guide" });
    expect(clamped).not.toHaveProperty("summaries");
    expect(documentsOf(clamped)).toContain("docA");
    // Asking for less is always allowed.
    expect((await run({ documentIds: MAIN, userId: "viewer", summaryTree: "off" })).summaryTree).toBeUndefined();
    // Default include: the viewer gets what the project's editors chose to show.
    await setDefault("w", "u", { summaryTree: "include" });
    expect((await run({ documentIds: MAIN, userId: "viewer" })).summaries?.length).toBeGreaterThan(0);

    // An editor and the owner may raise it per request, from any default.
    await setDefault("w", "u", { summaryTree: "off" });
    for (const userId of ["editor", "u"]) {
      const raised = await run({ documentIds: MAIN, userId, summaryTree: "include" });
      expect([userId, raised.summaryTree?.applied]).toEqual([userId, "include"]);
      expect(raised.summaries?.length).toBeGreaterThan(0);
    }
  });

  it("judges an API key by the key: only a server key with projects:manage in the project's organization may raise", async () => {
    const ceiling = await import("../search/summary-tree-ceiling.js");
    const key = async (id: string, orgId: string, userId: string, keyType: string, scopes: string[], revoked = false) => {
      await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes, revoked_at)
        values (${id}, ${userId}, ${orgId}, ${`hash-${id}`}, ${id}, ${keyType}, ${sql.array(scopes)}, ${revoked ? new Date() : null})
        on conflict (id) do nothing`;
      return id;
    };
    // Every key belongs to the owner, who could raise it as a signed-in user: the key's own type and scopes decide.
    const may = (apiKeyId: string | null, userId = "u") => ceiling.callerMayRaiseSummaryTree({ userId, projectId: "w", orgId: "org1", apiKeyId });
    expect(await may(await key("k-manage", "org1", "u", "server", ["projects:manage", "search:deep"]))).toBe(true);
    expect(await may(await key("k-search", "org1", "u", "server", ["search:deep"]))).toBe(false);
    expect(await may(await key("k-chat", "org1", "u", "server", ["chat"]))).toBe(false);
    expect(await may(await key("k-client", "org1", "u", "client", ["projects:manage", "search:deep"]))).toBe(false);
    expect(await may(await key("k-revoked", "org1", "u", "server", ["projects:manage"], true))).toBe(false);
    expect(await may(await key("k-other-org", "org2", "v", "server", ["projects:manage"]))).toBe(false);
    // Not an API key at all (an OAuth token id).
    expect(await may("oauth-token-id")).toBe(false);
    // Signed-in users: edit rights on this project.
    expect(await may(null, "u")).toBe(true);
    expect(await may(null, "editor")).toBe(true);
    expect(await may(null, "viewer")).toBe(false);
    expect(await may(null, "v")).toBe(false);
    expect(ceiling.clampSummaryTreeMode("include", "guide")).toBe("guide");
    expect(ceiling.clampSummaryTreeMode("guide", "include")).toBe("guide");
    expect(ceiling.clampSummaryTreeMode("include", "off")).toBe("off");
    expect(ceiling.knownSummaryTreeMode("always")).toBe("off");
  });
});

describe("summary tree: switches and modes", () => {
  it("serve switch off answers exactly as a project without a tree, and reads nothing", async () => {
    await setDefault("w", "u", { summaryTree: "guide" });
    try {
      statements.length = 0;
      // Project default `guide`, serve switch off.
      const switchedOff = await run({ serve: false, documentIds: MAIN });
      expect(switchedOff).not.toHaveProperty("summaryTree");
      expect(switchedOff).not.toHaveProperty("summaries");
      expect(Object.keys(switchedOff.timings ?? {}).filter((key) => key.startsWith("summaryTree"))).toEqual([]);
      expect(summaryReads.calls).toHaveLength(0);
      // Not even the eligibility query looks at the tree tables.
      expect(statements.filter((statement) => /document_summary_tree/.test(statement))).toEqual([]);

      // The same search with the tree turned off for the project, and the switch on.
      await setDefault("w", "u", { summaryTree: "off" });
      eligible.resetEligibleDocumentCachesForTests();
      const noTree = await run({ documentIds: MAIN });
      expect(JSON.stringify(stable(switchedOff))).toBe(JSON.stringify(stable(noTree)));

      // A request that asks while the switch is off is told so, identically to a project whose pipeline has no tree.
      const asked = await run({ serve: false, documentIds: MAIN, summaryTree: "include" });
      expect(asked.summaryTree).toEqual({ requested: "include", applied: "off", skipped: "mode", ms: 0 });
      expect(asked).not.toHaveProperty("summaries");
      expect(ids(asked)).toEqual(ids(noTree));
      expect(summaryReads.calls).toHaveLength(0);
      const { summaryTree: _field, ...askedRest } = stable(asked);
      expect(JSON.stringify(askedRest)).toBe(JSON.stringify(stable(noTree)));
    } finally {
      await setDefault("w", "u", { summaryTree: "off" });
    }
  });

  it("a project whose pipeline has the tree disabled never reads its summaries table", async () => {
    const asked = await run({ projectId: "plain", summaryTree: "guide" });
    expect(asked.summaryTree).toEqual({ requested: "guide", applied: "off", skipped: "mode", ms: 0 });
    expect(summaryReads.calls).toHaveLength(0);
    expect(asked.timings?.summaryTreeSkipped).toBe(1);
    // A stored retrieval default cannot turn it on either, and then says nothing.
    await setDefault("plain", "u", { summaryTree: "include" });
    try {
      const byDefault = await run({ projectId: "plain" });
      expect(byDefault).not.toHaveProperty("summaryTree");
      expect(summaryReads.calls).toHaveLength(0);
      expect(ids(byDefault)).toEqual(ids(asked));
    } finally {
      await setDefault("plain", "u", { summaryTree: "off" });
    }
  });

  it("keyword mode never touches the summaries table", async () => {
    await setDefault("w", "u", { summaryTree: "guide" });
    try {
      const byDefault = await run({ documentIds: MAIN, searchMode: "keyword", query: "cavitation" });
      expect(byDefault).not.toHaveProperty("summaryTree");
      expect(byDefault.searchMode).toBe("keyword");
      const asked = await run({ documentIds: MAIN, searchMode: "keyword", query: "cavitation", summaryTree: "include" });
      expect(asked.summaryTree).toEqual({ requested: "include", applied: "off", skipped: "mode", ms: 0 });
      expect(ids(asked)).toEqual(ids(byDefault));
      const fanout = await run({ documentIds: MAIN, searchMode: "keyword", query: "cavitation erosion", keywordQueries: ["cavitation", "erosion"] });
      expect(fanout).not.toHaveProperty("summaryTree");
      expect(summaryReads.calls).toHaveLength(0);
    } finally {
      await setDefault("w", "u", { summaryTree: "off" });
    }
  });

  it("runs in hybrid mode, and not for filters the leg cannot honour or outside the native path", async () => {
    expect((await run({ documentIds: MAIN, searchMode: "hybrid", summaryTree: "guide" })).summaryTree).toMatchObject({ applied: "guide" });
    summaryReads.calls.length = 0;
    const pageFiltered = await run({ documentIds: MAIN, summaryTree: "guide", filters: { pageRange: { from: 1, to: 3 } } });
    expect(pageFiltered.summaryTree).toMatchObject({ applied: "off", skipped: "mode" });
    vi.stubEnv("SEARCH_LANCEDB_NATIVE", "0");
    const legacy = await run({ documentIds: MAIN, summaryTree: "guide" });
    expect(legacy.summaryTree).toMatchObject({ applied: "off", skipped: "mode" });
    expect(summaryReads.calls).toHaveLength(0);
  });
});

describe("summary tree: deadline and failure", () => {
  it("contributes nothing when it misses its deadline, and says so", async () => {
    const off = await run({ documentIds: MAIN });
    summaryReads.delayMs = 1_500;
    const samples: Array<{ vectorMs: number; treeMs: number | null; deadlineMs: number; skipped: string | null }> = [];
    tree.observeSummaryTreeLegs((sample) => samples.push(sample));
    const started = performance.now();
    const late = await run({ documentIds: MAIN, summaryTree: "include" });
    const elapsed = performance.now() - started;
    expect(late.summaryTree).toMatchObject({ requested: "include", applied: "off", skipped: "deadline" });
    // No partial guide: exactly the chunk legs' answer.
    expect(ids(late)).toEqual(ids(off));
    expect(late).not.toHaveProperty("summaries");
    expect(late.timings?.summaryTreeSkipped).toBe(1);
    // The abandoned leg never reached its Postgres query, and the search did not wait for it.
    expect(late.timings?.summaryTreeFetch).toBeUndefined();
    expect(elapsed).toBeLessThan(1_400);
    expect(late.summaryTree!.ms).toBeLessThan(1_400);
    // The counter's name must not read as a statement timeout: pollers stop retrying on those (timings.ts).
    const { searchHitStatementTimeout } = await import("../search/timings.js");
    expect(searchHitStatementTimeout(late)).toBe(false);
    // The observer reports the abandoned leg's real time once it settles (the calibration hook).
    await vi.waitFor(() => expect(samples).toHaveLength(1), { timeout: 5_000 });
    expect(samples[0]!.skipped).toBe("deadline");
    expect(samples[0]!.treeMs!).toBeGreaterThan(samples[0]!.deadlineMs);
  });

  it("an error in the leg is a skipped leg, never a failed search", async () => {
    const off = await run({ documentIds: MAIN });
    summaryReads.fail = true;
    const failed = await run({ documentIds: MAIN, summaryTree: "guide" });
    expect(failed.summaryTree).toMatchObject({ requested: "guide", applied: "off", skipped: "error" });
    expect(ids(failed)).toEqual(ids(off));
    expect(failed.timings?.summaryTreeSkipped).toBe(1);
  });

  it("a ready tree whose table is missing is an error skip, not a probe loop", async () => {
    // Postgres says ready; the project database has no summaries table.
    await seedProject("org1", "bare", "u");
    await seedDocument({ orgId: "org1", projectId: "bare", userId: "u", id: "docBare", chunks: 8 });
    await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, embedding_model, dimension, built_at)
      values ('docBare', 'org1', 'bare', 'run-bare', 'ready', ${route.model}, ${DIM}, now())`;
    await writeLanceTables();
    const response = await run({ projectId: "bare", summaryTree: "guide" });
    expect(response.summaryTree).toMatchObject({ applied: "off", skipped: "error" });
    expect(response.timings?.summaryTreeTableMissing).toBe(1);
    expect(response.results.length).toBeGreaterThan(0);
  });
});

/**
 * Local deadline measurement (not a pass/fail test). Every leg is allowed to finish, and the report gives the
 * distribution of the tree leg's time against the vector leg's, the skip rate at the constants in summary-tree.ts,
 * and the smallest grace that keeps skips at or under 1% for a few factors:
 *
 *   SUMMARY_TREE_DEADLINE_MEASURE=1000 SUMMARY_TREE_DEADLINE_OUT=report.json pnpm --filter @docslurp/server exec vitest run src/__tests__/search-summary-tree.db.test.ts -t "deadline factors"
 *
 * This corpus is small and on local disk; the constants are set from the same numbers on production storage, where
 * `[search-timing]` lines carry `vector=`, `summaryTree=` and, for a skipped leg, a `summaryTreeLate` line.
 */
describe("summary tree: deadline factors", () => {
  const rounds = Number(process.env.SUMMARY_TREE_DEADLINE_MEASURE ?? 0);
  it.runIf(rounds > 0)("measures the tree leg against the vector leg", async () => {
    const samples: Array<{ vectorMs: number; treeMs: number }> = [];
    tree.observeSummaryTreeLegs((sample) => samples.push(sample), { ignoreDeadline: true });
    let seed = 5;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let round = 0; round < rounds; round += 1) {
      const queryVector = new Array<number>(DIM).fill(0).map(() => random() - 0.5);
      const norm = Math.hypot(...queryVector);
      await run({ summaryTree: "guide", queryVector: queryVector.map((value) => value / norm) });
    }
    await vi.waitFor(() => expect(samples.length).toBe(rounds), { timeout: 30_000 });
    const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;
    const skipRate = (factor: number, grace: number) => samples.filter((sample) => sample.treeMs > Math.max(sample.vectorMs * factor, sample.vectorMs + grace)).length / samples.length;
    const smallestGrace = (factor: number) => { for (let grace = 0; grace <= 2_000; grace += 5) if (skipRate(factor, grace) <= 0.01) return grace; return null; };
    const { SUMMARY_TREE_DEADLINE_FACTOR: factor, SUMMARY_TREE_DEADLINE_GRACE_MS: grace } = await import("@docslurp/shared");
    const report = {
      searches: samples.length,
      vectorMs: { p50: percentile(samples.map((sample) => sample.vectorMs), 0.5), p95: percentile(samples.map((sample) => sample.vectorMs), 0.95) },
      treeMs: { p50: percentile(samples.map((sample) => sample.treeMs), 0.5), p95: percentile(samples.map((sample) => sample.treeMs), 0.95) },
      treeMinusVectorMs: { p50: percentile(samples.map((sample) => sample.treeMs - sample.vectorMs), 0.5), p95: percentile(samples.map((sample) => sample.treeMs - sample.vectorMs), 0.95), p99: percentile(samples.map((sample) => sample.treeMs - sample.vectorMs), 0.99) },
      treeOverVector: { p50: percentile(samples.map((sample) => sample.treeMs / Math.max(sample.vectorMs, 0.001)), 0.5), p95: percentile(samples.map((sample) => sample.treeMs / Math.max(sample.vectorMs, 0.001)), 0.95), p99: percentile(samples.map((sample) => sample.treeMs / Math.max(sample.vectorMs, 0.001)), 0.99) },
      skipRateAtCurrentConstants: { factor, graceMs: grace, rate: skipRate(factor, grace) },
      smallestGraceMsForOnePercent: Object.fromEntries([1, 1.25, 1.5, 2, 3].map((value) => [value, smallestGrace(value)])),
    };
    const line = `[summary-tree-deadline] ${JSON.stringify(report, (_key, value) => typeof value === "number" ? Math.round(value * 100) / 100 : value)}\n`;
    // Passing tests' console output is not shown, so the report goes to the file named by SUMMARY_TREE_DEADLINE_OUT, else to stderr.
    if (process.env.SUMMARY_TREE_DEADLINE_OUT) await writeFile(process.env.SUMMARY_TREE_DEADLINE_OUT, line);
    else process.stderr.write(line);
    expect(samples.length).toBe(rounds);
  }, 600_000);
});

describe("summaries table access", () => {
  it("refuses without the serve switch, without a document scope, and filters foreign rows", async () => {
    const args = { orgId: "org1", projectId: "w", embeddingModel: route.model, queryVector: QUERY, limit: 10 };
    const actual = await vi.importActual<typeof import("../search/lancedb.js")>("../search/lancedb.js");
    await expect(actual.lanceDbSummarySearch({ ...args, documentIds: ["docA"] }, {})).rejects.toBeInstanceOf(actual.SummariesTargetRefused);
    const on = { DOCSLURP_SUMMARY_TREE_SERVE: "on" };
    await expect(actual.lanceDbSummarySearch({ ...args, documentIds: [] }, on)).rejects.toBeInstanceOf(actual.SummariesTargetRefused);
    await expect(actual.lanceDbSummarySearch({ ...args, orgId: " ", documentIds: ["docA"] }, on)).rejects.toBeInstanceOf(actual.SummariesTargetRefused);
    // The planted rows are the nearest in the table; a scope that does not name their documents never returns them.
    const scoped = await actual.lanceDbSummarySearch({ ...args, documentIds: ["docA"] }, on);
    expect(scoped.status).toBe("ok");
    if (scoped.status === "ok") {
      expect(scoped.hits.length).toBeGreaterThan(0);
      expect(scoped.hits.every((hit) => hit.documentId === "docA")).toBe(true);
      expect(scoped.hits[0]!.id).toBe("docA-orphan");
      expect(scoped.hits[0]).not.toHaveProperty("vector");
    }
    // A hostile id cannot break out of the filter.
    const hostile = await actual.lanceDbSummarySearch({ ...args, documentIds: ["x') OR ('1'='1"] }, on);
    expect(hostile).toEqual({ status: "ok", hits: [] });
  });
});

describe("summary tree readiness hint (migration 0164)", () => {
  it("document_chunks has the (document_id, chunk_index) index", async () => {
    const rows = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'document_chunks' and indexname = 'document_chunks_document_chunk_index_idx'`;
    expect(rows[0]?.indexdef).toMatch(/\(document_id, chunk_index\)/);
  });

  it("sends an immediate hint when a tree stops being servable and a debounced one when it becomes ready", async () => {
    await seedProject("org1", "hint", "u");
    await seedDocument({ orgId: "org1", projectId: "hint", userId: "u", id: "docHint", chunks: 1 });
    // Notifications reach an in-process listener only for statements run in process, so this test writes through
    // the database handle instead of the socket the search code uses.
    const received: Array<Record<string, unknown>> = [];
    const unlisten = await pglite.listen("search_eligibility", (payload) => { received.push(JSON.parse(payload) as Record<string, unknown>); });
    const write = async (statement: string) => { received.length = 0; await pglite.exec(statement); return received.splice(0); };
    try {
      expect(await write(`insert into document_summary_trees (document_id, org_id, project_id, run_id, status) values ('docHint', 'org1', 'hint', 'run-hint', 'building')`)).toEqual([]);
      expect(await write(`update document_summary_trees set status = 'ready', built_at = now() where document_id = 'docHint'`)).toEqual([{ projectIds: ["hint"], debounce: true }]);
      // Other columns of a ready tree: nothing.
      expect(await write(`update document_summary_trees set node_count = 5, updated_at = now() where document_id = 'docHint'`)).toEqual([]);
      expect(await write(`update document_summary_trees set status = 'partial' where document_id = 'docHint'`)).toEqual([{ projectIds: ["hint"] }]);
      expect(await write(`update document_summary_trees set status = 'ready' where document_id = 'docHint'`)).toEqual([{ projectIds: ["hint"], debounce: true }]);
      // A ready tree rebuilt in place, or moved to another run, is withdrawn: its rows are being replaced.
      expect(await write(`update document_summary_trees set built_at = now() + interval '1 second' where document_id = 'docHint'`)).toEqual([{ projectIds: ["hint"] }]);
      expect(await write(`update document_summary_trees set run_id = 'run-other' where document_id = 'docHint'`)).toEqual([{ projectIds: ["hint"] }]);
      expect(await write(`delete from document_summary_trees where document_id = 'docHint'`)).toEqual([{ projectIds: ["hint"] }]);
      // A tree that was never ready leaves without a hint.
      expect(await write(`insert into document_summary_trees (document_id, org_id, project_id, run_id, status) values ('docHint', 'org1', 'hint', 'run-hint', 'partial')`)).toEqual([]);
      expect(await write(`delete from document_summary_trees where document_id = 'docHint'`)).toEqual([]);
      // Deleting a document with a ready tree withdraws it (the cascade fires the tree's trigger as well as the document's).
      await write(`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, built_at) values ('docHint', 'org1', 'hint', 'run-hint', 'ready', now())`);
      expect(await write(`delete from documents where id = 'docHint'`)).toContainEqual({ projectIds: ["hint"] });
    } finally {
      await unlisten();
    }
  });
});
