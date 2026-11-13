import { describe, expect, it, vi } from "vitest";

import {
  DOPPLER_PAGE_FACTS_MAX_BYTES, DOPPLER_PAGE_FACTS_MAX_LINE_BYTES, dopplerPageFactsArtifact, dopplerPageFactsByteBudget, dopplerPageFactsMode,
  parseDopplerPageFacts, readDopplerPageFactsArtifact, type DopplerPageFactsDocument,
} from "./doppler-page-facts.js";
import { pageLayoutFactsFromDopplerFacts } from "./doppler-page-facts-layout.js";
import { parsePageLayoutFacts } from "./page-layout-facts.js";
import { probeRowsFromDopplerFacts } from "../routing/probe/doppler-facts.js";
import { pageInputFromProbeRow } from "../routing/page-input.js";
import {
  PRODUCER_MARKER, SCHEMA, docLine, figurePage, fullFixture, jsonl, runLine, scanPage, textPage,
} from "../test/doppler-page-facts-fixture.js";

function parse(input: unknown, pageCount = 3): DopplerPageFactsDocument {
  const result = parseDopplerPageFacts(input, { pageCount });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.facts;
}

/** Every number anywhere in a value is finite (and the walk finds no string from the document). */
function assertSane(value: unknown, path = "$"): void {
  if (typeof value === "number") { expect(Number.isFinite(value), path).toBe(true); return; }
  if (typeof value === "string") { expect(value.includes("PRODUCER-MARKER"), path).toBe(false); return; }
  if (Array.isArray(value)) { value.forEach((item, i) => assertSane(item, `${path}[${i}]`)); return; }
  if (value instanceof Map) { for (const [k, v] of value) assertSane(v, `${path}.get(${String(k)})`); return; }
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) assertSane(v, `${path}.${k}`);
}

