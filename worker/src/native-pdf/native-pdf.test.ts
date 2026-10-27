import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assemblePageMarkdown, planSpanPass } from "./assemble.js";
import { BindingNativePdfEngine, isNativePdfBindingModule } from "./binding-engine.js";
import { extractNativePdf } from "./extract.js";
import {
  applyNativePdfEngineEnv,
  loadNativePdfEngine,
  loadNativePdfModule,
  nativePdfVendorDir,
  readNativePdfManifest,
  setNativePdfEngineForTesting,
} from "./loader.js";
import { resolveNativePdfMode } from "./mode.js";
import { PopplerNativePdfEngine } from "./poppler-engine.js";
import { pageAgreement, runNativePdfShadow } from "./shadow.js";
import { assessTextPlausibility, isOcrLayer } from "./text-plausibility.js";
import {
  ENGINE_ERROR_CODES,
  NATIVE_PDF_FAILURE_KIND,
  NativePdfError,
  toNativePdfError,
  unsupported,
  type Bbox,
  type NativePdfEngine,
  type NativePdfPage,
  type NativePdfPageScan,
  type NativePdfScanRun,
  type NativePdfSpan,
  type NativePdfWord,
} from "./types.js";
import { ExtractorRegistry } from "../extractors/registry.js";

const span = (text: string, bbox: Bbox, font = "Helvetica", size = 10): NativePdfSpan => ({
  text, bbox, font, size, renderMode: 0, invisible: false, unmapped: 0,
});

interface FakePage extends Partial<NativePdfPage> { markdownText: string }

function fakeEngine(pages: FakePage[], opts: { failOpen?: boolean; openError?: unknown } = {}): NativePdfEngine {
  return {
    id: "fake",
    version: () => ({ engine: "native-pdf", version: "0.0.1", gitSha: "abcdef0123456789", features: [] }),
    async openPath() {
      if (opts.openError !== undefined) throw opts.openError;
      if (opts.failOpen) throw new NativePdfError("NATIVE_PDF_FAILED", "boom");
      return {
        pageCount: async () => pages.length,
        metadata: async () => ({ encrypted: false }),
        close: async () => undefined,
        page: (i: number): NativePdfPage => {
          const p = pages[i]!;
          return {
            size: p.size ?? (async () => ({ widthPt: 600, heightPt: 800, rotation: 0 as const })),
            text: async () => p.markdownText,
            markdown: p.markdown ?? (async () => p.markdownText),
            spans: p.spans ?? (async () => { throw unsupported("spans", "fake"); }),
            words: p.words ?? (async () => { throw unsupported("words", "fake"); }),
            images: p.images ?? (async () => []),
            drawings: async () => ({ lineCount: 0, rectCount: 0, longRuleCount: 0, vectorArea: 0 }),
            glyphStats: p.glyphStats ?? (async () => ({ glyphs: 0, invisible: 0, stroke: 0, unmapped: 0, fonts: 0 })),
            links: p.links ?? (async () => []),
            tables: async () => [],
            render: async () => Buffer.alloc(0),
            ocrFill: p.ocrFill ?? (async () => { throw unsupported("ocrFill", "fake"); }),
            ...(p.scan ? { scan: p.scan } : {}),
          };
        },
      };
    },
  };
}

afterEach(() => setNativePdfEngineForTesting(null));

