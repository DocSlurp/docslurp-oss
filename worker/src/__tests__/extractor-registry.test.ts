import { describe, expect, it } from "vitest";
import { documentExtractorRegistry, serializeExtractorOptions } from "../extractors/registry.js";
import type { CommandRunner } from "../tools/runner.js";

describe("document extractor registry", () => {
  it("resolves configured IDs in order and rejects unknown or incompatible IDs", () => {
    expect(documentExtractorRegistry.resolve("pdf", ["pymupdf", "kreuzberg"])).toEqual(["pymupdf", "kreuzberg"]);
    expect(() => documentExtractorRegistry.resolve("pdf", ["unknown"])).toThrow(/unknown extractor/);
    expect(() => documentExtractorRegistry.resolve("office-word", ["pymupdf"])).toThrow(/does not support/);
    expect(documentExtractorRegistry.resolve("office-excel")).toEqual(["kreuzberg"]);
    expect(documentExtractorRegistry.resolve("latex")).toEqual(["pandoc"]);
    expect(documentExtractorRegistry.resolve("structured-json")).toEqual(["json"]);
    expect(() => documentExtractorRegistry.resolve("structured-json", ["kreuzberg"])).toThrow(/does not support/);
    expect(() => documentExtractorRegistry.resolve("unknown")).toThrow(/no extractor configured/);
  });

  it("exposes direct methods as distinct graph edges", () => {
    const edges = documentExtractorRegistry.graphAdapters();
    expect(edges.find((edge) => edge.extractorId === "pymupdf" && edge.accepts.includes("source/pdf"))?.emits).toEqual(["document/text"]);
    expect(edges.filter((edge) => edge.extractorId === "kreuzberg").length).toBeGreaterThan(1);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
  });

  it("serializes only the selected extractor's options", () => {
    const options = { kreuzberg: { outputFormat: "markdown" }, dolphin: { mode: "page" } };
    expect(serializeExtractorOptions(options, "kreuzberg")).toBe('{"outputFormat":"markdown"}');
    expect(serializeExtractorOptions(options, "pymupdf")).toBeUndefined();
  });

  it("registers Poppler text and the local graph as selectable PDF methods", async () => {
    expect(documentExtractorRegistry.resolve("pdf", ["kreuzberg", "poppler-text", "graph-local"]))
      .toEqual(["kreuzberg", "poppler-text", "graph-local"]);
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
    const plan = { binary: "pymupdf", args: [], available: true };
    const runner = { pyMuPdfText: async () => plan } as unknown as CommandRunner;
    const prepared = await documentExtractorRegistry.prepare("pymupdf", runner, "/tmp/sample.pdf");
    expect(prepared.label).toBe("pymupdf");
    expect(prepared.outputPath).toBe("/tmp/sample.pdf.pymupdf.txt");
    expect(prepared.plan).toBe(plan);
    await expect(documentExtractorRegistry.prepare("missing", runner, "/tmp/sample.pdf")).rejects.toThrow(/unknown extractor/);
  });
});
