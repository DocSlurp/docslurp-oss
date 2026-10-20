import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Sql } from "postgres";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { Store } from "../db/store.js";
import type { MapDraft } from "../deferred/siphon-agent.js";
import { DocumentMapStage, mapCoverage, type DocumentMapOps } from "../stages/document-map.js";
import type { Document } from "../models.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { makeTestPdf, type TestPdfOptions } from "../test/make-outline-pdf.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
let store: Store;
let dir: string;

const BODY = "The committee reviewed the quarterly findings in detail and agreed on the next steps.";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "document-map-"));
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 1);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('d1', 'o1', 'u1', 'w', 'run-1', 'a.pdf', 'application/pdf', 'k1', 'processing', 30);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
  sql = (store as unknown as { sql: Sql }).sql;
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.exec(`delete from document_maps; delete from document_pages; delete from document_page_states; update documents set metadata = '{}'::jsonb;`);
});

function document(pageCount: number): Document {
  return { id: "d1", userId: "u1", runId: "run-1", filename: "a.pdf", mimeType: "application/pdf", sourceKey: "k1", status: "processing", extractionMode: "auto", pageCount, createdAt: new Date(), updatedAt: new Date() } as Document;
}

async function setup(options: TestPdfOptions, texts: string[], extra: { pipeline?: Record<string, unknown>; materialization?: Record<string, unknown>; ops?: Partial<DocumentMapOps>; deps?: Record<string, unknown> } = {}) {
  const file = path.join(dir, `t-${Math.random().toString(36).slice(2)}.pdf`);
  await writeFile(file, makeTestPdf(options));
  const calls: Array<[number, number]> = [];
  const decide = vi.fn();
  const usage = new PipelineUsageEventLedger();
  const stage = new DocumentMapStage(
    { get: async () => ({ path: file }) } as never, {} as never, {} as never,
    { openRouterApiKey: "k", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.04 } as unknown as Config,
    {
      sql: () => sql,
      pageEmbedder: null,
      ...extra.deps,
      ops: {
        extractText: async (_p, first, last) => { calls.push([first, last]); return Array.from({ length: last - first + 1 }, (_, i) => texts[first + i - 1] ?? ""); },
        decide,
        ...extra.ops,
      },
    },
  );
  const state = {
    run: { id: "run-1", orgId: "o1", userId: "u1", workspaceId: "w", pipeline: { ...defaultPipelineFeatures, ...extra.pipeline, materialization: extra.materialization ?? {} } },
    usageLedger: usage, documents: [], store: undefined,
  } as never;
  return { stage, state, calls, decide, usage };
}

const bodyPages = (n: number, footer: (p: number) => string | null) =>
  Array.from({ length: n }, (_, i) => `${BODY} Page ${i + 1}.${footer(i + 1) ? `\n\n${footer(i + 1)}` : ""}`);