describe("assemblePageMarkdown", () => {
  it("wraps link anchors using span geometry and leaves existing links alone", () => {
    const spans = [span("Read the docs", [10, 10, 80, 20]), span("site", [90, 10, 110, 20])];
    const out = assemblePageMarkdown({
      pageNumber: 1,
      markdown: "Read the docs at the site and [other](https://x.y)",
      spans,
      links: [{ uri: "https://example.com/docs", bbox: [8, 8, 82, 22] }],
    });
    expect(out.markdown).toContain("[Read the docs](https://example.com/docs)");
    expect(out.repairs).toContain("links:1");
    expect(out.markdown).toContain("[other](https://x.y)");
  });

  it("ignores non-http link targets", () => {
    const out = assemblePageMarkdown({
      pageNumber: 1, markdown: "click here", spans: [span("click here", [0, 0, 50, 10])],
      links: [{ uri: "javascript:alert(1)", bbox: [0, 0, 50, 10] }],
    });
    expect(out.markdown).toBe("click here");
  });

  it("fences runs of monospace lines with indentation and backticks a lone line", () => {
    const m = "Intro text\nfunction a() {\nreturn 1;\n}\nbetween\nlone\ntail";
    const spans = [
      span("Intro text", [10, 10, 80, 20]),
      span("function a() {", [10, 30, 90, 40], "Courier", 10),
      span("return 1;", [22, 42, 80, 52], "Courier", 10),
      span("}", [10, 54, 16, 64], "Courier", 10),
      span("between", [10, 66, 60, 76]),
      span("lone", [10, 80, 40, 90], "Menlo", 10),
      span("tail", [10, 100, 40, 110]),
    ];
    const out = assemblePageMarkdown({ pageNumber: 1, markdown: m, spans });
    expect(out.markdown).toContain("```\nfunction a() {\n  return 1;\n}\n```");
    expect(out.markdown).toContain("`lone`");
  });

  it("applies emphasis only when enabled and only to unambiguous text", () => {
    const spans = [span("Important", [0, 0, 50, 10], "Arial-Bold"), span("plain body text here", [0, 20, 100, 30])];
    const md = "Important\nplain body text here";
    expect(assemblePageMarkdown({ pageNumber: 1, markdown: md, spans }).markdown).toBe(md);
    expect(assemblePageMarkdown({ pageNumber: 1, markdown: md, spans }, { emphasis: true }).markdown).toContain("**Important**");
    const dup = assemblePageMarkdown({ pageNumber: 1, markdown: "Important and Important", spans }, { emphasis: true });
    expect(dup.markdown).toBe("Important and Important");
  });

  it("inserts image placeholders after the preceding text and skips scan layers and tiny images", () => {
    const spans = [span("Above the figure", [10, 10, 100, 20]), span("Below", [10, 400, 60, 410])];
    const out = assemblePageMarkdown({
      pageNumber: 3,
      markdown: "Above the figure\n\nBelow",
      spans,
      size: { widthPt: 600, heightPt: 800 },
      images: [
        { index: 0, bbox: [10, 100, 300, 300], widthPx: 600, heightPx: 400, effectiveDpi: 150 },
        { index: 1, bbox: [0, 0, 600, 800], widthPx: 1200, heightPx: 1600, effectiveDpi: 150 },
        { index: 2, bbox: [10, 320, 14, 324], widthPx: 8, heightPx: 8, effectiveDpi: 150 },
      ],
    });
    const lines = out.markdown.split("\n").filter(Boolean);
    expect(lines).toEqual(["Above the figure", "![image p3#1](docslurp:image/p3-1)", "Below"]);
    expect(out.repairs).toContain("images:1");
  });

  it("reorders interleaved two-column pages and flags RTL and math", () => {
    const left = Array.from({ length: 5 }, (_, i) => span(`${["amber","birch","cedar","dune","ember"][i]} left side ${["fox","gull","hawk","ibis","jay"][i]} text`, [40, 100 + i * 14, 260, 110 + i * 14]));
    const right = Array.from({ length: 5 }, (_, i) => span(`${["quartz","raven","slate","tundra","umber"][i]} right side ${["viper","wren","xenon","yak","zebra"][i]} text`, [340, 100 + i * 14, 560, 110 + i * 14]));
    const interleaved = left.flatMap((l, i) => [l.text, right[i]!.text]).join("\n");
    const out = assemblePageMarkdown({ pageNumber: 1, markdown: interleaved, spans: [...left, ...right], size: { widthPt: 600, heightPt: 800 } });
    expect(out.columns).toMatchObject({ columns: 2, interleaved: true });
    expect(out.repairs).toContain("column-order");
    const text = out.markdown.split("\n");
    expect(text.join(" ").indexOf("ember left")).toBeLessThan(text.join(" ").indexOf("quartz right"));

    const rtl = assemblePageMarkdown({ pageNumber: 1, markdown: "שלום עולם", spans: [span("שלום עולם", [0, 0, 50, 10])] });
    expect(rtl.warnings).toContain("rtl-visual-order");
    const math = assemblePageMarkdown({ pageNumber: 1, markdown: "x", spans: [span("∑∫∂∇∀∃∈∉ x", [0, 0, 50, 10])] });
    expect(math.warnings).toContain("math-needs-latex");
  });

  it("keeps single-column pages untouched", () => {
    const spans = Array.from({ length: 10 }, (_, i) => span(`a normal full width paragraph line ${i}`, [40, 100 + i * 14, 560, 110 + i * 14]));
    const md = spans.map((s) => s.text).join("\n");
    const out = assemblePageMarkdown({ pageNumber: 1, markdown: md, spans, size: { widthPt: 600, heightPt: 800 } });
    expect(out.markdown).toBe(md);
    expect(out.repairs).toEqual([]);
  });
});

describe("extractNativePdf", () => {
  it("joins per-page Markdown with form feeds, in order, even when side signals are unsupported", async () => {
    const result = await extractNativePdf(fakeEngine([{ markdownText: "# One" }, { markdownText: "Two" }, { markdownText: "Three" }]), "/x.pdf", { concurrency: 3 });
    expect(result.markdown).toBe("# One\fTwo\fThree");
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
  });

  it("rejects empty output so the caller falls back", async () => {
    const engine = fakeEngine([{ markdownText: "" }, { markdownText: "  " }, { markdownText: "" }]);
    await expect(extractNativePdf(engine, "/x.pdf")).rejects.toMatchObject({ code: "NATIVE_PDF_EMPTY" });
  });

  it("reroutes when interleaved columns cannot be repaired (table on page)", async () => {
    const mk = (xs: number, i: number, w: string) => span(`${w} ${i} alpha beta gamma ${w}x`, [xs, 100 + i * 14, xs + 200, 110 + i * 14]);
    const spans = [...Array.from({ length: 5 }, (_, i) => mk(40, i, ["amber", "birch", "cedar", "dune", "ember"][i]!)), ...Array.from({ length: 5 }, (_, i) => mk(340, i, ["quartz", "raven", "slate", "tundra", "umber"][i]!))];
    const md = "| a | b |\n" + [...spans].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]).map((s) => s.text).join("\n");
    const page = { markdownText: md, spans: async () => spans };
    const ok = await extractNativePdf(fakeEngine([page]), "/x.pdf", { rerouteOnLayoutRisk: false });
    await expect(extractNativePdf(fakeEngine([page]), "/x.pdf")).rejects.toMatchObject({ code: "NATIVE_PDF_LAYOUT" });
    expect(ok.warnings).toContain("multi-column-interleave");
  });

  it("treats image-placeholder-only pages as empty", async () => {
    const page = { markdownText: "", images: async () => [{ index: 0, bbox: [0, 0, 300, 400] as Bbox, widthPx: 900, heightPx: 1200, effectiveDpi: 200 }] };
    await expect(extractNativePdf(fakeEngine([page, page]), "/x.pdf")).rejects.toMatchObject({ code: "NATIVE_PDF_EMPTY" });
  });

  it("propagates open failures as NativePdfError", async () => {
    await expect(extractNativePdf(fakeEngine([{ markdownText: "a" }], { failOpen: true }), "/x.pdf")).rejects.toMatchObject({ code: "NATIVE_PDF_FAILED" });
  });

  it("falls back to plain text when a page's Markdown is unsupported or fails", async () => {
    for (const failure of [unsupported("markdown", "fake"), new Error("markdown crashed")]) {
      const page: FakePage = { markdownText: "plain words", markdown: async () => { throw failure; } };
      const result = await extractNativePdf(fakeEngine([page]), "/x.pdf");
      expect(result.markdown).toBe("plain words");
    }
  });
});

