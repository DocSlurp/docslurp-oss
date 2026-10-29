import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { createProbeRunner, parseProbeOutput, readProbeOverlap } from "../page-input.js";
import { setProbeBindingForTesting, type Box, type ProbeBinding, type ProbeBindingPage } from "./binding.js";
import { laplacianVariance, parsePages, percentiles, textLayerStatus } from "./features.js";
import type { CommandPlan } from "../../tools/runner.js";
import { sandboxedTesseract } from "./ocr-layer.js";
import { PROBE_LIMITS, PROBE_OVERLAP_MAX_OBJECTS, PROBE_OVERLAP_MAX_PAGES, probeNativePdf, type NativeProbeRow } from "./probe.js";

const png = await sharp({ create: { width: 612, height: 792, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();

interface FakePage {
  spans?: Array<{ text: string; bbox: Box; font?: string; size?: number }>;
  images?: Array<{ bbox: Box; widthPx?: number }>;
  stats?: Partial<ReturnType<ProbeBindingPage["glyphStats"]>>;
  drawings?: Partial<ReturnType<ProbeBindingPage["drawings"]>>;
  widgets?: Array<{ value?: string }>;
  annotations?: string[];
  rotation?: number;
  size?: { widthPt: number; heightPt: number };
}

const PROSE = "The quick brown fox jumps over the lazy dog and the cat is on the mat with all of the other animals here. ";

function fakeBinding(pages: FakePage[], extra: { js?: boolean; fonts?: Array<{ type: string; hasToUnicode: boolean }>; encrypted?: boolean; openError?: string } = {}): ProbeBinding {
  return {
    version: () => ({ version: "0.0.0-test", gitSha: "abcdef0123456", features: [] }),
    openPath: () => {
      if (extra.openError) throw Object.assign(new Error("boom"), { code: extra.openError });
      return {
        pageCount: () => pages.length,
        metadata: () => ({ encrypted: extra.encrypted ?? false, producer: "unit" }),
        hasJavaScript: () => extra.js ?? false,
        optionalContent: () => [],
        attachments: () => [],
        fonts: () => (extra.fonts ?? []).map((f, i) => ({ name: `F${i}`, embedded: true, isType3: f.type === "Type3", ...f })),
        close: () => undefined,
        page: (i: number) => {
          const p = pages[i]!;
          const spans = (p.spans ?? []).map((s) => ({ font: "Times", size: 11, renderMode: 0, invisible: false, unmapped: 0, ...s }));
          return {
            size: () => ({ widthPt: 612, heightPt: 792, ...p.size, rotation: p.rotation ?? 0 }),
            spans: () => spans,
            glyphStats: () => ({ glyphs: spans.reduce((n, s) => n + s.text.length, 0), invisible: 0, stroke: 0, unmapped: 0, fonts: 1, ...p.stats }),
            images: () => (p.images ?? []).map((im, index) => ({ index, widthPx: 1000, heightPx: 1000, effectiveDpi: 150, ...im })),
            drawings: () => ({ lineCount: 0, rectCount: 0, longRuleCount: 0, vectorArea: 0, ...p.drawings }),
            widgets: () => (p.widgets ?? []).map((w) => ({ kind: "text", bbox: [0, 0, 1, 1] as Box, ...w })),
            annotations: () => (p.annotations ?? []).map((subtype) => ({ subtype, bbox: [0, 0, 1, 1] as Box })),
            links: () => [],
            renderAsync: async () => png,
          } as ProbeBindingPage;
        },
      };
    },
  };
}

async function collect(binding: ProbeBinding, opts: Partial<Parameters<typeof probeNativePdf>[1]> = {}): Promise<NativeProbeRow[]> {
  const rows: NativeProbeRow[] = [];
  for await (const row of probeNativePdf(binding, { pdfPath: "/tmp/x.pdf", ...opts })) rows.push(row);
  return rows;
}

afterEach(() => setProbeBindingForTesting(null));

describe("native page probe", () => {
  it("renders on a second handle while reading features, with the same rows as one handle", async () => {
    const pages: FakePage[] = [
      { spans: [{ text: PROSE.repeat(4), bbox: [50, 50, 550, 700] }] },
      { images: [{ bbox: [0, 0, 612, 792] }] },
    ];
    const base = fakeBinding(pages);
    const opened: Array<{ renders: number; closed: boolean }> = [];
    const binding: ProbeBinding = {
      ...base,
      openPath: (file, options) => {
        const doc = base.openPath(file, options);
        const handle = { renders: 0, closed: false };
        opened.push(handle);
        return {
          ...doc,
          close: () => { handle.closed = true; },
          page: (i: number) => {
            const page = doc.page(i);
            return { ...page, renderAsync: async (o) => { handle.renders += 1; return await page.renderAsync(o); } };
          },
        };
      },
    };
    const strip = (rows: NativeProbeRow[]) => rows.map(({ probeMs: _probeMs, ...row }) => row);
    const overlapped = await collect(binding);
    expect(opened.map((h) => h.renders)).toEqual([0, 2]);
    expect(opened.every((h) => h.closed)).toBe(true);
    opened.length = 0;
    const sequential = await collect(binding, { overlapRender: false });
    expect(opened.map((h) => h.renders)).toEqual([2]);
    expect(strip(overlapped)).toEqual(strip(sequential));
  });

  it("keeps a page whose early render fails as a failed row, like the sequential probe", async () => {
    const base = fakeBinding([{ spans: [{ text: PROSE, bbox: [50, 50, 550, 700] }] }]);
    let opens = 0;
    const binding: ProbeBinding = {
      ...base,
      openPath: (file, options) => {
        const doc = base.openPath(file, options);
        const second = ++opens === 2;
        return { ...doc, page: (i: number) => ({ ...doc.page(i), renderAsync: async () => { if (second) throw new Error("render boom"); return png; } }) };
      },
    };
    const [row] = await collect(binding);
    expect(row!.unusualFeatures).toContain("probe-error");
  });

  /**
   * Wraps `fakeBinding` so every handle counts its in-flight renders; renders resolve on a later timer tick, so they
   * are still pending while the page's features are read. `close()` records how many renders were in flight.
   */
  function trackedBinding(pages: FakePage[], hooks: { spansThrow?: (pageIndex: number) => boolean; onRender?: (handle: number, pageIndex: number) => void } = {}) {
    const base = fakeBinding(pages);
    const handles: Array<{ inFlight: number; maxInFlight: number; renders: number; closedWithInFlight: number | null }> = [];
    const binding: ProbeBinding = {
      ...base,
      openPath: (file, options) => {
        const doc = base.openPath(file, options);
        const index = handles.length;
        const handle = { inFlight: 0, maxInFlight: 0, renders: 0, closedWithInFlight: null as number | null };
        handles.push(handle);
        return {
          ...doc,
          close: () => { handle.closedWithInFlight = handle.inFlight; },
          page: (i: number) => {
            const page = doc.page(i);
            return {
              ...page,
              spans: () => { if (hooks.spansThrow?.(i)) throw new Error("spans boom"); return page.spans(); },
              renderAsync: async (o) => {
                handle.inFlight += 1;
                handle.renders += 1;
                handle.maxInFlight = Math.max(handle.maxInFlight, handle.inFlight);
                hooks.onRender?.(index, i);
                try {
                  await new Promise((resolve) => setTimeout(resolve, 5));
                  return await page.renderAsync(o);
                } finally {
                  handle.inFlight -= 1;
                }
              },
            };
          },
        };
      },
    };
    return { binding, handles };
  }

  it("settles the early render before failing a page whose feature read throws, and before close", async () => {
    const pages: FakePage[] = [{ spans: [{ text: PROSE, bbox: [50, 50, 550, 700] }] }, { spans: [{ text: PROSE, bbox: [50, 50, 550, 700] }] }, {}];
    const { binding, handles } = trackedBinding(pages, { spansThrow: (i) => i !== 1 });
    const rows = await collect(binding);
    expect(rows.map((r) => r.unusualFeatures?.includes("probe-error"))).toEqual([true, false, true]);
    expect(handles).toHaveLength(2);
    expect(handles[1]!.renders).toBe(3);
    for (const handle of handles) {
      expect(handle.maxInFlight).toBeLessThanOrEqual(1);
      expect(handle.closedWithInFlight).toBe(0);
    }
  });

  it("closes both handles only after the in-flight render settles when aborted mid-render", async () => {
    const controller = new AbortController();
    const pages: FakePage[] = [{ spans: [{ text: PROSE, bbox: [50, 50, 550, 700] }] }, {}, {}];
    const { binding, handles } = trackedBinding(pages, { onRender: (handle) => { if (handle === 1) controller.abort(); } });
    await expect(collect(binding, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(handles[1]!.renders).toBe(1);
    for (const handle of handles) {
      expect(handle.maxInFlight).toBeLessThanOrEqual(1);
      expect(handle.closedWithInFlight).toBe(0);
    }
  });

  it("closes both handles with no render in flight when the consumer returns early", async () => {
    const pages: FakePage[] = [{ spans: [{ text: PROSE, bbox: [50, 50, 550, 700] }] }, {}, {}];
    const { binding, handles } = trackedBinding(pages, { spansThrow: (i) => i === 0 });
    for await (const row of probeNativePdf(binding, { pdfPath: "/tmp/x.pdf" })) {
      expect(row.pageNumber).toBe(1);
      break;
    }
    expect(handles[1]!.renders).toBe(1);
    for (const handle of handles) expect(handle.closedWithInFlight).toBe(0);
  });

  it("opens the second handle under the probe limits plus an object ceiling, and probes on one handle when that open fails", async () => {
    const base = fakeBinding([{}, {}]);
    const limits: unknown[] = [];
    let renders = 0;
    const binding: ProbeBinding = {
      ...base,
      openPath: (file, options) => {
        limits.push(options?.limits);
        if (limits.length === 2) throw Object.assign(new Error("too many objects"), { code: "PDF_LIMIT", limit: "object_count" });
        const doc = base.openPath(file, options);
        return { ...doc, page: (i: number) => ({ ...doc.page(i), renderAsync: async () => { renders += 1; return png; } }) };
      },
    };
    const rows = await collect(binding);
    expect(limits).toEqual([PROBE_LIMITS, { ...PROBE_LIMITS, maxObjects: PROBE_OVERLAP_MAX_OBJECTS }]);
    expect(rows.every((row) => !row.unusualFeatures?.includes("probe-error"))).toBe(true);
    expect(renders).toBe(2);
  });

  it("opens no second handle when overlap is off or the document exceeds the page ceiling", async () => {
    const pages: FakePage[] = [{}, {}, {}];
    const off = trackedBinding(pages);
    await collect(off.binding, { overlapRender: false });
    expect(off.handles).toHaveLength(1);
    const large = trackedBinding(pages);
    await collect(large.binding, { overlapRenderMaxPages: 2 });
    expect(large.handles).toHaveLength(1);
    expect(large.handles[0]!.renders).toBe(3);
    const within = trackedBinding(pages);
    await collect(within.binding, { overlapRenderMaxPages: 3 });
    expect(within.handles).toHaveLength(2);
  });

  it("classifies text, blank and raster pages like the Python probe", async () => {
    const rows = await collect(fakeBinding([
      { spans: [{ text: PROSE.repeat(4), bbox: [50, 50, 550, 700] }] },
      {},
      { images: [{ bbox: [0, 0, 612, 792] }] },
    ]));
    expect(rows.map((r) => r.textLayerStatus)).toEqual(["ok", "absent", "unknown"]);
    expect(rows[0]).toMatchObject({ pageNumber: 1, pageCount: 3, charCount: expect.any(Number), garbled: false });
    expect(rows[0]!.wordCount).toBeGreaterThan(60);
    expect(rows[0]!.textFacts).toMatchObject({ line: expect.stringContaining("text layer ok") });
    expect(rows[2]).toMatchObject({ fullPageImage: true, imageCount: 1, largestImageDpi: 117.6 });
    expect(rows[2]!.largestImageDpi).toBeGreaterThan(100);
    expect(rows[0]!.probeEngine).toBe("native-pdf@0.0.0-test+abcdef0");
    expect(rows[0]!.blur).toBe(0);
  });

  it("reports a hidden layer over a page image as ocr-layer and verifies it with the recogniser", async () => {
    const page: FakePage = {
      spans: [{ text: PROSE.repeat(3), bbox: [40, 60, 570, 700], font: "GlyphLessFont" }],
      images: [{ bbox: [0, 0, 612, 792] }],
      stats: { glyphs: 100, invisible: 100 },
    };
    const unverified = (await collect(fakeBinding([page])))[0]!;
    expect(unverified).toMatchObject({ textLayerStatus: "ocr-layer", invisibleTextRatio: 1, ocrEngineHint: true });
    expect(unverified.textOverImageRatio).toBeGreaterThan(0.9);

    const agrees = (await collect(fakeBinding([page]), { verifyOcrLayer: true, recognise: async () => PROSE.repeat(3) }))[0]!;
    expect(agrees.ocrLayerCheck?.agreement).toBeGreaterThanOrEqual(0.8);
    expect(agrees.textLayerStatus).toBe("ok");
    expect(agrees.textFacts).toMatchObject({ line: expect.stringContaining("OCR layer matches") });

    const lies = (await collect(fakeBinding([page]), { verifyOcrLayer: true, recognise: async () => "zebra quartz mango violin pepper tundra walnut cobalt harbor lantern ".repeat(2) }))[0]!;
    expect(lies.ocrLayerCheck?.agreement).toBe(0);
    expect(lies.textLayerStatus).toBe("suspect");

    const unverifiable = (await collect(fakeBinding([page]), { verifyOcrLayer: true, recognise: async () => null }))[0]!;
    expect(unverifiable.ocrLayerCheck?.agreement).toBeNull();
    expect(unverifiable.textLayerStatus).toBe("ocr-layer");
  });

  it("never runs tesseract itself: without a sandboxed recogniser the OCR layer stays unverified", async () => {
    const page: FakePage = {
      spans: [{ text: PROSE.repeat(3), bbox: [40, 60, 570, 700], font: "GlyphLessFont" }],
      images: [{ bbox: [0, 0, 612, 792] }],
      stats: { glyphs: 100, invisible: 100 },
    };
    // A tesseract on PATH that would be found by a bare spawn must not be used.
    const bin = await mkdtemp(path.join(os.tmpdir(), "docslurp-probe-bin-"));
    const marker = path.join(bin, "ran");
    await writeFile(path.join(bin, "tesseract"), `#!/bin/sh\ntouch ${marker}\necho ${PROSE.repeat(3)}\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
    try {
      const row = (await collect(fakeBinding([page]), { verifyOcrLayer: true }))[0]!;
      expect(row.ocrLayerCheck?.agreement).toBeNull();
      expect(row.textLayerStatus).toBe("ocr-layer");
      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("leaves an oversized OCR band unverified instead of OCRing it", async () => {
    let calls = 0;
    // A 100 x 100 inch page: its band is about 25 MP at the check's 100 dpi.
    const page: FakePage = {
      size: { widthPt: 7200, heightPt: 7200 },
      spans: [{ text: PROSE.repeat(3), bbox: [40, 60, 7000, 7000], font: "GlyphLessFont" }],
      images: [{ bbox: [0, 0, 7200, 7200] }],
      stats: { glyphs: 100, invisible: 100 },
    };
    const row = (await collect(fakeBinding([page]), { verifyOcrLayer: true, recognise: async () => { calls += 1; return PROSE.repeat(3); } }))[0]!;
    expect(calls).toBe(0);
    expect(row.ocrLayerCheck?.agreement).toBeNull();
  });

  it("runs the OCR-layer recogniser through the command runner with a bounded, single-threaded plan", async () => {
    const plans: CommandPlan[] = [];
    const runner = {
      plan: async (binary: string, ...args: string[]) => ({ binary, args, available: true }),
      run: async (plan: CommandPlan) => {
        plans.push(plan);
        await writeFile(`${plan.args[1]}.txt`, "recognised words");
        return { stdout: "", stderr: "" } as never;
      },
    };
    expect(await sandboxedTesseract(runner)(png)).toBe("recognised words");
    expect(plans[0]).toMatchObject({ binary: "tesseract", timeoutMs: 60_000, bundleEnv: { OMP_THREAD_LIMIT: "1" } });
    expect(plans[0]!.args.slice(2)).toEqual(["--psm", "4", "-l", "eng"]);
    const missing = { plan: async (binary: string, ...args: string[]) => ({ binary, args, available: false }), run: runner.run };
    expect(await sandboxedTesseract(missing)(png)).toBeNull();
  });

  it("flags unusual features per page and per document", async () => {
    const rows = await collect(
      fakeBinding(
        [{ widgets: [{ value: "Ada" }], annotations: ["Highlight", "Popup", "Link"], rotation: 90 }, { widgets: [{ value: "" }] }],
        { js: true, encrypted: true, fonts: [{ type: "Type3", hasToUnicode: false }, { type: "Type0", hasToUnicode: false }] },
      ),
    );
    expect(rows[0]!.unusualFeatures).toEqual([
      "acroform-filled", "annotation-highlight", "encrypted-empty-password", "javascript", "no-tounicode", "rotated-page", "type3-font",
    ]);
    expect(rows[1]!.unusualFeatures).toContain("acroform-empty");
    expect(rows[0]!.needsAttention).toBe(true);
  });

  it("downgrades a text layer whose Type0 fonts lack ToUnicode", async () => {
    const [row] = await collect(fakeBinding([{ spans: [{ text: PROSE.repeat(4), bbox: [50, 50, 550, 700] }] }], { fonts: [{ type: "Type0", hasToUnicode: false }] }));
    expect(row!.textLayerStatus).toBe("suspect");
    expect(row!.textFacts).toMatchObject({ line: expect.stringContaining("text layer suspect") });
  });

  it("infers no-tounicode from unmapped glyphs on pages with Type0 fonts", async () => {
    const [row] = await collect(fakeBinding([{ spans: [{ text: PROSE.repeat(4), bbox: [50, 50, 550, 700] }], stats: { glyphs: 10, unmapped: 400 } }], { fonts: [{ type: "Type0", hasToUnicode: true }] }));
    expect(row!.unusualFeatures).toContain("no-tounicode");
    const [partial] = await collect(fakeBinding([{ spans: [{ text: PROSE.repeat(4), bbox: [50, 50, 550, 700] }], stats: { unmapped: 20 } }], { fonts: [{ type: "Type0", hasToUnicode: true }] }));
    expect(partial!.unusualFeatures).not.toContain("no-tounicode");
    const [clean] = await collect(fakeBinding([{ spans: [{ text: PROSE.repeat(4), bbox: [50, 50, 550, 700] }] }], { fonts: [{ type: "Type0", hasToUnicode: true }] }));
    expect(clean!.unusualFeatures).not.toContain("no-tounicode");
  });

  it("counts glyphs the engine dropped as unmapped and writes thumbnails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "probe-thumb-"));
    const [row] = await collect(fakeBinding([{ spans: [{ text: PROSE.repeat(4), bbox: [50, 50, 550, 700] }], stats: { unmapped: 40 } }]), { thumbDir: dir, thumbPx: 100 });
    expect(row!.unmappedGlyphRatio).toBeGreaterThan(0.03);
    expect(row!.textLayerStatus).toBe("suspect");
    expect(path.basename(row!.thumbnail!)).toBe("x-p0001.png");
    expect((await readFile(row!.thumbnail!)).byteLength).toBeGreaterThan(0);
  });

  it("emits an explicit row for locked documents and throws a typed error for unreadable ones", async () => {
    const [locked] = await collect(fakeBinding([], { openError: "PDF_LOCKED" }));
    expect(locked).toMatchObject({ locked: true, unusualFeatures: ["encrypted-user-password"], needsAttention: true });
    await expect(collect(fakeBinding([], { openError: "PDF_ERROR" }))).rejects.toMatchObject({ name: "NativeProbeOpenError", code: "PDF_ERROR" });
  });

  it("turns a failing page into a flagged row instead of dropping it", async () => {
    const binding = fakeBinding([{}, {}]);
    const open = binding.openPath;
    binding.openPath = (...args) => {
      const doc = open(...args);
      const page = doc.page.bind(doc);
      doc.page = (i) => {
        const p = page(i);
        if (i === 1) p.spans = () => { throw new Error("corrupt content stream"); };
        return p;
      };
      return doc;
    };
    const rows = await collect(binding);
    expect(rows[1]).toMatchObject({ pageNumber: 2, textLayerStatus: "unknown", unusualFeatures: ["probe-error"], needsAttention: true });
  });
});

describe("probe helpers", () => {
  it("matches the Python helpers", () => {
    expect(parsePages("1,3-4,9", 5)).toEqual([1, 3, 4]);
    expect(parsePages(undefined, 2)).toEqual([1, 2]);
    expect(textLayerStatus(0, 0, 0, false, 0.5)).toBe("unknown");
    expect(textLayerStatus(10, 5, 0.5, false, 0)).toBe("suspect");
    expect(laplacianVariance(new Uint8Array(9).fill(7), 3, 3)).toBe(0);
    expect(percentiles(Uint8Array.from([0, 10, 20, 30, 40]), [0, 50, 100])).toEqual([0, 20, 40]);
  });
});

describe("probe overlap settings", () => {
  it("reads PROBE_OVERLAP_RENDER as an off switch and PROBE_OVERLAP_MAX_PAGES as the page ceiling", () => {
    expect(readProbeOverlap({})).toEqual({ overlapRender: true, overlapRenderMaxPages: PROBE_OVERLAP_MAX_PAGES });
    for (const value of ["0", "false", "OFF", " off "]) expect(readProbeOverlap({ PROBE_OVERLAP_RENDER: value }).overlapRender).toBe(false);
    expect(readProbeOverlap({ PROBE_OVERLAP_RENDER: "1" }).overlapRender).toBe(true);
    expect(readProbeOverlap({ PROBE_OVERLAP_MAX_PAGES: "250" }).overlapRenderMaxPages).toBe(250);
    for (const value of ["", "-1", "abc", "1.5"]) expect(readProbeOverlap({ PROBE_OVERLAP_MAX_PAGES: value }).overlapRenderMaxPages).toBe(PROBE_OVERLAP_MAX_PAGES);
  });
});

describe("default probe runner", () => {
  it("probes in-process and reports encrypted files it cannot open as locked", async () => {
    setProbeBindingForTesting(fakeBinding([{ spans: [{ text: PROSE.repeat(4), bbox: [50, 50, 550, 700] }] }]));
    const rows = parseProbeOutput(await createProbeRunner()({ pdfPath: "/tmp/x.pdf" }));
    expect(rows[0]).toMatchObject({ pageNumber: 1, probeEngine: expect.stringMatching(/^native-pdf@/) });

    setProbeBindingForTesting(fakeBinding([], { openError: "PDF_ERROR" }));
    const dir = await mkdtemp(path.join(os.tmpdir(), "probe-enc-"));
    const encrypted = path.join(dir, "e.pdf");
    await writeFile(encrypted, "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R/Encrypt<</Filter/Standard>>>>\n%%EOF");
    const plain = path.join(dir, "p.pdf");
    await writeFile(plain, "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
    const runner = createProbeRunner();
    expect(parseProbeOutput(await runner({ pdfPath: encrypted }))[0]).toMatchObject({ locked: true, unusualFeatures: ["encrypted-user-password"] });
    await expect(runner({ pdfPath: plain })).rejects.toThrow(/page probe failed: .*boom/);
  });
});
