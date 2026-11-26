import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createHash } from "node:crypto";
import { BILLABLE_UNIT_METRICS, decodeTextBytes, defaultPipelineFeatures, pageCredits, textPageCount } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadFixtureDocument } from "../test/load-document.js";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { maxTextPagesForBytes, recordMeasuredTextPageCount, TEXT_MEASURE_MAX_BYTES, TEXT_PAGES_CAPABILITY } from "../lib/text-page-count.js";
import * as textPagesGuest from "../lib/text-pages-guest.js";
import { setDefaultParserSandbox } from "../sandbox/startup.js";
import type { ParserSandboxProvider } from "../sandbox/types.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { StorageObjectTooLargeError } from "../tools/storage.js";

// Spend mechanics below are exact at zero: no running-job overdraft (the default lets running jobs reach -25).
process.env.RUN_CREDIT_OVERDRAFT_CREDITS = "0";

/**
 * The API counts a text file over 2 MB from a 2 MB sample scaled by size (`assumed`). The worker counts the whole decoded
 * text with the same rule, records it `counted`, and billing reads only that. This file's sample under-counts: its first
 * 2 MB is one long line (pages by characters), the rest is a million short lines (pages by lines).
 */
const SAMPLE_BYTES = 2_000_000;
const bytes = new Uint8Array(Buffer.concat([Buffer.alloc(SAMPLE_BYTES, "a"), Buffer.alloc(1_000_000, "\n"), Buffer.from("end")]));
const sha = createHash("sha256").update(bytes).digest("hex");
// What intake (server source-metadata.ts) stores: the text rule over the first 2 MB, scaled by the file's size.
const apiEstimate = Math.max(1, Math.ceil(textPageCount(decodeTextBytes(bytes.subarray(0, SAMPLE_BYTES), "utf-8")) * (bytes.length / SAMPLE_BYTES)));
const fullCount = Math.ceil(1_000_001 / 60);
const textFacts = { declaredMimeType: "text/plain", sniffedMimeType: null, mimeType: "text/plain", format: "plain-text", container: null, encoding: "utf-8", mismatch: "none" };

let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
const pipeline = JSON.stringify({ ...defaultPipelineFeatures });

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 10000000), ('o2', 'Low', 'low', 'u1', 8, 1);
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'L');
    insert into project_runs (monthly_reservation_cents,id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values (100, 'run1', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, ${apiEstimate}),
             (100, 'run2', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, ${apiEstimate});
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, source_sha256, file_facts, parse_source_scan_version, parse_source_sha256) values
      ('big', 'o1', 'u1', 'w1', 'run1', 'log.txt', 'text/plain', 'raw/big', 'processing', ${apiEstimate}, 'assumed', '${sha}', '${JSON.stringify(textFacts)}', 1, '${sha}'),
      ('poor', 'o2', 'u1', 'w2', 'run2', 'log.txt', 'text/plain', 'raw/poor', 'processing', ${apiEstimate}, 'assumed', '${sha}', '${JSON.stringify(textFacts)}', 1, '${sha}'),
      ('small', 'o1', 'u1', 'w1', 'run1', 'a.txt', 'text/plain', 'raw/small', 'processing', 2, 'counted', null, '${JSON.stringify(textFacts)}', 1, repeat('0', 64)),
      ('vm', 'o1', 'u1', 'w1', 'run1', 'notes.txt', 'text/plain', 'raw/vm', 'processing', 1, 'assumed', '${sha}', '${JSON.stringify(textFacts)}', 1, '${sha}');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}, 120_000);
afterEach(() => { setSpendCheckConfig(null); setDefaultParserSandbox(undefined); vi.restoreAllMocks(); });
afterAll(async () => { await store?.close(); await server?.stop(); await db?.close(); });

async function stateFor(runId: string, documentId: string) {
  const document = (await loadFixtureDocument(store, documentId))!;
  const state = WorkflowState.create(await store.loadRun(runId), [document]);
  state.executionGeneration = state.run.executionGeneration;
  state.bindStore(store);
  state.usageLedger.runId = runId;
  return { state, document };
}
const pageRow = async (id: string) => (await db.query<{ page_count: number; page_count_source: string }>(`select page_count, page_count_source from documents where id = '${id}'`)).rows[0];

