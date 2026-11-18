import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizePipelineFeatures, type CanonicalDocument } from "@docslurp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  embedMany: vi.fn(async (args: { values: string[] }) => ({
    embeddings: args.values.map((value) => {
      const digest = createHash("sha256").update(value).digest();
      return Array.from({ length: 1536 }, (_, index) => (digest[index % 8]! + 1) / 256);
    }),
    usage: { tokens: args.values.length * 7 },
  })),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ embedding: (model: string) => ({ model }) }),
  openai: { embedding: (model: string) => ({ model }) },
}));

import { fromEnv } from "../config.js";
import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import type { Document, ProjectRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { memoryCheckpointStore } from "../pipeline/checkpoint-store-memory.js";
import { readTableCells } from "../pipeline/table-cells-guest.js";
import {
  embedHtmlTableSources, readTableCellsArtifact, tableCellsArtifactKey, tableCellsGeneration, tableCellsByteCap, tableCellsCacheEnabled, tableCellsGuestVersion, tableSourceSha256,
  TABLE_CELLS_ARTIFACT_SCHEMA, writeTableCellsArtifact,
} from "../pipeline/html-table-cells-cache.js";
import { effectiveHtmlTableOutputCap, HTML_TABLE_BATCH_OUTPUT_TARGET, htmlTableCellsOutputBound, prepareHtmlTableCells, setTableParseMemoryBudgetForTests, TABLE_PARSE_HEAP_FACTOR, TableParseMemoryBudget, vmTableSources } from "../pipeline/html-table-vm.js";
import { SandboxOutputLimitError } from "../sandbox/types.js";
import { assertJsonShape } from "../lib/json-shape.js";
import { visionMayReadDocumentPages } from "../lib/vision-reads-pages.js";
import { VISION_ROUTING_VERSION_SLOT } from "../lib/vision-routing-v2.js";
import { SessionStaging } from "../sandbox/providers/modal/staging.js";
import { extractTextForEmbedding } from "../stages/embedding-runtime.js";
import { EmbedStage } from "../stages/embed.js";
import { htmlTableSources } from "../pipeline/chunking.js";
import { mayHaveHtmlTables, storeEmbedTableCells, writerEmbedInputs, writerTableSources } from "../stages/embed-table-cells.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { VisionExtractStage } from "../stages/vision-extract.js";
import { setDefaultParserSandbox, type InitializedParserSandbox } from "../sandbox/startup.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { GUEST_NODE_FLAGS } from "../sandbox/guest-node-flags.js";

/** S3-like: a missing key is a 404; a stream may or may not report its length; every read and write is logged. */
class MemoryStorage {
  readonly bucket = "t";
  readonly objects = new Map<string, Buffer>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly deletes: string[] = [];
  /** Report no Content-Length (chunked transfer), as some stores do. */
  hideLength = false;
  /** Bytes the reader actually pulled off the stream, per key. */
  readonly pulled = new Map<string, number>();
  failPut: Error | null = null;
  /** Hold every upload until its signal aborts (an upload in flight when a deadline passes). */
  holdPut = false;
  readonly abortedPuts: string[] = [];
  uri(key: string) { return `s3://t/${key}`; }
  private get(key: string): Buffer {
    const value = this.objects.get(key);
    if (value === undefined) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    return value;
  }
  async getBytes(key: string) { this.reads.push(key); return this.get(key); }
  async getJson<T>(key: string): Promise<T> { this.reads.push(key); return JSON.parse(this.get(key).toString("utf8")) as T; }
  async putJson(key: string, value: unknown) { this.writes.push(key); this.objects.set(key, Buffer.from(JSON.stringify(value))); }
  async putBytes(key: string, data: Uint8Array, _contentType?: string, options?: { signal?: AbortSignal }) {
    if (this.failPut) throw this.failPut;
    if (this.holdPut) {
      await new Promise<void>((_, reject) => options?.signal?.addEventListener("abort", () => { this.abortedPuts.push(key); reject(options.signal!.reason); }, { once: true }));
    }
    this.writes.push(key); this.objects.set(key, Buffer.from(data));
  }
  async deleteKeys(keys: string[]) { for (const key of keys) { this.deletes.push(key); this.objects.delete(key); } }
  async openStream(key: string) {
    this.reads.push(key);
    const body = this.get(key);
    const pulled = this.pulled;
    async function* chunks() {
      for (let offset = 0; offset < body.length; offset += 64 * 1024) {
        pulled.set(key, (pulled.get(key) ?? 0) + Math.min(64 * 1024, body.length - offset));
        yield body.subarray(offset, offset + 64 * 1024);
      }
    }
    return { stream: chunks(), size: this.hideLength ? null : body.length };
  }
  setText(key: string, text: string) { this.objects.set(key, Buffer.from(text, "utf8")); }
  text(key: string) { return this.objects.get(key)?.toString("utf8"); }
}

/** A parser VM stand-in that runs the real guest parser on the staged batch (table-cells.mjs), counting commands. */
function vmRunner(transform?: (cells: unknown[]) => unknown[]) {
  const batches: string[][] = [];
  const run = vi.fn(async (plan: { binary: string; args: string[] }, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    expect(plan.binary).toBe("node");
    const [script, input, output] = plan.args.slice(GUEST_NODE_FLAGS.length);
    expect(path.basename(script!)).toBe("table-cells.mjs");
    const batch = JSON.parse(await readFile(input!, "utf8")) as string[];
    batches.push(batch);
    const cells = batch.map(readTableCells);
    await writeFile(output!, JSON.stringify(transform ? transform(cells) : cells));
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { run, batches };
}

/** A registered Modal parser sandbox with an immutable image id: the guest identity production uses. */
function modalSandbox(config: Record<string, unknown> = { imageId: "im-guest1" }, id = "modal", location: "remote" | "local" = "remote"): InitializedParserSandbox {
  return { provider: { id } as InitializedParserSandbox["provider"], config, isolation: { location, filesystem: true, network: "full", processes: true } as unknown as InitializedParserSandbox["isolation"] };
}

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "testdata", "pdf-fixtures", "doppler-md-html");
const FIXTURES = ["routing-table-bullet-list.pdf.md", "routing-table-clean-financial.pdf.md", "routing-table-two-line-header.pdf.md"];

/** A fixture's table grown past the chunk budget (rows repeated), so chunking reads its cells rather than the source. */
function grown(markdown: string, copies: number): string {
  return markdown.replace(/<tbody>([\s\S]*?)<\/tbody>/i, (_, rows: string) => `<tbody>${Array.from({ length: copies }, (_, i) => rows.replace(/<td>/g, `<td>${i}·`)).join("")}</tbody>`);
}
const header = `<table><caption>Regional revenue</caption><thead><tr><th>Region</th><th colspan="2">Revenue</th></tr></thead><tbody>${
  Array.from({ length: 400 }, (_, i) => `<tr><td rowspan="1">Region ${i} &amp; partners</td><td>${i * 7}</td><td>${i % 3 ? "<b>up</b>" : "down<br>flat"}</td></tr>`).join("")}</tbody></table>`;
const unparsed = `<table class="x"><tr><td>${"unsupported attribute ".repeat(300)}</td></tr></table>`;

async function fixtureDocuments(): Promise<Record<string, string>> {
  const docs: Record<string, string> = {};
  for (const name of FIXTURES) {
    const text = await readFile(path.join(fixturesDir, name), "utf8");
    docs[name] = text;
    docs[`${name} grown`] = grown(text, 60);
  }
  docs["spans, caption and inline markup"] = `# Mixed\n\nIntro paragraph.\n\n${header}\n\nAfter the table.\n\n${unparsed}\n`;
  docs["all fixtures in one document"] = Object.values(docs).join("\n\n# Next\n\n");
  return docs;
}

type Pipeline = { piiPolicy?: { enabled?: boolean } | null };
const plainPipeline: Pipeline = { piiPolicy: { enabled: false } };
const scope = (over: Partial<{ id: string; storagePrefix: string | null; userId: string; pipeline: Pipeline }> = {}) =>
  ({ id: "run", storagePrefix: null as string | null, userId: "u1", pipeline: plainPipeline, ...over });
type Scope = ReturnType<typeof scope>;
const document = (id: string, text: string, run: Scope = scope()): Document => ({
  id, userId: run.userId, runId: run.id, filename: "tables.pdf", mimeType: "application/pdf", sourceKey: "unused", parseSourceDecision: "original",
  sourceSha256: createHash("sha256").update(text).digest("hex"), status: "processing", extractionMode: "hybrid", pageCount: 1,
  createdAt: new Date(), updatedAt: new Date(),
} as Document);
const root = (run: Scope) => run.storagePrefix ?? `${run.userId}/${run.id}`;

/** What the writing stage leaves for embed: the Markdown artifact and the canonical document, in their ledger slots. */
async function seed(storage: MemoryStorage, id: string, text: string, run: Scope = scope()) {
  const canonical = buildCanonicalDocumentFromMarkdown({ documentId: id, text, pageCount: 1, extractor: "test" });
  const markdownKey = `${root(run)}/markdown/${id}.md`;
  storage.setText(markdownKey, text);
  const canonicalKey = `${root(run)}/canonical/${id}.json`;
  await storage.putJson(canonicalKey, canonical);
  storage.writes.length = 0;
  return { markdownUri: storage.uri(markdownKey), canonicalUri: storage.uri(canonicalKey), canonical };
}

const storeArgs = (storage: MemoryStorage, id: string, text: string, canonical: CanonicalDocument, runner: Pick<CommandRunner, "run">, run: Scope = scope(), stage = "extract-markdown") =>
  ({ run, document: document(id, text, run), runner, storage: storage as unknown as ArtifactStore, stage, markdown: text, canonicalDocument: canonical });

async function embed(storage: MemoryStorage, id: string, text: string, slots: { markdownUri: string; canonicalUri: string }, runner: Pick<CommandRunner, "run">, run: Scope = scope()) {
  const projectRun = {
    id: run.id, userId: run.userId, orgId: "o1", projectId: "w1", stage: "embed", status: "processing", storagePrefix: run.storagePrefix,
    pipeline: { ...normalizePipelineFeatures({ embedding: { profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-small", target: "hosted" } as never }), contextualChunkPreambles: false, ...(run.pipeline.piiPolicy?.enabled ? { piiPolicy: { enabled: true, patterns: ["ssn"], action: "flag_for_review" } } : {}) },
    stats: {}, artifacts: { [`${id}:markdown`]: slots.markdownUri, [`${id}:canonical-document`]: slots.canonicalUri }, spentCents: 0,
  } as unknown as ProjectRun;
  const state = WorkflowState.create(projectRun, [document(id, text, run)]);
  state.docConcurrency = 1;
  state.store = memoryCheckpointStore();
  await new EmbedStage(runner as CommandRunner, storage as unknown as ArtifactStore, { ...fromEnv(), openRouterApiKey: "k", openAiApiKey: "k" }).run(state);
  const artifactUri = state.artifactLedger.readDocument(id, "embeddings");
  expect(artifactUri).toBeTruthy();
  const artifact = await storage.getJson<Record<string, unknown>>(artifactUri!.replace("s3://t/", ""));
  const reuse = state.pendingPerformance.find((event) => event.metric === "table-cells-reuse");
  return { artifact, reuse };
}

/** Today's path: no stored cells; embed parses every table in a VM of its own. */
async function oldPath(id: string, text: string) {
  vi.stubEnv("DOCSLURP_TABLE_CELLS_CACHE", "off");
  const storage = new MemoryStorage();
  const slots = await seed(storage, id, text);
  const vm = vmRunner();
  const result = await embed(storage, id, text, slots, vm);
  vi.stubEnv("DOCSLURP_TABLE_CELLS_CACHE", "on");
  return { ...result, vm };
}

/** New path: the writing stage stores the cells from its warm lane; embed reuses them. */
async function newPath(id: string, text: string, tamper?: (key: string, storage: MemoryStorage) => void, run: Scope = scope()) {
  const storage = new MemoryStorage();
  const slots = await seed(storage, id, text, run);
  const extractVm = vmRunner();
  const stored = await storeEmbedTableCells(storeArgs(storage, id, text, slots.canonical, extractVm, run));
  const key = tableCellsArtifactKey(run, document(id, text, run));
  tamper?.(key, storage);
  const embedVm = vmRunner();
  const result = await embed(storage, id, text, slots, embedVm, run);
  return { ...result, stored, extractVm, embedVm, storage, key };
}

const stable = (artifact: Record<string, unknown>) => JSON.stringify(artifact);
/** Serialize an artifact object with its `bytes` field set to its own length (the writer's header layout). */
function withLength(artifact: Record<string, unknown>): string {
  const draft = JSON.stringify({ ...artifact, bytes: "0".repeat(10) });
  return JSON.stringify({ ...artifact, bytes: String(Buffer.byteLength(draft)).padStart(10, "0") });
}

beforeEach(() => {
  vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
  vi.stubEnv("DOCSLURP_TABLE_CELLS_CACHE", "on");
  setDefaultParserSandbox(modalSandbox());
});
afterEach(() => { vi.unstubAllEnvs(); setDefaultParserSandbox(undefined); vi.restoreAllMocks(); });

describe("stored HTML table cells: identity with the VM path", () => {
  it("produces byte-identical embedding artifacts (chunks, ids, content hash) on every table fixture, with zero embed VM calls", async () => {
    const docs = await fixtureDocuments();
    let cellReads = 0;
    for (const [name, text] of Object.entries(docs)) {
      const id = `doc-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
      const before = await oldPath(id, text);
      const after = await newPath(id, text);
      expect(before.vm.run, name).toHaveBeenCalled();
      expect(after.stored.status, name).toBe("written");
      expect(after.embedVm.run, name).not.toHaveBeenCalled();
      expect(after.reuse?.metadata, name).toMatchObject({ status: "hit", misses: 0 });
      expect(stable(after.artifact), name).toBe(stable(before.artifact));
      expect(after.extractVm.batches.flat().sort(), name).toEqual(before.vm.batches.flat().sort());
      if (stable(before.artifact).includes("v2: r=row")) cellReads++;
    }
    // Chunking actually read stored cells (tables larger than a chunk), not only small tables kept whole.
    expect(cellReads).toBeGreaterThan(0);
  });

  it("does no extra work for a document without tables: no artifact, no VM call, no stored-cells read", async () => {
    const text = "# Plain\n\nJust prose, no tables at all.\n";
    expect(mayHaveHtmlTables(text, [])).toBe(false);
    const after = await newPath("plain", text);
    expect(after.stored.status).toBe("no-tables");
    expect(after.extractVm.run).not.toHaveBeenCalled();
    expect(after.embedVm.run).not.toHaveBeenCalled();
    expect(after.storage.objects.has(after.key)).toBe(false);
    expect(after.storage.reads).not.toContain(after.key);
    expect(after.reuse).toBeUndefined();
  });

  it("is off by default: nothing stored or read, embed parses in a VM as before", async () => {
    vi.stubEnv("DOCSLURP_TABLE_CELLS_CACHE", "");
    expect(tableCellsCacheEnabled({})).toBe(false);
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const after = await newPath("flag-off", text);
    expect(after.stored.status).toBe("off");
    expect(after.storage.objects.has(after.key)).toBe(false);
    expect(after.storage.reads).not.toContain(after.key);
    expect(after.embedVm.run).toHaveBeenCalledTimes(1);
    expect(after.reuse).toBeUndefined();
  });

  it("content written after the artifact (another generation) is a full miss: every table parsed in a VM, identical output", async () => {
    const early = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const later = `${early}\n\n# Vision page\n\n${header}\n`;
    const storage = new MemoryStorage();
    const first = await seed(storage, "partial", early);
    await storeEmbedTableCells(storeArgs(storage, "partial", early, first.canonical, vmRunner()));
    const slots = await seed(storage, "partial", later);
    const embedVm = vmRunner();
    const result = await embed(storage, "partial", later, slots, embedVm);
    expect(embedVm.batches.flat().sort()).toEqual(vmTableSources(htmlTableSources(later)).sort());
    expect(result.reuse?.metadata).toMatchObject({ status: "stale", hits: 0, misses: 2 });
    const before = await oldPath("partial", later);
    expect(stable(result.artifact)).toBe(stable(before.artifact));
  });

  it("a later writer (vision-extract) writes a fresh artifact for its generation; nothing is carried over", async () => {
    const early = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const later = `${early}\n\n${header}\n`;
    const storage = new MemoryStorage();
    await storeEmbedTableCells(storeArgs(storage, "fresh", early, (await seed(storage, "fresh", early)).canonical, vmRunner()));
    // vision-extract rewrote the document and stores every table of the new generation, re-parsed.
    const slots = await seed(storage, "fresh", later);
    const visionVm = vmRunner();
    const stored = await storeEmbedTableCells(storeArgs(storage, "fresh", later, slots.canonical, visionVm, scope(), "vision-extract"));
    expect(stored).toMatchObject({ status: "written", vmTables: 2 });
    expect(visionVm.batches.flat().sort()).toEqual(vmTableSources(htmlTableSources(later)).sort());
    const embedVm = vmRunner();
    const reused = await embed(storage, "fresh", later, slots, embedVm);
    expect(embedVm.run).not.toHaveBeenCalled();
    expect(reused.reuse?.metadata).toMatchObject({ status: "hit" });
  });

  it("two writes to one slot, the older PUT landing last: only an exact content match is used (M, H3b)", async () => {
    const early = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const later = `${early}\n\n${header}\n`;
    const storage = new MemoryStorage();
    const earlySlots = await seed(storage, "race", early);
    const newer = storeEmbedTableCells(storeArgs(storage, "race", later, (await seed(storage, "race", later)).canonical, vmRunner(), scope(), "vision-extract"));
    await newer;
    // The retried older write's PUT completes after the newer one and replaces it under the same key.
    await storeEmbedTableCells(storeArgs(storage, "race", early, earlySlots.canonical, vmRunner()));
    const slots = await seed(storage, "race", later);
    const embedVm = vmRunner();
    const result = await embed(storage, "race", later, slots, embedVm);
    // Reported as `stale` (a well-formed artifact for other table sources), logged at info, not as invalid.
    expect(result.reuse?.metadata).toMatchObject({ status: "stale", reason: "artifact written for other table sources" });
    expect(embedVm.run).toHaveBeenCalled();
    expect(stable(result.artifact)).toBe(stable((await oldPath("race", later)).artifact));
    // The same content written twice is the same generation: a hit.
    await storeEmbedTableCells(storeArgs(storage, "race", later, slots.canonical, vmRunner(), scope(), "vision-extract"));
    const again = vmRunner();
    expect((await embed(storage, "race", later, slots, again)).reuse?.metadata).toMatchObject({ status: "hit" });
    expect(again.run).not.toHaveBeenCalled();
  });
});

describe("stored HTML table cells: PII policy (H1)", () => {
  const pii: Scope = scope({ pipeline: { piiPolicy: { enabled: true } } });

  it("never writes on a run with a PII policy", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "pii", text, pii);
    const vm = vmRunner();
    expect(await storeEmbedTableCells(storeArgs(storage, "pii", text, slots.canonical, vm, pii))).toEqual({ status: "pii-policy" });
    expect(vm.run).not.toHaveBeenCalled();
    expect(storage.writes).toEqual([]);
  });

  it("never reads on a run with a PII policy: a planted artifact cannot put matched text into the index", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "pii", text, pii);
    // A well-formed artifact for this run, document and guest whose cells carry text the policy would have redacted.
    vi.stubEnv("DOCSLURP_TABLE_CELLS_CACHE", "on");
    const secret = "123-45-6789";
    const sources = vmTableSources([text]);
    const prepared = new Map(sources.map((source) => [source, (readTableCells(source) ?? []).map((cell) => ({ ...cell, value: secret }))]));
    const key = tableCellsArtifactKey(pii, document("pii", text, pii));
    await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key, runId: "run", documentId: "pii", generation: writerEmbedInputs(text, slots.canonical).generation, guestVersion: tableCellsGuestVersion().version!, prepared, byteCap: 64 * 1024 * 1024 });
    storage.reads.length = 0;
    const vm = vmRunner();
    const result = await embed(storage, "pii", text, slots, vm, pii);
    expect(storage.reads).not.toContain(key);
    expect(vm.run).toHaveBeenCalled();
    expect(stable(result.artifact)).not.toContain(secret);
    expect(result.reuse).toBeUndefined();
  });
});

describe("stored HTML table cells: tenant scope (M6)", () => {
  it("reads and writes exactly its own run's key, under the run's storage prefix, for two organizations", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const runA = scope({ id: "run-a", userId: "user-a", storagePrefix: "orgs/org-a/projects/p1/runs/run-a" });
    const runB = scope({ id: "run-b", userId: "user-b", storagePrefix: "orgs/org-b/projects/p9/runs/run-b" });
    const a = await newPath("shared-doc-id", text, undefined, runA);
    expect(a.key).toBe("orgs/org-a/projects/p1/runs/run-a/table-cells/shared-doc-id.json");
    expect(a.storage.writes.filter((key) => key.includes("/table-cells/"))).toEqual([a.key]);
    // The writer never reads (each write is fresh); embed reads its own key once.
    expect(a.storage.reads.filter((key) => key.includes("/table-cells/"))).toEqual([a.key]);
    // Organization B's same document id, in the same store: it never reads A's key, and A's artifact is not reused.
    const storage = a.storage;
    const slotsB = await seed(storage, "shared-doc-id", text, runB);
    storage.reads.length = 0;
    const vmB = vmRunner();
    const b = await embed(storage, "shared-doc-id", text, slotsB, vmB, runB);
    expect(storage.reads.filter((key) => key.includes("/table-cells/"))).toEqual(["orgs/org-b/projects/p9/runs/run-b/table-cells/shared-doc-id.json"]);
    expect(b.reuse?.metadata).toMatchObject({ status: "missing" });
    expect(vmB.run).toHaveBeenCalled();
    // A copy of A's artifact under B's key is refused (run and document are bound into the artifact header).
    storage.objects.set("orgs/org-b/projects/p9/runs/run-b/table-cells/shared-doc-id.json", storage.objects.get(a.key)!);
    const copied = await embed(storage, "shared-doc-id", text, slotsB, vmRunner(), runB);
    expect(copied.reuse?.metadata).toMatchObject({ status: "invalid" });
  });

  it("a document of another run never writes under this run's key", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "foreign", text);
    const vm = vmRunner();
    const result = await storeEmbedTableCells({ ...storeArgs(storage, "foreign", text, slots.canonical, vm), document: { ...document("foreign", text), runId: "other-run" } });
    expect(result).toMatchObject({ status: "unavailable", error: "document belongs to another run" });
    expect(vm.run).not.toHaveBeenCalled();
    expect(storage.writes).toEqual([]);
  });
});