describe("shadow mode", () => {
  it("records per-page agreement and a document row without throwing", async () => {
    const engine = fakeEngine([{ markdownText: "alpha beta gamma" }, { markdownText: "delta" }]);
    const rows = await runNativePdfShadow({
      engine, sourcePath: "/x.pdf", documentId: "doc1", stageName: "extract-markdown",
      referencePages: ["alpha beta gamma", "something else"], referenceText: "", referenceExtractor: "kreuzberg",
    });
    const pageRows = rows.filter((r) => r.scope === "page");
    expect(pageRows.map((r) => [r.pageNumber, r.value])).toEqual([[1, 1], [2, 0]]);
    expect(rows.every((r) => r.metric === "native-pdf-shadow")).toBe(true);
    const doc = rows.find((r) => r.scope === "document")!;
    expect(doc.value).toBe(0.5);
    expect((doc.metadata as { adapter: string }).adapter).toBe("native-pdf-adapter@0.0.1+abcdef012345");
  });

  it("falls back to a document-only row without page boundaries and reports engine errors as rows", async () => {
    const engine = fakeEngine([{ markdownText: "alpha beta" }]);
    const rows = await runNativePdfShadow({
      engine, sourcePath: "/x.pdf", documentId: "d", stageName: "s", referencePages: null, referenceText: "alpha beta", referenceExtractor: "kreuzberg",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(1);
    const failed = await runNativePdfShadow({
      engine: fakeEngine([{ markdownText: "a" }], { failOpen: true }), sourcePath: "/x.pdf", documentId: "d", stageName: "s",
      referencePages: [], referenceText: "", referenceExtractor: "kreuzberg",
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ unit: "error", metadata: { code: "NATIVE_PDF_FAILED" } });
  });

  it("scores agreement as bag-of-words F1", () => {
    expect(pageAgreement("", "")).toBe(1);
    expect(pageAgreement("a b", "")).toBe(0);
    expect(pageAgreement("Hello, World", "world hello")).toBe(1);
  });
});

describe("mode, loader and engines", () => {
  it("defaults to off and ignores unknown values", () => {
    expect(resolveNativePdfMode({})).toBe("off");
    expect(resolveNativePdfMode({ DOCSLURP_PDF_ENGINE: "shadow" })).toBe("shadow");
    expect(resolveNativePdfMode({ DOCSLURP_PDF_ENGINE: "native-pdf" })).toBe("native-pdf");
    expect(resolveNativePdfMode({ DOCSLURP_PDF_ENGINE: "kreuzberg" })).toBe("off");
  });

  it("reports absence without throwing", async () => {
    setNativePdfEngineForTesting("no module");
    expect(await loadNativePdfEngine()).toEqual({ ok: false, reason: "no module" });
  });

  it("wraps a binding and maps NotImplementedError to unsupported", async () => {
    const binding = {
      version: () => ({ version: "1.2.3", gitSha: "deadbeefdeadbeef", features: ["markdown"] }),
      openPath: () => ({
        pageCount: () => 1, metadata: () => ({ encrypted: false }), close: () => undefined,
        page: () => ({
          size: () => ({ widthPt: 1, heightPt: 1, rotation: 0 as const }), text: () => "t", markdown: () => "# md",
          spans: () => { const e = new Error("nope"); e.name = "NotImplementedError"; throw e; },
          images: () => [], drawings: () => ({ lineCount: 0, rectCount: 0, longRuleCount: 0, vectorArea: 0 }),
          links: () => [], tables: () => [], render: () => Buffer.alloc(0),
        }),
      }),
    };
    expect(isNativePdfBindingModule(binding)).toBe(true);
    const engine = new BindingNativePdfEngine(binding);
    const doc = await engine.openPath("/x.pdf");
    await expect(doc.page(0).spans()).rejects.toMatchObject({ code: "NATIVE_PDF_UNSUPPORTED" });
    expect(await doc.page(0).markdown()).toBe("# md");
    const result = await extractNativePdf(engine, "/x.pdf");
    expect(result.markdown).toBe("# md");
  });

  it("serves text pages from poppler output and rejects geometry", async () => {
    const runner = {
      extractText: async () => ({ binary: "pdftotext", args: [], available: true }),
      run: async () => ({ stdout: "Page   one\n\nline\fPage two\f", stderr: "" }),
    };
    const result = await extractNativePdf(new PopplerNativePdfEngine(runner), "/x.pdf");
    expect(result.pageCount).toBe(2);
    expect(result.markdown).toBe("Page one\n\nline\fPage two");
  });
});

describe("registry integration", () => {
  const prior = process.env.DOCSLURP_PDF_ENGINE;
  afterEach(() => {
    if (prior === undefined) delete process.env.DOCSLURP_PDF_ENGINE;
    else process.env.DOCSLURP_PDF_ENGINE = prior;
  });

  it("leaves the pdf order unchanged when off and prepends native-pdf in native-pdf mode", () => {
    const registry = new ExtractorRegistry();
    delete process.env.DOCSLURP_PDF_ENGINE;
    expect(registry.resolve("pdf")).toEqual(["kreuzberg", "native-pdf", "poppler-text"]);
    process.env.DOCSLURP_PDF_ENGINE = "shadow";
    expect(registry.resolve("pdf")[0]).toBe("kreuzberg");
    process.env.DOCSLURP_PDF_ENGINE = "native-pdf";
    expect(registry.resolve("pdf")).toEqual(["native-pdf", "kreuzberg", "poppler-text"]);
  });

  it("marks native-pdf unavailable when no engine is installed so kreuzberg runs", async () => {
    const registry = new ExtractorRegistry();
    setNativePdfEngineForTesting("absent");
    const runner = { extractText: async () => ({ binary: "", args: [], available: false }), run: async () => ({ stdout: "", stderr: "" }) };
    const prepared = await registry.prepare("native-pdf", runner as never, "/tmp/x.pdf");
    expect(prepared.plan.available).toBe(false);
  });

  it("executes through the markdownFile executor with the fake engine", async () => {
    const registry = new ExtractorRegistry();
    setNativePdfEngineForTesting(fakeEngine([{ markdownText: "hello" }, { markdownText: "world" }]));
    const runner = { extractText: async () => ({ binary: "", args: [], available: false }), run: async () => ({ stdout: "", stderr: "" }) };
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/native-pdf-test-"));
    const prepared = await registry.prepare("native-pdf", runner as never, `${dir}/x.pdf`);
    expect(prepared.plan.available).toBe(true);
    let written = "";
    const executors = {
      markdownFile: async (_c: unknown, _k: string, outputPath: string) => {
        written = await import("node:fs/promises").then((fs) => fs.readFile(outputPath, "utf8"));
        return { label: "native-pdf" } as never;
      },
    };
    await prepared.execute(executors as never, "key", `${dir}/x.pdf`);
    expect(written).toBe("hello\fworld");
  });
});

describe("parser artifact", () => {
  it("builds a neutral native-pdf payload that aligns canonical blocks", async () => {
    const { buildNativeParserPayload } = await import("./parser-payload.js");
    const { buildCanonicalDocumentFromMarkdown } = await import("../lib/canonical-document.js");
    const { enrichCanonicalDocumentWithBestParser } = await import("../lib/parser-canonical.js");
    const engine = fakeEngine([{
      markdownText: "Hello world.",
      spans: async () => [span("Hello world.", [10, 20, 90, 30])],
    }]);
    const doc = await engine.openPath("/x.pdf");
    const payload = await buildNativeParserPayload(doc);
    const base = buildCanonicalDocumentFromMarkdown({ documentId: "d", text: "Hello world.", pageCount: 1, extractor: "native-pdf" });
    const enriched = enrichCanonicalDocumentWithBestParser(base, [{ parser: "native-pdf", payload, artifactUri: "s3://x" }]);
    expect(enriched.source.parser).toBe("native-pdf");
    expect(enriched.source.format).toBe("native-pdf-json");
    expect(enriched.blocks[0]!.pageNumber).toBe(1);
    expect(enriched.blocks[0]!.bbox).not.toBeNull();
  });
});

describe("invisible-text dropout guard", () => {
  const ocrText = "invisible ocr layer words ".repeat(20);
  const invisibleSpan = (text: string): NativePdfSpan => ({ ...span(text, [10, 10, 500, 20]), invisible: true, renderMode: 3 });

  it("rejects a document whose output lost an invisible OCR layer", async () => {
    const page: FakePage = { markdownText: "![img](p1)", spans: async () => [invisibleSpan(ocrText)] };
    const failure = await extractNativePdf(fakeEngine([page]), "/x.pdf", { minTextPageRatio: 0 }).catch((e) => e);
    expect(failure).toBeInstanceOf(NativePdfError);
    expect((failure as NativePdfError).code).toBe("NATIVE_PDF_DROPOUT");
  });

  it("keeps output that carries the invisible layer, and short or unknown pages", async () => {
    const keeps: FakePage = { markdownText: ocrText, spans: async () => [invisibleSpan(ocrText)] };
    const tiny: FakePage = { markdownText: "ok", spans: async () => [span("a few words", [0, 0, 50, 10])] };
    const noSignal: FakePage = { markdownText: "words without any side signal" };
    const result = await extractNativePdf(fakeEngine([keeps, tiny, noSignal]), "/x.pdf");
    expect(result.warnings).not.toContain("native-pdf-dropout");
  });

  it("falls back to glyph counts and the probe hint when spans are unavailable", async () => {
    const glyphOnly: FakePage = { markdownText: "x", glyphStats: async () => ({ glyphs: 900, invisible: 900, stroke: 0, unmapped: 0, fonts: 1 }) };
    const failure = await extractNativePdf(fakeEngine([glyphOnly]), "/x.pdf", { minTextPageRatio: 0 }).catch((e) => e);
    expect((failure as NativePdfError).code).toBe("NATIVE_PDF_DROPOUT");
    const hinted = await extractNativePdf(fakeEngine([{ markdownText: "x" }]), "/x.pdf", { minTextPageRatio: 0, expectedChars: () => 1500 }).catch((e) => e);
    expect((hinted as NativePdfError).code).toBe("NATIVE_PDF_DROPOUT");
  });

  it("can be switched off", async () => {
    const page: FakePage = { markdownText: "![img](p1)", spans: async () => [invisibleSpan(ocrText)] };
    const result = await extractNativePdf(fakeEngine([page]), "/x.pdf", { minTextPageRatio: 0, rejectOnDropout: false });
    expect(result.pages[0]!.warnings.some((w) => w.startsWith("native-pdf-dropout:"))).toBe(true);
  });

  const scans = ["scan-letter-32-good", "scan-article-2col-33-good", "scan-memo-35-good", "scan-lists-36-good"];
  const dir = "/path/to/eval-data/eval-suite/inputs";
  it.skipIf(!scans.every((name) => existsSync(`${dir}/${name}.pdf`)))("keeps the real good-OCR-layer scans on the installed binding", async () => {
    const loaded = await loadNativePdfEngine();
    if (!loaded.ok) return;
    for (const name of scans) {
      const result = await extractNativePdf(loaded.engine, `${dir}/${name}.pdf`);
      const page = result.pages[0]!;
      expect(page.expectedChars).toBeGreaterThan(500);
      expect(page.engineChars / page.expectedChars).toBeGreaterThan(0.9);
    }
  });
});

describe("OCR-layer spans in the repair pass", () => {
  const inv = (text: string, bbox: Bbox): NativePdfSpan => ({ ...span(text, bbox), invisible: true, renderMode: 3 });
  it("keeps invisible spans when they are the page's text layer, drops tiny hidden fragments over visible text", async () => {
    const { textLayerSpans } = await import("./assemble.js");
    const ocr = [inv("scanned words here", [10, 10, 100, 20]), inv("and more words", [10, 30, 100, 40])];
    expect(textLayerSpans(ocr)).toHaveLength(2);
    expect(textLayerSpans([...ocr, span("x", [0, 0, 5, 5])])).toHaveLength(3);
    const visible = [span("A real visible paragraph of text", [10, 10, 200, 20])];
    expect(textLayerSpans([...visible, inv("hidden", [0, 0, 5, 5])])).toEqual(visible);
  });

  const dir = "/path/to/eval-data/eval-suite/inputs";
  const repros = ["scan-article-2col-33-good", "scan-report-31-good", "scan-mixed-layers-3p"];
  it.skipIf(!repros.every((n) => existsSync(`${dir}/${n}.pdf`)))("repairs see the OCR layer of the repro scans", async () => {
    const loaded = await loadNativePdfEngine();
    if (!loaded.ok) return;
    for (const name of repros) {
      const doc = await loaded.engine.openPath(`${dir}/${name}.pdf`);
      const { groupLines } = await import("./assemble.js");
      const page = doc.page(0);
      const lines = groupLines(await page.spans());
      expect(lines.length, name).toBeGreaterThan(5);
      const result = await extractNativePdf(loaded.engine, `${dir}/${name}.pdf`);
      expect(result.pages[0]!.engineChars, name).toBeGreaterThan(500);
      expect(result.warnings, name).not.toContain("native-pdf-dropout");
      await doc.close();
    }
  });
});

describe("emphasis does not double-apply on upstream emphasis", () => {
  it.each(["Some **Bold words** here", "Some *Italic words* here"])("leaves %s untouched", (markdown) => {
    const target = markdown.includes("Bold") ? "Bold words" : "Italic words";
    const font = markdown.includes("Bold") ? "Helvetica-Bold" : "Helvetica-Oblique";
    const out = assemblePageMarkdown(
      { pageNumber: 1, markdown, spans: [span(target, [10, 10, 80, 20], font)] },
      { emphasis: true },
    );
    expect(out.markdown).toBe(markdown);
  });
});

/** A binding-shaped error (`EngineError`): message, `code`, optional `limit`. */
const engineError = (code: string | undefined, message = "engine says no", limit?: string) =>
  Object.assign(new Error(message), code === undefined ? {} : { code }, limit ? { limit } : {});

describe("engine error mapping", () => {
  it.each([
    ["PDF_LOCKED", "PDF_LOCKED", "locked"],
    ["PDF_UNSUPPORTED_ENCRYPTION", "PDF_UNSUPPORTED_ENCRYPTION", "expected"],
    ["PDF_LIMIT", "PDF_LIMIT", "expected"],
    ["NATIVE_PDF_UNSUPPORTED", "NATIVE_PDF_UNSUPPORTED", "expected"],
    ["PDF_ERROR", "NATIVE_PDF_FAILED", "unexpected"],
    ["PDF_CLOSED", "NATIVE_PDF_FAILED", "unexpected"],
    ["INVALID_ARGUMENT", "NATIVE_PDF_FAILED", "unexpected"],
    ["PDF_SOMETHING_NEW", "NATIVE_PDF_FAILED", "unexpected"],
    [undefined, "NATIVE_PDF_FAILED", "unexpected"],
  ])("maps engine code %s to %s (%s)", (engineCode, code, kind) => {
    const mapped = toNativePdfError(engineError(engineCode));
    expect(mapped).toMatchObject({ code, kind, engineCode: engineCode ?? "unknown" });
  });

  it("keeps the tripped limit and maps NotImplementedError by name", () => {
    expect(toNativePdfError(engineError("PDF_LIMIT", "too big", "total_decompressed_size")).limit).toBe("total_decompressed_size");
    const notImplemented = Object.assign(new Error("nope"), { name: "NotImplementedError" });
    expect(toNativePdfError(notImplemented).code).toBe("NATIVE_PDF_UNSUPPORTED");
  });

  it("gives every adapter code a failure kind", () => {
    for (const code of Object.values(ENGINE_ERROR_CODES)) expect(NATIVE_PDF_FAILURE_KIND[code]).toBeDefined();
  });

  // Guards against an upstream binding adding an error code the adapter has not decided an outcome for.
  const manifest = readNativePdfManifest(nativePdfVendorDir());
  const typings = manifest ? path.join(nativePdfVendorDir(), "node_modules", manifest.package, "index.d.ts") : "";
  it.skipIf(!typings || !existsSync(typings))("covers every error code the installed binding documents", () => {
    const doc = readFileSync(typings, "utf8");
    const documented = new Set([...doc.matchAll(/`((?:PDF|NATIVE_PDF|INVALID)_[A-Z_]+|INVALID_ARGUMENT)`/g)].map((m) => m[1]!));
    expect(documented.size).toBeGreaterThanOrEqual(7);
    for (const code of documented) expect(ENGINE_ERROR_CODES, code).toHaveProperty(code);
  });
});

describe("registry fallback semantics", () => {
  afterEach(() => vi.restoreAllMocks());

  async function runRegistry(openError: unknown) {
    const registry = new ExtractorRegistry();
    setNativePdfEngineForTesting(fakeEngine([{ markdownText: "unused" }], { openError }));
    const runner = { extractText: async () => ({ binary: "", args: [], available: false }), run: async () => ({ stdout: "", stderr: "" }) };
    const dir = await mkdtemp(path.join(os.tmpdir(), "native-pdf-fallback-"));
    const prepared = await registry.prepare("native-pdf", runner as never, `${dir}/x.pdf`);
    return await prepared.execute({ markdownFile: async () => ({ label: "native-pdf" }) } as never, "key", `${dir}/x.pdf`).then(
      () => null,
      (error: unknown) => error,
    );
  }

  it.each([
    ["PDF_LOCKED", "PDF_LOCKED", false],
    ["PDF_UNSUPPORTED_ENCRYPTION", "PDF_UNSUPPORTED_ENCRYPTION", false],
    ["PDF_LIMIT", "PDF_LIMIT", false],
    ["NATIVE_PDF_UNSUPPORTED", "NATIVE_PDF_UNSUPPORTED", false],
    ["PDF_ERROR", "NATIVE_PDF_FAILED", true],
    ["PDF_SOMETHING_NEW", "NATIVE_PDF_FAILED", true],
  ])("%s rejects as %s so the next extractor runs (warns: %s)", async (engineCode, code, warns) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const failure = await runRegistry(engineError(engineCode));
    expect(failure).toBeInstanceOf(NativePdfError);
    expect(failure).toMatchObject({ code });
    const logged = (warns ? warn : info).mock.calls.map((c) => String(c[0])).find((line) => line.includes("fell back"));
    expect(logged).toContain(`code=${code}`);
    expect(logged).toContain("next=next-in-order");
    if (!warns) expect(warn).not.toHaveBeenCalled();
  });

  it("rejects output-guard failures the same way (empty, dropout)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = new ExtractorRegistry();
    setNativePdfEngineForTesting(fakeEngine([{ markdownText: "" }]));
    const runner = { extractText: async () => ({ binary: "", args: [], available: false }), run: async () => ({ stdout: "", stderr: "" }) };
    const dir = await mkdtemp(path.join(os.tmpdir(), "native-pdf-fallback-"));
    const prepared = await registry.prepare("native-pdf", runner as never, `${dir}/x.pdf`);
    await expect(prepared.execute({ markdownFile: async () => ({}) } as never, "key", `${dir}/x.pdf`)).rejects.toMatchObject({ code: "NATIVE_PDF_EMPTY" });
  });
});