describe("text pages are measured in full by the worker, and only that count bills", () => {
  it("the fixture's 2 MB sample under-counts the file", () => {
    expect(bytes.length).toBeGreaterThan(SAMPLE_BYTES);
    expect(apiEstimate).toBeLessThan(fullCount / 10);
  });

  it("an estimate is assumed and bills nothing until the worker measures it", async () => {
    const { state } = await stateFor("run1", "big");
    const sql = (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;
    // A dry read of what would bill: the assumed text file contributes no pages, the counted one its two.
    const before = await sql<{ id: string }[]>`select id from documents where run_id = 'run1' and (billing_pages is not null or page_count_source = 'counted')`;
    expect(before.map((row) => row.id)).toEqual(["small"]);
    expect(state.documents[0]!.pageCountSource).toBe("assumed");
  }, 60_000);

  it("counts the whole decoded text with the same rule, records it counted, and bills exactly that count", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const { state, document } = await stateFor("run1", "big");
    const readSource = vi.fn(async (maxBytes: number) => { expect(maxBytes).toBe(TEXT_MEASURE_MAX_BYTES); return bytes; });
    expect(await recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource })).toEqual({ pages: fullCount, estimate: apiEstimate });
    expect(await pageRow("big")).toEqual({ page_count: fullCount, page_count_source: "counted" });
    const sql = (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;
    const charges = await recordPageBaseFee(sql, WorkflowState.create(await store.loadRun("run1"), [(await loadFixtureDocument(store, "big"))!, (await loadFixtureDocument(store, "small"))!]));
    expect(charges.fastPages).toBe(fullCount + 2);
    const { rows } = await db.query<{ amount: string; cost_cents: string }>(`select amount::text, cost_cents::text from usage_events where run_id = 'run1' and metric = $1`, [BILLABLE_UNIT_METRICS.fastPage]);
    expect(Number(rows[0]!.amount)).toBe(fullCount + 2);
    expect(Number(rows[0]!.cost_cents)).toBeCloseTo(pageCredits("fast", fullCount + 2));
  }, 60_000);

  it("leaves a count intake took from the whole text alone", async () => {
    const { state, document } = await stateFor("run1", "small");
    const readSource = vi.fn();
    expect(await recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource })).toBeNull();
    expect(readSource).not.toHaveBeenCalled();
  }, 60_000);

  it("pauses the run when the measured pages above the estimate no longer fit the balance", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const { state, document } = await stateFor("run2", "poor");
    // The page basis records the count, then authorizes the raise: the run is paused and the document stopped.
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: async () => bytes })).rejects.toMatchObject({ name: "RunPolicyError", paused: true });
    expect(await pageRow("poor")).toEqual({ page_count: fullCount, page_count_source: "counted" });
    await expect(state.pageBasis.authorize(document)).rejects.toMatchObject({ name: "RunPolicyError" });
    const { rows } = await db.query<{ control_state: string | null }>(`select control_state from project_runs where id = 'run2'`);
    expect(rows[0]!.control_state).toBe("paused");
  }, 60_000);

  it("refuses a file too large to measure, or bytes that are not the uploaded source, instead of billing an estimate", async () => {
    await db.exec(`update documents set page_count = ${apiEstimate}, page_count_source = 'assumed' where id = 'poor'`);
    const { state, document } = await stateFor("run2", "poor");
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: async (max) => { throw new StorageObjectTooLargeError("raw/poor", max + 1, max); } }))
      .rejects.toThrow(/too large to measure/);
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: async () => new TextEncoder().encode("swapped") }))
      .rejects.toMatchObject({ name: "SourceIntegrityError" });
    expect(await pageRow("poor")).toEqual({ page_count: apiEstimate, page_count_source: "assumed" });
  }, 60_000);

  it("PostgresPageBasisLedger.pauseForFunds pauses a processing run once; a second pause reports blocked, not paused", async () => {
    await db.exec(`insert into project_runs (monthly_reservation_cents,id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents)
      values (100, 'run3', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract', '${pipeline}', 1)`);
    const run = { id: "run3", orgId: "o1", projectId: "w1", userId: "u1" };
    expect(await store.pageBasisLedger.pauseForFunds(run, "credit_exhausted")).toEqual({ paused: true, blocked: true });
    const { rows } = await db.query<{ control_state: string; pause_reason: string }>(`select control_state, pause_reason from project_runs where id = 'run3'`);
    expect(rows[0]).toEqual({ control_state: "paused", pause_reason: "credit_exhausted" });
    expect(await store.pageBasisLedger.pauseForFunds(run, "credit_exhausted")).toEqual({ paused: false, blocked: true });
  }, 60_000);
});

/**
 * DocSlurp/app issue 599: under the VM-only floor the worker never decodes a text source. The count comes from the parser VM's
 * text-pages guest; the host checks the answer against the staged file's size and refuses anything else.
 */
