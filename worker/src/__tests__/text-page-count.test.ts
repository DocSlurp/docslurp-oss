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

import {
  hostCountsTextPages, hostTextEvidenceOfFile, hostTextPages, INSPECTION_TEXT_PAGES_CAPABILITY, isPureAscii, textEvidenceWanted, pagesFromTextInspection, recordMeasuredTextPageCount, TEXT_MEASURE_MAX_BYTES,
  TextEvidenceCounter, textPagesBounds, TextPageCountUnavailableError, textPagesRequestFor, validateTextPagesInspection,
} from "../lib/text-page-count.js";
import * as textPagesGuest from "../lib/text-pages-guest.js";
import { inspectQuarantine } from "../lib/quarantine.js";
import { isDocumentLevelFailure } from "../lib/document-failure.js";
import { initializeParserSandbox, setDefaultParserSandbox } from "../sandbox/startup.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { StorageObjectTooLargeError } from "../tools/storage.js";

// Spend mechanics below are exact at zero: no running-job overdraft (the default lets running jobs reach -25).
process.env.RUN_CREDIT_OVERDRAFT_CREDITS = "0";

/**
 * Intake records a text file's pages as an estimate (`assumed`): it used to scale a 2 MB sample's count by size, and now
 * estimates from the size alone without decoding. The worker counts the whole decoded text with the text rule, records it
 * `counted`, and billing reads only that. This fixture's sample under-counts: its first 2 MB is one long line (pages by
 * characters), the rest is a million short lines (pages by lines).
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

/** The in-process measurement (development), as format-detect runs it outside the service profile. */
const inProcess = (content: Uint8Array) => async (request: textPagesGuest.TextPagesRequest) => textPagesGuest.inspectTextPages(content, { mimeType: null, encoding: "utf-8" }, request);

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
    const measure = vi.fn(inProcess(bytes));
    expect(await recordMeasuredTextPageCount({ state, document, format: "plain-text", measure })).toEqual({ pages: fullCount, estimate: apiEstimate });
    expect(measure).toHaveBeenCalledWith({ markup: false, force: true });
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
    const measure = vi.fn();
    expect(await recordMeasuredTextPageCount({ state, document, format: "plain-text", measure })).toBeNull();
    expect(measure).not.toHaveBeenCalled();
  }, 60_000);

  it("pauses the run when the measured pages above the estimate no longer fit the balance (the estimate-to-measured gap is authorized)", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const { state, document } = await stateFor("run2", "poor");
    // The page basis records the count, then authorizes the raise: the run is paused and the document stopped.
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", measure: inProcess(bytes) })).rejects.toMatchObject({ name: "RunPolicyError", paused: true });
    expect(await pageRow("poor")).toEqual({ page_count: fullCount, page_count_source: "counted" });
    await expect(state.pageBasis.authorize(document)).rejects.toMatchObject({ name: "RunPolicyError" });
    const { rows } = await db.query<{ control_state: string | null }>(`select control_state from project_runs where id = 'run2'`);
    expect(rows[0]!.control_state).toBe("paused");
  }, 60_000);

  it("refuses a file too large to measure instead of billing an estimate", async () => {
    await db.exec(`update documents set page_count = ${apiEstimate}, page_count_source = 'assumed' where id = 'poor'`);
    const { state, document } = await stateFor("run2", "poor");
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", measure: async () => { throw new StorageObjectTooLargeError("raw/poor", TEXT_MEASURE_MAX_BYTES + 1, TEXT_MEASURE_MAX_BYTES); } }))
      .rejects.toThrow(/too large to measure/);
    expect(await pageRow("poor")).toEqual({ page_count: apiEstimate, page_count_source: "assumed" });
  }, 60_000);

  it("an inspection with no text answer (an image older than the worker) is retried, never a document failure, and records nothing", async () => {
    await db.exec(`update documents set page_count = 1, page_count_source = 'assumed' where id = 'vm'`);
    const { state, document } = await stateFor("run1", "vm");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = await recordMeasuredTextPageCount({ state, document, format: "plain-text", measure: async () => undefined }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TextPageCountUnavailableError);
    // The fixed token an alert keys on.
    expect(logged.mock.calls.flat().join(" ")).toContain("[parser-sandbox] status=refused reason=capability-missing capability=inspection-text-pages");
    expect(isDocumentLevelFailure(failure)).toBe(false);
    // A guest that measured nothing although asked with `force` is not a count of this file: refused (a document failure).
    const none = await recordMeasuredTextPageCount({ state, document, format: "plain-text", measure: async () => null }).catch((error: unknown) => error);
    expect(none).toMatchObject({ name: "TextPageCountRefusedError" });
    expect(await pageRow("vm")).toEqual({ page_count: 1, page_count_source: "assumed" });
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

/** A UTF-16 file as the guest would see it: little-endian with its byte-order mark. */
const utf16 = (text: string) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
const evidenceOf = (content: Uint8Array) => { const counter = new TextEvidenceCounter(); counter.update(content); return counter.result(); };

describe("the host's bounds on the guest's text count", () => {
  const latin1 = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
  const utf8 = (text: string) => new TextEncoder().encode(text);
  const soundCases: Array<[string, Uint8Array, "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "8-bit", boolean]> = [
    ["newlines", new Uint8Array(Buffer.alloc(100_000, "\n")), "utf-8", false],
    ["one long line", new Uint8Array(Buffer.alloc(100_000, "x")), "utf-8", false],
    ["narrow CSV", utf8("a,b\n".repeat(20_000)), "utf-8", false],
    ["East Asian UTF-8", utf8("漢字かな".repeat(10_000)), "utf-8", false],
    ["Cyrillic UTF-8", utf8("Привет мир\n".repeat(5_000)), "utf-8", false],
    ["UTF-8 with a mark", new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("café\n".repeat(5_000))])), "utf-8-bom", false],
    ["East Asian UTF-16", utf16("漢字かな上上".repeat(10_000)), "utf-16le", false],
    ["UTF-16 CSV", utf16("a,b\n".repeat(20_000)), "utf-16le", false],
    ["UTF-16BE prose", new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("plain words here\n".repeat(5_000), "utf16le").swap16()])), "utf-16be", false],
    ["HTML markup", utf8("<b>x</b>".repeat(20_000)), "utf-8", true],
    ["tag-dense HTML", utf8("<tr><td>1</td><td>2</td></tr>\n".repeat(20_000)), "utf-8", true],
    ["script-heavy HTML", utf8(`<html><script>${"var a = 1;\n".repeat(20_000)}</script><p>hello</p></html>`), "utf-8", true],
    ["UTF-16 HTML", utf16("<p>hello</p>\n".repeat(5_000)), "utf-16le", true],
    ["8-bit", latin1("caf\xe9\n".repeat(10_000)), "8-bit", false],
    ["trailing spaces", utf8(`word${" ".repeat(50_000)}`), "utf-8", false],
  ];

  it.each(soundCases)("%s: the rule's count lies within the host's bounds", (_name, content, encoding, markup) => {
    const measured = textPagesGuest.measureTextPagesBytes(content, { encoding, markup }).pages;
    const bounds = textPagesBounds(evidenceOf(content), { encoding, markup });
    expect(measured).toBeGreaterThanOrEqual(bounds.min);
    expect(measured).toBeLessThanOrEqual(bounds.max);
  });

  it("are exact for ASCII-compatible plain text by lines, and tight by characters", () => {
    const lines = new Uint8Array(Buffer.alloc(100_000, "\n"));
    expect(textPagesBounds(evidenceOf(lines), { encoding: "utf-8", markup: false }).min).toBe(Math.ceil(100_001 / 60));
    const line = new Uint8Array(Buffer.alloc(100_000, "x"));
    expect(textPagesBounds(evidenceOf(line), { encoding: "utf-8", markup: false })).toEqual({ min: 29, max: 29 });
    // White space a trim removes never raises the ceiling.
    expect(textPagesBounds(evidenceOf(utf8(`word${" ".repeat(50_000)}`)), { encoding: "utf-8", markup: false }).max).toBe(1);
    // UTF-16 Latin text: at most twice its count (a NUL byte in every code unit is never East Asian).
    const wide = utf16("x".repeat(70_000));
    expect(textPagesBounds(evidenceOf(wide), { encoding: "utf-16le", markup: false }).max).toBeLessThanOrEqual(2 * 20 + 1);
    // UTF-16 East Asian text whose code units hold 0x0A bytes (上 is U+4E0A): those are not line feeds.
    const ue = utf16("上".repeat(60_000));
    expect(textPagesBounds(evidenceOf(ue), { encoding: "utf-16le", markup: false }).max).toBe(textPagesGuest.measureTextPagesBytes(ue, { encoding: "utf-16le", markup: false }).pages);
    // Markup: lines bounded by the newlines plus the `<` bytes, not by the file size.
    const tags = utf8("<a>".repeat(60_000));
    expect(textPagesBounds(evidenceOf(tags), { encoding: "utf-8", markup: true }).max).toBe(Math.max(Math.ceil(60_001 / 60), Math.ceil(180_000 / 3500)));
  });

  it("refuses a guest claim the host's bytes contradict", () => {
    const refused = (content: Uint8Array, claim: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "8-bit") =>
      () => validateTextPagesInspection({ text: { pages: 1, bytes: content.length } }, evidenceOf(content), claim);
    // UTF-16 claimed for bytes with no NUL: one page for any file otherwise.
    expect(refused(utf8("plain words\n".repeat(10_000)), "utf-16le")).toThrow(/claims UTF-16/);
    expect(refused(utf8("Привет мир\n".repeat(10_000)), "utf-16be")).toThrow(/claims UTF-16/);
    // A byte-order mark names the encoding.
    expect(refused(utf16("words\n".repeat(100)), "utf-8")).toThrow(/byte-order mark/);
    expect(refused(utf16("words\n".repeat(100)), "utf-16be")).toThrow(/byte-order mark/);
    expect(refused(utf8("no mark here"), "utf-8-bom")).toThrow(/byte-order mark/);
  });

  it("the host's own count of pure-ASCII text is the shared rule's, at any shape", () => {
    const shapes = ["", "x", "\n", "  \n\t padded \r\n  ", "a,b\r\n".repeat(9_000), "word ".repeat(3_000), `${" ".repeat(9_000)}x${"\n".repeat(200)}`, "{\"a\":[1,2,3]}\n".repeat(400)];
    let seed = 7;
    for (let index = 0; index < 40; index++) {
      let text = "";
      const length = (seed = (seed * 48271) % 2147483647) % 20_000;
      for (let at = 0; at < length; at++) text += " \t\r\nabc<>,.{}"[(seed = (seed * 48271) % 2147483647) % 15];
      shapes.push(text);
    }
    for (const text of shapes) {
      const evidence = evidenceOf(utf8(text));
      expect(isPureAscii(evidence)).toBe(true);
      expect(hostTextPages(evidence)).toBe(textPagesGuest.measureTextPagesBytes(utf8(text), { encoding: "utf-8", markup: false }).pages);
    }
    expect(isPureAscii(evidenceOf(utf8("café")))).toBe(false);
    expect(isPureAscii(evidenceOf(new Uint8Array([0x61, 0x00])))).toBe(false);
    expect(hostCountsTextPages(evidenceOf(utf8("a")), "plain-text")).toBe(true);
    expect(hostCountsTextPages(evidenceOf(utf8("a")), "html")).toBe(false);
    expect(hostCountsTextPages(evidenceOf(utf8("é")), "plain-text")).toBe(false);
  });

  it("counts text facts only for text-rule formats or headers no binary magic number claims", () => {
    expect(textEvidenceWanted(utf8("%PDF-1.7\n"), "a.pdf", "pdf")).toBe(false);
    expect(textEvidenceWanted(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), "a.docx", "office-word")).toBe(false);
    expect(textEvidenceWanted(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "a.png", "image")).toBe(false);
    expect(textEvidenceWanted(utf8("hello"), "notes", "unknown")).toBe(true);
    expect(textEvidenceWanted(utf16("hello"), "notes", "unknown")).toBe(true);
    // A text-rule format is counted whatever its header looks like.
    expect(textEvidenceWanted(utf8("%PDF-1.7"), "a.txt", "plain-text")).toBe(true);
  });

  it.each([
    ["more pages than the bytes can hold", (n: number) => ({ pages: n, bytes: 7 })],
    ["fewer pages than the newlines give", () => ({ pages: 1, bytes: 6_000 })],
    ["zero pages", () => ({ pages: 0, bytes: 6_000 })],
    ["a fractional count", () => ({ pages: 1.5, bytes: 6_000 })],
    ["a count as a string", () => ({ pages: "100", bytes: 6_000 })],
    ["another file's size", () => ({ pages: 100, bytes: 6_001 })],
    ["extra fields", () => ({ pages: 100, bytes: 6_000, note: "x" })],
    ["not an object", () => [100]],
  ])("refuses a guest answer with %s", (_name, answer) => {
    const evidence = evidenceOf(new Uint8Array(Buffer.alloc(6_000, "\n")));
    expect(() => validateTextPagesInspection({ text: answer(10_000) }, evidence, "utf-8")).toThrow(expect.objectContaining({ name: "TextPageCountRefusedError" }));
  });

  it("accepts the guest's exact answer, and tells an absent answer (older image) from no measurement", () => {
    const content = new Uint8Array(Buffer.alloc(6_000, "\n"));
    const evidence = evidenceOf(content);
    expect(validateTextPagesInspection({ text: { pages: 101, bytes: 6_000 } }, evidence, "utf-8")).toEqual({ pages: 101, bytes: 6_000 });
    expect(validateTextPagesInspection({ text: null }, evidence, "utf-8")).toBeNull();
    expect(validateTextPagesInspection({ sniffed: {} }, evidence, "utf-8")).toBeUndefined();
    expect(() => pagesFromTextInspection(undefined, "plain-text")).toThrow(TextPageCountUnavailableError);
    expect(pagesFromTextInspection({ pages: 3, bytes: 9 }, "html")).toBeNull();
    expect(pagesFromTextInspection({ pages: 3, markupPages: 1, bytes: 9 }, "html")).toBe(1);
  });

  it("hostTextEvidenceOfFile streams the same facts as the counter", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "text-evidence-"));
    try {
      const content = Buffer.concat([Buffer.alloc(300_000, "a\n"), Buffer.from([0xff, 0x0a, 0x20, 0x7e, 0x7f])]);
      await writeFile(path.join(dir, "f"), content);
      expect(await hostTextEvidenceOfFile(path.join(dir, "f"))).toEqual(evidenceOf(new Uint8Array(content)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("text pages under the VM-only floor: the quarantine inspection carries the count", () => {
  const dirs: string[] = [];
  afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });
  const policy = { quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 2000, quarantineMaxArchiveDepth: 12, quarantineMaxTotalUncompressedBytes: 1 << 30, quarantineMaxSingleEntryBytes: 1 << 29, quarantineMaxExpansionRatio: 100 };

  async function staged(content: Uint8Array): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "text-pages-test-"));
    dirs.push(dir);
    const file = path.join(dir, "source.txt");
    await writeFile(file, content);
    return file;
  }

  /** A parser VM stand-in: answers with `answer(options)` as the guest's result JSON, recording each command. */
  function vmRunner(answer: (options: Record<string, unknown>) => unknown) {
    return {
      run: vi.fn(async (plan: { binary: string; args: string[] }) => {
        const [, config, output] = plan.args.slice(-3) as [string, string, string];
        await writeFile(output, JSON.stringify(answer(JSON.parse(await readFile(config, "utf8")) as Record<string, unknown>)));
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
  }
  const sniffedText = { mimeType: "text/plain", container: null, encoding: "utf-8" };

  it("asks for the count in the same command and validates it against the host's byte facts; no host decoder runs", async () => {
    vi.stubEnv("DOCSLURP_PROFILE", "service");
    vi.stubEnv("NODE_ENV", "production");
    const decode = vi.spyOn(textPagesGuest, "inspectTextPages");
    const content = new Uint8Array(Buffer.alloc(6_000, "\n"));
    const file = await staged(content);
    let seen: Record<string, unknown> | undefined;
    const runner = vmRunner((options) => { seen = options; return { sniffed: sniffedText, archive: null, pdf: null, text: { pages: 101, bytes: 6_000 } }; });
    const inspection = await inspectQuarantine({ bytes: Buffer.alloc(0), filename: "a.txt", tempFile: file, runner: runner as never, policy, text: { markup: false, force: true }, textEvidence: await hostTextEvidenceOfFile(file) });
    expect(inspection.text).toEqual({ pages: 101, bytes: 6_000 });
    expect(seen?.text).toEqual({ markup: false, force: true });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled();
    // An undercount the newlines contradict is refused.
    const lying = vmRunner(() => ({ sniffed: sniffedText, archive: null, pdf: null, text: { pages: 1, bytes: 6_000 } }));
    await expect(inspectQuarantine({ bytes: Buffer.alloc(0), filename: "a.txt", tempFile: file, runner: lying as never, policy, text: { markup: false, force: true }, textEvidence: await hostTextEvidenceOfFile(file) }))
      .rejects.toMatchObject({ name: "TextPageCountRefusedError" });
    // An older image: no `text` key, read as unavailable (undefined), never decoded here.
    const old = vmRunner(() => ({ sniffed: sniffedText, archive: null, pdf: null }));
    const inspected = await inspectQuarantine({ bytes: Buffer.alloc(0), filename: "a.txt", tempFile: file, runner: old as never, policy, text: { markup: false, force: true }, textEvidence: await hostTextEvidenceOfFile(file) });
    expect(inspected.text).toBeUndefined();
    expect(() => pagesFromTextInspection(inspected.text, "plain-text")).toThrow(TextPageCountUnavailableError);
    expect(decode).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("refuses a guest result reached through a symlink", async () => {
    vi.stubEnv("DOCSLURP_PROFILE", "service");
    vi.stubEnv("NODE_ENV", "production");
    const file = await staged(new TextEncoder().encode("hi"));
    const { symlink } = await import("node:fs/promises");
    const target = path.join(path.dirname(file), "elsewhere.json");
    await writeFile(target, JSON.stringify({ sniffed: sniffedText, archive: null, pdf: null, text: null }));
    const runner = { run: vi.fn(async (plan: { args: string[] }) => { await symlink(target, plan.args.at(-1)!); return { stdout: "", stderr: "", exitCode: 0 }; }) };
    await expect(inspectQuarantine({ bytes: Buffer.alloc(0), filename: "a.txt", tempFile: file, runner: runner as never, policy })).rejects.toThrow();
    vi.unstubAllEnvs();
  });

  it("asks only for documents that still owe a count, with markup for HTML", () => {
    expect(textPagesRequestFor({ pageCountSource: "counted" }, "plain-text")).toBeNull();
    expect(textPagesRequestFor({ pageCountSource: "assumed" }, "html")).toEqual({ markup: true, force: true });
    expect(textPagesRequestFor({ pageCountSource: "assumed" }, "unknown")).toEqual({ markup: false, force: false });
  });
});

describe("worker startup under the VM-only floor", () => {
  const contract = (capabilities: string[]) => ({
    id: "fake-remote",
    readConfig: () => ({}),
    probe: async () => ({ ok: true, isolation: { filesystem: true, network: "none", processes: true, location: "remote" }, detail: "ok", capabilities }),
  });

  it("refuses a remote parser image without the inspection's text answer, so a bad deploy never takes traffic", async () => {
    const registry = await import("../sandbox/registry.js");
    vi.spyOn(registry, "resolveSandboxProviderId").mockReturnValue("modal" as never);
    vi.spyOn(registry, "loadSandboxProvider").mockResolvedValue(contract([]) as never);
    const policy = await import("../sandbox/policy.js");
    vi.spyOn(policy, "assertSandboxPolicy").mockReturnValue({ warnings: [] } as never);
    const vmOnly = await import("../lib/vm-only-parsing.js");
    vi.spyOn(vmOnly, "assertServiceProfileRuntime").mockReturnValue(undefined as never);
    const env = { NODE_ENV: "production", DOCSLURP_PROFILE: "service" } as NodeJS.ProcessEnv;
    await expect(initializeParserSandbox(env, "linux")).rejects.toThrow(/lacks required capabilities: inspection-text-pages/);
    vi.spyOn(registry, "loadSandboxProvider").mockResolvedValue(contract([INSPECTION_TEXT_PAGES_CAPABILITY]) as never);
    await expect(initializeParserSandbox(env, "linux")).resolves.toMatchObject({ capabilities: [INSPECTION_TEXT_PAGES_CAPABILITY] });
  });
});