describe("parseDopplerPageFacts: well-formed input", () => {
  it("reads every family of a full-level stream", () => {
    const facts = parse(fullFixture());
    expect([...facts.pages.keys()]).toEqual([1, 2, 3]);
    expect(facts.summary).toEqual({ pageCount: 3, pagesKnown: 3, pagesFailed: 0, linesDropped: 0, complete: true });
    expect(facts.run).toEqual({ pagesEmitted: 3, pagesFailed: 0, version: "25.10.0", commit: "abc1234" });
    const p1 = facts.pages.get(1)!;
    expect(Object.keys(p1).sort()).toEqual(["annots", "factsMs", "fonts", "forms", "geometry", "images", "layers", "page", "parseWarnings", "text", "unusualFeatures", "vectors"]);
    expect(p1.text).toMatchObject({ wordCount: 410, textLayer: "visible", mathGlyphRatio: 0.0125 });
    expect(p1.images?.items?.[0]).toMatchObject({ filter: "flate", colorSpace: "rgb", obj: 42, copy: "render", px: [300, 150] });
    expect(p1.annots?.bySubtype).toEqual({ link: 2, widget: 1 });
    expect(facts.pages.get(2)!.geometry).toEqual({ widthPt: 612, heightPt: 792, rotation: 90, userUnit: 1, mediaBox: [0, 0, 792, 612], cropBox: [0, 0, 792, 612] });
    expect(facts.pages.get(3)!.vectors?.clusters).toEqual([{ bbox: [72, 100, 540, 500], paths: 880, curves: 300, segments: 2000 }]);
    expect(facts.doc).toMatchObject({ level: "full", reportedPageCount: 3, pdfVersion: "1.7", lang: "en-US", acroForm: "present", ocgCount: 1 });
  });

  it("never keeps producer or creator, nor any unknown field", () => {
    const facts = parse(jsonl([docLine({ title: PRODUCER_MARKER }), textPage(1, { note: PRODUCER_MARKER, text: { ...textPage().text as object, extra: PRODUCER_MARKER } }), runLine()]), 1);
    expect("producer" in facts.doc).toBe(false);
    expect("creator" in facts.doc).toBe(false);
    const stored = JSON.stringify(dopplerPageFactsArtifact("doc-1", facts));
    expect(stored).not.toContain("PRODUCER-MARKER");
    expect(stored).not.toContain("producer");
    assertSane(facts);
  });

  it("reads a basic-level stream: families not computed are absent, not zero", () => {
    const basic = (n: number) => {
      const { fonts: _f, vectors: _v, forms: _fo, annots: _a, layers: _l, ...rest } = textPage(n);
      const text = { ...(rest.text as Record<string, unknown>) };
      for (const key of ["clippedCharCount", "controlCharRatio", "privateUseRatio", "replacementCharRatio", "mathGlyphRatio", "verticalCharRatio", "rotatedTextRatio", "textOverImageRatio"]) delete text[key];
      const { items: _i, maskCount: _m, inlineCount: _in, itemsTruncated: _it, ...images } = rest.images as Record<string, unknown>;
      return { ...rest, text, images, unusualFeatures: [] };
    };
    const facts = parse(jsonl([docLine({ level: "basic", producer: undefined, creator: undefined }), basic(1), runLine({ pagesEmitted: 1 })]), 1);
    const page = facts.pages.get(1)!;
    expect(page.fonts).toBeUndefined();
    expect(page.vectors).toBeUndefined();
    expect(page.images?.items).toBeUndefined();
    expect(page.text?.mathGlyphRatio).toBeUndefined();
  });

  it("accepts the bytes as well as a string, and tolerates CRLF", () => {
    expect(parse(Buffer.from(fullFixture())).pages.size).toBe(3);
    expect(parse(fullFixture().replaceAll("\n", "\r\n")).pages.size).toBe(3);
  });

  it("keeps a failed page as failed, with no other facts", () => {
    const facts = parse(jsonl([docLine(), { schema: SCHEMA, type: "page", page: 1, error: "failed", parseWarnings: ["page-failed"], unusualFeatures: [] }, scanPage(2), runLine()]), 2);
    expect(facts.pages.get(1)).toEqual({ page: 1, failed: true, parseWarnings: ["page-failed"], unusualFeatures: [] });
    expect(facts.summary.pagesFailed).toBe(1);
  });

  it("drops unknown enum values in lists, as the contract asks, and keeps the known ones", () => {
    const facts = parse(jsonl([docLine({ unusualFeatures: ["xfa-present", "future-flag"] }), textPage(1, { parseWarnings: ["limit-hit", "new-warning"], unusualFeatures: ["scan-page", "brand-new"] })]), 1);
    expect(facts.doc.unusualFeatures).toEqual(["xfa-present"]);
    expect(facts.pages.get(1)!.parseWarnings).toEqual(["limit-hit"]);
    expect(facts.pages.get(1)!.unusualFeatures).toEqual(["scan-page"]);
    expect(facts.summary.complete).toBe(false);
  });

  it("gives a locked or unreadable document no page facts", () => {
    for (const doc of [{ schema: SCHEMA, type: "doc", locked: true, encryption: "user-password-required", unusualFeatures: ["encrypted-user-password"] },
      { schema: SCHEMA, type: "doc", error: "damaged" }]) {
      const facts = parse(jsonl([doc, textPage(1), runLine()]), 1);
      expect(facts.pages.size).toBe(0);
    }
  });
});