describe("DocumentMapStage", () => {
  it("maps a born-digital outline with zero model calls and two pdftotext calls", async () => {
    const texts = bodyPages(30, () => null);
    const { stage, state, calls, decide, usage } = await setup({
      pages: texts,
      outline: [
        { title: "Introduction", page: 1 }, { title: "Methods", page: 11, children: [{ title: "Sampling", page: 13 }] }, { title: "Results", page: 21 },
      ],
      pageLabels: [[0, { style: "r", start: 1 }], [2, { style: "D", start: 1 }]],
    }, texts);

    const built = await stage.mapDocument(state, document(30));

    const top = built.nodes.filter((n) => n.parentId === null);
    expect(top.map((n) => [n.title, n.physicalStart, n.physicalEnd])).toEqual([["Introduction", 1, 10], ["Methods", 11, 20], ["Results", 21, 30]]);
    expect(built.nodes.find((n) => n.title === "Sampling")).toMatchObject({ parentId: expect.any(String), physicalStart: 13, physicalEnd: 20, source: "outline" });
    expect(built.coverage).toBe(1);
    expect(built.labelSource).toBe("pdf-page-labels");
    expect(calls).toEqual([[1, 15], [16, 30]]);
    expect(decide).not.toHaveBeenCalled();
    const events = usage.snapshot();
    expect(events.filter((e) => e.metric !== "page-mapped")).toEqual([]);
    expect(events.find((e) => e.metric === "page-mapped")).toMatchObject({ amount: 30, unit: "page" });

    const map = (await db.query<{ coverage: number; nodes: unknown[]; hit: boolean }>(
      `select coverage, nodes, search_text @@ plainto_tsquery('simple', 'methods') as hit from document_maps where document_id = 'd1'`)).rows[0]!;
    expect(map.coverage).toBe(1);
    expect(map.nodes).toHaveLength(4);
    expect(map.hit).toBe(true);
    const page5 = (await db.query<{ page_label: string; label_source: string; mapped: boolean }>(
      `select page_label, label_source, mapped from document_page_states where document_id='d1' and page_number = 5`)).rows[0]!;
    expect(page5).toEqual({ page_label: "3", label_source: "pdf-page-labels", mapped: true });
    const meta = (await db.query<{ metadata: { mapTitle?: string } }>(`select metadata from documents where id='d1'`)).rows[0]!;
    expect(meta.metadata.mapTitle).toBe("Introduction");
  });

  it("builds nodes from dotted-leader TOC text and calibrates printed pages", async () => {
    const toc = ["Contents", "Introduction ........ 1", "Methods . . . . . . 11", "Results ........ 21", "Appendix ........ 28"].join("\n");
    const texts = ["Cover page of the annual report with enough characters to count as text.", `${toc}\n${BODY}`, ...bodyPages(28, () => null).map((t, i) => `${t}\n\n${i + 1}`)];
    const { stage, state, decide } = await setup({ pages: texts }, texts);

    const built = await stage.mapDocument(state, document(30));

    expect(built.nodes.map((n) => [n.title, n.source, n.physicalStart, n.physicalEnd])).toEqual([
      ["Introduction", "toc-text", 3, 12], ["Methods", "toc-text", 13, 22], ["Results", "toc-text", 23, 29], ["Appendix", "toc-text", 30, 30],
    ]);
    expect(built.labelSource).toBe("ocr-calibrated");
    expect(built.segments[0]).toMatchObject({ offset: 2, style: "arabic" });
    expect(built.coverage).toBeCloseTo(28 / 30);
    expect(decide).not.toHaveBeenCalled();
  });

  it("reports coverage for a scanned document and does not siphon when agent discovery is off", async () => {
    const texts = Array.from({ length: 30 }, () => "");
    const ocr = vi.fn();
    const { stage, state, decide, usage } = await setup({ pages: texts }, texts, { materialization: { allowAgentDiscovery: false }, ops: { ocrPages: ocr } });

    const built = await stage.mapDocument(state, document(30));

    expect(built.bornDigital).toBe(false);
    expect(built.coverage).toBe(0);
    expect(built.siphon).toBeNull();
    expect(decide).not.toHaveBeenCalled();
    expect(ocr).not.toHaveBeenCalled();
    expect(usage.snapshot().filter((e) => e.metric !== "page-mapped")).toEqual([]);
    const row = (await db.query<{ coverage: number }>(`select coverage from document_maps where document_id='d1'`)).rows[0]!;
    expect(row.coverage).toBe(0);
  });

  it("siphons a scanned document within budget, recording usage", async () => {
    const texts = Array.from({ length: 100 }, () => "");
    const ocr = vi.fn(async ({ first, last }: { first: number; last: number }) => ({ pageTexts: Array.from({ length: last - first + 1 }, (_, i) => `OCR page ${first + i}`), costCents: 0 }));
    const { stage, state, decide, usage } = await setup({ pages: texts }, texts, { ops: { ocrPages: ocr as never } });
    decide.mockImplementation(async (args: { usage: (u: unknown) => void }) => {
      args.usage({ provider: "openrouter", model: "m", metric: "document-map-siphon", inputTokens: 500, outputTokens: 80, amount: 1, unit: "window" });
      const extracted: MapDraft = { nodes: [{ id: "x", title: "Overview", level: 1, parentId: null, printedStart: null, printedEnd: null, physicalStart: 2, physicalEnd: null, source: "agent", confidence: 0.6 }], terms: [] };
      return { decision: { action: "stop", reason: "done" }, extracted };
    });

    const built = await stage.mapDocument(state, document(100));

    expect(ocr).toHaveBeenCalledTimes(1);
    expect(built.siphon?.pagesRead.length).toBeLessThanOrEqual(5);
    expect(built.nodes).toMatchObject([{ title: "Overview", source: "agent", physicalStart: 2, physicalEnd: 100 }]);
    expect(usage.snapshot().some((e) => e.metric === "document-map-siphon" && e.inputTokens === 500)).toBe(true);
  });

  it("writes plain page text for pages the map does not cover", async () => {
    const texts = bodyPages(30, () => null);
    const mid = await setup({ pages: texts, outline: [{ title: "Middle", page: 10 }, { title: "Next", page: 12 }] }, texts);
    const built = await mid.stage.mapDocument(mid.state, document(30));
    expect(built.coverage).toBeLessThan(0.85);
    const parsed = await db.query<{ n: number }>(`select count(*)::int as n from document_pages where document_id='d1'`);
    expect(parsed.rows[0]!.n).toBe(9); // pages 1-9 precede the first node
    const states = await db.query<{ n: number }>(`select count(*)::int as n from document_page_states where document_id='d1' and state='parsed'`);
    expect(states.rows[0]!.n).toBe(9);
  });
});