describe("binding adapter", () => {
  function fakeBinding(page: Record<string, unknown> = {}) {
    const opened: unknown[] = [];
    const binding = {
      version: () => ({ version: "9.9.9", gitSha: "0123456789abcdef", features: [] }),
      openPath: (_path: string, options?: unknown) => {
        opened.push(options);
        return {
          pageCount: () => 1, metadata: () => ({ encrypted: false }), close: () => undefined,
          page: () => ({
            size: () => ({ widthPt: 1, heightPt: 1, rotation: 0 as const }), text: () => "t", markdown: () => "m", spans: () => [],
            images: () => [], drawings: () => ({ lineCount: 0, rectCount: 0, longRuleCount: 0, vectorArea: 0 }),
            links: () => [], tables: () => [], render: () => Buffer.alloc(0), ...page,
          }),
        };
      },
    };
    return { binding, opened };
  }

  it("opens every document under the worker limits profile", async () => {
    const { binding, opened } = fakeBinding();
    const engine = new BindingNativePdfEngine(binding);
    await engine.openPath("/x.pdf");
    await engine.openPath("/y.pdf", { password: "secret" });
    expect(opened).toEqual([{ limits: { profile: "worker" } }, { limits: { profile: "worker" }, password: "secret" }]);
  });

  it("serves ocrFill through ocrFillAsync and reports unsupported without it or without models", async () => {
    const ocrFillAsync = vi.fn(async () => ({
      text: "scanned words", markdown: "scanned words", filledRegions: 2, engine: "ocr-model", policy: "fill", recognized: 2,
      replacedPages: 1, regions: 0, unmappedNative: false,
    }));
    const doc = await new BindingNativePdfEngine(fakeBinding({ ocrFillAsync }).binding).openPath("/x.pdf");
    expect(await doc.page(0).ocrFill({ policy: "adaptive", dpi: 150 })).toEqual({
      text: "scanned words", markdown: "scanned words", filledRegions: 2, engine: "ocr-model", replacedPages: 1,
    });
    expect(ocrFillAsync).toHaveBeenCalledWith({ policy: "adaptive", dpi: 150 });

    const older = await new BindingNativePdfEngine(fakeBinding().binding).openPath("/x.pdf");
    await expect(older.page(0).ocrFill()).rejects.toMatchObject({ code: "NATIVE_PDF_UNSUPPORTED" });
    const noModels = vi.fn(async () => { throw engineError("NATIVE_PDF_UNSUPPORTED", "OCR models are not configured"); });
    const bare = await new BindingNativePdfEngine(fakeBinding({ ocrFillAsync: noModels }).binding).openPath("/x.pdf");
    await expect(bare.page(0).ocrFill()).rejects.toMatchObject({ code: "NATIVE_PDF_UNSUPPORTED" });
  });

  it("maps neutral env settings onto the engine's variables without overriding explicit ones", () => {
    const target: NodeJS.ProcessEnv = { PDFUST_FONTS_DIR: "/explicit/fonts" };
    applyNativePdfEngineEnv(
      { NATIVE_PDF_OCR_MODEL_DIR: "/models", NATIVE_PDF_FONTS_DIR: "/fonts", NATIVE_PDF_OCR_MAX_CONCURRENT: " 2 " },
      target,
    );
    expect(target).toEqual({ PDFUST_OCR_MODEL_DIR: "/models", PDFUST_FONTS_DIR: "/explicit/fonts", PDFUST_OCR_MAX_CONCURRENT: "2" });
  });
});