describe("parseDopplerPageFacts: hostile input", () => {
  it("refuses the whole stream on a broken or missing doc line", () => {
    for (const input of [
      "", "\n", "not json\n", jsonl([textPage(1), docLine()]), jsonl([{ ...docLine(), schema: "doppler-page-facts/2" }]),
      jsonl([{ ...docLine(), unusualFeatures: "scan-page" }]), JSON.stringify(docLine()), `${JSON.stringify(docLine()).slice(0, -1)}\n`,
      jsonl([{ ...docLine(), note: "é" }]).replace("\\u00e9", "é"),
    ]) {
      const result = parseDopplerPageFacts(input, { pageCount: 3 });
      expect(result, JSON.stringify(input).slice(0, 80)).toEqual({ ok: false, reason: "header" });
    }
  });

  it("refuses unsupported inputs and a host page count it cannot bound by", () => {
    for (const input of [null, undefined, 42, {}, [fullFixture()], new ArrayBuffer(8)]) {
      expect(parseDopplerPageFacts(input, { pageCount: 3 })).toEqual({ ok: false, reason: "unsupported-input" });
    }
    for (const pageCount of [0, -1, 1.5, Number.NaN, Infinity, 100_001]) {
      expect(parseDopplerPageFacts(fullFixture(), { pageCount })).toEqual({ ok: false, reason: "page-count" });
    }
  });

  it("refuses oversized input before parsing it, at the per-page budget and the absolute ceiling", () => {
    expect(dopplerPageFactsByteBudget(1)).toBe(8 * 1024 * 1024 + 12 * 1024);
    expect(dopplerPageFactsByteBudget(100_000)).toBe(DOPPLER_PAGE_FACTS_MAX_BYTES);
    const big = fullFixture() + " ".repeat(dopplerPageFactsByteBudget(3));
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      expect(parseDopplerPageFacts(big, { pageCount: 3 })).toEqual({ ok: false, reason: "oversized" });
      expect(parseDopplerPageFacts(Buffer.from(big), { pageCount: 3 })).toEqual({ ok: false, reason: "oversized" });
      expect(parseSpy).not.toHaveBeenCalled();
    } finally { parseSpy.mockRestore(); }
  });

  it("drops an over-long line, a non-ASCII line and an unterminated last line", () => {
    const long = textPage(2, { pad: "x".repeat(DOPPLER_PAGE_FACTS_MAX_LINE_BYTES) });
    const nonAscii = JSON.stringify(scanPage(3)).replace("\"geometry\"", "\"geometry \"");
    const facts = parse(jsonl([docLine(), textPage(1), long, nonAscii]) + JSON.stringify(runLine()));
    expect([...facts.pages.keys()]).toEqual([1]);
    expect(facts.summary).toMatchObject({ linesDropped: 3, complete: false });
  });

  it("refuses non-ASCII in string input rather than folding it to ASCII (council #358 L1)", () => {
    // U+0131 would become 0x31 ("1") if only its low byte were kept.
    const line = JSON.stringify(textPage(1)).replace("\"page\":1,", "\"page\":\u0131,");
    expect(parse(jsonl([docLine(), line]), 1).pages.size).toBe(0);
  });

  it("refuses a stream with more lines than the page count allows", () => {
    const lines = [docLine(), ...Array.from({ length: 40 }, () => "{}")];
    expect(parseDopplerPageFacts(jsonl(lines), { pageCount: 3 })).toEqual({ ok: false, reason: "too-many-lines" });
  });

  it("drops non-finite and out-of-range numbers: the field, family or page becomes unknown", () => {
    const lines = [
      docLine({ ocgCount: -1, incrementalUpdates: 1.5, outlineCount: 1e400 }),
      // 1e999 parses to Infinity: the geometry is unknown, the rest of the page stands.
      JSON.stringify(textPage(1)).replace("\"widthPt\":612", "\"widthPt\":1e999"),
      // A ratio above 1: the text family is unknown.
      JSON.stringify(scanPage(2)).replace("\"textCoverage\":0.55", "\"textCoverage\":1.5"),
      // NaN is not JSON: the line is dropped.
      JSON.stringify(figurePage(3)).replace("\"paths\":900", "\"paths\":NaN"),
    ];
    const facts = parse(jsonl(lines));
    expect(facts.doc.ocgCount).toBeUndefined();
    expect(facts.doc.incrementalUpdates).toBeUndefined();
    expect(facts.doc.outlineCount).toBeUndefined();
    expect(facts.pages.get(1)!.geometry).toBeUndefined();
    expect(facts.pages.get(1)!.text).toBeDefined();
    expect(facts.pages.get(2)!.text).toBeUndefined();
    expect(facts.pages.get(2)!.images).toBeDefined();
    expect(facts.pages.has(3)).toBe(false);
    assertSane(facts);
  });

  it("keeps only pages within the host's page count, ascending, once", () => {
    const lines = [
      docLine({ pageCount: 1_000_000 }),
      textPage(0), textPage(-1), textPage(1.5 as unknown as number), textPage("2" as unknown as number),
      textPage(2), textPage(2), // a repeated page is unknown, whichever line is right
      textPage(1), // out of order
      scanPage(3), figurePage(4), // 4 is past the host's count
      runLine(),
    ];
    const facts = parse(jsonl(lines));
    expect([...facts.pages.keys()]).toEqual([3]);
    // The facts' own page count is reported, never used.
    expect(facts.doc.reportedPageCount).toBe(1_000_000);
    expect(facts.summary.pageCount).toBe(3);
  });

  it("makes a family with contradicting counts unknown", () => {
    const text = textPage(1).text as Record<string, unknown>;
    for (const bad of [{ visibleWordCount: 409 }, { textLayer: "invisible" }, { textLayer: "sideways" }, { clippedCharCount: 5 }]) {
      const facts = parse(jsonl([docLine(), textPage(1, { text: { ...text, ...bad } })]), 1);
      expect(facts.pages.get(1)!.text, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("makes an over-long or malformed list unknown rather than truncating it", () => {
    const images = textPage(1).images as Record<string, unknown>;
    const item = (images.items as unknown[])[0];
    const facts = parse(jsonl([
      docLine(),
      textPage(1, { images: { ...images, imageCount: 40, items: Array.from({ length: 33 }, (_, i) => ({ ...(item as object), index: i + 1 })) } }),
      textPage(2, { parseWarnings: Array.from({ length: 65 }, () => "limit-hit") }),
      textPage(3, { annots: { ...(textPage().annots as object), bySubtype: { link: -1 } } }),
    ]));
    expect(facts.pages.get(1)!.images).toBeDefined();
    expect(facts.pages.get(1)!.images!.items).toBeUndefined();
    expect(facts.pages.has(2)).toBe(false);
    expect(facts.pages.get(3)!.annots).toBeUndefined();
  });

  it("does not let a hostile key reach an object's prototype", () => {
    const line = JSON.stringify(textPage(1)).replace("\"bySubtype\":{", "\"bySubtype\":{\"__proto__\":{\"polluted\":1},\"constructor\":3,");
    const facts = parse(jsonl([docLine(), line]), 1);
    expect(facts.pages.get(1)!.annots!.bySubtype).toEqual({ link: 2, widget: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("survives deeply nested JSON on one line", () => {
    const deep = `{"schema":"${SCHEMA}","type":"page","page":1,"x":${"[".repeat(30_000)}${"]".repeat(30_000)}}`;
    const facts = parse(jsonl([docLine(), deep.length <= DOPPLER_PAGE_FACTS_MAX_LINE_BYTES ? deep : "{}"]), 1);
    expect(facts.pages.size).toBe(0);
  });

  it("mutation fuzz: never throws, never keeps a document string, every kept number finite and every page in range", () => {
    let seed = 0x5eed;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const base = fullFixture();
    const tokens = ["-1", "1e999", "0.5", "null", "true", "\"x\"", "[]", "{}", "1e308", "-0", "99999999999999999999", "\"__proto__\"", "\n"];
    for (let i = 0; i < 1500; i++) {
      let text = base;
      for (let m = 0; m < 1 + Math.floor(rand() * 6); m++) {
        const at = Math.floor(rand() * text.length);
        const op = rand();
        if (op < 0.3) text = text.slice(0, at) + tokens[Math.floor(rand() * tokens.length)] + text.slice(at + 1);
        else if (op < 0.5) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rand() * 20));
        else if (op < 0.7) text = text.slice(0, at) + String.fromCharCode(Math.floor(rand() * 256)) + text.slice(at + 1);
        else text = text.replace(/\d+(\.\d+)?/, () => tokens[Math.floor(rand() * 3)]!);
      }
      const result = parseDopplerPageFacts(text, { pageCount: 3 });
      if (!result.ok) continue;
      assertSane(result.facts);
      for (const [n, page] of result.facts.pages) {
        expect(n >= 1 && n <= 3 && page.page === n).toBe(true);
        for (const r of [page.text?.textCoverage, page.images?.imageCoverage, page.vectors?.coverage, page.text?.mathGlyphRatio]) {
          if (r !== undefined) expect(r >= 0 && r <= 1).toBe(true);
        }
      }
      // The mappers accept whatever the reader kept.
      pageLayoutFactsFromDopplerFacts(result.facts);
      probeRowsFromDopplerFacts(result.facts, 3);
    }
  }, 60_000);

  it("parses a hostile 100k-line stream within memory and time bounds", () => {
    const pageCount = 100_000;
    const line = (n: number) => `{"schema":"${SCHEMA}","type":"page","page":${n},"parseWarnings":["limit-hit","limit-hit"],"unusualFeatures":["x"],"junk":[1,2,3]}\n`;
    const input = JSON.stringify(docLine()) + "\n" + Array.from({ length: pageCount }, (_, i) => line(i + 1)).join("");
    expect(input.length).toBeLessThan(dopplerPageFactsByteBudget(pageCount));
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    const facts = parse(input, pageCount);
    const ms = performance.now() - started;
    expect(facts.pages.size).toBe(pageCount);
    expect(ms).toBeLessThan(10_000);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024 * 1024);
    // The same lines for a 10-page document: refused at the line cap, not parsed.
    const started2 = performance.now();
    expect(parseDopplerPageFacts(input, { pageCount: 10 })).toEqual({ ok: false, reason: "oversized" });
    const tight = JSON.stringify(docLine()) + "\n" + "{}\n".repeat(100_000);
    expect(parseDopplerPageFacts(tight, { pageCount: 10 })).toEqual({ ok: false, reason: "too-many-lines" });
    expect(performance.now() - started2).toBeLessThan(2_000);
  }, 60_000);
});

describe("stored artifact", () => {
  it("round-trips through the reader, revalidated, and refuses another document's facts", () => {
    const facts = parse(fullFixture());
    const artifact = JSON.parse(JSON.stringify(dopplerPageFactsArtifact("doc-1", facts)));
    const read = readDopplerPageFactsArtifact(artifact, { documentId: "doc-1", pageCount: 3 })!;
    expect(read.doc).toEqual(facts.doc);
    expect([...read.pages.entries()]).toEqual([...facts.pages.entries()]);
    expect(readDopplerPageFactsArtifact(artifact, { documentId: "doc-2", pageCount: 3 })).toBeNull();
    // A smaller host page count drops what it does not cover.
    expect([...readDopplerPageFactsArtifact({ ...artifact, pages: artifact.pages.slice(0, 2) }, { documentId: "doc-1", pageCount: 2 })!.pages.keys()]).toEqual([1, 2]);
  });
});

describe("dopplerPageFactsMode", () => {
  it("defaults to store, and turns an unknown value off", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(dopplerPageFactsMode({})).toBe("store");
    expect(dopplerPageFactsMode({ DOCSLURP_DOPPLER_PAGE_FACTS: " USE " })).toBe("use");
    expect(dopplerPageFactsMode({ DOCSLURP_DOPPLER_PAGE_FACTS: "off" })).toBe("off");
    expect(dopplerPageFactsMode({ DOCSLURP_DOPPLER_PAGE_FACTS: "yes" })).toBe("off");
    vi.restoreAllMocks();
  });
});

describe("pageLayoutFactsFromDopplerFacts (golden)", () => {
  it("maps every field facts can supply, and leaves the rest unknown", () => {
    const layout = pageLayoutFactsFromDopplerFacts(parse(fullFixture()));
    const logo = { bbox: [36, 36, 108, 72], coverage: 0.0103, widthPx: 300, heightPx: 150, bitsPerComponent: 8, colorSpace: "rgb", encoding: "image",
      ppi: [300, 300], bytesPerPixel: null, repeated: true, wordsInside: null };
    expect(Object.fromEntries(layout)).toEqual({
      1: { images: [logo], tables: null, words: 410, grids: null, tableCoverage: null, widthPt: 612, heightPt: 792, invisibleWords: 0, textLayer: "visible" },
      2: {
        images: [
          { bbox: [0, 0, 612, 792], coverage: 1, widthPx: 2550, heightPx: 3300, bitsPerComponent: 1, colorSpace: "gray", encoding: "ccitt",
            ppi: [300, 300], bytesPerPixel: null, repeated: false, wordsInside: null },
          logo,
        ],
        tables: null, words: 300, grids: [], tableCoverage: null, widthPt: 612, heightPt: 792, invisibleWords: 300, textLayer: "invisible",
      },
      3: { images: [logo], tables: null, words: 8, grids: [], tableCoverage: null, widthPt: 612, heightPt: 792, invisibleWords: 0, textLayer: "visible" },
    });
    // What it stores reads back through the layout reader unchanged (classify-route's path).
    const stored = { version: "pdf-layout-facts@1", pages: [...layout].map(([pageNumber, page]) => ({ pageNumber, known: true, ...page })) };
    expect(parsePageLayoutFacts(JSON.parse(JSON.stringify(stored)), 3)).toEqual(layout);
  });

  it("leaves images unknown when the list is truncated or not computed, and grids unknown at a cap", () => {
    const images = textPage(1).images as Record<string, unknown>;
    const vectors = textPage(1).vectors as Record<string, unknown>;
    const facts = parse(jsonl([
      docLine(),
      textPage(1, { images: { ...images, itemsTruncated: true } }),
      textPage(2, { images: { ...images, imageCount: 5 }, vectors: { ...vectors, hRules: 0, limitHit: true } }),
      { schema: SCHEMA, type: "page", page: 3, error: "failed", parseWarnings: [], unusualFeatures: [] },
    ]));
    const layout = pageLayoutFactsFromDopplerFacts(facts);
    expect(layout.get(1)!.images).toBeNull();
    expect(layout.get(2)!.images).toBeNull();
    expect(layout.get(2)!.grids).toBeNull();
    expect(layout.has(3)).toBe(false);
  });
});

describe("probeRowsFromDopplerFacts (golden)", () => {
  it("maps pages to probe rows the router accepts", async () => {
    const rows = probeRowsFromDopplerFacts(parse(fullFixture()), 3);
    expect(rows.map((row) => [row.pageNumber, row.pageCount, row.textLayerStatus, row.tableRuleScore, row.needsAttention])).toEqual([
      [1, 3, "ok", 5, true],
      [2, 3, "ocr-layer", 0, false],
      [3, 3, "ok", 0, false],
    ]);
    expect(rows[1]).toEqual({
      pageNumber: 2, pageCount: 3, charCount: 1800, wordCount: 300, textCoverage: 0.55, fontCount: 1, unmappedGlyphRatio: 0, mathGlyphRatio: 0,
      tableRuleScore: 0, imageCoverage: 1, largestImageCoverage: 1, fullPageImage: true, vectorDrawingCount: 0, uncoveredVectorRatio: 0,
      garbled: false, textLayerStatus: "ocr-layer", imageCount: 2,
      textFacts: { wordCount: 300, imageCount: 2, imageCoverage: 1, textLayerStatus: "ocr-layer" },
      invisibleTextRatio: 1, textOverImageRatio: 1,
      images: [{ bbox: [0, 0, 612, 792], coverage: 1 }, { bbox: [36, 36, 108, 72], coverage: 0.0103 }],
      smallestFontPt: 9.5, widthPt: 612, heightPt: 792, rotation: 90, probeMs: 2.5, unusualFeatures: ["rotated-page", "scan-page"],
      needsAttention: false, probeEngine: "doppler-facts",
    });
    expect(rows.every((row) => row.thumbnail === undefined)).toBe(true);
    for (const row of rows) {
      const input = await pageInputFromProbeRow(row, null);
      expect(input.features.pageNumber).toBe(row.pageNumber);
      expect(input.thumbnail).toBeUndefined();
    }
  });

  it("gives a locked document the probe's single locked row, and an unreadable one none", () => {
    const locked = parse(jsonl([{ schema: SCHEMA, type: "doc", locked: true, unusualFeatures: ["encrypted-user-password"] }]), 5);
    expect(probeRowsFromDopplerFacts(locked, 5)).toMatchObject([{ locked: true, textLayerStatus: "unknown", needsAttention: true, probeEngine: "doppler-facts" }]);
    expect(probeRowsFromDopplerFacts(parse(jsonl([{ schema: SCHEMA, type: "doc", error: "open-failed" }]), 5), 5)).toEqual([]);
  });
});
