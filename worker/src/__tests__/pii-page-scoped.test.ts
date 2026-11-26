import { describe, expect, it } from "vitest";

import {
  normalizePipelineFeatures,
  PII_BLOCKED_DOCUMENT_STATUS,
  PII_WITHHELD_SECTION_TEXT,
  piiWithheldPageText,
  type CanonicalDocument,
  type PiiMatch,
  type PiiPolicy,
} from "@docslurp/shared";

import { fromEnv } from "../config.js";
import type { Document, ProjectRun } from "../models.js";
import { locateMatches, planPiiWithholding, withholdPagesThenRedact } from "../lib/pii-page-withholding.js";
import { documentPiiWithholding, indexableDocuments, isPageWithheldInRun } from "../pipeline/pii-gate.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { extractTextForEmbedding } from "../stages/embedding-runtime.js";
import { PiiDetectStage, type PiiDetectionSink, type PiiDocumentOutcome } from "../stages/pii-detect.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

const BUCKET = "test-bucket";
const SSN = "123-45-6789";

class MemoryStore {
  readonly bucket = BUCKET;
  readonly objects = new Map<string, string>();
  uri(key: string) { return `s3://${BUCKET}/${key}`; }
  async getBytes(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) throw new Error(`missing ${key}`);
    return Buffer.from(value, "utf8");
  }
  async getJson<T>(key: string): Promise<T> { return JSON.parse((await this.getBytes(key)).toString("utf8")) as T; }
  async putJson(key: string, value: unknown) { this.objects.set(key, JSON.stringify(value)); }
  async streamText(key: string, text: string) { this.objects.set(key, text); }
  async deleteKeys(keys: string[]) { for (const key of keys) this.objects.delete(key); }
  async objectSize(key: string) { const value = this.objects.get(key); return value === undefined ? null : Buffer.byteLength(value); }
  async getByteRange(key: string, start: number, end: number) { return (await this.getBytes(key)).subarray(start, end + 1); }
  json<T>(key: string): T { return JSON.parse(this.objects.get(key) ?? "null") as T; }
}

class RecordingSink implements PiiDetectionSink {
  detections: PiiMatch[][] = [];
  outcomes: PiiDocumentOutcome[] = [];
  async recordDetections(_documentId: string, _runId: string, matches: PiiMatch[]) { this.detections.push(matches); }
  async setDocumentOutcome(_documentId: string, outcome: PiiDocumentOutcome) { this.outcomes.push(outcome); }
  async close() {}
}

type Fixture = ReturnType<typeof setup>;

function canonical(documentId: string, pageTexts: string[]): CanonicalDocument {
  return {
    documentId,
    generator: "test",
    source: { format: "markdown", artifactUri: null, extractor: "test", parser: null, parserArtifactUri: null },
    stats: { blockCount: pageTexts.length, headingCount: 0, paragraphCount: pageTexts.length, codeBlockCount: 0, tableCount: 0, pageCount: pageTexts.length },
    blocks: pageTexts.map((text, index) => ({
      id: `b${index + 1}`, type: "paragraph", order: index, text, headingPath: [], pageNumber: index + 1,
      lineStart: null, lineEnd: null, bbox: null, metadata: {},
    })),
  };
}

