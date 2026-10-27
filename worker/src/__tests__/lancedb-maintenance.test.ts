import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VectorBackendRecord } from "../stages/embedding-runtime.js";
import {
  DEFAULT_LANCEDB_CADENCE,
  LEGACY_OPTIMIZE_EVERY_ROWS,
  createMaintenanceCoordinator,
  lanceDbFtsIndexEnabled,
  lanceDbMaintenanceDue,
  lanceDbMaintenanceSettings,
  requestLanceDbMaintenance,
  runLanceDbMaintenance,
  type LanceDbCadencePolicy,
} from "../stages/lancedb-maintenance.js";
import * as connection from "../stages/lancedb-connection.js";
import { deleteLanceDbDocumentRows } from "../db/superseded-purge.js";
import {
  DirectMaintenanceCadence,
  chunkFirstPage,
  planPageWindows,
  writeLanceDbDocumentInWindows,
  writeLanceDbRecords,
} from "../stages/lancedb-writer.js";

const DIM = 8;
const vector = (seed: number) => Array.from({ length: DIM }, (_, i) => Math.sin(seed * 7 + i));
const record = (documentId: string, index: number): VectorBackendRecord => ({
  id: `${documentId}-${index.toString().padStart(3, "0")}`,
  documentId,
  chunkIndex: index,
  text: `chunk ${index}`,
  vector: vector(index),
  metadata: { documentId, sourceKey: "k", filename: "f.pdf" },
});

/** Two chunks per page, matching how IndexStage pairs records with chunk pages. */
function documentChunks(documentId: string, pages: number) {
  return Array.from({ length: pages * 2 }, (_, index) => ({
    record: record(documentId, index),
    page: Math.floor(index / 2) + 1,
  }));
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "docslurp-lance-maint-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function withTable<T>(fn: (table: import("@lancedb/lancedb").Table) => Promise<T>): Promise<T> {
  const db = await connect(dir);
  const table = await db.openTable("chunks");
  try { return await fn(table); } finally { table.close(); db.close(); }
}

describe("planPageWindows", () => {
  it("buckets by page, keeps page-less chunks in the current window, and orders windows", () => {
    const items = [
      { id: "a", page: 1 }, { id: "b", page: null }, { id: "c", page: 21 },
      { id: "d", page: null }, { id: "e", page: 3 }, { id: "f", page: 45 },
    ];
    expect(planPageWindows(items, (item) => item.page, 20).map((w) => w.map((item) => item.id)))
      .toEqual([["a", "b", "e"], ["c", "d"], ["f"]]);
    expect(planPageWindows([{ page: null }], (item) => item.page, 20)).toHaveLength(1);
    expect(planPageWindows([], () => 1, 20)).toEqual([]);
  });

  it("reads the first page from pageNumber or pageNumbers", () => {
    expect(chunkFirstPage({ pageNumber: 4, pageNumbers: [2] })).toBe(4);
    expect(chunkFirstPage({ pageNumber: null, pageNumbers: [9, 7] })).toBe(7);
    expect(chunkFirstPage({})).toBeNull();
  });
});

const everyWindow: LanceDbCadencePolicy = { optimizeEveryRows: 1, optimizeEveryCommits: 1, optimizeIntervalMs: 0, optimizeMinIntervalMs: 0 };

describe("lanceDbFtsIndexEnabled", () => {
  it("is on unless LANCEDB_FTS_INDEX turns it off", () => {
    expect(lanceDbFtsIndexEnabled({})).toBe(true);
    expect(lanceDbFtsIndexEnabled({ LANCEDB_FTS_INDEX: "1" })).toBe(true);
    for (const off of ["0", "false", "off", "no"]) expect(lanceDbFtsIndexEnabled({ LANCEDB_FTS_INDEX: off })).toBe(false);
  });
});

describe("lanceDbMaintenanceDue", () => {
  const policy: LanceDbCadencePolicy = { optimizeEveryRows: 100, optimizeEveryCommits: 5, optimizeIntervalMs: 60_000, optimizeMinIntervalMs: 10_000 };
  const at = (rowsSince: number, commitsSince: number, ageMs: number | null) =>
    lanceDbMaintenanceDue({ rowsSince, commitsSince, lastOptimizedAt: ageMs === null ? null : 1_000_000 - ageMs }, policy, 1_000_000);

  it("is never due without new rows", () => {
    expect(at(0, 0, null)).toBe(false);
    expect(at(0, 9, 3_600_000)).toBe(false);
  });

  it("is due on the first write to a table that was never optimized", () => {
    expect(at(1, 1, null)).toBe(true);
  });

  it("triggers on rows, commits or staleness, whichever comes first", () => {
    expect(at(99, 4, 20_000)).toBe(false);
    expect(at(100, 1, 20_000)).toBe(true);
    expect(at(10, 5, 20_000)).toBe(true);
    expect(at(1, 1, 60_000)).toBe(true);
  });

  it("debounces: nothing is due within the minimum interval", () => {
    expect(at(10_000, 500, 9_999)).toBe(false);
    expect(at(10_000, 500, 10_000)).toBe(true);
  });
});