describe("text pages under the VM-only floor", () => {
  const remote = { filesystem: true, network: "full", processes: true, location: "remote" } as const;
  const vmImage = (capabilities: string[]) => setDefaultParserSandbox({ provider: { id: "modal" } as unknown as ParserSandboxProvider, config: {}, isolation: remote, capabilities });
  const dirs: string[] = [];
  afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

  /** A staged source on disk, as stageSourceFile leaves it (already hash-verified there). */
  async function staged(content: Uint8Array): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "text-pages-test-"));
    dirs.push(dir);
    const file = path.join(dir, "source.txt");
    await writeFile(file, content);
    return file;
  }

  /** A parser VM stand-in that answers with `answer` (what a guest wrote), recording the command it was given. */
  function vmRunner(answer: (source: string, options: unknown) => unknown) {
    const calls: Array<{ binary: string; args: string[] }> = [];
    return {
      calls,
      run: vi.fn(async (plan: { binary: string; args: string[] }) => {
        calls.push(plan);
        const [source, config, output] = plan.args.slice(-3) as [string, string, string];
        await writeFile(output, JSON.stringify(answer(source, JSON.parse(await readFile(config, "utf8")))));
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
  }

  /** Hostile text: invalid UTF-8, NULs, a 2 MB single line, an HTML body behind a .txt name. */
  const hostile = new Uint8Array(Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x28, 0x8c, 0xbc, 0x00, 0x00]),
    Buffer.alloc(2_000_000, "x"),
    Buffer.from("<html><script>".repeat(1000)),
  ]));

  it("runs the text-pages guest on the staged source and records its count; no host decoder runs", async () => {
    vmImage([TEXT_PAGES_CAPABILITY]);
    const decode = vi.spyOn(textPagesGuest, "measureTextPagesBytes");
    const { state, document } = await stateFor("run1", "vm");
    const source = await staged(hostile);
    const runner = vmRunner(() => ({ pages: 7, bytes: hostile.length }));
    const readSource = vi.fn();
    expect(await recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource, runner, stageSource: async () => source, vmOnly: true }))
      .toEqual({ pages: 7, estimate: 1 });
    expect(readSource).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.binary).toBe("node");
    expect(runner.calls[0]!.args.some((arg) => arg.endsWith("text-pages.mjs"))).toBe(true);
    expect(runner.calls[0]!.args.at(-3)).toBe(source);
    expect(await pageRow("vm")).toEqual({ page_count: 7, page_count_source: "counted" });
    await db.exec(`update documents set page_count = 1, page_count_source = 'assumed' where id = 'vm'`);
  }, 60_000);

  it("in development the same rule runs in-process (the spy the refusals rely on sees that decode)", async () => {
    const decode = vi.spyOn(textPagesGuest, "measureTextPagesBytes");
    const { state, document } = await stateFor("run1", "vm");
    expect(await recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: async () => bytes, vmOnly: false })).toEqual({ pages: fullCount, estimate: 1 });
    expect(decode).toHaveBeenCalledTimes(1);
    await db.exec(`update documents set page_count = 1, page_count_source = 'assumed' where id = 'vm'`);
  }, 60_000);

  it("passes the guest only the sniffed encoding and whether the text is HTML", async () => {
    vmImage([TEXT_PAGES_CAPABILITY]);
    const { state, document } = await stateFor("run1", "vm");
    const source = await staged(new TextEncoder().encode("<p>hi</p>"));
    let seen: unknown;
    const runner = vmRunner((_source, options) => { seen = options; return { pages: 1, bytes: 9 }; });
    await recordMeasuredTextPageCount({ state, document, format: "html", readSource: vi.fn(), runner, stageSource: async () => source, vmOnly: true });
    expect(seen).toEqual({ encoding: "utf-8", markup: true });
    await db.exec(`update documents set page_count = 1, page_count_source = 'assumed' where id = 'vm'`);
  }, 60_000);

  it.each([
    ["more pages than the bytes can hold", (bytes: number) => ({ pages: maxTextPagesForBytes(bytes) + 1, bytes })],
    ["zero pages", (bytes: number) => ({ pages: 0, bytes })],
    ["a fractional count", (bytes: number) => ({ pages: 1.5, bytes })],
    ["a count as a string", (bytes: number) => ({ pages: "5", bytes })],
    ["another file's size", (bytes: number) => ({ pages: 1, bytes: bytes + 1 })],
    ["extra fields", (bytes: number) => ({ pages: 1, bytes, note: "x" })],
    ["not an object", () => [1]],
  ])("refuses a guest answer with %s, recording nothing", async (_name, answer) => {
    vmImage([TEXT_PAGES_CAPABILITY]);
    const { state, document } = await stateFor("run1", "vm");
    const source = await staged(hostile);
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: vi.fn(), runner: vmRunner(() => answer(hostile.length)), stageSource: async () => source, vmOnly: true }))
      .rejects.toMatchObject({ name: "TextPageCountRefusedError" });
    expect(await pageRow("vm")).toEqual({ page_count: 1, page_count_source: "assumed" });
  }, 60_000);

  it("refuses loudly, never decoding on the host, without a VM runner or on an image without the guest", async () => {
    const decode = vi.spyOn(textPagesGuest, "measureTextPagesBytes");
    const { state, document } = await stateFor("run1", "vm");
    const readSource = vi.fn(async () => hostile);
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource, vmOnly: true }))
      .rejects.toMatchObject({ name: "TextPageCountRefusedError" });
    // An older image (no text-pages capability), or no sandbox known yet: refused before anything is staged or run.
    for (const capabilities of [[], null] as const) {
      if (capabilities) vmImage([...capabilities]); else setDefaultParserSandbox(undefined);
      const runner = vmRunner(() => ({ pages: 1, bytes: hostile.length }));
      const source = await staged(hostile);
      await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource, runner, stageSource: async () => source, vmOnly: true }))
        .rejects.toThrow(/text-pages guest/);
      expect(runner.run).not.toHaveBeenCalled();
    }
    expect(readSource).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(await pageRow("vm")).toEqual({ page_count: 1, page_count_source: "assumed" });
  }, 60_000);

  it("refuses an oversized text file before the VM runs, never billing an estimate", async () => {
    vmImage([TEXT_PAGES_CAPABILITY]);
    const { state, document } = await stateFor("run1", "vm");
    const runner = vmRunner(() => ({ pages: 1, bytes: 1 }));
    // The staged download is bounded: storage refuses an object over the limit.
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: vi.fn(), runner, vmOnly: true,
      stageSource: async () => { throw new StorageObjectTooLargeError("raw/vm", TEXT_MEASURE_MAX_BYTES + 1, TEXT_MEASURE_MAX_BYTES); } }))
      .rejects.toThrow(/too large to measure/);
    // A staged file over the limit (a sparse file: no bytes written) is refused on its size alone.
    const dir = await mkdtemp(path.join(tmpdir(), "text-pages-test-"));
    dirs.push(dir);
    const big = path.join(dir, "big.txt");
    await writeFile(big, "");
    const { truncate } = await import("node:fs/promises");
    await truncate(big, TEXT_MEASURE_MAX_BYTES + 1);
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: vi.fn(), runner, stageSource: async () => big, vmOnly: true }))
      .rejects.toThrow(/too large to measure/);
    expect(runner.run).not.toHaveBeenCalled();
    expect(await pageRow("vm")).toEqual({ page_count: 1, page_count_source: "assumed" });
  }, 60_000);
});