/** A PDF of `pageTexts.length` pages: Markdown with `\f` page breaks, canonical blocks per page, page images and figures. */
function setup(action: PiiPolicy["action"], pageTexts: string[], options: { markdown?: string; documentId?: string; storage?: MemoryStore; canonicalBlocks?: boolean; patterns?: PiiPolicy["patterns"] } = {}) {
  const storage = options.storage ?? new MemoryStore();
  const sink = new RecordingSink();
  const documentId = options.documentId ?? "doc-1";
  const prefix = "u1/run-1";
  const document: Document = {
    parseSourceDecision: "unscanned-allowed",
    id: documentId, userId: "u1", runId: "run-1", filename: "record.pdf", mimeType: "application/pdf",
    sourceKey: `${prefix}/source/${documentId}`, status: "processing", extractionMode: "hybrid", pageCount: pageTexts.length,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const markdownKey = `${prefix}/markdown/${documentId}.md`;
  const canonicalKey = `${prefix}/canonical/${documentId}.json`;
  if (!storage.objects.has(markdownKey)) storage.objects.set(markdownKey, options.markdown ?? pageTexts.join("\f"));
  if (options.canonicalBlocks !== false && !storage.objects.has(canonicalKey)) storage.objects.set(canonicalKey, JSON.stringify(canonical(documentId, pageTexts)));
  const artifacts: Record<string, string> = {
    [`${documentId}:markdown`]: storage.uri(markdownKey),
    [`${documentId}:native-pdf-json`]: storage.uri(`${prefix}/parsers/${documentId}.json`),
    [`${documentId}:doppler-figures`]: storage.uri(`${prefix}/doppler-figures/${documentId}/index.json`),
  };
  if (options.canonicalBlocks !== false) artifacts[`${documentId}:canonical-document`] = storage.uri(canonicalKey);
  pageTexts.forEach((_, index) => {
    const page = index + 1;
    artifacts[`${documentId}:page-${page}`] = storage.uri(`${prefix}/pages/${documentId}/page-${page}.png`);
    artifacts[`${documentId}:doppler-figure:p${page}.0`] = storage.uri(`${prefix}/doppler-figures/${documentId}/p${page}.0.webp`);
  });
  const pipeline = normalizePipelineFeatures({ piiPolicy: { enabled: true, patterns: options.patterns ?? ["ssn"], action, allowlistPatterns: [] } });
  const run = { id: "run-1", userId: "u1", orgId: "o1", projectId: "w1", stage: "pii-detect", status: "processing", pipeline, stats: {}, artifacts } as unknown as ProjectRun;
  const state = WorkflowState.create(run, [document]);
  const stage = new PiiDetectStage({} as CommandRunner, storage as unknown as ArtifactStore, fromEnv(), sink);
  return { storage, sink, state, stage, document, documentId, prefix, markdownKey, canonicalKey, artifacts };
}

const uri = (f: Fixture, slot: string) => f.artifacts[`${f.documentId}:${slot}`]!;
const outcome = (f: Fixture) => f.sink.outcomes.at(-1)!;

describe("block_indexing withholds the page, not the document", () => {
  it("one PII page: the document completes; that page's text, chunks, images and figures are withheld", async () => {
    const f = setup("block_indexing", ["Intro page.", `Payroll: SSN ${SSN}.`, "Closing page."]);
    await f.stage.run(f.state);

    expect(f.document.status).not.toBe(PII_BLOCKED_DOCUMENT_STATUS);
    expect(outcome(f)).toMatchObject({ scope: "pages", withheldPages: [2], blocked: false, pageCount: 3 });
    expect(indexableDocuments(f.state)).toEqual([f.document]);
    expect(isPageWithheldInRun(f.state, f.document, 2)).toBe(true);
    expect(isPageWithheldInRun(f.state, f.document, 1)).toBe(false);
    expect(isPageWithheldInRun(f.state, f.document, null)).toBe(true);

    const markdown = f.storage.objects.get(f.markdownKey)!;
    expect(markdown.split("\f")).toEqual(["Intro page.", piiWithheldPageText(2, ["ssn"]), "Closing page."]);
    expect(markdown.split("\f")[1]).toBe("[Page 2 withheld by the project's privacy policy: contains a Social Security number]");
    expect(outcome(f).withheldPageTypes).toEqual({ "2": ["ssn"] });
    expect(outcome(f).findings).toEqual([{ pageNumber: 2, patternType: "ssn", detector: "rule", validation: "structure", confidence: null }]);
    const doc = f.storage.json<CanonicalDocument>(f.canonicalKey);
    expect(doc.blocks.map((block) => block.text)).toEqual(["Intro page.", piiWithheldPageText(2, ["ssn"]), "Closing page."]);
    expect(JSON.stringify([...f.storage.objects.values()])).not.toContain(SSN.slice(0, 6) + "6789");

    // What later stages embed and index is the rewritten text.
    const embedded = await extractTextForEmbedding(f.document, {} as CommandRunner, f.storage as unknown as ArtifactStore,
      uri(f, "markdown"), undefined, uri(f, "canonical-document"));
    expect(embedded.text).toContain("Intro page.");
    expect(embedded.text).toContain("Closing page.");
    expect(embedded.text).not.toContain(SSN);

    const withheld = new Set(outcome(f).withheldArtifactUris);
    for (const slot of ["page-2", "doppler-figure:p2.0", "native-pdf-json", "doppler-figures"]) expect(withheld.has(uri(f, slot)), slot).toBe(true);
    expect(withheld.has(`s3://${BUCKET}/${f.document.sourceKey}`)).toBe(true);
    for (const slot of ["page-1", "page-3", "doppler-figure:p1.0", "doppler-figure:p3.0", "markdown", "canonical-document"]) {
      expect(withheld.has(uri(f, slot)), slot).toBe(false);
    }
  });

  it("a mid-document page of a sharded PDF: page 7 of 12 is withheld, every other page served", async () => {
    const texts = Array.from({ length: 12 }, (_, index) => `Shard ${index < 6 ? "A" : "B"} page ${index + 1}.`);
    texts[6] = `Shard B page 7 has ${SSN}.`;
    const f = setup("block_indexing", texts);
    await f.stage.run(f.state);

    expect(outcome(f)).toMatchObject({ scope: "pages", withheldPages: [7] });
    const pages = f.storage.objects.get(f.markdownKey)!.split("\f");
    expect(pages).toHaveLength(12);
    expect(pages[6]).toBe(piiWithheldPageText(7, ["ssn"]));
    expect(pages[5]).toBe("Shard A page 6.");
    expect(pages[7]).toBe("Shard B page 8.");
    const withheld = new Set(outcome(f).withheldArtifactUris);
    expect(withheld.has(uri(f, "page-7"))).toBe(true);
    expect([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12].some((page) => withheld.has(uri(f, `page-${page}`)))).toBe(false);
  });

  it("a match spanning two pages withholds both", () => {
    // A value whose detected span crosses a page break (OCR that joins lines, a number split by the page).
    const markdown = "Clean first.\fAccount 4111 1111\f1111 1111 continues.\fClean last.";
    const at = markdown.indexOf("4111");
    const length = markdown.indexOf(" continues") - at;
    const findings = {
      pageCount: 4, canonical: null, html: null, contract: null, fallback: null,
      markdown: { text: markdown, matches: [{ patternType: "credit-card" as const, matchedPrefix: "fp", pageNumber: null, byteOffset: at, charOffset: at, length }] },
    };
    const located = locateMatches(findings);
    expect([...located.pages].sort()).toEqual([2, 3]);
    expect(located.unattributed).toEqual([]);
    expect(planPiiWithholding("block_indexing", findings, true)).toEqual({ scope: "pages", pages: [2, 3], carriedPages: [], pageTypes: new Map([[2, ["credit-card"]], [3, ["credit-card"]]]) });
  });

  it("a match whose span crosses a page break never merges pages: later pages keep their numbers", async () => {
    // A PEM key from page 2 into page 3, and an SSN on page 5 of 6: redacting the key's span before withholding would
    // drop the break between pages 2 and 3 and shift page 5's text onto page 4.
    // Assembled at runtime so secret scanners never see a PEM block in the source.
    const pem = (edge: string) => `-----${edge} ${["PRIVATE", "KEY"].join(" ")}-----`;
    const key = `${pem("BEGIN")}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC`;
    const texts = ["p1 clean", `p2 ${key}`, `AAAAAAAAAAAAAAAAAAAAAAAA\n${pem("END")} p3`, "p4 clean", `p5 Jane Doe 12 Elm St SSN ${SSN}`, "p6 clean"];
    const f = setup("block_indexing", texts, { patterns: ["ssn", "private-key"], canonicalBlocks: false });
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "pages", withheldPages: [2, 3, 5] });
    const pages = f.storage.objects.get(f.markdownKey)!.split("\f");
    expect(pages).toEqual(["p1 clean", piiWithheldPageText(2, ["private-key"]), piiWithheldPageText(3, ["private-key"]), "p4 clean", piiWithheldPageText(5, ["ssn"]), "p6 clean"]);
    expect(f.storage.objects.get(f.markdownKey)).not.toContain("Jane Doe");
  });

  it("a match crossing a break between two clean pages is redacted on both, even when neither half matches alone", () => {
    // Page 2 is withheld (carried over); a card number runs from page 3 into page 4. Rescanning each page alone finds
    // nothing (the identity redactor here), so the whole text's match offsets are clipped to each page.
    const text = "one\fcarried\fcard 4111 1111\f1111 1111 end\ffive";
    const at = text.indexOf("4111");
    const length = text.indexOf(" end") - at;
    const match = { patternType: "credit-card" as const, matchedPrefix: "fp", pageNumber: null, byteOffset: at, charOffset: at, length };
    const pages = withholdPagesThenRedact(text, new Set([2]), (page) => page, [match]).split("\f");
    expect(pages).toEqual(["one", piiWithheldPageText(2), "card [REDACTED:credit-card]", "[REDACTED:credit-card] end", "five"]);
  });

  it("overlapping matches on a clean page are merged: no tail of the longer one survives", () => {
    const text = "head\fx 0123456789abcdefghij tail";
    const outer = text.indexOf("0123");
    const inner = text.indexOf("5678");
    const match = (charOffset: number, length: number) => ({ patternType: "generic-api-key" as const, matchedPrefix: "fp", pageNumber: null, byteOffset: charOffset, charOffset, length });
    const pages = withholdPagesThenRedact(text, new Set([1]), (page) => page, [match(outer, 20), match(inner, 4)]).split("\f");
    expect(pages).toEqual([piiWithheldPageText(1), "x [REDACTED:generic-api-key] tail"]);
  });

  it("every page withheld: the document is blocked", async () => {
    const f = setup("block_indexing", [`A ${SSN}`, `B ${SSN}`]);
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "document", blocked: true });
    expect(f.document.status).toBe(PII_BLOCKED_DOCUMENT_STATUS);
    expect(indexableDocuments(f.state)).toEqual([]);
  });

  it("unknown page attribution fails closed: the whole document is withheld, with the reason", async () => {
    // Markdown with no page breaks for a 3-page document: the hit cannot be placed on a page.
    const f = setup("block_indexing", ["one", "two", "three"], { markdown: `one two ${SSN} three`, canonicalBlocks: false });
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "document", blocked: true });
    expect(outcome(f).reason).toContain("could not be placed on a page");
    // Unplaced: the finding has no page (0), never a guessed one.
    expect(outcome(f).findings).toEqual([{ pageNumber: 0, patternType: "ssn", detector: "rule", validation: "structure", confidence: null }]);
    expect(f.document.status).toBe(PII_BLOCKED_DOCUMENT_STATUS);
    expect(new Set(outcome(f).withheldArtifactUris).has(uri(f, "page-1"))).toBe(true);
  });

  it("a canonical block without a page on a paged document fails closed", async () => {
    const f = setup("block_indexing", ["one", "two", "three"]);
    const doc = canonical("doc-1", ["one", "two", "three"]);
    doc.blocks.push({ ...doc.blocks[0]!, id: "loose", order: 9, pageNumber: null, text: `loose ${SSN}` });
    f.storage.objects.set(f.canonicalKey, JSON.stringify(doc));
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "document", blocked: true });
  });
});