describe("DocumentMapStage coarse text layer PII", () => {
  const SSN = "123-45-6789";
  const run = async (action: "block_indexing" | "redact_artifacts" | "flag_for_review") => {
    const texts = bodyPages(30, () => null);
    texts[1] = `${texts[1]} SSN ${SSN}`;
    const t = await setup({ pages: texts, outline: [{ title: "Middle", page: 10 }, { title: "Next", page: 12 }] }, texts, {
      pipeline: { piiPolicy: { enabled: true, patterns: ["ssn"], action, allowlistPatterns: [] } },
    });
    await t.stage.mapDocument(t.state, document(30));
  };

  it("does not write or index a blocked page and marks it blocked-pii", async () => {
    await run("block_indexing");
    const pages = await db.query<{ page_number: number }>(`select page_number from document_pages where document_id='d1' order by page_number`);
    expect(pages.rows.map((r) => r.page_number)).not.toContain(2);
    expect(pages.rows).toHaveLength(8);
    const [state] = (await db.query<{ state: string }>(`select state from document_page_states where document_id='d1' and page_number=2`)).rows;
    expect(state!.state).toBe("blocked-pii");
  });

  it("writes redacted text under redact_artifacts", async () => {
    await run("redact_artifacts");
    const [row] = (await db.query<{ text: string }>(`select text from document_pages where document_id='d1' and page_number=2`)).rows;
    expect(row!.text).not.toContain(SSN);
    expect(row!.text).toContain("committee");
  });

  it("uses the page-index id scheme so materialization upserts over the coarse row", async () => {
    await run("flag_for_review");
    const ids = await db.query<{ id: string }>(`select id from document_pages where document_id='d1' and page_number in (1,2) order by page_number`);
    expect(ids.rows.map((r) => r.id)).toEqual(["d1-page-0001", "d1-page-0002"]);
  });
});