describe("lanceDbMaintenanceSettings cadence knobs", () => {
  it("defaults to background maintenance with the benchmarked cadence", () => {
    expect(lanceDbMaintenanceSettings(new URLSearchParams(), {})).toMatchObject({ mode: "background", ...DEFAULT_LANCEDB_CADENCE });
  });

  it("inline mode restores the old defaults: 20,000-row trigger, 300 s, no consolidation", () => {
    const inline = lanceDbMaintenanceSettings(new URLSearchParams(), { LANCEDB_MAINTENANCE_MODE: "inline", LANCEDB_MAX_INDEX_SEGMENTS: "8" });
    expect(inline).toMatchObject({ mode: "inline", optimizeEveryRows: LEGACY_OPTIMIZE_EVERY_ROWS, optimizeIntervalMs: 300_000, maxIndexSegments: 0 });
    // The old URI knobs still apply.
    expect(lanceDbMaintenanceSettings(new URLSearchParams("optimizeEveryRows=500&maintenanceMode=inline"), {}).optimizeEveryRows).toBe(500);
  });

  it("reads the URI and lets environment variables override it", () => {
    const params = new URLSearchParams("optimizeEveryRows=500&optimizeEveryCommits=7&optimizeMinIntervalSeconds=0&maxIndexSegments=0&maintenanceMode=inline");
    expect(lanceDbMaintenanceSettings(params, {})).toMatchObject({
      mode: "inline", optimizeEveryRows: 500, optimizeEveryCommits: 7, optimizeMinIntervalMs: 0, maxIndexSegments: 0,
    });
    expect(lanceDbMaintenanceSettings(params, {
      LANCEDB_OPTIMIZE_EVERY_ROWS: "9000",
      LANCEDB_OPTIMIZE_INTERVAL_SECONDS: "30",
      LANCEDB_MAX_INDEX_SEGMENTS: "8",
      LANCEDB_CONSOLIDATE_MAX_ROWS: "1000",
      LANCEDB_MAINTENANCE_MODE: "background",
    })).toMatchObject({ mode: "background", optimizeEveryRows: 9_000, optimizeIntervalMs: 30_000, maxIndexSegments: 8, consolidateMaxRows: 1_000 });
    // Garbage falls back to the default rather than disabling the trigger.
    expect(lanceDbMaintenanceSettings(new URLSearchParams(), { LANCEDB_OPTIMIZE_EVERY_ROWS: "lots" }).optimizeEveryRows)
      .toBe(DEFAULT_LANCEDB_CADENCE.optimizeEveryRows);
  });
});

describe("DirectMaintenanceCadence", () => {
  it("requests one run per due burst and resets its counters", () => {
    const cadence = new DirectMaintenanceCadence();
    const policy: LanceDbCadencePolicy = { optimizeEveryRows: 100, optimizeEveryCommits: 3, optimizeIntervalMs: 60_000, optimizeMinIntervalMs: 0 };
    expect(cadence.recordWrite("t", 40, policy, 0)).toBe(true); // first write to the table
    expect(cadence.recordWrite("t", 40, policy, 1)).toBe(false);
    expect(cadence.recordWrite("t", 40, policy, 2)).toBe(false);
    expect(cadence.recordWrite("t", 40, policy, 3)).toBe(true); // 3 commits
    expect(cadence.recordWrite("other", 1, policy, 3)).toBe(true); // per table
    expect(cadence.recordWrite("t", 1, policy, 60_004)).toBe(true); // staleness
  });
});