describe("block_document keeps whole-document blocking as an explicit choice", () => {
  it("one match blocks the document", async () => {
    const f = setup("block_document", ["clean", `bad ${SSN}`, "clean"]);
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "document", blocked: true, withheldPageTypes: {} });
    expect(f.document.status).toBe(PII_BLOCKED_DOCUMENT_STATUS);
    expect(documentPiiWithholding(f.state, f.document).scope).toBe("document");
    // Operator findings name the page the match was on; tenants see the document-level categories only.
    expect(outcome(f).findings).toEqual([{ pageNumber: 2, patternType: "ssn", detector: "rule", validation: "structure", confidence: null }]);
  });
});

describe("rescans lift or extend page withholding", () => {
  it("a rescan of rewritten text keeps the withheld page withheld, even under a weaker policy", async () => {
    const first = setup("block_indexing", ["p1", `p2 ${SSN}`, "p3"]);
    await first.stage.run(first.state);
    const again = setup("flag_for_review", ["p1", `p2 ${SSN}`, "p3"], { storage: first.storage });
    await again.stage.run(again.state);
    expect(outcome(again)).toMatchObject({ scope: "pages", withheldPages: [2] });
    expect(new Set(outcome(again).withheldArtifactUris).has(uri(again, "page-2"))).toBe(true);
    // The carried page keeps its reason: the placeholder names its categories, and the rescan reads them back.
    expect(outcome(again).withheldPageTypes).toEqual({ "2": ["ssn"] });
    expect(again.storage.objects.get(again.markdownKey)!.split("\f")[1]).toBe(piiWithheldPageText(2, ["ssn"]));
  });

  it("a page withheld before types were recorded stays withheld on rescan, with a generic reason", async () => {
    const first = setup("block_indexing", ["p1", `p2 ${SSN}`, "p3"]);
    await first.stage.run(first.state);
    // Rewrite page 2 to the pre-types placeholder, as an older release wrote it.
    const legacy = "[Page 2 withheld by the project's privacy policy]";
    const markdown = first.storage.objects.get(first.markdownKey)!.split("\f");
    markdown[1] = legacy;
    first.storage.objects.set(first.markdownKey, markdown.join("\f"));
    const doc = first.storage.json<CanonicalDocument>(first.canonicalKey);
    doc.blocks[1] = { ...doc.blocks[1]!, text: legacy };
    first.storage.objects.set(first.canonicalKey, JSON.stringify(doc));
    const again = setup("block_indexing", ["p1", "x", "p3"], { storage: first.storage });
    await again.stage.run(again.state);
    expect(outcome(again)).toMatchObject({ scope: "pages", withheldPages: [2], withheldPageTypes: {}, findings: [] });
    expect(again.storage.objects.get(again.markdownKey)!.split("\f")[1]).toBe(legacy);
  });

  it("a rescan that finds a new PII page extends the withheld set", async () => {
    const first = setup("block_indexing", ["p1", `p2 ${SSN}`, "p3", "p4"]);
    await first.stage.run(first.state);
    const markdown = first.storage.objects.get(first.markdownKey)!.split("\f");
    markdown[3] = `p4 now ${SSN}`;
    first.storage.objects.set(first.markdownKey, markdown.join("\f"));
    const doc = first.storage.json<CanonicalDocument>(first.canonicalKey);
    doc.blocks[3] = { ...doc.blocks[3]!, text: `p4 now ${SSN}` };
    first.storage.objects.set(first.canonicalKey, JSON.stringify(doc));
    const again = setup("block_indexing", ["p1", "x", "p3", "p4"], { storage: first.storage });
    await again.stage.run(again.state);
    expect(outcome(again)).toMatchObject({ scope: "pages", withheldPages: [2, 4] });
  });

  it("a re-extracted document without PII lifts the withholding", async () => {
    const first = setup("block_indexing", ["p1", `p2 ${SSN}`, "p3"]);
    await first.stage.run(first.state);
    const fresh = new MemoryStore();
    const again = setup("block_indexing", ["p1", "p2 cleaned at the source", "p3"], { storage: fresh });
    await again.stage.run(again.state);
    expect(outcome(again)).toMatchObject({ scope: "none", withheldPages: [], blocked: false, withheldArtifactUris: [] });
  });
});