describe("stored HTML table cells: guest identity (M1)", () => {
  it("comes from the registered parser sandbox's immutable image, unmocked", () => {
    const one = tableCellsGuestVersion(modalSandbox({ imageId: "im-guest1" }));
    const two = tableCellsGuestVersion(modalSandbox({ imageId: "im-guest2" }));
    expect(one.version).toMatch(/^[0-9a-f]{64}$/);
    expect(two.version).toMatch(/^[0-9a-f]{64}$/);
    expect(one.version).not.toBe(two.version);
    expect(tableCellsGuestVersion(modalSandbox({ imageId: "im-guest1" })).version).toBe(one.version);
    const pinned = tableCellsGuestVersion(modalSandbox({ image: `registry.example/parser@sha256:${"a".repeat(64)}` }));
    expect(pinned.version).toMatch(/^[0-9a-f]{64}$/);
    expect(tableCellsGuestVersion(modalSandbox({ image: `registry.example/parser@sha256:${"b".repeat(64)}` })).version).not.toBe(pinned.version);
  });

  it.each([
    ["no registered sandbox", undefined],
    ["a mutable image tag", modalSandbox({ image: "registry.example/parser:latest" })],
    ["a malformed image id", modalSandbox({ imageId: "latest" })],
    ["another provider", modalSandbox({ imageId: "im-guest1" }, "bubblewrap", "local")],
    ["a local modal-named provider", modalSandbox({ imageId: "im-guest1" }, "modal", "local")],
  ])("is unknown with %s, and then nothing is stored or reused", async (_, sandbox) => {
    expect(tableCellsGuestVersion(sandbox).version).toBeNull();
    setDefaultParserSandbox(sandbox);
    const warn = vi.spyOn(console, "warn");
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const after = await newPath("no-guest", text);
    expect(after.stored).toMatchObject({ status: "unavailable" });
    expect(after.storage.objects.has(after.key)).toBe(false);
    expect(after.embedVm.run).toHaveBeenCalled();
    expect(after.reuse?.metadata).toMatchObject({ status: "unavailable" });
    expect(warn.mock.calls.flat().join("\n")).not.toContain("not stored");
  });

  it("another image's artifact is refused", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "img", text);
    await storeEmbedTableCells(storeArgs(storage, "img", text, slots.canonical, vmRunner()));
    setDefaultParserSandbox(modalSandbox({ imageId: "im-guest2" }));
    const vm = vmRunner();
    const result = await embed(storage, "img", text, slots, vm);
    expect(result.reuse?.metadata).toMatchObject({ status: "invalid" });
    expect(vm.run).toHaveBeenCalled();
  });
});

