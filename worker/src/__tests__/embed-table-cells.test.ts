import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizePipelineFeatures } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

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
// The guest parser's identity comes from built files; tests pin it.
const guest = vi.hoisted(() => ({ version: "guest-v1" as string | null }));
vi.mock("../pipeline/html-table-cells-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pipeline/html-table-cells-cache.js")>()),
  tableCellsGuestVersion: async () => guest.version,
}));

import { fromEnv } from "../config.js";
import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import type { Document, ProjectRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { memoryCheckpointStore } from "../pipeline/checkpoint-store-memory.js";
import { readTableCells } from "../pipeline/table-cells-guest.js";
import { readTableCellsArtifact, tableCellsArtifactKey, tableSourceSha256, TABLE_CELLS_ARTIFACT_MAX_BYTES, TABLE_CELLS_ARTIFACT_SCHEMA } from "../pipeline/html-table-cells-cache.js";
import { vmTableSources } from "../pipeline/html-table-vm.js";
import { EmbedStage } from "../stages/embed.js";
import { mayHaveHtmlTables, storeEmbedTableCells } from "../stages/embed-table-cells.js";
import type { CommandRunner } from "../tools/runner.js";
import { StorageObjectTooLargeError, type ArtifactStore } from "../tools/storage.js";
import { GUEST_NODE_FLAGS } from "../sandbox/guest-node-flags.js";

/** S3-like: a missing key is a 404, a read past maxBytes is refused before parsing. */
class MemoryStorage {
  readonly bucket = "t";
  readonly objects = new Map<string, string>();
  readonly reads: string[] = [];
  uri(key: string) { return `s3://t/${key}`; }
  private object(key: string, maxBytes?: number): string {
    this.reads.push(key);
    const value = this.objects.get(key);
    if (value === undefined) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    const size = Buffer.byteLength(value);
    if (maxBytes !== undefined && size > maxBytes) throw new StorageObjectTooLargeError(key, size, maxBytes);
    return value;
  }
  async getBytes(key: string, options?: { maxBytes?: number }) { return Buffer.from(this.object(key, options?.maxBytes), "utf8"); }
  async getJson<T>(key: string, options?: { maxBytes?: number }): Promise<T> { return JSON.parse(this.object(key, options?.maxBytes)) as T; }
  async putJson(key: string, value: unknown) { this.objects.set(key, JSON.stringify(value)); }
}

/** A parser VM stand-in that runs the real guest parser on the staged batch (table-cells.mjs), counting commands. */
function vmRunner() {
  const batches: string[][] = [];
  const run = vi.fn(async (plan: { binary: string; args: string[] }) => {
    expect(plan.binary).toBe("node");
    const [script, input, output] = plan.args.slice(GUEST_NODE_FLAGS.length);
    expect(path.basename(script!)).toBe("table-cells.mjs");
    const batch = JSON.parse(await readFile(input!, "utf8")) as string[];
    batches.push(batch);
    await writeFile(output!, JSON.stringify(batch.map(readTableCells)));
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { run, batches };
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

const run = { id: "run", storagePrefix: null };
const document = (id: string, text: string): Document => ({
  id, userId: "u1", runId: "run", filename: "tables.pdf", mimeType: "application/pdf", sourceKey: "unused", parseSourceDecision: "original",
  sourceSha256: createHash("sha256").update(text).digest("hex"), status: "processing", extractionMode: "hybrid", pageCount: 1,
  createdAt: new Date(), updatedAt: new Date(),
} as Document);

/** What extract-markdown leaves for embed: the Markdown artifact and the canonical document, in their ledger slots. */
async function seed(storage: MemoryStorage, id: string, text: string) {
  const markdownKey = `u1/run/markdown/${id}.md`;
  storage.objects.set(markdownKey, text);
  const canonicalKey = `u1/run/canonical/${id}.json`;
  await storage.putJson(canonicalKey, buildCanonicalDocumentFromMarkdown({ documentId: id, text, pageCount: 1, extractor: "test" }));
  return { markdownUri: storage.uri(markdownKey), canonicalUri: storage.uri(canonicalKey) };
}

async function embed(storage: MemoryStorage, id: string, text: string, slots: { markdownUri: string; canonicalUri: string }, runner: Pick<CommandRunner, "run">) {
  const projectRun = {
    id: "run", userId: "u1", orgId: "o1", projectId: "w1", stage: "embed", status: "processing",
    pipeline: { ...normalizePipelineFeatures({ embedding: { profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-small", target: "hosted" } as never }), contextualChunkPreambles: false },
    stats: {}, artifacts: { [`${id}:markdown`]: slots.markdownUri, [`${id}:canonical-document`]: slots.canonicalUri }, spentCents: 0,
  } as unknown as ProjectRun;
  const state = WorkflowState.create(projectRun, [document(id, text)]);
  state.docConcurrency = 1;
  // The shared in-memory checkpoint store: stages write through its ports (#472), so a hand-written stub drifts.
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

/** New path: extract-markdown stores the cells from its warm lane; embed reuses them. */
async function newPath(id: string, text: string, tamper?: (key: string, storage: MemoryStorage) => void) {
  const storage = new MemoryStorage();
  const slots = await seed(storage, id, text);
  const extractVm = vmRunner();
  const stored = await storeEmbedTableCells({ run, document: document(id, text), runner: extractVm, storage: storage as unknown as ArtifactStore, stage: "extract-markdown", ...slots });
  const key = tableCellsArtifactKey(run, document(id, text));
  tamper?.(key, storage);
  const embedVm = vmRunner();
  const result = await embed(storage, id, text, slots, embedVm);
  return { ...result, stored, extractVm, embedVm, storage, key };
}

const stable = (artifact: Record<string, unknown>) => JSON.stringify(artifact);

afterEach(() => { vi.unstubAllEnvs(); guest.version = "guest-v1"; });

describe("stored HTML table cells: identity with the VM path", () => {
  it("produces byte-identical embedding artifacts (chunks, ids, content hash) on every table fixture, with zero embed VM calls", async () => {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
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
      // The stored cells are the VM's: the same tables, the same records.
      expect(after.extractVm.batches.flat().sort(), name).toEqual(before.vm.batches.flat().sort());
      if (name.includes("grown") || name.includes("spans")) cellReads++;
    }
    expect(cellReads).toBeGreaterThan(0);
  });

  it("does no extra work for a document without tables: no artifact, no VM call, no stored-cells read", async () => {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
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

  it("with the flag off, stores nothing and embed parses in a VM as before", async () => {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    vi.stubEnv("DOCSLURP_TABLE_CELLS_CACHE", "off");
    const text = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const after = await newPath("flag-off", text);
    expect(after.stored.status).toBe("off");
    expect(after.storage.objects.has(after.key)).toBe(false);
    expect(after.embedVm.run).toHaveBeenCalledTimes(1);
    expect(after.reuse).toBeUndefined();
  });

  it("sends only tables missing from the artifact (written later, e.g. by vision) to a VM, with identical output", async () => {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    const docs = await fixtureDocuments();
    const early = docs["routing-table-clean-financial.pdf.md grown"]!;
    const later = `${early}\n\n# Vision page\n\n${header}\n`;
    const storage = new MemoryStorage();
    const first = await seed(storage, "partial", early);
    await storeEmbedTableCells({ run, document: document("partial", early), runner: vmRunner(), storage: storage as unknown as ArtifactStore, stage: "extract-markdown", ...first });
    const slots = await seed(storage, "partial", later);
    const embedVm = vmRunner();
    const result = await embed(storage, "partial", later, slots, embedVm);
    expect(embedVm.run).toHaveBeenCalledTimes(1);
    expect(embedVm.batches.flat()).toEqual([header]);
    expect(result.reuse?.metadata).toMatchObject({ status: "partial", hits: 1, misses: 1 });
    const before = await oldPath("partial", later);
    expect(stable(result.artifact)).toBe(stable(before.artifact));
  });

  it("a later writer (vision-extract) adds new tables and keeps the parsed ones without re-parsing them", async () => {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    const early = (await fixtureDocuments())["routing-table-clean-financial.pdf.md grown"]!;
    const later = `${early}\n\n${header}\n`;
    const storage = new MemoryStorage();
    await storeEmbedTableCells({ run, document: document("merge", early), runner: vmRunner(), storage: storage as unknown as ArtifactStore, stage: "extract-markdown", ...(await seed(storage, "merge", early)) });
    const visionVm = vmRunner();
    const slots = await seed(storage, "merge", later);
    const stored = await storeEmbedTableCells({ run, document: document("merge", later), runner: visionVm, storage: storage as unknown as ArtifactStore, stage: "vision-extract", ...slots });
    expect(stored).toMatchObject({ status: "written", reusedTables: 1, vmTables: 1 });
    expect(visionVm.batches.flat()).toEqual([header]);
    const embedVm = vmRunner();
    await embed(storage, "merge", later, slots, embedVm);
    expect(embedVm.run).not.toHaveBeenCalled();
    // Unchanged on a retry: nothing re-parsed, nothing rewritten.
    const again = vmRunner();
    expect(await storeEmbedTableCells({ run, document: document("merge", later), runner: again, storage: storage as unknown as ArtifactStore, stage: "vision-extract", ...slots })).toMatchObject({ status: "current" });
    expect(again.run).not.toHaveBeenCalled();
  });

  it("never fails the writing stage: a VM failure is reported and embed falls back to its own VM", async () => {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    const text = (await fixtureDocuments())["routing-table-two-line-header.pdf.md grown"]!;
    const storage = new MemoryStorage();
    const slots = await seed(storage, "vm-down", text);
    const stored = await storeEmbedTableCells({ run, document: document("vm-down", text), runner: { run: vi.fn().mockRejectedValue(new Error("sandbox unavailable")) }, storage: storage as unknown as ArtifactStore, stage: "extract-markdown", ...slots });
    expect(stored).toMatchObject({ status: "failed", error: "sandbox unavailable" });
    const embedVm = vmRunner();
    await embed(storage, "vm-down", text, slots, embedVm);
    expect(embedVm.run).toHaveBeenCalledTimes(1);
  });
});

describe("stored HTML table cells: fail closed to the VM path", () => {
  const text = () => fixtureDocuments().then((docs) => docs["all fixtures in one document"]!);
  type Artifact = { schema: string; runId: string; documentId: string; guestVersion: string; tables: Array<{ sha256: string; cells: unknown }> };
  const edit = (change: (artifact: Artifact) => void) => (key: string, storage: MemoryStorage) => {
    const artifact = JSON.parse(storage.objects.get(key)!) as Artifact;
    change(artifact);
    storage.objects.set(key, JSON.stringify(artifact));
  };

  async function expectVmFallback(name: string, tamper: (key: string, storage: MemoryStorage) => void, status: "missing" | "invalid" | "partial") {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
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
    const after = await expectVmFallback("hash", edit((artifact) => { artifact.tables[0]!.sha256 = tableSourceSha256("<table><tr><td>other</td></tr></table>"); }), "partial");
    expect(after.embedVm.batches.flat()).toHaveLength(1);
  });

  it("tampered artifact: swapped cells under a real hash still validate only as VM-shaped records (bounded labels)", async () => {
    await expectVmFallback("label", edit((artifact) => {
      const table = artifact.tables.find((entry) => Array.isArray(entry.cells) && (entry.cells as unknown[]).length > 0)!;
      (table.cells as Array<{ label: string }>)[0]!.label = "row 1 column 1 rowspan 1 colspan 1\n# injected heading";
    }), "invalid");
  });

  it("oversized artifact is never read into memory", async () => {
    await expectVmFallback("oversized", (key, storage) => { storage.objects.set(key, " ".repeat(TABLE_CELLS_ARTIFACT_MAX_BYTES + 1)); }, "invalid");
  });

  it("missing artifact", async () => {
    await expectVmFallback("missing", (key, storage) => { storage.objects.delete(key); }, "missing");
  });

  it("cross-document key: another document's artifact is refused", async () => {
    await expectVmFallback("cross-document", edit((artifact) => { artifact.documentId = "someone-elses-document"; }), "invalid");
  });

  it("cross-run artifact is refused", async () => {
    await expectVmFallback("cross-run", edit((artifact) => { artifact.runId = "another-run"; }), "invalid");
  });

  it("another guest parser version is refused", async () => {
    await expectVmFallback("guest", edit((artifact) => { artifact.guestVersion = "guest-v0"; }), "invalid");
  });

  it.each([
    ["non-string value", (cells: Array<Record<string, unknown>>) => { cells[0]!.value = 42; }],
    ["extra field", (cells: Array<Record<string, unknown>>) => { cells[0]!.html = "<script>"; }],
    ["non-boolean header", (cells: Array<Record<string, unknown>>) => { cells[0]!.header = "yes"; }],
    ["oversized value", (cells: Array<Record<string, unknown>>) => { cells[0]!.value = "x".repeat(4 * 1024 * 1024 + 1); }],
  ])("malformed cells (%s) discard the whole artifact", async (name, change) => {
    await expectVmFallback(`cells-${name}`, edit((artifact) => {
      const table = artifact.tables.find((entry) => Array.isArray(entry.cells) && (entry.cells as unknown[]).length > 0)!;
      change(table.cells as Array<Record<string, unknown>>);
    }), "invalid");
  });

  it.each([
    ["unknown schema", (artifact: Artifact) => { artifact.schema = "docslurp.html-table-cells.v0"; }],
    ["unexpected top-level field", (artifact: Artifact) => { (artifact as Record<string, unknown>).extra = 1; }],
    ["malformed hash", (artifact: Artifact) => { artifact.tables[0]!.sha256 = "ABC"; }],
    ["duplicate hash", (artifact: Artifact) => { artifact.tables.push({ ...artifact.tables[0]! }); }],
    ["cells not a list", (artifact: Artifact) => { artifact.tables[0]!.cells = { label: "caption", value: "x" }; }],
  ])("malformed artifact (%s) discards the whole artifact", async (name, change) => {
    await expectVmFallback(`artifact-${name}`, edit(change), "invalid");
  });

  it("unparseable JSON discards the whole artifact", async () => {
    await expectVmFallback("json", (key, storage) => { storage.objects.set(key, "{\"schema\":"); }, "invalid");
  });

  it("an unknown guest parser version stores and reuses nothing", async () => {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    guest.version = null;
    const after = await newPath("no-guest", await text());
    expect(after.stored).toMatchObject({ status: "unavailable" });
    expect(after.storage.objects.has(after.key)).toBe(false);
    expect(after.embedVm.run).toHaveBeenCalled();
  });

  it("looks a table up only under the sha256 of the exact source chunking asks for", async () => {
    const storage = new MemoryStorage();
    const a = "<table><tr><td>A</td></tr></table>", b = "<table><tr><td>B</td></tr></table>";
    const key = "u1/run/table-cells/doc.json";
    await storage.putJson(key, { schema: TABLE_CELLS_ARTIFACT_SCHEMA, runId: "run", documentId: "doc", guestVersion: "g", tables: [{ sha256: tableSourceSha256(a), cells: readTableCells(a) }] });
    const lookup = await readTableCellsArtifact({ storage: storage as unknown as ArtifactStore, key, runId: "run", documentId: "doc", guestVersion: "g", sources: [` ${a} `, b] });
    expect(lookup.status).toBe("partial");
    expect([...lookup.cached.keys()]).toEqual([a]);
    expect(vmTableSources([` ${a} `, b])).toEqual([a, b]);
  });
});
