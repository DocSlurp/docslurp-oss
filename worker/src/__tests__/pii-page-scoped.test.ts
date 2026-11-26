import { describe, expect, it } from "vitest";

import {
  isPageImageWithheld,
  isPageWithheld,
  normalizePipelineFeatures,
  piiWithholding,
  PII_BLOCKED_DOCUMENT_STATUS,
  PII_WITHHELD_SECTION_TEXT,
  piiWithheldPageText,
  type CanonicalDocument,
  type PiiMatch,
  type PiiPolicy,
} from "@docslurp/shared";

import { fromEnv } from "../config.js";
import { isDocumentLevelFailure } from "../lib/document-failure.js";
import { findingsStatement, PiiFindingsUnavailableError } from "../lib/pii-deferred-outcome.js";
import type { Document, ProjectRun } from "../models.js";
import { locateMatches, planPiiWithholding, withholdPagesThenRedact } from "../lib/pii-page-withholding.js";
import { indexableDocuments, isPiiBlockedDocument } from "../pipeline/pii-gate.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { extractTextForEmbedding } from "../stages/embedding-runtime.js";
import { PiiDetectStage, type PiiDetectionSink, type PiiDocumentOutcome } from "../stages/pii-detect.js";
import { withoutPlaceholderChunks } from "../stages/embed.js";
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
  scrubTitlesAndMap?: PiiDetectionSink["scrubTitlesAndMap"];
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
function setup(action: PiiPolicy["action"], pageTexts: string[], options: { markdown?: string; documentId?: string; storage?: MemoryStore; canonicalBlocks?: boolean; patterns?: PiiPolicy["patterns"]; contract?: unknown } = {}) {
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
  if (options.contract !== undefined) {
    const contractKey = `${prefix}/contract/${documentId}.json`;
    storage.objects.set(contractKey, JSON.stringify(options.contract));
    artifacts[`${documentId}:extraction-contract`] = storage.uri(contractKey);
  }
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
    const recorded = piiWithholding({ status: f.document.status, metadata: { pii: { scope: outcome(f).scope, withheldPages: outcome(f).withheldPages } } });
    expect(isPageWithheld(recorded, 2)).toBe(true);
    expect(isPageWithheld(recorded, 1)).toBe(false);
    expect(isPageWithheld(recorded, null)).toBe(true);

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
    expect(isPiiBlockedDocument(f.state, f.document)).toBe(true);
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

  it("the extraction contract's markdown and rawText lose the withheld section too (M8)", async () => {
    const markdown = `# Intro\nWelcome.\n\n# Payroll\nSSN ${SSN} for Jane Roe.\n\n# Benefits\nDental and vision.\n`;
    const contract = { documentId: "doc-1", markdown, rawText: markdown.replace(/# /g, ""), images: [], charts: [], tables: [], headers: [], links: [] };
    const f = setup("block_indexing", [markdown], { canonicalBlocks: false, contract });
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "sections", blocked: false });
    const written = f.storage.json<{ markdown: string; rawText: string }>(`${f.prefix}/contract/${f.documentId}.json`);
    for (const field of [written.markdown, written.rawText]) {
      expect(field).not.toContain("Jane Roe");
      expect(field).not.toContain(SSN);
      expect(field).toContain("Dental and vision.");
      expect(field).toContain(PII_WITHHELD_SECTION_TEXT);
    }
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

describe("a redaction retry after the outcome write failed (M1)", () => {
  it("rescanning text already redacted in place keeps the redaction: the source and every page image stay withheld", async () => {
    const first = setup("redact_artifacts", ["Intro.", `SSN ${SSN}.`, "End."]);
    // The findings write fails once (a worker before its migration, a database blip): the outcome is not recorded.
    first.sink.setDocumentOutcome = async () => { throw new Error("pii_page_findings is not available"); };
    await first.stage.run(first.state).catch(() => undefined);
    expect(first.sink.outcomes).toHaveLength(0);
    expect(first.storage.objects.get(first.markdownKey)).toContain("[REDACTED:ssn]");
    // The retry reads the rewritten artifacts: no match, only markers.
    const retry = setup("redact_artifacts", ["Intro.", `SSN ${SSN}.`, "End."], { storage: first.storage });
    await retry.stage.run(retry.state);
    expect(outcome(retry)).toMatchObject({ redacted: true, blocked: false, redactedPages: null });
    const withheld = new Set(outcome(retry).withheldArtifactUris);
    expect(withheld.has(retry.storage.uri(retry.document.sourceKey))).toBe(true);
    for (const page of [1, 2, 3]) expect(withheld.has(uri(retry, `page-${page}`)), `page-${page}`).toBe(true);
  });

  it("a value only in a canonical block, redacted there on attempt one, is a carried redaction on retry; titles are scrubbed", async () => {
    const pages = ["Intro.", `SSN ${SSN}.`, "End."];
    const first = setup("redact_artifacts", pages, { markdown: "Intro.\fNothing.\fEnd." });
    first.sink.setDocumentOutcome = async () => { throw new Error("database blip"); };
    await first.stage.run(first.state).catch(() => undefined);
    expect(first.storage.objects.get(first.canonicalKey)).toContain("[REDACTED:ssn]");
    const retry = setup("redact_artifacts", pages, { storage: first.storage, markdown: "Intro.\fNothing.\fEnd." });
    const scrubbed: unknown[] = [];
    retry.sink.scrubTitlesAndMap = async (_id, withheld) => { scrubbed.push(withheld); };
    await retry.stage.run(retry.state);
    expect(outcome(retry)).toMatchObject({ redacted: true, redactedPages: null });
    expect(new Set(outcome(retry).withheldArtifactUris).has(retry.storage.uri(retry.document.sourceKey))).toBe(true);
    expect(scrubbed).toHaveLength(1);
  });

  it("a clean document with no markers is still recorded clean", async () => {
    const f = setup("redact_artifacts", ["Intro.", "Nothing here.", "End."]);
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ redacted: false, matchCount: 0 });
    expect(outcome(f).withheldArtifactUris).toEqual([]);
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

describe("redaction over carried pages serves only known-clean pages' pixels (M1)", () => {
  it("a page redacted on a rescan has its image withheld and is recorded as redacted", async () => {
    const CARD = "4111 1111 1111 1111";
    const first = setup("block_indexing", ["p1", `p2 ${SSN}`, "p3", "p4", "p5"]);
    await first.stage.run(first.state);
    const markdown = first.storage.objects.get(first.markdownKey)!.split("\f");
    markdown[4] = `p5 card ${CARD}`;
    first.storage.objects.set(first.markdownKey, markdown.join("\f"));
    const doc = first.storage.json<CanonicalDocument>(first.canonicalKey);
    doc.blocks[4] = { ...doc.blocks[4]!, text: `p5 card ${CARD}` };
    first.storage.objects.set(first.canonicalKey, JSON.stringify(doc));
    const again = setup("redact_artifacts", ["p1", "x", "p3", "p4", "x"], { storage: first.storage, patterns: ["ssn", "credit-card"] });
    await again.stage.run(again.state);
    expect(outcome(again)).toMatchObject({ scope: "pages", withheldPages: [2], redacted: true, redactedPages: [5] });
    const withheld = new Set(outcome(again).withheldArtifactUris);
    expect(withheld.has(uri(again, "page-5"))).toBe(true);
    expect(withheld.has(uri(again, "doppler-figure:p5.0"))).toBe(true);
    expect(withheld.has(uri(again, "page-1"))).toBe(false);
    // Readers: a render of page 5 is refused, page 1 is allowed.
    const recorded = piiWithholding({ status: "completed", metadata: { pii: { scope: "pages", withheldPages: [2], redacted: true, redactedPages: [5] } } });
    expect(isPageImageWithheld(recorded, 5)).toBe(true);
    expect(isPageImageWithheld(recorded, 1)).toBe(false);
    expect(isPageWithheld(recorded, 5)).toBe(false);
    // A redaction outcome that did not record its pages keeps every page's pixels withheld.
    expect(isPageImageWithheld(piiWithholding({ metadata: { pii: { scope: "pages", withheldPages: [2], redacted: true } } }), 1)).toBe(true);
  });
});

describe("a rescan of section-rewritten text keeps the sections withheld (M4)", () => {
  it("a one-page document rescanned over its rewritten text stays withheld, with its pre-scan artifacts", async () => {
    const markdown = `# Intro\nWelcome.\n\n# Payroll\nSSN ${SSN}.\n`;
    const first = setup("block_indexing", [markdown], { canonicalBlocks: false });
    await first.stage.run(first.state);
    expect(outcome(first)).toMatchObject({ scope: "sections" });
    // A partial reprocess copies the rewritten Markdown forward and rescans it (any policy).
    for (const action of ["block_indexing", "flag_for_review", "redact_artifacts"] as const) {
      const again = setup(action, [markdown], { storage: first.storage, canonicalBlocks: false });
      await again.stage.run(again.state);
      expect(outcome(again), action).toMatchObject({ scope: "sections", blocked: false });
      const withheld = new Set(outcome(again).withheldArtifactUris);
      expect(withheld.has(uri(again, "page-1")), action).toBe(true);
      expect(withheld.has(`s3://${BUCKET}/${again.document.sourceKey}`), action).toBe(true);
    }
  });

  it("a canonical block marked withheld is carried too", async () => {
    const f = setup("flag_for_review", ["Clean text."]);
    const doc = canonical("doc-1", ["Clean text."]);
    doc.blocks.push({ ...doc.blocks[0]!, id: "w", order: 2, text: PII_WITHHELD_SECTION_TEXT, metadata: { piiWithheld: true } });
    f.storage.objects.set(f.canonicalKey, JSON.stringify(doc));
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "sections", withheldSectionCount: 1 });
  });
});

describe("rollout safety (M6)", () => {
  it("an action this worker does not know blocks the document", async () => {
    const f = setup("block_indexing", ["clean", `bad ${SSN}`, "clean"]);
    (f.state.run.pipeline.piiPolicy as { action: string }).action = "quarantine_everything";
    await f.stage.run(f.state);
    expect(outcome(f)).toMatchObject({ scope: "document", blocked: true, action: "block_document" });
  });

  it("a missing findings table fails the stage as retryable infrastructure, never the document", async () => {
    const missing = Object.assign(new Error('relation "pii_page_findings" does not exist'), { code: "42P01", name: "PostgresError" });
    const error = await findingsStatement(() => Promise.reject(missing)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PiiFindingsUnavailableError);
    expect(isDocumentLevelFailure(error)).toBe(false);
    // Any other statement error is passed through unchanged.
    const other = new Error("boom");
    expect(await findingsStatement(() => Promise.reject(other)).catch((caught: unknown) => caught)).toBe(other);
  });
});

describe("carried pages keep their exact categories", () => {
  it("ids that share a label come back as recorded, not as the label's first id", () => {
    const text = `one\f${piiWithheldPageText(2, ["aws-access-key"])}\fthree`;
    const findings = { pageCount: 3, canonical: null, html: null, contract: null, fallback: null, markdown: { text, matches: [] } };
    const before = planPiiWithholding("flag_for_review", findings, false);
    expect(before.scope === "pages" && before.pageTypes.get(2)).not.toEqual(["aws-access-key"]);
    const after = planPiiWithholding("flag_for_review", { ...findings, previousPageTypes: new Map([[2, ["aws-access-key" as const]]]) }, false);
    expect(after.scope === "pages" && after.pageTypes.get(2)).toEqual(["aws-access-key"]);
    // A previous record that names different labels is not trusted over the placeholder.
    const mismatch = planPiiWithholding("flag_for_review", { ...findings, previousPageTypes: new Map([[2, ["ssn" as const]]]) }, false);
    expect(mismatch.scope === "pages" && mismatch.pageTypes.get(2)).not.toEqual(["ssn"]);
  });
});

describe("placeholder-only chunks are never indexed", () => {
  it("drops chunks that are only placeholders and keeps the clean part of a mixed chunk", () => {
    const chunk = (text: string, pageNumbers: number[]) => ({ text, pageNumber: pageNumbers[0] ?? null, pageNumbers });
    const out = withoutPlaceholderChunks([
      chunk(piiWithheldPageText(2, ["credit-card"]), [2]),
      chunk(`Totals for March.\n\n${piiWithheldPageText(3, ["credit-card"])}`, [1, 3]),
      chunk(PII_WITHHELD_SECTION_TEXT, []),
      chunk("Clean page.", [4]),
    ]);
    expect(out).toEqual([
      { text: "Totals for March.", pageNumber: 1, pageNumbers: [1] },
      { text: "Clean page.", pageNumber: 4, pageNumbers: [4] },
    ]);
  });

  it("a multi-page chunk left with one page is on that page, and its source trace drops the withheld page", () => {
    const [out] = withoutPlaceholderChunks([{
      text: `${piiWithheldPageText(2, ["ssn"])}\n\nPage three text.`, pageNumber: null, pageNumbers: [2, 3],
      sourceTrace: { pageNumbers: [2, 3], blockIds: ["b2", "b3"] },
    }]);
    expect(out).toEqual({ text: "Page three text.", pageNumber: 3, pageNumbers: [3], sourceTrace: { pageNumbers: [3], blockIds: ["b2", "b3"] } });
  });

  it("a fully withheld one-section document leaves an empty chunk list (nothing to embed or index)", () => {
    expect(withoutPlaceholderChunks([{ text: PII_WITHHELD_SECTION_TEXT, pageNumber: 1, pageNumbers: [1] }])).toEqual([]);
  });
});

describe("the canonical locator (M9, structural keys)", () => {
  const block = (text: string, metadata: Record<string, unknown> = {}) => ({ id: text, type: "paragraph", order: 0, text, headingPath: [], pageNumber: 1, metadata });
  const at = (text: string, value: string) => ({ patternType: "passport" as const, charOffset: text.indexOf(value), length: value.length }) as never;

  it("a short value inside an unrelated string does not hide its own occurrence split over two blocks: unmapped", async () => {
    const { mapTextMatchesToCanonical } = await import("../lib/pii-page-withholding.js");
    const text = "Order 9X1234567 shipped.\n\nPassport number\n\nX1234\n567";
    const blocks = [block("Order 9X1234567 shipped."), block("Passport number"), block("X1234"), block("567")];
    const mapped = mapTextMatchesToCanonical(blocks, text, [at(text, "X1234\n567")], 1);
    expect(mapped.unmapped).toHaveLength(1);
    // The unrelated hit is still replaced (more is withheld, never less).
    expect(mapped.blockIndexes.has(0)).toBe(true);
  });

  it("copies in heading paths do not count as the value's own occurrence, at any length", async () => {
    const { mapTextMatchesToCanonical } = await import("../lib/pii-page-withholding.js");
    for (const value of ["X1234567", "GB82WEST12345698765432"]) {
      const text = `## Ref ${value}\n\nPassport number\n\n${value.slice(0, 4)}\n${value.slice(4)}`;
      const heading = { ...block(`## Ref ${value}`), type: "heading", headingPath: [`Ref ${value}`] };
      const blocks = [heading, { ...block("Passport number"), headingPath: [`Ref ${value}`] }, { ...block(value.slice(0, 4)), headingPath: [`Ref ${value}`] }, { ...block(value.slice(4)), headingPath: [`Ref ${value}`] }];
      const mapped = mapTextMatchesToCanonical(blocks, text, [at(text, `${value.slice(0, 4)}\n${value.slice(4)}`)], 1);
      expect(mapped.unmapped, value).toHaveLength(1);
    }
  });

  it("exact and re-spaced hits are both found", async () => {
    const { mapTextMatchesToCanonical } = await import("../lib/pii-page-withholding.js");
    const text = "Passport number\n\nX1234567 and again X 1234 567";
    const blocks = [block("Passport number"), block("X1234567"), block("again X 1234 567")];
    const mapped = mapTextMatchesToCanonical(blocks, text, [at(text, "X1234567")], 1);
    expect(mapped.unmapped).toHaveLength(0);
    expect([...mapped.blockIndexes.keys()].sort()).toEqual([1, 2]);
  });

  it("a value only in a structural key (url, *Id) is not located: the caller fails closed", async () => {
    const { mapTextMatchesToCanonical } = await import("../lib/pii-page-withholding.js");
    const text = "Passport number\n\nX1234567";
    const blocks = [block("Passport number"), block("see link", { url: "https://example.test/X1234567", linkId: "X1234567" })];
    expect(mapTextMatchesToCanonical(blocks, text, [at(text, "X1234567")], 1).unmapped).toHaveLength(1);
  });
});
