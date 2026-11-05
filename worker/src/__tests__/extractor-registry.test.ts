import { describe, expect, it } from "vitest";
import { documentExtractorRegistry, serializeExtractorOptions } from "../extractors/registry.js";
import type { CommandRunner } from "../tools/runner.js";

describe("document extractor registry", () => {
  it("resolves configured IDs in order and rejects unknown or incompatible IDs", () => {
    expect(documentExtractorRegistry.resolve("pdf", ["native-pdf", "poppler-text"])).toEqual(["native-pdf", "poppler-text"]);
    expect(documentExtractorRegistry.list().some((entry) => entry.id === "docling")).toBe(false);
    expect(() => documentExtractorRegistry.resolve("pdf", ["docling"])).toThrow(/unknown extractor/);
    expect(() => documentExtractorRegistry.resolve("pdf", ["unknown"])).toThrow(/unknown extractor/);
    expect(() => documentExtractorRegistry.resolve("office-word", ["native-pdf"])).toThrow(/does not support/);
    expect(documentExtractorRegistry.resolve("office-excel")).toEqual(["xlsx"]);
    expect(documentExtractorRegistry.resolve("latex")).toEqual(["pandoc"]);
    expect(documentExtractorRegistry.resolve("structured-json")).toEqual(["json"]);
    expect(() => documentExtractorRegistry.resolve("structured-json", ["pandoc"])).toThrow(/does not support/);
    expect(() => documentExtractorRegistry.resolve("unknown")).toThrow(/no extractor configured/);
  });

  it("exposes direct methods as distinct graph edges", () => {
    const edges = documentExtractorRegistry.graphAdapters();
    expect(edges.find((edge) => edge.extractorId === "poppler-text" && edge.accepts.includes("source/pdf"))?.emits).toEqual(["document/text"]);
    expect(edges.filter((edge) => edge.extractorId === "pandoc").length).toBeGreaterThan(1);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
  });

  it("serializes only the selected extractor's options", () => {
    const options = { "vm-pdf": { images: { enabled: true } }, dolphin: { mode: "page" } };
    expect(serializeExtractorOptions(options, "dolphin")).toBe('{"mode":"page"}');
    expect(serializeExtractorOptions(options, "native-pdf")).toBeUndefined();
  });

  it("re-parses every extractor's options against its strict schema before handing any to a script (M4)", () => {
    expect(serializeExtractorOptions({ dolphin: { mode: "layout", maxBatchSize: 4 } }, "dolphin")).toBe('{"mode":"layout","maxBatchSize":4}');
    // A hand-built or stored config with Dolphin paths never reaches dolphin_extract.py, whichever extractor runs.
    const injected = { "vm-pdf": { images: { enabled: true } }, dolphin: { mode: "page", repoPath: "/tmp/attacker", modelPath: "/tmp/m" } };
    expect(() => serializeExtractorOptions(injected, "dolphin")).toThrow();
    expect(() => serializeExtractorOptions(injected, "vm-pdf")).toThrow();
    expect(() => serializeExtractorOptions({ dolphin: { dolphin: { repoPath: "/tmp/attacker" } } }, "dolphin")).toThrow();
    // Unknown ids and keys fail closed.
    expect(() => serializeExtractorOptions({ pandoc: { filter: "/tmp/evil.lua" } }, "pandoc")).toThrow(/takes no options/);
    // Retired ids take no options either, so an unparsed config naming one never reaches a script.
    expect(() => serializeExtractorOptions({ liteparse: { ocr: true } }, "pandoc")).toThrow(/takes no options/);
    expect(() => serializeExtractorOptions({ kreuzberg: { forceOcr: true } }, "pptx")).toThrow(/takes no options/);
  });

  it("registers Poppler text and the local graph as selectable PDF methods", async () => {
    expect(documentExtractorRegistry.resolve("pdf", ["native-pdf", "poppler-text", "graph-local"]))
      .toEqual(["native-pdf", "poppler-text", "graph-local"]);
    const popplerPlan = { binary: "pdftotext", args: [], available: true };
    const poppler = await documentExtractorRegistry.prepare("poppler-text", {
      extractText: async (source: string, preservePageBreaks: boolean) => {
        expect(source).toBe("/tmp/sample.pdf");
        expect(preservePageBreaks).toBe(true);
        return popplerPlan;
      },
    } as unknown as CommandRunner, "/tmp/sample.pdf");
    expect(poppler.plan).toBe(popplerPlan);
    let streamed = false;
    await poppler.execute({ stream: async () => { streamed = true; return {} as any; } } as any, "key", "/tmp/sample.pdf");
    expect(streamed).toBe(true);
    const graph = await documentExtractorRegistry.prepare("graph-local", {} as CommandRunner, "/tmp/sample.pdf");
    let graphed = false;
    await graph.execute({ graph: async () => { graphed = true; return {} as any; } } as any, "key", "/tmp/sample.pdf");
    expect(graphed).toBe(true);
  });

  it("prepares the requested ID without silently falling back to pandoc", async () => {
    const plan = { binary: "python3", args: [], available: true };
    const runner = { officeMarkdown: async () => plan } as unknown as CommandRunner;
    const prepared = await documentExtractorRegistry.prepare("pptx", runner, "/tmp/sample.pptx");
    expect(prepared.label).toBe("pptx");
    expect(prepared.outputPath).toBe("/tmp/sample.pptx.pptx.md");
    expect(prepared.plan).toBe(plan);
    await expect(documentExtractorRegistry.prepare("missing", runner, "/tmp/sample.pdf")).rejects.toThrow(/unknown extractor/);
  });
});
