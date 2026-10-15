import { describe, expect, it } from "vitest";
import { citationLocatorSchema, formatCitationLocator } from "@docslurp/shared";
import { buildCanonicalChunksFromDocument, buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { buildMediaCanonicalDocument } from "../media/canonical.js";
import { enrichCanonicalDocumentWithPyMuPdf } from "../lib/parser-canonical.js";
import { a1, columnLetters } from "../lib/chunk-locator.js";
import type { TimedSegment } from "../media/segments.js";

const seg = (start: number, end: number, text: string, speaker?: string): TimedSegment => ({ start, end, text, speaker, timing: "segment" });

describe("media chunk locators", () => {
  const segments = [
    ...Array.from({ length: 12 }, (_, i) => seg(i * 10, i * 10 + 9, `Alice sentence number ${i} about the roadmap.`, "Speaker 1")),
    seg(120, 128, "Bob answers about budgets.", "Speaker 2"),
    seg(300, 310, "Much later, Bob again.", "Speaker 2"),
  ];
  const { canonical } = buildMediaCanonicalDocument({ documentId: "m", mediaKind: "audio", durationSeconds: 400, segments,
    visualSegments: [{ id: "m:visual:0", start: 5, end: 15, samples: [5, 10, 15], text: "A slide titled Roadmap" }], sourceArtifactUri: "s3://m", extractor: "media:x" });
  const chunks = buildCanonicalChunksFromDocument(canonical, "m.mp3", { maxChars: 4000 });
  it("caps a chunk's span and never merges speakers, modes or distant moments", () => {
    for (const chunk of chunks) {
      const loc = chunk.locator;
      expect(loc?.kind).toBe("media");
      if (loc?.kind === "media") expect(loc.endSeconds - loc.startSeconds).toBeLessThanOrEqual(100);
    }
    const speakers = chunks.map(c => c.locator?.kind === "media" ? c.locator.speaker : "none");
    expect(speakers).toContain("Speaker 1"); expect(speakers).toContain("Speaker 2");
    const late = chunks.find(c => c.text.includes("Much later"))!;
    expect(late.locator).toMatchObject({ startSeconds: 300, endSeconds: 310 });
    expect(late.text).not.toContain("budgets");
  });
  it("marks visual evidence as shown with its frames", () => {
    const shown = chunks.find(c => c.locator?.kind === "media" && c.locator.mode === "shown")!;
    expect(shown.locator).toMatchObject({ kind: "media", media: "audio", frameSeconds: [5, 10, 15], speaker: null });
    expect(citationLocatorSchema.parse(shown.locator)).toBeTruthy();
    expect(formatCitationLocator(shown.locator!)).toBe("00:05–00:15");
    expect(formatCitationLocator({ ...(shown.locator as object), startSeconds: 252.2, endSeconds: 270.4 } as never)).toBe("04:12–04:31");
  });
});

describe("media chunk economy", () => {
  const build = (segments: TimedSegment[], options: { evidenceBoundaries?: boolean } = {}) => buildCanonicalChunksFromDocument(
    buildMediaCanonicalDocument({ documentId: "e", mediaKind: "audio", durationSeconds: 600, segments, visualSegments: [], sourceArtifactUri: "s3://e", extractor: "x" }).canonical,
    "e.mp3", { maxChars: 4000, ...options });
  const long = (i: number, who: string) => seg(i * 20, i * 20 + 18, `${who} explains point ${i} of the plan in some detail so this turn is comfortably long, and then it keeps going with more detail about timing and owners.`, who);
  it("keeps one-word replies in the surrounding chunk (text keeps the speaker label) instead of one chunk per turn", () => {
    const segments = [long(0, "Speaker 1"), seg(19, 19.5, "Yeah.", "Speaker 2"), seg(20, 21, "Right.", "Speaker 1"), long(1, "Speaker 1"), long(2, "Speaker 1"), long(3, "Speaker 2")];
    const chunks = build(segments);
    expect(chunks.length).toBeLessThan(build(segments, { evidenceBoundaries: false }).length + 3);
    const first = chunks[0];
    expect(first.text).toContain("Yeah."); expect(first.text).toMatch(/Speaker 2/);
    expect(first.locator).toMatchObject({ kind: "media", speaker: "Speaker 1" });
    // real speaker changes still split
    expect(chunks.some(c => c.locator?.kind === "media" && c.locator.speaker === "Speaker 2" && c.text.includes("point 3"))).toBe(true);
  });
  it("gives the pieces of one long split segment distinct, ordered sub-spans labelled chunk timing", () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says something quite specific.`).join(" ");
    const chunks = buildCanonicalChunksFromDocument(buildMediaCanonicalDocument({ documentId: "l", mediaKind: "audio", durationSeconds: 200,
      segments: [seg(0, 200, text, "Speaker 1")], visualSegments: [], sourceArtifactUri: "s3://l", extractor: "x" }).canonical, "l.mp3", { maxChars: 600 });
    expect(chunks.length).toBeGreaterThan(3);
    const spans = chunks.map(c => c.locator as { startSeconds: number; endSeconds: number; timing: string });
    for (const [i, span] of spans.entries()) {
      expect(span.timing).toBe("chunk");
      if (i > 0) expect(span.startSeconds).toBeGreaterThanOrEqual(spans[i - 1]!.startSeconds);
    }
    expect(new Set(spans.map(s => `${s.startSeconds}-${s.endSeconds}`)).size).toBe(spans.length);
    expect(spans[0]!.startSeconds).toBe(0); expect(spans.at(-1)!.endSeconds).toBeLessThanOrEqual(200);
  });
});

describe("page chunk locators", () => {
  const md = "# Title\n\nFirst paragraph here.\n\nSecond paragraph follows.";
  it("carries character offsets inside the page text", () => {
    const doc = buildCanonicalDocumentFromMarkdown({ documentId: "d", text: md, pageCount: 1, extractor: "x" });
    const second = doc.blocks.find(b => b.text.startsWith("Second"))!;
    expect(md.slice(second.metadata.charStart as number, second.metadata.charEnd as number)).toBe(second.text);
    const [chunk] = buildCanonicalChunksFromDocument(doc, "d", { maxChars: 4000 });
    expect(chunk.locator).toMatchObject({ kind: "page", pageNumber: 1, charStart: 0, charEnd: md.length });
  });
  it("normalizes parser boxes by page size and drops them without one", () => {
    const base = buildCanonicalDocumentFromMarkdown({ documentId: "d", text: "Hello world paragraph.", pageCount: 1, extractor: "x" });
    const payload = (extra: object) => ({ pages: [{ ...extra, blocks: [{ type: 0, bbox: [60, 80, 300, 120], lines: [{ spans: [{ text: "Hello world paragraph.", size: 10, font: "f" }] }] }] }] });
    const withSize = enrichCanonicalDocumentWithPyMuPdf(base, payload({ width: 600, height: 800 }));
    const [chunk] = buildCanonicalChunksFromDocument(withSize, "d");
    expect(chunk.locator).toMatchObject({ kind: "page", boxes: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.05 }] });
    const noSize = enrichCanonicalDocumentWithPyMuPdf(base, payload({}));
    expect(buildCanonicalChunksFromDocument(noSize, "d")[0].locator).toMatchObject({ kind: "page", boxes: [] });
  });
  it("uses an image locator for image sources", () => {
    const base = buildCanonicalDocumentFromMarkdown({ documentId: "i", text: "Receipt total 42", pageCount: 1, extractor: "ocr" });
    expect(buildCanonicalChunksFromDocument(base, "i", { sourceKind: "image" })[0].locator).toEqual({ kind: "image", boxes: [] });
  });
  it("converts columns to A1", () => {
    expect([1, 26, 27, 52, 703].map(columnLetters)).toEqual(["A", "Z", "AA", "AZ", "AAA"]);
    expect(a1(2, 7)).toBe("B7");
  });
});