describe("writeLanceDbDocumentInWindows", () => {
  async function writeDocument(documentId: string, pages: number, cadence: LanceDbCadencePolicy, mode: "background" | "inline" = "background") {
    const write = vi.fn(writeLanceDbRecords);
    const maintain = vi.fn(requestLanceDbMaintenance);
    const schedule = vi.fn(() => true);
    const windows = planPageWindows(documentChunks(documentId, pages), (item) => item.page, 20)
      .map((window) => window.map((item) => item.record));
    const result = await writeLanceDbDocumentInWindows({
      uri: dir, table: "chunks", windows,
      maintenance: { enabled: true, mode, vectorIndexMinRows: 1_000_000, cadence },
      deps: { write, maintain, schedule },
      cadence: new DirectMaintenanceCadence(),
    });
    return { write, maintain, schedule, result };
  }

  it("inline mode is the old behaviour: three windows, each followed by awaited maintenance, whatever the cadence", async () => {
    const { write, maintain, schedule, result } = await writeDocument("doc45", 45, DEFAULT_LANCEDB_CADENCE, "inline");
    expect(result).toEqual({ writes: 3, maintenanceRuns: 3 });
    expect(write.mock.calls.map(([, , rows]) => rows.length)).toEqual([40, 40, 10]);
    expect(maintain).toHaveBeenCalledTimes(3);
    expect(schedule).not.toHaveBeenCalled();
    expect(await withTable((table) => table.countRows())).toBe(90);
  });

  it("inline mode still maintains after a document with no records (one empty window)", async () => {
    const maintain = vi.fn(async () => undefined);
    const result = await writeLanceDbDocumentInWindows({
      uri: dir, table: "chunks", windows: [],
      maintenance: { enabled: true, mode: "inline", vectorIndexMinRows: 1, cadence: DEFAULT_LANCEDB_CADENCE },
      deps: { write: vi.fn(async () => undefined), maintain },
      cadence: new DirectMaintenanceCadence(),
    });
    expect(result).toEqual({ writes: 1, maintenanceRuns: 1 });
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it("background mode follows the cadence: only the first window of a fresh table is due under the defaults", async () => {
    const { maintain, schedule, result } = await writeDocument("doc45", 45, DEFAULT_LANCEDB_CADENCE);
    expect(result).toEqual({ writes: 3, maintenanceRuns: 1 });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(maintain).not.toHaveBeenCalled();
  });

  it("background mode schedules instead of waiting", async () => {
    const { maintain, schedule, result } = await writeDocument("doc5", 5, everyWindow, "background");
    expect(result).toEqual({ writes: 1, maintenanceRuns: 1 });
    expect(maintain).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledWith(dir, "chunks", expect.objectContaining({ vectorIndexMinRows: 1_000_000 }));
  });

  it("skips maintenance when disabled", async () => {
    const maintain = vi.fn(requestLanceDbMaintenance);
    const schedule = vi.fn(() => true);
    const result = await writeLanceDbDocumentInWindows({
      uri: dir, table: "chunks", windows: [[record("d", 0)]],
      maintenance: { enabled: false, vectorIndexMinRows: 1, cadence: everyWindow },
      deps: { maintain, schedule },
      cadence: new DirectMaintenanceCadence(),
    });
    expect(result).toEqual({ writes: 1, maintenanceRuns: 0 });
    expect(maintain).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe("LanceDB maintenance", () => {
  it("coalesces awaited requests made while a run is active into one follow-up run", async () => {
    const coordinator = createMaintenanceCoordinator();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = async () => { runs += 1; if (runs === 1) await gate; };
    const first = coordinator.request("t", task);
    const second = coordinator.request("t", task);
    const third = coordinator.request("t", task);
    expect(second).toBe(third);
    expect(runs).toBe(1);
    release();
    await Promise.all([first, second, third]);
    expect(runs).toBe(2);
    expect(coordinator.activeKeys()).toBe(0);
    await Promise.all([coordinator.request("a", task), coordinator.request("b", async () => { throw new Error("x"); })]);
    expect(runs).toBe(3);
  });

  it.each(["optimize failed", "history prune failed"])("propagates erasure failure (%s) and retries, while ordinary maintenance stays best effort", async (message) => {
    const optimize = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValue({
      compaction: { fragmentsRemoved: 1 }, prune: { oldVersionsRemoved: 1, bytesRemoved: 8 },
    });
    const table = { delete: vi.fn(), optimize, countRows: async () => 0, listIndices: async () => [], close: vi.fn() };
    vi.spyOn(connection, "connectLanceDb").mockResolvedValue({
      tableNames: async () => ["chunks"], openTable: async () => table, close: vi.fn(),
    } as unknown as import("@lancedb/lancedb").Connection);
    const args = { uri: dir, table: "chunks", documentIds: ["erased"], purgeHistory: true };
    await expect(deleteLanceDbDocumentRows(args)).rejects.toThrow(message);
    await expect(deleteLanceDbDocumentRows(args)).resolves.toBeUndefined();
    expect(optimize).toHaveBeenCalledTimes(2);
    expect(optimize.mock.calls[1]![0].cleanupOlderThan).toBeInstanceOf(Date);
    optimize.mockRejectedValueOnce(new Error(message));
    await expect(requestLanceDbMaintenance(dir, "chunks", { vectorIndexMinRows: 100 })).resolves.toBeUndefined();
  });

  it("does not coalesce strict maintenance with pending weaker retention", async () => {
    const coordinator = createMaintenanceCoordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runs: string[] = [];
    const first = coordinator.request("t", async () => { await gate; });
    const ordinary = coordinator.request("t", async () => { runs.push("ordinary"); });
    const strict = coordinator.request("t", async () => { runs.push("strict"); }, false);
    release();
    await Promise.all([first, ordinary, strict]);
    expect(runs).toEqual(["ordinary", "strict"]);
    expect(coordinator.activeKeys()).toBe(0);
  });

  it("optimizes, builds the vector index past the threshold, and keeps search working", async () => {
    for (let doc = 0; doc < 4; doc += 1) {
      await writeLanceDbRecords(dir, "chunks", Array.from({ length: 10 }, (_, i) => record(`d${doc}`, doc * 10 + i)));
    }
    const below = await runLanceDbMaintenance(dir, "chunks", { vectorIndexMinRows: 100 });
    expect(below).toMatchObject({ ok: true, rows: 40, indexCreated: false });

    const above = await runLanceDbMaintenance(dir, "chunks", { vectorIndexMinRows: 40 });
    expect(above).toMatchObject({ ok: true, rows: 40, indexCreated: true });
    await withTable(async (table) => {
      const indices = await table.listIndices();
      expect(indices.find((index) => index.columns.includes("vector"))?.indexType).toBe("IvfHnswSq");
    });

    // Later writes are folded into the existing index instead of rebuilding it.
    await writeLanceDbRecords(dir, "chunks", [record("late", 99)]);
    const again = await runLanceDbMaintenance(dir, "chunks", { vectorIndexMinRows: 40 });
    expect(again).toMatchObject({ ok: true, rows: 41, indexCreated: false });
    await withTable(async (table) => {
      const hits = await table.vectorSearch(vector(99)).column("vector").limit(1).toArray();
      expect(hits[0]?.id).toBe("late-099");
    });
  });

  it("adds one index segment per optimize and consolidates past maxIndexSegments", async () => {
    await writeLanceDbRecords(dir, "chunks", Array.from({ length: 40 }, (_, i) => record("base", i)));
    expect(await runLanceDbMaintenance(dir, "chunks", { vectorIndexMinRows: 40 })).toMatchObject({ indexCreated: true });
    for (let round = 0; round < 3; round += 1) {
      await writeLanceDbRecords(dir, "chunks", [record(`late${round}`, 100 + round)]);
      const result = await runLanceDbMaintenance(dir, "chunks", { vectorIndexMinRows: 40, maxIndexSegments: 4 });
      expect(result).toMatchObject({ ok: true, consolidated: false, indexSegments: round + 2, unindexedRows: 0 });
    }
    // Fragments split by segment boundaries never compact on their own.
    expect(await withTable(async (table) => (await table.stats()).fragmentStats.numFragments)).toBe(4);

    await writeLanceDbRecords(dir, "chunks", [record("late3", 103)]);
    // Above the row cap the rebuild is skipped...
    expect(await runLanceDbMaintenance(dir, "chunks", { vectorIndexMinRows: 40, maxIndexSegments: 4, consolidateMaxRows: 10 }))
      .toMatchObject({ ok: true, consolidated: false, indexSegments: 5 });
    // ...otherwise it collapses the index into one segment and the table into one fragment.
    const consolidated = await runLanceDbMaintenance(dir, "chunks", { vectorIndexMinRows: 40, maxIndexSegments: 4 });
    expect(consolidated).toMatchObject({ ok: true, consolidated: true, indexSegments: 1, unindexedRows: 0, rows: 44 });
    await withTable(async (table) => {
      expect((await table.stats()).fragmentStats.numFragments).toBe(1);
      const hits = await table.vectorSearch(vector(103)).column("vector").limit(1).toArray();
      expect(hits[0]?.id).toBe("late3-103");
    });
  });

  it("swallows failures", async () => {
    const result = await runLanceDbMaintenance(dir, "missing_table", { vectorIndexMinRows: 1 });
    expect(result.ok).toBe(false);
    await expect(requestLanceDbMaintenance(dir, "missing_table", { vectorIndexMinRows: 1 })).resolves.toBeUndefined();
  });

  it("purging a document deletes its rows and compacts the table", async () => {
    await writeLanceDbRecords(dir, "chunks", [record("keep", 1), record("keep", 2)]);
    await writeLanceDbRecords(dir, "chunks", [record("gone", 3), record("gone", 4), record("gone", 5)]);
    const before = await connect(dir).then(async (db) => {
      const table = await db.openTable("chunks");
      const stats = await table.stats();
      table.close();
      db.close();
      return stats.fragmentStats.numFragments;
    });

    await deleteLanceDbDocumentRows({ uri: dir, table: "chunks", documentIds: ["gone"] });

    const db = await connect(dir);
    const table = await db.openTable("chunks");
    try {
      expect(await table.countRows()).toBe(2);
      expect(await table.countRows(`"documentId" = 'gone'`)).toBe(0);
      expect((await table.stats()).fragmentStats.numFragments).toBeLessThanOrEqual(before);
    } finally {
      table.close();
      db.close();
    }
  });
});