describe("unpaged documents withhold the section holding the match", () => {
  it("a one-page document keeps its clean sections", async () => {
    const markdown = `# Intro\nWelcome.\n\n# Payroll\nSSN ${SSN}.\n\n# Benefits\nDental and vision.\n`;
    const f = setup("block_indexing", [markdown], { canonicalBlocks: false });
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "sections", withheldSectionCount: 1, blocked: false });
    const text = f.storage.objects.get(f.markdownKey)!;
    expect(text).toContain("Welcome.");
    expect(text).toContain("Dental and vision.");
    expect(text).toContain(PII_WITHHELD_SECTION_TEXT);
    expect(text).not.toContain(SSN);
    // Nothing written before the scan is served: page images and figures of the one page are withheld.
    expect(new Set(outcome(f).withheldArtifactUris).has(uri(f, "page-1"))).toBe(true);
  });
});

describe("redact_artifacts is page-scoped for images", () => {
  it("redacts the value and withholds only the hit page's images", async () => {
    const f = setup("redact_artifacts", ["Intro.", `SSN ${SSN}.`, "End."]);
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ redacted: true, blocked: false });
    expect(f.storage.objects.get(f.markdownKey)).not.toContain(SSN);
    const withheld = new Set(outcome(f).withheldArtifactUris);
    expect(withheld.has(uri(f, "page-2"))).toBe(true);
    expect(withheld.has(uri(f, "page-1"))).toBe(false);
    expect(withheld.has(uri(f, "page-3"))).toBe(false);
  });
});