/** Minimal one-page PDF: Type1 standard fonts, each line `[font, size, text]`; optional extra trailer entries/objects. */
function buildPdf(lines: Array<[string, number, string]>, extra?: { trailer: string; object: string }): Buffer {
  const fonts = [...new Set(lines.map(([font]) => font))];
  const content = lines
    .map(([font, size, text], i) => `BT /F${fonts.indexOf(font) + 1} ${size} Tf 50 ${740 - i * 18} Td (${text.replace(/[()\\]/g, "")}) Tj ET`)
    .join("\n");
  const fontRefs = fonts.map((_, i) => `/F${i + 1} ${5 + i} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${fontRefs} >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ...fonts.map((font) => `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`),
    ...(extra ? [extra.object] : []),
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  const trailer = extra ? extra.trailer.replace("{n}", String(objects.length)) : "";
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

const realModule = loadNativePdfModule();

describe.skipIf(!realModule.ok)("native-pdf on the installed binding", () => {
  const writePdf = async (name: string, bytes: Buffer) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "native-pdf-real-"));
    const file = path.join(dir, name);
    await writeFile(file, bytes);
    return file;
  };

  it("reports span fonts, so the code and emphasis repairs run on real output", async () => {
    const file = await writePdf("code.pdf", buildPdf([
      ["Helvetica-Bold", 16, "Installation guide"],
      ["Helvetica", 11, "Run the following commands before the first start of the service."],
      ["Courier", 10, "npm install --global docslurp"],
      ["Courier", 10, "docslurp init --workspace demo"],
      ["Courier", 10, "docslurp ingest ./reports"],
      ["Helvetica", 11, "The ingest command prints one line for every processed document."],
    ]));
    const loaded = await loadNativePdfEngine();
    if (!loaded.ok) return;
    const doc = await loaded.engine.openPath(file);
    const fonts = (await doc.page(0).spans()).map((s) => s.font);
    await doc.close();
    expect(fonts.every((font) => font !== "")).toBe(true);
    expect(fonts.some((font) => /courier/i.test(font))).toBe(true);
    const result = await extractNativePdf(loaded.engine, file, { emphasis: true });
    const page = result.pages[0]!;
    expect(page.repairs.some((r) => r.startsWith("code:"))).toBe(true);
    expect(page.markdown).toMatch(/```\n(?:.*\n)?npm install --global docslurp/);
  });

  it("rejects an unknown security handler with PDF_UNSUPPORTED_ENCRYPTION, not a password prompt", async () => {
    const file = await writePdf("acme.pdf", buildPdf([["Helvetica", 11, "Hello"]], {
      trailer: "/Encrypt {n} 0 R",
      object: "<< /Filter /AcmeSecure /V 1 /R 2 /O <00> /U <00> /P -4 >>",
    }));
    const loaded = await loadNativePdfEngine();
    if (!loaded.ok) return;
    await expect(loaded.engine.openPath(file)).rejects.toMatchObject({ code: "PDF_UNSUPPORTED_ENCRYPTION", kind: "expected" });
  });

  const hasQpdf = (() => { try { execFileSync("qpdf", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
  it.skipIf(!hasQpdf)("reports a user-password PDF as PDF_LOCKED and opens it with the password", async () => {
    const plain = await writePdf("plain.pdf", buildPdf([["Helvetica", 11, "Locked hello"]]));
    const locked = plain.replace(/plain\.pdf$/, "locked.pdf");
    execFileSync("qpdf", ["--encrypt", "user1", "owner1", "256", "--", plain, locked]);
    const loaded = await loadNativePdfEngine();
    if (!loaded.ok) return;
    await expect(loaded.engine.openPath(locked)).rejects.toMatchObject({ code: "PDF_LOCKED", kind: "locked" });
    const doc = await loaded.engine.openPath(locked, { password: "user1" });
    expect(await doc.page(0).text()).toContain("Locked hello");
    await doc.close();
  });

  it("re-reads a page admitted at an exact text budget without a spurious PDF_LIMIT", async () => {
    if (!realModule.ok) return;
    const file = await writePdf("budget.pdf", buildPdf([["Helvetica", 11, "Budgeted text that is read several times over."]]));
    const binding = realModule.module as {
      openPath(p: string, o?: unknown): { page(i: number): { text(): string; markdown(): string; spans(): unknown[]; glyphStats(): { glyphs: number } }; close(): void };
    };
    const probe = binding.openPath(file);
    const glyphs = probe.page(0).glyphStats().glyphs;
    probe.close();
    const doc = binding.openPath(file, { limits: { profile: "worker", maxTextGlyphs: glyphs } });
    const page = doc.page(0);
    const first = page.text();
    expect(page.markdown()).toContain("Budgeted");
    expect(page.spans().length).toBeGreaterThan(0);
    expect(page.text()).toBe(first);
    doc.close();
  });

  it("reports OCR without models as NATIVE_PDF_UNSUPPORTED (the executor's tesseract fallback)", async () => {
    const saved = process.env.PDFUST_OCR_MODEL_DIR;
    delete process.env.PDFUST_OCR_MODEL_DIR;
    try {
      const file = await writePdf("ocr.pdf", buildPdf([["Helvetica", 11, "Nothing to recognise"]]));
      const loaded = await loadNativePdfEngine();
      if (!loaded.ok) return;
      const doc = await loaded.engine.openPath(file);
      await expect(doc.page(0).ocrFill()).rejects.toMatchObject({ code: "NATIVE_PDF_UNSUPPORTED" });
      await doc.close();
    } finally {
      if (saved !== undefined) process.env.PDFUST_OCR_MODEL_DIR = saved;
    }
  });
});

describe("one-pass scan and conditional span pass", () => {
  const run = (text: string, bbox: Bbox, font = "Helvetica", extra: Partial<NativePdfScanRun> = {}): NativePdfScanRun => ({
    ...span(text, bbox, font), glyphs: text.length, overImage: 0, controlChars: 0, type3: false, ...extra,
  });
  const stats = (runs: NativePdfScanRun[]): NativePdfPageScan["stats"] => {
    const glyphs = runs.reduce((s, r) => s + r.glyphs, 0);
    return {
      glyphs, mapped: glyphs, unmapped: 0, stroke: 0, type3: 0, controlChars: 0,
      invisible: runs.filter((r) => r.invisible).reduce((s, r) => s + r.glyphs, 0),
      overImage: runs.reduce((s, r) => s + r.overImage, 0),
    };
  };
  const wordsOf = (runs: NativePdfScanRun[]): NativePdfWord[] => runs.flatMap((r) => {
    let x = r.bbox[0];
    return r.text.split(" ").map((w) => { const box: Bbox = [x, r.bbox[1], x + w.length * 5, r.bbox[3]]; x += (w.length + 1) * 5; return { text: w, bbox: box }; });
  });
  const prose = [
    run("The quarterly review covers three regions.", [50, 50, 300, 62]),
    run("Each region reports revenue and staffing.", [50, 70, 300, 82]),
  ];
  const scanPage = (runs: NativePdfScanRun[], extra: Partial<FakePage> = {}): FakePage & { spanCalls: () => number } => {
    let calls = 0;
    const markdownText = runs.filter((r) => !r.invisible || runs.every((x) => x.invisible)).map((r) => r.text).join("\n\n");
    return {
      markdownText,
      scan: async () => ({ runs, images: [], stats: stats(runs) }),
      words: async () => wordsOf(runs),
      spans: async () => { calls += 1; return runs.map(({ glyphs: _g, overImage: _o, controlChars: _c, type3: _t, ...s }) => s); },
      spanCalls: () => calls,
      ...extra,
    };
  };

  it("skips spans() when no span-based repair can apply, with the same Markdown as the per-signal path", async () => {
    const page = scanPage(prose);
    const fast = await extractNativePdf(fakeEngine([page]), "/x.pdf");
    expect(page.spanCalls()).toBe(0);
    const legacy = await extractNativePdf(fakeEngine([{ ...page, scan: undefined }]), "/x.pdf");
    expect(fast.markdown).toBe(legacy.markdown);
    expect(fast.pages[0]!.expectedChars).toBe(legacy.pages[0]!.expectedChars);
  });

  it("reads spans() when a link, kept image, monospace run or emphasis can change the page", async () => {
    const plan = (extra: Parameters<typeof planSpanPass>[0], emphasis = false) => planSpanPass(extra, { emphasis }).reasons;
    const base = { markdown: "text", runs: prose, words: wordsOf(prose), size: { widthPt: 600, heightPt: 800 } };
    expect(plan(base)).toEqual([]);
    expect(plan({ ...base, links: [{ uri: "https://example.com", bbox: [0, 0, 10, 10] }] })).toEqual(["links"]);
    expect(plan({ ...base, links: [{ uri: "javascript:void(0)", bbox: [0, 0, 10, 10] }] })).toEqual([]);
    expect(plan({ ...base, images: [{ index: 0, bbox: [50, 100, 300, 300], widthPx: 400, heightPx: 300, effectiveDpi: 150 }] })).toEqual(["images"]);
    expect(plan({ ...base, runs: [...prose, run("const x = 1;", [50, 90, 200, 100], "Courier")] })).toEqual(["code"]);
    expect(plan({ ...base, runs: [...prose, run("important", [50, 90, 200, 100], "Helvetica-Bold")] })).toEqual([]);
    expect(plan({ ...base, runs: [...prose, run("important", [50, 90, 200, 100], "Helvetica-Bold")] }, true)).toEqual(["emphasis"]);
    expect(plan({ ...base, words: undefined })).toEqual(["no-words"]);

    const mono = scanPage([...prose, run("const x = 1;", [50, 90, 200, 100], "Courier"), run("let y = 2;", [50, 102, 200, 112], "Courier")]);
    const out = await extractNativePdf(fakeEngine([mono]), "/x.pdf");
    expect(mono.spanCalls()).toBe(1);
    expect(out.pages[0]!.repairs.some((r) => r.startsWith("code:"))).toBe(true);
  });

  it("falls back to the per-signal reads when scan() is unsupported", async () => {
    const page = scanPage(prose, { scan: async () => { throw unsupported("scan", "fake"); } });
    const result = await extractNativePdf(fakeEngine([page]), "/x.pdf");
    expect(page.spanCalls()).toBe(1);
    expect(result.markdown).toContain("quarterly review");
  });
});

describe("hidden OCR-layer plausibility guard", () => {
  const fullPageImage = { index: 0, bbox: [0, 0, 600, 800] as Bbox, widthPx: 2500, heightPx: 3300, effectiveDpi: 300 };
  // Synthetic text classes only: natural prose, consonant-heavy letter salad, and flat lowercase word lists.
  const proseText = "The committee met on Tuesday to review the budget. Members agreed to fund two new projects, and the chair "
    + "asked for a short report by the end of the month. A vote on the remaining items is planned for May.";
  const letterSalad = Array.from({ length: 40 }, (_, i) => ["xkrtq", "bnvmpl", "zzrwkt", "qlpdfg", "trnvbx"][i % 5]).join(" ");
  const flatList = Array.from({ length: 40 }, (_, i) => ["harbor", "lantern", "meadow", "copper", "willow", "garnet"][i % 6]).join(" ");
  const ocrScan = (text: string, invisible = true): FakePage => {
    const runs: NativePdfScanRun[] = [{ ...span(text, [20, 20, 580, 780]), invisible, renderMode: invisible ? 3 : 0,
      glyphs: text.length, overImage: text.length, controlChars: 0, type3: false }];
    const glyphs = text.length;
    return {
      markdownText: text,
      scan: async () => ({ runs, images: [fullPageImage],
        stats: { glyphs, mapped: glyphs, unmapped: 0, invisible: invisible ? glyphs : 0, stroke: 0, type3: 0, controlChars: 0, overImage: glyphs } }),
      words: async () => [],
      images: async () => [fullPageImage],
    };
  };

  it("scores natural prose as plausible and letter salad or flat word lists as not", () => {
    expect(assessTextPlausibility(proseText).reasons).toEqual([]);
    expect(assessTextPlausibility(letterSalad).reasons).toContain("implausible-tokens");
    expect(assessTextPlausibility(flatList).reasons).toContain("flat-text");
    expect(assessTextPlausibility("too few words here").reasons).toEqual([]);
    // Codes, ordinals and units are ordinary letter/digit mixes.
    expect(assessTextPlausibility(`${proseText} Ref A4 ISO9001 2nd 10kg`).reasons).toEqual([]);
  });

  it("detects an OCR layer only for invisible text over a page-sized image", () => {
    expect(isOcrLayer({ glyphs: 100, invisible: 100, overImage: 100 })).toBe(true);
    expect(isOcrLayer({ glyphs: 100, invisible: 100, overImage: 0 })).toBe(false);
    expect(isOcrLayer({ glyphs: 100, invisible: 0, overImage: 100 })).toBe(false);
    expect(isOcrLayer({ glyphs: 0, invisible: 0, overImage: 0 })).toBe(false);
  });

  it("emits an unreliable OCR layer like a scan without text, without rejecting the document", async () => {
    const result = await extractNativePdf(fakeEngine([ocrScan(letterSalad), ocrScan(proseText)]), "/x.pdf");
    expect(result.pages[0]!.markdown).toBe("![image p1#1](docslurp:image/p1-1)");
    expect(result.pages[0]!.warnings[0]).toMatch(/^ocr-layer-unreliable:implausible-tokens/);
    expect(result.pages[1]!.markdown).toContain("committee met on Tuesday");
    expect(result.warnings).toContain("ocr-layer-unreliable");
    const flat = await extractNativePdf(fakeEngine([ocrScan(flatList)]), "/x.pdf");
    expect(flat.pages[0]!.markdown).toBe("![image p1#1](docslurp:image/p1-1)");
  });

  it("leaves visible text layers alone and can be switched off", async () => {
    const visible = await extractNativePdf(fakeEngine([ocrScan(letterSalad, false)]), "/x.pdf");
    expect(visible.pages[0]!.markdown).toContain("xkrtq");
    const off = await extractNativePdf(fakeEngine([ocrScan(letterSalad)]), "/x.pdf", { dropUnreliableOcrLayer: false });
    expect(off.pages[0]!.markdown).toContain("xkrtq");
  });
});