describe("stored HTML table cells: the writer never fails its stage", () => {
  const grownText = () => fixtureDocuments().then((docs) => docs["routing-table-two-line-header.pdf.md grown"]!);

  it("a VM failure is reported (one bounded line) and embed falls back to its own VM", async () => {
    const text = await grownText();
    const storage = new MemoryStorage();
    const slots = await seed(storage, "vm-down", text);
    const long = `sandbox unavailable\n${"x".repeat(1000)}`;
    const stored = await storeEmbedTableCells(storeArgs(storage, "vm-down", text, slots.canonical, { run: vi.fn().mockRejectedValue(new Error(long)) }));
    expect(stored.status).toBe("failed");
    expect(stored.error!.length).toBeLessThanOrEqual(200);
    expect(stored.error).not.toContain("\n");
    const embedVm = vmRunner();
    await embed(storage, "vm-down", text, slots, embedVm);
    expect(embedVm.run).toHaveBeenCalledTimes(1);
  });

  it("a storage write failure is reported, not thrown", async () => {
    const text = await grownText();
    const storage = new MemoryStorage();
    const slots = await seed(storage, "put-fails", text);
    storage.failPut = new Error("SlowDown: reduce your request rate");
    expect(await storeEmbedTableCells(storeArgs(storage, "put-fails", text, slots.canonical, vmRunner()))).toMatchObject({ status: "failed", error: "SlowDown: reduce your request rate" });
  });

  it("its own deadline (M5) is reported as a failure, not thrown", async () => {
    const text = await grownText();
    const storage = new MemoryStorage();
    const slots = await seed(storage, "slow", text);
    const run = vi.fn((_plan: unknown, signal?: AbortSignal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const stored = await storeEmbedTableCells({ ...storeArgs(storage, "slow", text, slots.canonical, { run } as never), deadlineMs: 50 });
    expect(stored).toMatchObject({ status: "failed", error: "deadline of 50 ms exceeded" });
    expect(storage.writes).toEqual([]);
  });

  it("the stage's own abort propagates", async () => {
    const text = await grownText();
    const storage = new MemoryStorage();
    const slots = await seed(storage, "abort", text);
    const controller = new AbortController();
    const run = vi.fn(async () => { controller.abort(new Error("activity cancelled")); throw new Error("command aborted"); });
    await expect(storeEmbedTableCells({ ...storeArgs(storage, "abort", text, slots.canonical, { run } as never), signal: controller.signal })).rejects.toThrow("activity cancelled");
  });

  it("the structural byte cap admits the worst legitimate table (every cell empty)", async () => {
    const sparse = `<table>${Array.from({ length: 3000 }, () => "<tr><td><td><td><td>").join("")}</table>`;
    const text = `# Sparse\n\n${sparse}\n`;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "sparse", text);
    const stored = await storeEmbedTableCells(storeArgs(storage, "sparse", text, slots.canonical, vmRunner()));
    expect(stored.status).toBe("written");
    expect(stored.bytes).toBeLessThanOrEqual(tableCellsByteCap([sparse]));
  });

  it("more than 1,024 tables: not stored", async () => {
    const prepared = new Map(Array.from({ length: 1025 }, (_, i) => [`<table><tr><td>${i}</td></tr></table>`, null] as const));
    const storage = new MemoryStorage();
    expect(await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "r", documentId: "d", generation: "g".repeat(64), guestVersion: "g", prepared, byteCap: 64 * 1024 * 1024 })).toMatchObject({ status: "too-large", tables: 1025, bytes: 0 });
    expect(storage.writes).toEqual([]);
  });
});