describe("a label and its value in two canonical blocks (the Markdown matches across the blank line)", () => {
  const PASSPORT = "X1234567";
  const labelled = (documentId: string, pages: Array<Array<{ type: "heading" | "paragraph"; text: string }>>): CanonicalDocument => {
    const doc = canonical(documentId, pages.map(() => ""));
    let order = 0;
    doc.blocks = pages.flatMap((blocks, pageIndex) => blocks.map((block) => ({
      id: `b${order}`, type: block.type, order: order++, text: block.type === "heading" ? `## ${block.text}` : block.text,
      headingPath: block.type === "heading" ? [block.text] : [], pageNumber: pageIndex + 1,
      lineStart: null, lineEnd: null, bbox: null, metadata: block.type === "heading" ? { level: 2 } : {},
    })));
    return doc;
  };
  const setupLabelled = (action: PiiPolicy["action"], pages: Array<Array<{ type: "heading" | "paragraph"; text: string }>>, mimeType: string) => {
    const storage = new MemoryStore();
    const markdown = pages.map((blocks) => blocks.map((block) => (block.type === "heading" ? `## ${block.text}` : block.text)).join("\n\n")).join("\f");
    storage.objects.set(`u1/run-1/canonical/doc-1.json`, JSON.stringify(labelled("doc-1", pages)));
    const f = setup(action, pages.map(() => ""), { storage, markdown, patterns: ["passport"] });
    f.document.mimeType = mimeType;
    return f;
  };
  const onePage = [[{ type: "heading" as const, text: "Passport number" }, { type: "paragraph" as const, text: PASSPORT }, { type: "heading" as const, text: "Travel" }, { type: "paragraph" as const, text: "Window seat." }]];

  for (const mimeType of ["text/markdown", "text/plain", "application/pdf"]) {
    it(`one-page ${mimeType}: the value leaves the canonical document too, so embed and search never see it`, async () => {
      const f = setupLabelled("block_indexing", onePage, mimeType);
      await f.stage.run(f.state);
      expect(outcome(f)).toMatchObject({ scope: "sections", blocked: false });
      expect(f.storage.objects.get(f.markdownKey)).not.toContain(PASSPORT);
      expect(f.storage.objects.get(f.canonicalKey)).not.toContain(PASSPORT);
      const embedded = await extractTextForEmbedding(f.document, {} as CommandRunner, f.storage as unknown as ArtifactStore,
        uri(f, "markdown"), undefined, uri(f, "canonical-document"));
      expect(embedded.text).not.toContain(PASSPORT);
      expect(embedded.text).toContain("Window seat.");
    });
  }

  it("redact_artifacts: the value is redacted in the canonical block that holds it", async () => {
    const f = setupLabelled("redact_artifacts", onePage, "application/pdf");
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ redacted: true, blocked: false });
    const doc = f.storage.json<CanonicalDocument>(f.canonicalKey);
    expect(JSON.stringify(doc)).not.toContain(PASSPORT);
    expect(doc.blocks[1]!.text).toBe("[REDACTED:passport]");
    expect(doc.blocks[3]!.text).toBe("Window seat.");
  });

  it("paged redact_artifacts: the value on page 2 is redacted in its block and page 2's images are withheld", async () => {
    const f = setupLabelled("redact_artifacts", [[{ type: "paragraph", text: "Cover." }], onePage[0]!, [{ type: "paragraph", text: "End." }]], "application/pdf");
    await f.stage.run(f.state);
    expect(JSON.stringify(f.storage.json<CanonicalDocument>(f.canonicalKey))).not.toContain(PASSPORT);
    const withheld = new Set(outcome(f).withheldArtifactUris);
    expect(withheld.has(uri(f, "page-2"))).toBe(true);
    expect(withheld.has(uri(f, "page-1"))).toBe(false);
  });

  it("paged block_indexing: a label and value on one page withhold that page in both artifacts", async () => {
    const f = setupLabelled("block_indexing", [[{ type: "paragraph", text: "Cover." }], onePage[0]!, [{ type: "paragraph", text: "End." }]], "application/pdf");
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "pages", withheldPages: [2], withheldPageTypes: { "2": ["passport"] } });
    expect(f.storage.objects.get(f.canonicalKey)).not.toContain(PASSPORT);
  });

  it("a Markdown value the canonical document does not hold in any block fails closed to the whole document", async () => {
    const f = setupLabelled("block_indexing", onePage, "application/pdf");
    // The canonical document renders the value split over two blocks: no block holds it.
    const doc = labelled("doc-1", [[{ type: "heading", text: "Passport number" }, { type: "paragraph", text: "X1234" }, { type: "paragraph", text: "567" }]]);
    f.storage.objects.set(f.canonicalKey, JSON.stringify(doc));
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "document", blocked: true });
    expect(outcome(f).reason).toContain("text-match-not-in-canonical");
  });

  it("redact_artifacts fails closed the same way", async () => {
    const f = setupLabelled("redact_artifacts", onePage, "application/pdf");
    const doc = labelled("doc-1", [[{ type: "heading", text: "Passport number" }, { type: "paragraph", text: "X1234" }, { type: "paragraph", text: "567" }]]);
    f.storage.objects.set(f.canonicalKey, JSON.stringify(doc));
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "document", blocked: true, redacted: false });
  });
});

describe("headings from a withheld page leave later pages' heading paths", () => {
  it("drops the plain heading text a withheld page's heading contributed", async () => {
    const f = setup("block_indexing", ["Cover.", "x", "Notes continue."]);
    const doc = canonical("doc-1", ["Cover.", "x", "Notes continue."]);
    doc.blocks = [
      { ...doc.blocks[0]! },
      { ...doc.blocks[1]!, type: "heading", text: "## Jane Roe: **intake**", headingPath: ["Jane Roe: intake"], metadata: { level: 2 } },
      { ...doc.blocks[1]!, id: "b2b", text: `SSN ${SSN}`, headingPath: ["Jane Roe: intake"] },
      { ...doc.blocks[2]!, headingPath: ["Jane Roe: intake"] },
    ];
    f.storage.objects.set(f.canonicalKey, JSON.stringify(doc));
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "pages", withheldPages: [2] });
    const out = f.storage.json<CanonicalDocument>(f.canonicalKey);
    expect(JSON.stringify(out)).not.toContain("Jane Roe");
    expect(out.blocks.at(-1)!.headingPath).toEqual([]);
  });
});