describe("DocumentMapStage coarse visual layer", () => {
  it("embeds uncovered pages of a scanned document and leaves covered pages alone", async () => {
    await db.exec(`delete from document_page_vectors`);
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#ccc" } }).png().toBuffer();
    const embedImages = vi.fn(async (images: unknown[]) => ({ vectors: images.map(() => [1, 0, 0, 0]), inputTokens: images.length * 10, costCents: 0 }));
    const embedder = { provider: "test", model: "fake-embed", dims: 4, embedImages } as never;
    const rendered: number[][] = [];
    const rasters = { renderSelectedPages: async ({ pageNumbers }: { pageNumbers: number[] }) => {
      rendered.push(pageNumbers);
      return pageNumbers.map((pageNumber) => ({ pageNumber, artifactKey: `k${pageNumber}`, cacheHit: true }));
    } };
    const storage = { getBytes: async () => new Uint8Array(png), deleteKeys: async () => undefined };
    const texts = Array.from({ length: 30 }, () => "");
    const { stage, state } = await setup({ pages: texts }, texts, {
      pipeline: { visualPages: { route: "auto", coarseFallback: true } },
      materialization: { allowAgentDiscovery: true },
      ops: { ocrPages: (async ({ first, last }: { first: number; last: number }) => ({ pageTexts: Array.from({ length: last - first + 1 }, () => "ocr"), costCents: 0 })) as never,
        decide: (async () => ({ decision: { action: "stop", reason: "done" }, extracted: { nodes: [{ id: "x", title: "Chapter", level: 1, parentId: null, printedStart: null, printedEnd: null, physicalStart: 25, physicalEnd: null, source: "agent", confidence: 0.6 }], terms: [] } })) as never },
      deps: { pageEmbedder: embedder, pageEmbedIo: { rasters, storage } },
    });
    const built = await stage.mapDocument(state, document(30));
    expect(built.coverage).toBeLessThan(0.85);
    const rows = await db.query<{ page_number: number }>(`select page_number from document_page_vectors where document_id='d1' order by page_number`);
    const pages = rows.rows.map((r) => r.page_number);
    expect(pages.length).toBeGreaterThan(0);
    const covered = new Set<number>();
    for (const n of built.nodes) for (let p = n.physicalStart!; p <= (n.physicalEnd ?? n.physicalStart!); p++) covered.add(p);
    expect(pages.some((p) => covered.has(p))).toBe(false);
    expect(pages.length + covered.size).toBe(30);
  });
});

describe("DocumentMapStage coarse visual layer opt-in", () => {
  it("makes zero embedder calls for a low-coverage scanned document unless coarseFallback is on", async () => {
    const embedImages = vi.fn(async (images: unknown[]) => ({ vectors: images.map(() => [1, 0, 0, 0]), inputTokens: 10, costCents: 0 }));
    const embedder = { provider: "test", model: "fake-embed", dims: 4, embedImages } as never;
    const renderSelectedPages = vi.fn(async () => []);
    const storage = { getBytes: async () => new Uint8Array(), deleteKeys: async () => undefined };
    const texts = Array.from({ length: 30 }, () => "");
    for (const pipeline of [{}, { visualPages: { route: "auto", coarseFallback: false } }]) {
      const { stage, state } = await setup({ pages: texts }, texts, {
        pipeline, materialization: { allowAgentDiscovery: false },
        deps: { pageEmbedder: embedder, pageEmbedIo: { rasters: { renderSelectedPages }, storage } },
      });
      const built = await stage.mapDocument(state, document(30));
      expect(built.bornDigital).toBe(false);
      expect(built.coverage).toBeLessThan(0.85);
    }
    expect(embedImages).not.toHaveBeenCalled();
    expect(renderSelectedPages).not.toHaveBeenCalled();
  });
});

describe("DocumentMapStage coarse layer failure", () => {
  it("keeps the persisted map when page embedding throws", async () => {
    const embedder = { provider: "test", model: "fake-embed", dims: 4, embedImages: async () => { throw new Error("embed down"); } } as never;
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#ccc" } }).png().toBuffer();
    const rasters = { renderSelectedPages: async ({ pageNumbers }: { pageNumbers: number[] }) => pageNumbers.map((pageNumber) => ({ pageNumber, artifactKey: `k${pageNumber}`, cacheHit: true })) };
    const storage = { getBytes: async () => new Uint8Array(png), deleteKeys: async () => undefined };
    const texts = Array.from({ length: 30 }, () => "");
    const { stage, state } = await setup({ pages: texts }, texts, {
      pipeline: { visualPages: { route: "auto", coarseFallback: true } },
      materialization: { allowAgentDiscovery: false },
      deps: { pageEmbedder: embedder, pageEmbedIo: { rasters, storage } },
    });
    const built = await stage.mapDocument(state, document(30));
    expect(built.coverage).toBe(0);
    const row = await db.query<{ n: number }>(`select count(*)::int as n from document_maps where document_id='d1'`);
    expect(row.rows[0]!.n).toBe(1);
  });
});