describe("stored HTML table cells: stage wiring", () => {
  const extract = (runner: Pick<CommandRunner, "run">, storage: MemoryStorage) => ({ runner, storage, name: "extract-markdown" });
  /** A real WorkflowState over a normalized pipeline: what visionMayReadDocumentPages reads (quality, privacy, playbook, routing pin). */
  const runState = (id: string, text: string, pipeline: Record<string, unknown>, playbook?: string) => {
    const projectRun = {
      id: "run", userId: "u1", orgId: "o1", projectId: "w1", stage: "extract-markdown", status: "processing", stats: {}, artifacts: {}, spentCents: 0,
      pipeline: { ...normalizePipelineFeatures({}), ...pipeline },
    } as unknown as ProjectRun;
    const state = WorkflowState.create(projectRun, [document(id, text)]);
    if (playbook) state.artifactLedger.recordDocument(id, "parser-playbook", playbook);
    return state;
  };
  const wired = async (state: WorkflowState, needsVision: boolean, vm = vmRunner()) => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "wired", text);
    const stats = await ExtractMarkdownStage.prototype.storeTableCellsForEmbed.call(extract(vm, storage) as never, state, document("wired", text),
      { markdown: text, canonicalDocument: slots.canonical, needsVision });
    return { stats, storage, vm };
  };

  it.each([
    // [case, pipeline, needsVision, expected]: extract-markdown writes unless vision will actually read the pages.
    ["Fast quality (vision never reads a page), extraction asked for vision", { quality: "fast", visionFallback: true }, true, "written"],
    ["privacy mode blocks the hosted vision route, extraction asked for vision", { quality: "auto", visionFallback: true, privacyMode: "local-only" }, true, "written"],
    ["vision fallback off, extraction asked for vision", { quality: "auto", visionFallback: false }, true, "written"],
    ["auto quality, extraction asked for vision", { quality: "auto", visionFallback: true }, true, "vision-pending"],
    ["auto quality, no vision needed", { quality: "auto", visionFallback: true }, false, "written"],
    ["good quality reads every page (vision's override) though extraction did not ask", { quality: "good", visionFallback: true }, false, "vision-pending"],
  ] as const)("extract-markdown: %s → %s", async (_, pipeline, needsVision, expected) => {
    const { stats, storage } = await wired(runState("wired", "", pipeline), needsVision);
    expect(stats.status).toBe(expected);
    expect(storage.writes.some((key) => key.includes("/table-cells/"))).toBe(expected === "written");
  });

  it("with the flag off, the status is `off`, never `vision-pending` (Low-3)", async () => {
    vi.stubEnv("DOCSLURP_TABLE_CELLS_CACHE", "");
    const { stats, vm } = await wired(runState("wired", "", { quality: "auto", visionFallback: true }), true);
    expect(stats).toEqual({ status: "off" });
    expect(vm.run).not.toHaveBeenCalled();
    const pii = await wired(runState("wired", "", { quality: "good", visionFallback: true, piiPolicy: { enabled: true, patterns: ["ssn"], action: "redact_artifacts" } }), true);
    vi.stubEnv("DOCSLURP_TABLE_CELLS_CACHE", "on");
    expect((await wired(runState("wired", "", { quality: "good", visionFallback: true, piiPolicy: { enabled: true, patterns: ["ssn"], action: "redact_artifacts" } }), true)).stats).toEqual({ status: "pii-policy" });
    expect(pii.stats).toEqual({ status: "off" });
  });

  it.each([
    // The Fast playbook disallows vision without evidence routing (v1); with evidence routing (v3) a page's own evidence decides.
    ["v1", "written"],
    ["v3", "vision-pending"],
  ] as const)("extract-markdown with the Fast playbook under routing %s → %s", async (pin, expected) => {
    const state = runState("wired", "", { quality: "auto", visionFallback: true }, "fast");
    state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, pin);
    expect((await wired(state, true)).stats.status).toBe(expected);
  });

  it.each(["auto", "good"] as const)("extract-markdown writes for a text-native source under %s quality: vision never reads it (Low)", async (quality) => {
    const state = runState("wired", "", { quality, visionFallback: true });
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "wired", text);
    const markdownDocument = { ...document("wired", text), filename: "tables.md", mimeType: "text/markdown" } as Document;
    expect(visionMayReadDocumentPages(state, markdownDocument, true)).toBe(false);
    const stats = await ExtractMarkdownStage.prototype.storeTableCellsForEmbed.call(extract(vmRunner(), storage) as never, state, markdownDocument, { markdown: text, canonicalDocument: slots.canonical, needsVision: true });
    expect(stats.status).toBe("written");
  });

  it("extract-markdown swallows a writer failure but not the stage's abort", async () => {
    const state = runState("wired", "", { quality: "fast" });
    expect((await wired(state, false, { run: vi.fn().mockRejectedValue(new Error("vm gone")) } as never)).stats).toMatchObject({ status: "failed", error: "vm gone" });
    const controller = new AbortController();
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "wired", text);
    const aborting = { run: vi.fn(async () => { controller.abort(new Error("cancelled")); throw new Error("aborted"); }) };
    await expect(ExtractMarkdownStage.prototype.storeTableCellsForEmbed.call(extract(aborting, storage) as never, state, document("wired", text),
      { markdown: text, canonicalDocument: slots.canonical, needsVision: false }, controller.signal)).rejects.toThrow("cancelled");
  });

  it("the real extract-markdown stage stores cells for the Markdown slot it records, and reports them in its stats (F5)", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-table-cells-stage-"));
    try {
      const storage = new MemoryStorage();
      const vm = vmRunner();
      const runner = {
        run: vm.run,
        officeMarkdown: async () => ({ binary: "python3", args: [], available: true }),
        dopplerMarkdown: async () => ({ binary: "pdftomarkdown", args: [], available: false }),
        extractText: async () => ({ binary: "pdftotext", args: [], available: true }),
        extractMarkdown: async () => ({ binary: "pandoc", args: [], available: true }),
      } as unknown as CommandRunner;
      const stage = new ExtractMarkdownStage(runner, storage as never, {} as never);
      const internals = stage as any;
      const sourcePath = path.join(scratch, "tables.html");
      await writeFile(sourcePath, "<html><body>tables</body></html>");
      internals.sources = { get: async () => ({ path: sourcePath, sha256: "sha-tables" }) };
      internals.recordSourcePageFacts = async () => undefined;
      internals.buildParserArtifacts = async () => [];
      internals.enrichOfficeStructure = async ({ document }: { document: unknown }) => document;
      internals.extractCandidate = async (extractor: { label: string; plan?: unknown }, textKey: string) => {
        const tempTextPath = path.join(scratch, `${extractor.label}.md`);
        await writeFile(tempTextPath, text);
        storage.setText(textKey, text);
        return { label: extractor.label, plan: extractor.plan, textKey, textUri: storage.uri(textKey), tempTextPath };
      };
      const spy = vi.spyOn(internals, "storeTableCellsForEmbed");
      const state = runState("doc-1", text, { quality: "auto", visionFallback: true, markdownExtraction: true });
      state.artifactLedger.recordDocument("doc-1", "normalizedFormat", "html");
      state.bindStore(memoryCheckpointStore());
      await stage.run(state);
      const markdownUri = state.artifactLedger.readDocument("doc-1", "markdown")!;
      expect(spy).toHaveBeenCalledTimes(1);
      const [, , extracted] = spy.mock.calls[0] as [unknown, unknown, { markdown: string; needsVision: boolean }];
      // The Markdown handed to the writer is exactly what the stage recorded in the markdown slot.
      expect(extracted.markdown).toBe(storage.text(markdownUri.replace("s3://t/", "")));
      expect(typeof extracted.needsVision).toBe("boolean");
      expect(extracted.needsVision).toBe((state.documentStage("doc-1", "extract-markdown")?.stats as { needsVision?: boolean }).needsVision);
      const stats = state.documentStage("doc-1", "extract-markdown")?.stats as { tableCells?: { status: string } };
      // This extraction did not ask for vision, so extract-markdown is the last table writer and stores the cells.
      expect(extracted.needsVision).toBe(false);
      expect(stats.tableCells).toMatchObject({ status: "written", vmCommands: 1 });
      // Embed, reading the slots extract-markdown recorded, reuses every table with no VM call.
      const embedVm = vmRunner();
      const canonicalUri = state.artifactLedger.readDocument("doc-1", "canonical-document")!;
      const reuse = await embed(storage, "doc-1", text, { markdownUri, canonicalUri }, embedVm);
      expect(reuse.reuse?.metadata).toMatchObject({ status: "hit", misses: 0 });
      expect(embedVm.run).not.toHaveBeenCalled();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("vision-extract stores the reconciled document's cells, for the reconciled slot, only when it re-read pages", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "vision", text);
    const vm = vmRunner();
    const self = { runner: vm, storage, name: "vision-extract" };
    const state = runState("vision", text, { quality: "auto", visionFallback: true });
    const call = (reconciliation: Record<string, unknown>) => VisionExtractStage.prototype.storeTableCellsForEmbed.call(self as never, state, document("vision", text), reconciliation as never);
    expect(await call({ changedPages: [], markdown: text, canonicalDocument: slots.canonical })).toBeNull();
    expect(await call({ changedPages: [1], markdown: "# none\n", canonicalDocument: undefined })).toEqual({ status: "no-tables" });
    expect(vm.run).not.toHaveBeenCalled();
    expect((await call({ changedPages: [1], markdown: text, canonicalDocument: slots.canonical }))?.status).toBe("written");
  });

  it("in-memory Markdown and the slot it was written to give embed's exact source set (F5), decomposed characters included (F2)", async () => {
    const decomposed = "Café München";
    const docs = await fixtureDocuments();
    const cases = [
      docs["all fixtures in one document"]!,
      `# ${decomposed}\n\n<table><tr><td>${decomposed.repeat(200)}</td></tr></table>\n`,
      `![chart](image://page-1/img-1)\n\n${docs["spans, caption and inline markup"]!}`,
    ];
    for (const markdown of cases) {
      const storage = new MemoryStorage();
      const slots = await seed(storage, "same", markdown);
      // Canonical block text as a non-NFC parser left it: used as stored by both sides, as the chunker reads it.
      const canonical = structuredClone(slots.canonical);
      for (const block of canonical.blocks) block.text = block.text.normalize("NFD");
      await storage.putJson(slots.canonicalUri.replace("s3://t/", ""), canonical);
      const fromSlots = embedHtmlTableSources(await extractTextForEmbedding(document("same", markdown), {} as CommandRunner, storage as unknown as ArtifactStore, slots.markdownUri, undefined, slots.canonicalUri));
      expect(new Set(vmTableSources(writerTableSources(markdown.normalize("NFD"), canonical)))).toEqual(new Set(vmTableSources(fromSlots)));
      // And the same generation: what the writer derived is exactly what embed read.
      const read = await extractTextForEmbedding(document("same", markdown), {} as CommandRunner, storage as unknown as ArtifactStore, slots.markdownUri, undefined, slots.canonicalUri);
      expect(writerEmbedInputs(markdown, canonical).generation).toBe(tableCellsGeneration(embedHtmlTableSources(read)));
    }
  });
});

