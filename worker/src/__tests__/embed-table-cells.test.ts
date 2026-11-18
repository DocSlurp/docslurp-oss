import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
  readTableCellsArtifact, tableCellsArtifactKey, tableCellsByteCap, tableCellsCacheEnabled, tableCellsGuestVersion, tableSourceSha256,
  TABLE_CELLS_ARTIFACT_SCHEMA, writeTableCellsArtifact,
} from "../pipeline/html-table-cells-cache.js";
import { prepareHtmlTableCells, vmTableSources } from "../pipeline/html-table-vm.js";
import { EmbedStage } from "../stages/embed.js";
import { htmlTableSources } from "../pipeline/chunking.js";
import { mayHaveHtmlTables, storeEmbedTableCells } from "../stages/embed-table-cells.js";
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
  uri(key: string) { return `s3://t/${key}`; }
  private get(key: string): Buffer {
    const value = this.objects.get(key);
    if (value === undefined) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    return value;
  }
  async getBytes(key: string) { this.reads.push(key); return this.get(key); }
  async getJson<T>(key: string): Promise<T> { this.reads.push(key); return JSON.parse(this.get(key).toString("utf8")) as T; }
  async putJson(key: string, value: unknown) { this.writes.push(key); this.objects.set(key, Buffer.from(JSON.stringify(value))); }
  async putBytes(key: string, data: Uint8Array) {
    if (this.failPut) throw this.failPut;
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

  it("sends only tables missing from the artifact (written later) to a VM, with identical output", async () => {
    const early = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const later = `${early}\n\n# Vision page\n\n${header}\n`;
    const storage = new MemoryStorage();
    const first = await seed(storage, "partial", early);
    await storeEmbedTableCells(storeArgs(storage, "partial", early, first.canonical, vmRunner()));
    const slots = await seed(storage, "partial", later);
    const embedVm = vmRunner();
    const result = await embed(storage, "partial", later, slots, embedVm);
    expect(embedVm.batches.flat()).toEqual([header]);
    expect(result.reuse?.metadata).toMatchObject({ status: "partial", hits: 1, misses: 1 });
    const before = await oldPath("partial", later);
    expect(stable(result.artifact)).toBe(stable(before.artifact));
  });

  it("a later writer (vision-extract) adds new tables and keeps the parsed ones without re-parsing them", async () => {
    const early = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const later = `${early}\n\n${header}\n`;
    const storage = new MemoryStorage();
    await storeEmbedTableCells(storeArgs(storage, "merge", early, (await seed(storage, "merge", early)).canonical, vmRunner()));
    const visionVm = vmRunner();
    const slots = await seed(storage, "merge", later);
    const stored = await storeEmbedTableCells(storeArgs(storage, "merge", later, slots.canonical, visionVm, scope(), "vision-extract"));
    expect(stored).toMatchObject({ status: "written", reusedTables: 1, vmTables: 1 });
    expect(visionVm.batches.flat()).toEqual([header]);
    const embedVm = vmRunner();
    await embed(storage, "merge", later, slots, embedVm);
    expect(embedVm.run).not.toHaveBeenCalled();
    const again = vmRunner();
    storage.writes.length = 0;
    expect(await storeEmbedTableCells(storeArgs(storage, "merge", later, slots.canonical, again, scope(), "vision-extract"))).toMatchObject({ status: "current" });
    expect(again.run).not.toHaveBeenCalled();
    expect(storage.writes).toEqual([]);
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
    await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key, runId: "run", documentId: "pii", guestVersion: tableCellsGuestVersion().version!, prepared, byteCap: 64 * 1024 * 1024 });
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
    expect(a.storage.reads.filter((key) => key.includes("/table-cells/"))).toEqual([a.key, a.key]);
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

  it("too large for the document's byte cap: not stored", async () => {
    // Many empty cells: the encoding outgrows twice the source.
    const tiny = `<table>${Array.from({ length: 3000 }, () => "<tr><td><td><td><td>").join("")}</table>`;
    const text = `# Sparse\n\n${tiny}\n`;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "sparse", text);
    const stored = await storeEmbedTableCells(storeArgs(storage, "sparse", text, slots.canonical, vmRunner()));
    expect(stored.status).toBe("too-large");
    expect(stored.bytes).toBeGreaterThan(tableCellsByteCap([tiny]));
    expect(storage.writes).toEqual([]);
  });

  it("more than 1,024 tables: not stored", async () => {
    const prepared = new Map(Array.from({ length: 1025 }, (_, i) => [`<table><tr><td>${i}</td></tr></table>`, null] as const));
    const storage = new MemoryStorage();
    expect(await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "r", documentId: "d", guestVersion: "g", prepared, byteCap: 64 * 1024 * 1024 })).toMatchObject({ status: "too-large", tables: 1025 });
    expect(storage.writes).toEqual([]);
  });
});