describe("DocumentMapStage fix round 1", () => {
  const roman = (n: number) => ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"][n - 1]!;

  it("siphons a born-digital PDF without an outline when the TOC regexes miss, using sampled pages", async () => {
    const texts = bodyPages(30, () => null);
    texts[1] = `Contents\nIntroduction    1\nMethods    11\nResults    21\n${BODY}`;
    const { stage, state, calls, decide } = await setup({ pages: texts }, texts);
    decide.mockImplementation(async (args: { observation: { startPage: number; endPage: number; pageTexts: string[] }; usage: (u: unknown) => void }) => {
      args.usage({ provider: "openrouter", model: "m", metric: "document-map-siphon", inputTokens: 400, outputTokens: 60, amount: 1, unit: "window" });
      const extracted: MapDraft = { nodes: [{ id: "x", title: "Methods", level: 1, parentId: null, printedStart: "11", printedEnd: null, physicalStart: 11, physicalEnd: null, source: "agent", confidence: 0.6 }], terms: [] };
      return { decision: { action: "stop", reason: "done" }, extracted };
    });

    const built = await stage.mapDocument(state, document(30));

    expect(decide).toHaveBeenCalled();
    const first = decide.mock.calls[0]![0] as { observation: { startPage: number; pageTexts: string[] } };
    expect(first.observation.pageTexts.join("\n")).toContain("Introduction    1");
    expect(built.nodes.map((n) => n.title)).toContain("Methods");
    expect(calls.slice(0, 2)).toEqual([[1, 15], [16, 30]]);
  });

  it("resolves arabic TOC entries after a long roman preface using a middle-of-book sample", async () => {
    const toc = ["Contents", "Chapter One ........ 1", "Chapter Two ........ 8", "Chapter Three ........ 15"].join("\n");
    const texts = bodyPages(40, (p) => (p <= 20 ? roman(p) : String(p - 20)));
    texts[2] = `${toc}\n${BODY}\n\niii`;
    const { stage, state, calls, decide } = await setup({ pages: texts }, texts);
    decide.mockResolvedValue({ decision: { action: "stop", reason: "done" }, extracted: { nodes: [], terms: [] } });

    const built = await stage.mapDocument(state, document(40));

    expect(built.labelSource).toBe("ocr-calibrated");
    expect(built.nodes.map((n) => [n.title, n.physicalStart])).toEqual([["Chapter One", 21], ["Chapter Two", 28], ["Chapter Three", 35]]);
    expect(calls.slice(0, 3)).toEqual([[1, 15], [26, 40], [18, 22]]);
  });

  it("widens instead of dropping entries when no label evidence exists", async () => {
    const toc = ["Contents", "Alpha Topic ........ 5", "Beta Topic ........ 12", "Gamma Topic ........ 20"].join("\n");
    const texts = bodyPages(30, () => null);
    texts[1] = `${toc}\n${BODY}`;
    const { stage, state } = await setup({ pages: texts }, texts);

    const built = await stage.mapDocument(state, document(30));

    expect(built.labelSource).toBe("none");
    expect(built.nodes.map((n) => [n.title, n.physicalStart])).toEqual([["Alpha Topic", 2], ["Beta Topic", 9], ["Gamma Topic", 17]]);
    const stored = (await db.query<{ nodes: Array<Record<string, unknown>> }>(`select nodes from document_maps where document_id='d1'`)).rows[0]!.nodes;
    expect(Object.keys(stored[0]!).sort()).toEqual(["confidence", "id", "level", "parentId", "physicalEnd", "physicalStart", "printedEnd", "printedStart", "source", "title"]);
  });

  it("degrades to text-only mapping when the PDF structure cannot be read", async () => {
    const toc = ["Contents", "Alpha Topic ........ 5", "Beta Topic ........ 12", "Gamma Topic ........ 20"].join("\n");
    const texts = bodyPages(30, () => null);
    texts[1] = `${toc}\n${BODY}`;
    const { stage, state } = await setup({ pages: texts }, texts, { ops: { readStructure: async () => { throw new Error("encrypted"); } } });
    const built = await stage.mapDocument(state, document(30));
    expect(built.nodes).toHaveLength(3);
  });
});

describe("mapCoverage", () => {
  it("is the covered share of pages", () => {
    const node = (s: number, e: number) => ({ id: "x", title: "t", level: 1, parentId: null, printedStart: null, printedEnd: null, physicalStart: s, physicalEnd: e, source: "outline" as const, confidence: 1 });
    expect(mapCoverage([node(1, 5), node(4, 10)], 20)).toBe(0.5);
    expect(mapCoverage([], 20)).toBe(0);
  });
});