describe("the parser VM transfer and parse bounds (H2)", () => {
  it("each batch's output cap comes from its tables' structure and is passed to the transfer", async () => {
    const small = Array.from({ length: 3 }, (_, i) => `<table><tr><td>${i}</td><td>x</td></tr></table>`);
    const plans: Array<{ maxOutputBytes?: number }> = [];
    const vm = vmRunner();
    const run = vi.fn(async (plan: { maxOutputBytes?: number; binary: string; args: string[] }, signal?: AbortSignal) => { plans.push(plan); return vm.run(plan, signal); });
    await prepareHtmlTableCells(small, { run } as never);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.maxOutputBytes).toBe(htmlTableCellsOutputBound(small));
    expect(plans[0]!.maxOutputBytes).toBeLessThan(2048);
  });

  it("splits tables into batches whose output bound stays under the batch target; a big table gets a batch of its own", async () => {
    // ~3.9 MB of UTF-8 each: two share a batch (7.8 MB), a third would cross the budget-fitted target (128 MiB / 15).
    const big = (i: number) => `<table><tr><td>${i}${"界".repeat(1_300_000)}</td></tr></table>`;
    const sources = [big(1), big(2), big(3), "<table><tr><td>tiny</td></tr></table>"];
    const vm = vmRunner();
    const plans: Array<{ maxOutputBytes?: number }> = [];
    await prepareHtmlTableCells(sources, { run: vi.fn(async (plan: never, signal?: AbortSignal) => { plans.push(plan); return vm.run(plan, signal); }) } as never);
    expect(vm.batches.map((batch) => batch.length)).toEqual([2, 2]);
    for (const plan of plans) expect(plan.maxOutputBytes! * TABLE_PARSE_HEAP_FACTOR).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(Math.max(...plans.map((plan) => plan.maxOutputBytes!))).toBeLessThanOrEqual(HTML_TABLE_BATCH_OUTPUT_TARGET);
  });

  it("the Modal transfer refuses an output file over the command's cap before reading it, and bounds the read itself", async () => {
    const reads: Array<{ path: string; limit?: number }> = [];
    const out = await mkdtemp(path.join(tmpdir(), "docslurp-staging-cap-"));
    const file = path.join(out, "cells.json");
    const remote = {
      stat: async (p: string) => p === out ? { path: p, isDir: true, size: 0, mtime: 0 } : p === file ? { path: p, isDir: false, size: 5000, mtime: 2 } : null,
      list: async (p: string) => p === out ? [{ path: file, isDir: false, size: 5000, mtime: 2 }] : [],
      readFile: async (p: string, limit?: number) => { reads.push({ path: p, limit }); return new Uint8Array(5000); },
      writeFile: async () => undefined, mkdir: async () => undefined, remove: async () => undefined,
    };
    const staging = new SessionStaging(remote);
    const snapshot = { roots: [out], entries: new Map(), seq: 0 };
    try {
      await expect(staging.download(snapshot, { maxBytes: 4096 })).rejects.toThrow(/exceeds limit/);
      expect(reads).toEqual([]);
      await expect(staging.download(snapshot, { maxBytes: 8192 })).resolves.toBeUndefined();
      expect(reads).toEqual([{ path: file, limit: 8192 }]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it.each([
    ["deep nesting", () => `${"[".repeat(60)}${"]".repeat(60)}`],
    ["a flood of empty records", () => `[[${Array(20).fill("{}").join(",")}]]`],
  ])("rejects guest output with %s before JSON.parse", async (_, payload) => {
    const table = "<table><tr><td>x</td></tr></table>";
    const vm = { run: vi.fn(async (plan: { args: string[] }) => { await writeFile(plan.args.slice(GUEST_NODE_FLAGS.length)[2]!, payload()); return { exitCode: 0, stdout: "", stderr: "" }; }) };
    const parse = vi.spyOn(JSON, "parse");
    await expect(prepareHtmlTableCells([table], vm as never)).rejects.toThrow(/JSON (nesting|container count) exceeds limit/);
    expect(parse.mock.calls.filter(([text]) => typeof text === "string" && text.startsWith("[["))).toEqual([]);
  });

  it("worst-case heap for a hostile payload at the cap is bounded (measured, H2c)", async () => {
    // Shapes JSON.parse amplifies most, each filling a 4 MiB cap. Each must either be refused by the pre-scan or, if
    // allowed, cost at most 12 bytes of heap per input byte (measured ~6 for real cell records).
    v8.setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const cap = 4 * 1024 * 1024;
    const fill = (unit: string, open: string, close: string) => `${open}${Array(Math.floor((cap - open.length - close.length) / (unit.length + 1))).fill(unit).join(",")}${close}`;
    const stored = { maxDepth: 5, maxContainers: Math.floor(cap / 6) + 8 };
    const payloads: Array<[string, () => string, { maxDepth: number; maxContainers: number }]> = [
      ["deep nesting", () => `${"[".repeat(cap / 2 - 1)}${"]".repeat(cap / 2 - 1)}`, stored],
      ["empty arrays", () => fill("[]", "[", "]"), stored],
      ["empty objects", () => fill("{}", "[", "]"), stored],
      ["minimal stored cells", () => fill("[1,1,1,1,0,\"\"]", "[", "]"), stored],
      ["minimal captions", () => fill("[0,\"\"]", "[", "]"), stored],
      // Guest output: one container per cell tag, so a hostile guest can return at most one record per tag.
      ["guest records at the tag limit", () => fill("{\"label\":\"caption\",\"value\":\"\"}", "[[", "]]"), { maxDepth: 3, maxContainers: Math.floor(cap / 31) + 2 }],
    ];
    const measured: Record<string, number | "refused"> = {};
    for (const [name, build, limits] of payloads) {
      let text: string | null = build();
      try { assertJsonShape(text, limits); } catch { measured[name] = "refused"; text = null; continue; }
      const length = text.length;
      gc(); gc(); const before = process.memoryUsage().heapUsed;
      let value: unknown = JSON.parse(text);
      gc(); gc(); const after = process.memoryUsage().heapUsed;
      expect(value).toBeTruthy();
      value = null; text = null;
      measured[name] = Math.round(((after - before) / length) * 10) / 10;
    }
    console.log(`[table-cells heap] bytes of heap per input byte at a 4 MiB cap: ${JSON.stringify(measured)}`);
    expect(measured["deep nesting"]).toBe("refused");
    for (const [name, ratio] of Object.entries(measured)) if (ratio !== "refused") expect(ratio, name).toBeLessThanOrEqual(12);
  });
});

describe("the parser VM path's memory bounds (H2b)", () => {
  afterEach(() => { setTableParseMemoryBudgetForTests(undefined); });
  // About 4,000 records: its real guest output (~300 KB) is far over a 64 KiB per-table cap.
  const wide = `<table>${Array.from({ length: 2000 }, (_, i) => `<tr><td>r${i}</td><td>v${i}</td></tr>`).join("")}</table>`;

  it("a table whose output exceeds the per-table cap gets null cells (chunked as source text); the document succeeds", async () => {
    vi.stubEnv("DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES", String(64 * 1024));
    const small = "<table><tr><td>kept</td></tr></table>";
    const vm = vmRunner();
    const result = await prepareHtmlTableCells([wide, small], vm);
    expect(result.prepared.get(wide)).toBeNull();
    expect(result.prepared.get(small)).toEqual(readTableCells(small));
    expect(result.overCap).toBe(1);
    // Over the cap, the table ran alone under the cap; the small one in a batch of its own kind.
    expect(vm.batches).toEqual(expect.arrayContaining([[wide], [small]]));
  });

  it("a size refusal from the transfer itself (Modal) degrades the same way", async () => {
    vi.stubEnv("DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES", String(64 * 1024));
    const run = vi.fn(async () => { throw new SandboxOutputLimitError("parser VM output file exceeds limit"); });
    const result = await prepareHtmlTableCells([wide], { run } as never);
    expect(result.prepared.get(wide)).toBeNull();
  });

  it("embed output for an over-cap table is exactly the guest's null result; tables under the cap are unchanged", async () => {
    const under = `<table><caption>Q1</caption><tr><th>Region</th><th>Revenue</th></tr>${Array.from({ length: 40 }, (_, i) => `<tr><td>R${i}</td><td>${i * 3}</td></tr>`).join("")}</table>`;
    expect(htmlTableCellsOutputBound([under])).toBeLessThan(64 * 1024);
    const text = `# Wide\n\n${wide}\n\n# Small\n\n${under}\n`;
    // Reference: no cap, the guest itself returns null for the wide table.
    vi.stubEnv("DOCSLURP_TABLE_CELLS_CACHE", "off");
    const refStorage = new MemoryStorage();
    const refSlots = await seed(refStorage, "capped", text);
    const reference = await embed(refStorage, "capped", text, refSlots, vmRunner((cells) => cells.map((records, i) => i === 0 && Array.isArray(records) && records.length > 3000 ? null : records)));
    vi.stubEnv("DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES", String(64 * 1024));
    const storage = new MemoryStorage();
    const slots = await seed(storage, "capped", text);
    const capped = await embed(storage, "capped", text, slots, vmRunner());
    expect(stable(capped.artifact)).toBe(stable(reference.artifact));
  });

  it("concurrent documents never hold more than the worker-wide budget", async () => {
    const doc = (d: number) => Array.from({ length: 6 }, (_, i) => `<table><tr><td>${d}-${i}${"z".repeat(6000)}</td></tr></table>`);
    const runWith = async (total: number) => {
      const budget = new TableParseMemoryBudget(total);
      setTableParseMemoryBudgetForTests(budget);
      let inFlight = 0, peakInFlight = 0;
      const vm = vmRunner();
      const slow = { run: vi.fn(async (plan: never, signal?: AbortSignal) => { inFlight++; peakInFlight = Math.max(peakInFlight, inFlight); await new Promise((resolve) => setTimeout(resolve, 15)); inFlight--; return vm.run(plan, signal); }) };
      const results = await Promise.all([0, 1, 2].map((d) => prepareHtmlTableCells(doc(d), slow as never)));
      for (const [d, result] of results.entries()) for (const source of doc(d)) expect(result.prepared.get(source)).toEqual(readTableCells(source));
      return { budget, peakInFlight };
    };
    // Each document's batch (~37 KB of output) reserves ~555 KB (× TABLE_PARSE_HEAP_FACTOR): 600 KB admits one at a time.
    const tight = await runWith(600 * 1024);
    expect(tight.budget.peak).toBeLessThanOrEqual(600 * 1024);
    expect(tight.peakInFlight).toBe(1);
    expect(tight.budget.inUse).toBe(0);
    // A budget that fits them all lets them overlap.
    const roomy = await runWith(16 * 1024 * 1024);
    expect(roomy.peakInFlight).toBe(3);
    expect(roomy.budget.peak).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("a document's batches run two at a time", async () => {
    vi.stubEnv("DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES", String(64 * 1024));
    let inFlight = 0, peakInFlight = 0;
    const vm = vmRunner();
    const slow = { run: vi.fn(async (plan: never, signal?: AbortSignal) => { inFlight++; peakInFlight = Math.max(peakInFlight, inFlight); await new Promise((resolve) => setTimeout(resolve, 15)); inFlight--; return vm.run(plan, signal); }) };
    // Four tables each over the per-table bound, so four single-table batches.
    const tables = Array.from({ length: 4 }, (_, i) => `<table><tr><td>${i}${"q".repeat(70 * 1024)}</td></tr></table>`);
    await prepareHtmlTableCells(tables, slow as never);
    expect(slow.run).toHaveBeenCalledTimes(4);
    expect(peakInFlight).toBe(2);
  });

  it("dense tables under the cap that together exceed the document cell limit stop at the first batch that crosses it (H2b)", async () => {
    // Each table: 100,000 records (~7.7 MB, under the 8 MiB cap), one batch each. 256,000 cells allow two; the third crosses.
    const dense = (i: number) => `<table><tr>${"<td>".repeat(100_000)}${i}</tr></table>`;
    const tables = Array.from({ length: 6 }, (_, i) => dense(i));
    const record = { label: "row 1 column 1 rowspan 1 colspan 1", value: "", header: false };
    const records = Array.from({ length: 100_000 }, () => record);
    const vm = vmRunner((cells) => cells.map(() => records));
    await expect(prepareHtmlTableCells(tables, vm)).rejects.toThrow(/document cell count exceeds limit/);
    // Two workers: batches 1 and 2, then 3 (which crosses) and at most 4 alongside it; never 5 or 6.
    expect(vm.run.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(vm.run.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("every reservation is the batch's whole cost: transfer caps are lowered to fit the budget, never the reservation (H2b)", async () => {
    const budget = new TableParseMemoryBudget(15 * 100 * 1024);
    setTableParseMemoryBudgetForTests(budget);
    const vm = vmRunner();
    const plans: Array<{ maxOutputBytes?: number }> = [];
    const run = vi.fn(async (plan: never, signal?: AbortSignal) => { plans.push(plan); return vm.run(plan, signal); });
    // One table over the fitted 100 KiB cap (null), and several small ones.
    const tables = [wide, ...Array.from({ length: 8 }, (_, i) => `<table><tr><td>${i}${"s".repeat(20_000)}</td></tr></table>`)];
    const result = await prepareHtmlTableCells(tables, { run } as never);
    expect(effectiveHtmlTableOutputCap()).toBe(100 * 1024);
    for (const plan of plans) expect(plan.maxOutputBytes! * TABLE_PARSE_HEAP_FACTOR).toBeLessThanOrEqual(budget.total);
    expect(budget.peak).toBeLessThanOrEqual(budget.total);
    expect(result.prepared.get(wide)).toBeNull();
    for (const table of tables.slice(1)) expect(result.prepared.get(table)).toEqual(readTableCells(table));
  });

  it("each batch stages into its own input and output directories; only its result file is writable output (M4)", async () => {
    vi.stubEnv("DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES", String(64 * 1024));
    const seen: Array<{ input: string; output: string; outputDirFiles: string[] }> = [];
    const vm = vmRunner();
    const run = vi.fn(async (plan: { args: string[] }, signal?: AbortSignal) => {
      const [, input, output] = plan.args.slice(GUEST_NODE_FLAGS.length);
      seen.push({ input: input!, output: output!, outputDirFiles: await readdir(path.dirname(output!)) });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return vm.run(plan as never, signal);
    });
    const tables = Array.from({ length: 4 }, (_, i) => `<table><tr><td>${i}${"q".repeat(70 * 1024)}</td></tr></table>`);
    await prepareHtmlTableCells(tables, { run } as never);
    expect(new Set(seen.map((entry) => path.dirname(entry.output))).size).toBe(4);
    for (const entry of seen) {
      expect(path.dirname(entry.input)).not.toBe(path.dirname(entry.output));
      expect(entry.outputDirFiles).toEqual([]);
    }
  });

  it("the budget is FIFO and an aborted waiter leaves the queue", async () => {
    const budget = new TableParseMemoryBudget(100);
    const first = await budget.reserve(80);
    const controller = new AbortController();
    const waiting = budget.reserve(50, controller.signal);
    const behind = budget.reserve(10);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    (await behind)();
    first();
    expect(budget.inUse).toBe(0);
  });

  it.each([
    ["a numeric array", () => `[[${Array(200).fill("1").join(",")}]]`],
    ["an over-long string", () => `[[{"label":"caption","value":"${"x".repeat(150)}"}]]`],
  ])("refuses guest output with %s before JSON.parse", async (_, payload) => {
    const table = "<table><tr><td>x</td></tr></table>";
    expect(payload().length).toBeLessThanOrEqual(htmlTableCellsOutputBound([table]) * 3);
    const vm = { run: vi.fn(async (plan: { args: string[] }) => { await writeFile(plan.args.slice(GUEST_NODE_FLAGS.length)[2]!, payload()); return { exitCode: 0, stdout: "", stderr: "" }; }) };
    const parse = vi.spyOn(JSON, "parse");
    await expect(prepareHtmlTableCells([table], vm as never)).rejects.toThrow(/JSON (scalar count|string length) exceeds limit|result exceeds limit/);
    expect(parse.mock.calls.filter(([text]) => typeof text === "string" && text.startsWith("[["))).toEqual([]);
  });
});

describe("the structural output bound covers real guest output (Low-8, Low-9)", () => {
  // Escape-heavy fragments: control characters, quotes, backslashes, named and numeric references (including the
  // multi-code-point and longest-expanding named ones, C0/C1 and surrogate numerics), `<br>`, inline markup.
  const fragments = ["a", "B c", " ", "\t", "\n", "\r\n", "\r", "\"", "\\", "&amp;", "&lt;", "&quot;", "&bsol;", "&#9;", "&#10;", "&#1;",
    "&#x1F600;", "&nbsp;", "&acE;", "&nvlt;", "&bne;", "&NotEqualTilde;", "&nGt;", "&nLt;", "&Afr;", "&#0;", "&#128;", "&#x7f;",
    "&#xD800;", "&#xDFFF;", "&#x10FFFF;", "&#1114112;", "&amp", "&copy", "&", "<", "\u0001", "\u001f", "\u007f", "\u2028", "\u0085",
    "é", "漢", "😀", "\ud800", "\udc00", "<br>", "<br/>", "<b>x</b>", "<i>", "</i>", "\u0000", "\u00a0", "\ufffd"];
  let seed = 4242;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const text = () => Array.from({ length: Math.floor(random() * 7) }, () => pick(fragments)).join("");
  const table = () => {
    let body = random() < 0.2 ? `<caption>${text()}</caption>` : "";
    for (let row = 0, rows = 1 + Math.floor(random() * 4); row < rows; row++) {
      body += "<tr>";
      for (let column = 0, columns = 1 + Math.floor(random() * 4); column < columns; column++) {
        const tag = random() < 0.3 ? "th" : "td";
        body += `<${tag}${random() < 0.2 ? ` colspan="${1 + Math.floor(random() * 3)}"` : ""}>${text()}</${tag}>`;
      }
      body += "</tr>";
    }
    return `<table>${random() < 0.5 ? `<tbody>${body}</tbody>` : body}</table>`;
  };
  // The bound before the single-scan rewrite, kept as the reference the scan must reproduce exactly.
  const regexBound = (source: string) => {
    const growth = 5 * (source.match(/[\u0000-\u001f\u007f]/g)?.length ?? 0) + (source.match(/["\\]/g)?.length ?? 0)
      + 2 * (source.match(/&/g)?.length ?? 0) + 3 * (source.match(/[\uD800-\uDFFF]/g)?.length ?? 0);
    return Buffer.byteLength(source, "utf8") + growth + 96 * (source.match(/<(?:td|th|caption)(?=[\t\n\f\r />])/gi)?.length ?? 0) + 8;
  };

  it("on 20,000 fuzzed escape-heavy tables, real guest output never exceeds the bound, and the scan equals the reference formula", () => {
    let parsed = 0, worst = 0;
    const batch: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const source = table();
      expect(htmlTableCellsOutputBound([source]) - 64).toBe(regexBound(source));
      const cells = readTableCells(source);
      if (!cells) continue;
      parsed++;
      const real = Buffer.byteLength(JSON.stringify(cells)) + 1;
      const bound = htmlTableCellsOutputBound([source]) - 64;
      expect(real, source).toBeLessThanOrEqual(bound);
      worst = Math.max(worst, real / bound);
      if (batch.length < 64) batch.push(source);
    }
    // Most escape-heavy tables are refused by the guest (parse errors: null cells); hundreds still parse.
    expect(parsed).toBeGreaterThan(500);
    expect(worst).toBeLessThan(1);
    // A whole batch, exactly as the guest writes it.
    expect(Buffer.byteLength(JSON.stringify(batch.map(readTableCells)))).toBeLessThanOrEqual(htmlTableCellsOutputBound(batch));
  });

  it("every numeric character reference in the edge ranges stays within the bound", () => {
    const ranges: Array<[number, number]> = [[0, 0x2ff], [0xd7f0, 0xe010], [0xfff0, 0x10010], [0x10fff0, 0x110010]];
    for (const [from, to] of ranges) {
      for (let code = from; code <= to; code++) {
        for (const ref of [`&#${code};`, `&#x${code.toString(16)};`, `&#${code}`]) {
          const source = `<table><tr><td>${ref}${ref}</td></tr></table>`;
          const cells = readTableCells(source);
          if (!cells) continue;
          expect(Buffer.byteLength(JSON.stringify(cells)) + 1, ref).toBeLessThanOrEqual(htmlTableCellsOutputBound([source]) - 64);
        }
      }
    }
  });
});

describe("stored HTML table cells: keys and limits", () => {
  it("the per-table output cap in effect is part of the cache identity (M3)", () => {
    const sources = ["<table><tr><td>x</td></tr></table>"];
    const atDefault = tableCellsGeneration(sources);
    vi.stubEnv("DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES", String(64 * 1024));
    expect(tableCellsGeneration(sources)).not.toBe(atDefault);
    vi.stubEnv("DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES", "");
    expect(tableCellsGeneration(sources)).toBe(atDefault);
  });

  it("hashes the exact parser input: sources differing only by an unpaired surrogate do not collide", () => {
    const lone = "<table><tr><td>\uD800</td></tr></table>", replaced = "<table><tr><td>�</td></tr></table>";
    expect(createHash("sha256").update(lone, "utf8").digest("hex")).toBe(createHash("sha256").update(replaced, "utf8").digest("hex"));
    expect(tableSourceSha256(lone)).not.toBe(tableSourceSha256(replaced));
  });

  it("more than 1,024 tables: nothing parsed, nothing built (F4)", async () => {
    const markdown = Array.from({ length: 1025 }, (_, i) => `<table><tr><td>${i}</td></tr></table>`).join("\n\n");
    const storage = new MemoryStorage();
    const slots = await seed(storage, "many", markdown);
    const vm = vmRunner();
    expect(await storeEmbedTableCells(storeArgs(storage, "many", markdown, slots.canonical, vm))).toEqual({ status: "too-large", tables: 1025 });
    expect(vm.run).not.toHaveBeenCalled();
    expect(storage.writes).toEqual([]);
  });

  it("the writer stops at the cap while serializing, before building the artifact (H2d)", async () => {
    const tables = Array.from({ length: 50 }, (_, i) => `<table><tr><td>${String(i).repeat(1000)}</td></tr></table>`);
    const prepared = new Map(tables.map((t) => [t, readTableCells(t)]));
    const concat = vi.spyOn(Buffer, "concat");
    const storage = new MemoryStorage();
    const result = await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "r", documentId: "d", generation: "g".repeat(64), guestVersion: "g", prepared, byteCap: 5000 });
    expect(result.status).toBe("too-large");
    expect(result.bytes).toBeLessThan(5000 + 2000);
    expect(concat).not.toHaveBeenCalled();
    expect(storage.writes).toEqual([]);
  });

  it("the writer's deadline covers the upload: a PUT in flight is cancelled (M5)", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "slow-put", text);
    storage.holdPut = true;
    const stored = await storeEmbedTableCells({ ...storeArgs(storage, "slow-put", text, slots.canonical, vmRunner()), deadlineMs: 300 });
    expect(stored).toMatchObject({ status: "failed", error: "deadline of 300 ms exceeded" });
    expect(storage.abortedPuts).toEqual([tableCellsArtifactKey(scope(), document("slow-put", text))]);
    expect(storage.objects.has(tableCellsArtifactKey(scope(), document("slow-put", text)))).toBe(false);
  });
});

describe("stored HTML table cells: fail closed to the VM path", () => {
  const text = () => fixtureDocuments().then((docs) => docs["all fixtures in one document"]!);
  type Artifact = { schema: string; runId: string; documentId: string; generation: string; guestVersion: string; bytes: string; tables: Array<[string, unknown]> };
  // Edits keep the recorded length right, so each case reaches the check it is about.
  const edit = (change: (artifact: Artifact) => void) => (key: string, storage: MemoryStorage) => {
    const artifact = JSON.parse(storage.text(key)!) as Artifact;
    change(artifact);
    storage.setText(key, withLength(artifact));
  };
  const firstCells = (artifact: Artifact) => artifact.tables.find(([, cells]) => Array.isArray(cells) && cells.length > 0)![1] as unknown[][];

  async function expectVmFallback(name: string, tamper: (key: string, storage: MemoryStorage) => void, status: "missing" | "invalid" | "partial") {
    const body = await text();
    const id = `neg-${name}`;
    const before = await oldPath(id, body);
    const after = await newPath(id, body, tamper);
    expect(after.reuse?.metadata, name).toMatchObject({ status });
    expect(after.embedVm.run, name).toHaveBeenCalled();
    expect(stable(after.artifact), name).toBe(stable(before.artifact));
    return after;
  }

  it("tampered artifact: a hash that no longer matches its table's source is a miss, parsed in a VM", async () => {
    const after = await expectVmFallback("hash", edit((artifact) => { artifact.tables[0]![0] = tableSourceSha256("<table><tr><td>other</td></tr></table>"); }), "partial");
    expect(after.embedVm.batches.flat()).toHaveLength(1);
  });

  it("oversized artifact (the store reports its length): refused before reading", async () => {
    const after = await expectVmFallback("oversized", (key, storage) => { storage.setText(key, " ".repeat(64 * 1024 * 1024 + 1)); }, "invalid");
    expect(after.storage.pulled.get(after.key) ?? 0).toBe(0);
  });

  it("oversized artifact without a length: the transfer stops at the cap", async () => {
    const after = await expectVmFallback("chunked", (key, storage) => { storage.hideLength = true; storage.setText(key, " ".repeat(64 * 1024 * 1024)); }, "invalid");
    const cap = tableCellsByteCap(htmlTableSources(after.storage.text("u1/run/markdown/neg-chunked.md")!));
    expect(after.storage.pulled.get(after.key)!).toBeLessThanOrEqual(cap + 64 * 1024);
    expect(after.storage.pulled.get(after.key)!).toBeLessThan(64 * 1024 * 1024);
  });

  it("missing artifact", async () => {
    await expectVmFallback("missing", (key, storage) => { storage.objects.delete(key); }, "missing");
  });

  it.each([
    ["another document", (artifact: Artifact) => { artifact.documentId = "someone-elses-document"; }],
    ["another run", (artifact: Artifact) => { artifact.runId = "another-run"; }],
    ["another guest", (artifact: Artifact) => { artifact.guestVersion = "0".repeat(64); }],
    ["unknown schema", (artifact: Artifact) => { artifact.schema = "docslurp.html-table-cells.v1"; }],
    ["an unexpected top-level field", (artifact: Artifact) => { (artifact as Record<string, unknown>).extra = 1; }],
    ["a malformed hash", (artifact: Artifact) => { artifact.tables[0]![0] = "ABC"; }],
    ["a duplicate hash", (artifact: Artifact) => { artifact.tables.push([...artifact.tables[0]!]); }],
    ["an entry that is not a pair", (artifact: Artifact) => { (artifact.tables as unknown[])[0] = { sha256: artifact.tables[0]![0], cells: null }; }],
    ["cells that are not a list", (artifact: Artifact) => { artifact.tables[0]![1] = { label: "caption", value: "x" }; }],
    ["a non-string value", (artifact: Artifact) => { firstCells(artifact)[0]![5] = 42; }],
    ["a nested value", (artifact: Artifact) => { firstCells(artifact)[0]![5] = ["x"]; }],
    ["a bad header flag", (artifact: Artifact) => { firstCells(artifact)[0]![4] = 3; }],
    ["a cell position out of range", (artifact: Artifact) => { firstCells(artifact)[0]![0] = 10_000; }],
    ["an extra cell field", (artifact: Artifact) => { firstCells(artifact)[0]!.push("extra"); }],
    ["an oversized value", (artifact: Artifact) => { firstCells(artifact)[0]![5] = "x".repeat(4 * 1024 * 1024 + 1); }],
  ])("artifact with %s discards the whole artifact", async (name, change) => {
    await expectVmFallback(`artifact-${name}`, edit(change), "invalid");
  });

  it("truncated JSON discards the whole artifact", async () => {
    await expectVmFallback("json", (key, storage) => { storage.setText(key, storage.text(key)!.slice(0, -10)); }, "invalid");
  });

  it("a foreign header is refused before the body is parsed", async () => {
    const storage = new MemoryStorage();
    const a = "<table><tr><td>x</td></tr></table>";
    await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "other-run", documentId: "d", generation: "g".repeat(64), guestVersion: "g", prepared: new Map([[a, readTableCells(a)]]), byteCap: 1 << 20 });
    const parse = vi.spyOn(JSON, "parse");
    const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "r", documentId: "d", generation: "g".repeat(64), guestVersion: "g", sources: [a] });
    expect(lookup).toMatchObject({ status: "invalid", reason: expect.stringContaining("header mismatch") });
    expect(parse).not.toHaveBeenCalled();
  });

  const g = "g".repeat(64);
  const scopeArgs = { runId: "r", documentId: "d", generation: g, guestVersion: "g" };
  const headerOf = (bytes: number) => `{"schema":"${TABLE_CELLS_ARTIFACT_SCHEMA}","runId":"r","documentId":"d","generation":"${g}","guestVersion":"g","bytes":"${String(bytes).padStart(10, "0")}","tables":[`;

  it("the read budget comes from the tables looked up, never from the artifact's header (H2a)", async () => {
    const tables = Array.from({ length: 4 }, (_, i) => `<table><tr><td>${String(i).repeat(5000)}</td></tr></table>`);
    const storage = new MemoryStorage();
    await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, prepared: new Map(tables.map((t) => [t, readTableCells(t)])), byteCap: tableCellsByteCap(tables) });
    expect((await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, sources: tables })).status).toBe("hit");
    // Looked up for one table, the four-table artifact is over budget: refused from its header, body unread.
    storage.hideLength = true;
    const parse = vi.spyOn(JSON, "parse");
    const one = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, sources: tables.slice(0, 1) });
    expect(one).toMatchObject({ status: "invalid", reason: "artifact exceeds the read budget for these tables" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("millions of compact captions under the 64 MiB ceiling are refused from the header, before the body is read (H2a)", async () => {
    const table = "<table><caption>c</caption><tr><td>x</td></tr></table>";
    const captions = Array(5_000_000).fill('[0,""]').join(",");
    const body = `["${tableSourceSha256(table)}",[${captions}]]]}`;
    const storage = new MemoryStorage();
    storage.hideLength = true;
    const length = Buffer.byteLength(headerOf(0)) + Buffer.byteLength(body);
    storage.setText("k", `${headerOf(length)}${body}`);
    expect(length).toBeLessThan(64 * 1024 * 1024);
    const parse = vi.spyOn(JSON, "parse");
    const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, sources: [table] });
    expect(lookup).toMatchObject({ status: "invalid", reason: "artifact exceeds the read budget for these tables" });
    expect(storage.pulled.get("k")!).toBeLessThanOrEqual(64 * 1024);
    expect(parse).not.toHaveBeenCalled();
  });

  it.each([
    ["a scalar flood", (table: string) => `["${tableSourceSha256(table)}",[[1,1,1,1,0,""${",1".repeat(400)}]]]`],
    ["an over-long string", (table: string) => `["${tableSourceSha256(table)}",[[0,"${"x".repeat(600)}"]]]`],
  ])("within the byte budget, %s is refused before JSON.parse (H2a)", async (_, entry) => {
    const table = `<table><tr><td>${"y".repeat(300)}</td></tr></table>`;
    const body = `${entry(table)}]}`;
    const storage = new MemoryStorage();
    const length = Buffer.byteLength(headerOf(0)) + Buffer.byteLength(body);
    expect(length).toBeLessThanOrEqual(tableCellsByteCap([table]));
    storage.setText("k", `${headerOf(length)}${body}`);
    const parse = vi.spyOn(JSON, "parse");
    const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, sources: [table] });
    expect(lookup).toMatchObject({ status: "invalid", reason: expect.stringMatching(/JSON (scalar count|string length) exceeds limit/) });
    expect(parse).not.toHaveBeenCalled();
  });

  it("reads into one buffer of the recorded length, with no concatenation of the body (Low-7)", async () => {
    const tables = Array.from({ length: 8 }, (_, i) => `<table><tr><td>${String(i).repeat(40_000)}</td></tr></table>`);
    const storage = new MemoryStorage();
    await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, prepared: new Map(tables.map((t) => [t, readTableCells(t)])), byteCap: tableCellsByteCap(tables) });
    const length = storage.objects.get("k")!.length;
    expect(length).toBeGreaterThan(4 * 64 * 1024);
    const concat = vi.spyOn(Buffer, "concat");
    const allocUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    expect((await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, sources: tables })).status).toBe("hit");
    // One concatenation, of the first chunk (the header); the body is allocated once at the recorded length.
    expect(concat.mock.calls.length).toBeLessThanOrEqual(1);
    expect(allocUnsafe.mock.calls.filter(([size]) => size === length)).toHaveLength(1);
  });

  it("tag-heavy sources do not raise the pre-scan past the document cell limit: a malformed artifact is refused before JSON.parse (H2a)", async () => {
    // Three tables of ~1M cell tags each: 3M tags, but at most 256,000 records may be decoded.
    const sources = [0, 1, 2].map((i) => `<table><tr>${"<td>".repeat(1_000_000)}${i}</tr></table>`);
    // Within the byte budget: 400,000 empty records under one hash, more containers than the document limit allows.
    const body = `["${tableSourceSha256(sources[0]!)}",[${Array(400_000).fill("[]").join(",")}]]]}`;
    const storage = new MemoryStorage();
    storage.setText("k", `${headerOf(Buffer.byteLength(headerOf(0)) + Buffer.byteLength(body))}${body}`);
    expect(storage.objects.get("k")!.length).toBeLessThan(tableCellsByteCap(sources));
    setTableParseMemoryBudgetForTests(new TableParseMemoryBudget(4 * 1024 * 1024 * 1024));
    const parse = vi.spyOn(JSON, "parse");
    try {
      const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, sources });
      expect(lookup).toMatchObject({ status: "invalid", reason: "JSON container count exceeds limit" });
      expect(parse).not.toHaveBeenCalled();
    } finally { setTableParseMemoryBudgetForTests(undefined); }
  });

  it("a read whose reservation (bytes × parse factor) cannot fit the worker budget is not attempted (H2a)", async () => {
    const sources = [0, 1, 2].map((i) => `<table><tr>${"<td>".repeat(1_000_000)}${i}</tr></table>`);
    const storage = new MemoryStorage();
    storage.setText("k", "{}");
    const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, sources });
    expect(tableCellsByteCap(sources) * TABLE_PARSE_HEAP_FACTOR).toBeGreaterThan(128 * 1024 * 1024);
    expect(lookup).toMatchObject({ status: "unavailable", reason: "artifact read would exceed the worker table-parse budget" });
    expect(storage.reads).toEqual([]);
  });

  it("bytes past the recorded length stop the transfer there", async () => {
    const tables = Array.from({ length: 4 }, (_, i) => `<table><tr><td>${String(i).repeat(5000)}</td></tr></table>`);
    const storage = new MemoryStorage();
    await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, prepared: new Map(tables.map((t) => [t, readTableCells(t)])), byteCap: tableCellsByteCap(tables) });
    storage.hideLength = true;
    storage.setText("k", `${storage.text("k")}${" ".repeat(1 << 20)}`);
    const longer = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, sources: tables });
    expect(longer.status).toBe("invalid");
    expect(storage.pulled.get("k")!).toBeLessThan(storage.objects.get("k")!.length);
  });

  it("an artifact over the document's cell budget is refused as a whole, before its records are decoded (M2)", async () => {
    // 270,000 records across three tables of 90,000 cells each exceed the 256,000-cell document budget.
    const sources = [0, 1, 2].map((i) => `<table><tr>${"<td>".repeat(90_000)}${i}</tr></table>`);
    const storage = new MemoryStorage();
    storage.setText("k", withLength({ schema: TABLE_CELLS_ARTIFACT_SCHEMA, ...scopeArgs, bytes: "", tables: sources.map((source) => [tableSourceSha256(source), Array.from({ length: 90_000 }, () => [1, 1, 1, 1, 0, ""])]) }));
    // A worker budget large enough for this read's reservation, so the decode-time check is what refuses it.
    setTableParseMemoryBudgetForTests(new TableParseMemoryBudget(2 * 1024 * 1024 * 1024));
    const parse = vi.spyOn(JSON, "parse");
    try {
      const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", ...scopeArgs, sources });
      // The pre-scan's record limit is clamped to the document's cells (H2a), so it refuses this before parsing.
      expect(lookup).toMatchObject({ status: "invalid", reason: expect.stringMatching(/JSON container count exceeds limit|artifact exceeds the document budget/) });
      expect(parse).not.toHaveBeenCalled();
    } finally { setTableParseMemoryBudgetForTests(undefined); }
  });

  it("stored cells that push the document over its budget are dropped; every table is parsed in a VM once more (M2)", async () => {
    const a1 = `<table><tr><td>a1</td></tr></table>`, a2 = `<table><tr><td>a2</td></tr></table>`, b = `<table><tr><td>b</td></tr></table>`;
    // Two poisoned hits, each at the per-table limit, fill the 256,000-cell document budget; the honest miss crosses it.
    const poisoned = () => Array.from({ length: 128_000 }, () => ({ label: "row 1 column 1 rowspan 1 colspan 1", value: "", header: false }));
    const vm = vmRunner();
    const result = await prepareHtmlTableCells([a1, a2, b], vm, undefined, { cached: new Map([[a1, poisoned()], [a2, poisoned()]]) });
    expect(vm.batches).toEqual([[b], [a1, a2, b]]);
    expect(result.prepared.get(a1)).toEqual(readTableCells(a1));
    expect(result.prepared.get(a2)).toEqual(readTableCells(a2));
    expect(result.cachedTables).toBe(0);
  });

  it("looks a table up only under the sha256 of the exact source chunking asks for", async () => {
    const storage = new MemoryStorage();
    const a = "<table><tr><td>A</td></tr></table>", b = "<table><tr><td>B</td></tr></table>";
    await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "run", documentId: "doc", generation: "g".repeat(64), guestVersion: "g", prepared: new Map([[a, readTableCells(a)]]), byteCap: 1 << 20 });
    const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "run", documentId: "doc", generation: "g".repeat(64), guestVersion: "g", sources: [` ${a} `, b] });
    expect(lookup.status).toBe("partial");
    expect([...lookup.cached.keys()]).toEqual([a]);
    expect(lookup.cached.get(a)).toEqual(readTableCells(a));
  });
});

describe("the VM boundary (H2)", () => {
  const table = "<table><tr><td>x</td></tr></table>";
  it.each<[string, (cell: Record<string, unknown>) => unknown]>([
    ["an extra field", (cell: Record<string, unknown>) => ({ ...cell, html: "<script>" })],
    ["a nested value", (cell: Record<string, unknown>) => ({ ...cell, value: { text: "x" } })],
    ["a nested header", (cell: Record<string, unknown>) => ({ ...cell, header: [true] })],
    ["an array instead of a record", () => ["row 1 column 1 rowspan 1 colspan 1", "x"]],
  ])("rejects guest output with %s", async (_, change) => {
    const vm = vmRunner((cells) => (cells as Array<Array<Record<string, unknown>>>).map((records) => records.map(change)));
    // Refused either by the pre-scan (nesting) or by the record check: never accepted.
    await expect(prepareHtmlTableCells([table], vm)).rejects.toThrow(/invalid HTML table cell|JSON (nesting|scalar count) exceeds limit/);
  });
});