describe("the text-pages guest", () => {
  it("counts hostile bytes without failing: invalid UTF-8, NULs, a huge single line, unclosed markup", () => {
    const line = new Uint8Array(Buffer.alloc(3_500 * 40, "y"));
    expect(textPagesGuest.measureTextPagesBytes(line, { encoding: "utf-8", markup: false })).toEqual({ pages: 40, bytes: line.length });
    const junk = new Uint8Array([0xc3, 0x28, 0x00, 0x00, 0xff, 0xfe, 0xa0, 0x0a, 0x0a]);
    for (const encoding of ["utf-8", "utf-16le", "utf-16be", "8-bit", null] as const) {
      const { pages } = textPagesGuest.measureTextPagesBytes(junk, { encoding, markup: true });
      expect(pages).toBeGreaterThanOrEqual(1);
      expect(pages).toBeLessThanOrEqual(maxTextPagesForBytes(junk.length));
    }
    const lines = new Uint8Array(Buffer.alloc(6_000, "\n"));
    expect(textPagesGuest.measureTextPagesBytes(lines, { encoding: "utf-8", markup: false }).pages).toBe(maxTextPagesForBytes(lines.length));
    const unclosed = new TextEncoder().encode("<script>".repeat(50_000));
    expect(textPagesGuest.measureTextPagesBytes(unclosed, { encoding: "utf-8", markup: true }).pages).toBe(1);
  });

  it("refuses options it did not expect", () => {
    for (const raw of [null, [], {}, { encoding: "utf-7", markup: false }, { encoding: null, markup: "yes" }, { encoding: null, markup: false, path: "/etc/passwd" }]) {
      expect(() => textPagesGuest.parseTextPagesOptions(raw)).toThrow(/invalid text pages options/);
    }
    expect(textPagesGuest.parseTextPagesOptions({ encoding: "utf-16le", markup: true })).toEqual({ encoding: "utf-16le", markup: true });
  });

  it("refuses a file over the limit by its size, before reading it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "text-pages-test-"));
    try {
      const big = path.join(dir, "big.txt");
      await writeFile(big, "");
      const { truncate } = await import("node:fs/promises");
      await truncate(big, TEXT_MEASURE_MAX_BYTES + 1);
      await expect(textPagesGuest.measureTextPagesFile(big, { encoding: null, markup: false })).rejects.toThrow(/too large to measure/);
      const small = path.join(dir, "small.txt");
      await writeFile(small, "a\nb\n");
      expect(await textPagesGuest.measureTextPagesFile(small, { encoding: null, markup: false })).toEqual({ pages: 1, bytes: 4 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