describe("stored HTML table cells: stage wiring", () => {
  const extract = (runner: Pick<CommandRunner, "run">, storage: MemoryStorage) => ({ runner, storage, name: "extract-markdown" });
  const state = (run: Scope, visionFallback: boolean) => ({ run: { ...run, pipeline: { ...run.pipeline, visionFallback } } }) as unknown as WorkflowState;

  it("extract-markdown stores cells, skips when vision will re-read pages (H3b) and when there are no tables", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "wired", text);
    const call = (needsVision: boolean, visionFallback: boolean, markdown = text, vm = vmRunner()) =>
      ExtractMarkdownStage.prototype.storeTableCellsForEmbed.call(extract(vm, storage) as never, state(scope(), visionFallback), document("wired", text), { markdown, canonicalDocument: markdown === text ? slots.canonical : buildCanonicalDocumentFromMarkdown({ documentId: "wired", text: markdown, pageCount: 1, extractor: "t" }), needsVision });
    expect(await call(true, true)).toEqual({ status: "vision-pending" });
    expect(storage.writes).toEqual([]);
    expect(await call(false, true, "# no tables\n")).toEqual({ status: "no-tables" });
    expect((await call(true, false)).status).toBe("written");
  });

  it("extract-markdown swallows a writer failure but not the stage's abort", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "wired", text);
    const failing = { run: vi.fn().mockRejectedValue(new Error("vm gone")) };
    expect(await ExtractMarkdownStage.prototype.storeTableCellsForEmbed.call(extract(failing, storage) as never, state(scope(), false), document("wired", text), { markdown: text, canonicalDocument: slots.canonical, needsVision: false }, undefined)).toMatchObject({ status: "failed" });
    const controller = new AbortController();
    const aborting = { run: vi.fn(async () => { controller.abort(new Error("cancelled")); throw new Error("aborted"); }) };
    await expect(ExtractMarkdownStage.prototype.storeTableCellsForEmbed.call(extract(aborting, storage) as never, state(scope(), false), document("wired", text), { markdown: text, canonicalDocument: slots.canonical, needsVision: false }, controller.signal)).rejects.toThrow("cancelled");
  });

  it("vision-extract stores the reconciled document's cells only when it re-read pages", async () => {
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "vision", text);
    const vm = vmRunner();
    const self = { runner: vm, storage, name: "vision-extract" };
    expect(await VisionExtractStage.prototype.storeTableCellsForEmbed.call(self as never, state(scope(), true), document("vision", text), { changedPages: [], markdown: text, canonicalDocument: slots.canonical })).toBeNull();
    expect(await VisionExtractStage.prototype.storeTableCellsForEmbed.call(self as never, state(scope(), true), document("vision", text), { changedPages: [1], markdown: "# none\n", canonicalDocument: undefined })).toEqual({ status: "no-tables" });
    expect(vm.run).not.toHaveBeenCalled();
    expect((await VisionExtractStage.prototype.storeTableCellsForEmbed.call(self as never, state(scope(), true), document("vision", text), { changedPages: [1], markdown: text, canonicalDocument: slots.canonical }))?.status).toBe("written");
  });
});

describe("stored HTML table cells: fail closed to the VM path", () => {
  const text = () => fixtureDocuments().then((docs) => docs["all fixtures in one document"]!);
  type Artifact = { schema: string; runId: string; documentId: string; guestVersion: string; tables: Array<[string, unknown]> };
  const edit = (change: (artifact: Artifact) => void) => (key: string, storage: MemoryStorage) => {
    const artifact = JSON.parse(storage.text(key)!) as Artifact;
    change(artifact);
    storage.setText(key, JSON.stringify(artifact));
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
    const parse = vi.spyOn(JSON, "parse");
    const storage = new MemoryStorage();
    storage.setText("k", `{"schema":"${TABLE_CELLS_ARTIFACT_SCHEMA}","runId":"other","documentId":"d","guestVersion":"g","tables":[]}`);
    const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "r", documentId: "d", guestVersion: "g", sources: ["<table><tr><td>x</td></tr></table>"] });
    expect(lookup).toMatchObject({ status: "invalid", reason: expect.stringContaining("header mismatch") });
    expect(parse).not.toHaveBeenCalled();
  });

  it("an artifact over the document's cell budget is refused as a whole (M2)", async () => {
    // Three large sources raise the byte cap; 270,000 empty cells across them exceed the 256,000-cell document budget.
    const sources = [0, 1, 2].map((i) => `<table><tr><td>${String(i).repeat(1_500_000)}</td></tr></table>`);
    const tables = sources.map((source) => JSON.stringify([tableSourceSha256(source), Array.from({ length: 90_000 }, () => [1, 1, 1, 1, 0, ""])]));
    const storage = new MemoryStorage();
    storage.setText("k", `{"schema":"${TABLE_CELLS_ARTIFACT_SCHEMA}","runId":"r","documentId":"d","guestVersion":"g","tables":[${tables.join(",")}]}`);
    const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "r", documentId: "d", guestVersion: "g", sources });
    expect(lookup).toMatchObject({ status: "invalid", reason: "artifact exceeds the document budget" });
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
    await writeTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "run", documentId: "doc", guestVersion: "g", prepared: new Map([[a, readTableCells(a)]]), byteCap: 1 << 20 });
    const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key: "k", runId: "run", documentId: "doc", guestVersion: "g", sources: [` ${a} `, b] });
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
    await expect(prepareHtmlTableCells([table], vm)).rejects.toThrow(/invalid HTML table cell/);
  });
});
