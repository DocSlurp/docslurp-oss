import { describe, expect, it } from "vitest";
import type { ExtractionArtifactRef } from "@docslurp/shared";
import { executeArtifactGraph, type ArtifactGraphAdapter } from "./artifact-graph.js";

function ref(id: string, kind: string, parents: string[] = [], pageNumber?: number, producer = "source"): ExtractionArtifactRef {
  return { id, kind, uri: `mem://${id}`, mediaType: "text/plain", sha256: "abc", sourceDocumentId: "doc", derivedFrom: parents,
    placements: pageNumber ? [{ pageNumber, fidelity: "page-only" }] : [], producer: { id: producer, optionsDigest: "none" } };
}

describe("executeArtifactGraph", () => {
  it("fans out page work and joins only matching page inputs", async () => {
    const seen: string[][] = [];
    const adapter: ArtifactGraphAdapter = { id: "layout", accepts: ["page/text", "page/image"], emits: ["page/markdown"], scope: "page",
      async run(inputs, ctx) { seen.push(inputs.map((a) => a.id)); return [ref(`md-${ctx.pageNumber}`, "page/markdown", inputs.map((a) => a.id), ctx.pageNumber, "layout")]; } };
    const result = await executeArtifactGraph({ sourceDocumentId: "doc", initial: [ref("text-1", "page/text", [], 1), ref("img-1", "page/image", [], 1), ref("text-2", "page/text", [], 2), ref("img-2", "page/image", [], 2)], target: ["page/markdown"], adapters: [adapter] });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([["text-1", "img-1"], ["text-2", "img-2"]]);
    expect(result.steps).toEqual(["layout@1", "layout@2"]);
  });

  it("rejects missing page inputs instead of mixing unrelated pages", async () => {
    const adapter: ArtifactGraphAdapter = { id: "layout", accepts: ["page/text", "page/image"], emits: ["page/markdown"], scope: "page", run: async () => { throw new Error("must not run"); } };
    const result = await executeArtifactGraph({ sourceDocumentId: "doc", initial: [ref("t", "page/text", [], 1), ref("i", "page/image", [], 2)], target: ["page/markdown"], adapters: [adapter] });
    expect(result).toMatchObject({ ok: false, reason: "unsatisfied" });
  });

  it("rejects ambiguous same-kind inputs", async () => {
    const adapter: ArtifactGraphAdapter = { id: "format", accepts: ["text"], emits: ["markdown"], scope: "document", run: async () => [] };
    const result = await executeArtifactGraph({ sourceDocumentId: "doc", initial: [ref("a", "text"), ref("b", "text")], target: ["markdown"], adapters: [adapter] });
    expect(result).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("validates producer, parents, document, and output bounds", async () => {
    const base = { sourceDocumentId: "doc", initial: [ref("pdf", "source/pdf")], target: ["document/text"] };
    const adapter = (run: ArtifactGraphAdapter["run"]): ArtifactGraphAdapter => ({ id: "parse", accepts: ["source/pdf"], emits: ["document/text"], scope: "document", run });
    await expect(executeArtifactGraph({ ...base, adapters: [adapter(async () => [ref("text", "document/text", [], undefined, "parse")])] })).rejects.toThrow("invalid parents");
    await expect(executeArtifactGraph({ ...base, adapters: [adapter(async () => [{ ...ref("text", "document/text", ["pdf"], undefined, "parse"), sourceDocumentId: "other" }])] })).rejects.toThrow("another document");
    const limited = await executeArtifactGraph({ ...base, adapters: [adapter(async () => [ref("text", "document/text", ["pdf"], undefined, "parse")])], maxOutputs: 1 });
    expect(limited).toMatchObject({ ok: false, reason: "limit" });
  });

  it("passes abort signal without executing a step", async () => {
    const controller = new AbortController(); controller.abort();
    const adapter: ArtifactGraphAdapter = { id: "parse", accepts: ["source/pdf"], emits: ["document/text"], scope: "document", run: async () => { throw new Error("must not run"); } };
    await expect(executeArtifactGraph({ sourceDocumentId: "doc", initial: [ref("pdf", "source/pdf")], target: ["document/text"], adapters: [adapter], signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
  });
});

describe("page production and aggregation", () => {
  it("runs PDF to page images to per-page OCR to ordered document Markdown", async () => {
    const seen: string[][] = [];
    const adapters: ArtifactGraphAdapter[] = [
      { id: "raster", accepts: ["source/pdf"], emits: ["page/image"], scope: "document", outputScope: "page",
        async run(inputs) { return [ref("img-1", "page/image", [inputs[0].id], 1, "raster"), ref("img-2", "page/image", [inputs[0].id], 2, "raster")]; } },
      { id: "ocr", accepts: ["page/image"], emits: ["page/text"], scope: "page",
        async run(inputs, ctx) { return [ref(`txt-${ctx.pageNumber}`, "page/text", inputs.map((a) => a.id), ctx.pageNumber, "ocr")]; } },
      { id: "join", accepts: ["page/text"], emits: ["document/markdown"], scope: "aggregate",
        async run(inputs, ctx) { seen.push(inputs.map((a) => a.id)); expect(ctx.pageNumbers).toEqual([1, 2]); return [ref("md", "document/markdown", inputs.map((a) => a.id), undefined, "join")]; } },
    ];
    const result = await executeArtifactGraph({ sourceDocumentId: "doc", initial: [ref("pdf", "source/pdf")], target: ["document/markdown"], adapters });
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual(["raster", "ocr@1", "ocr@2", "join"]);
    expect(seen).toEqual([["txt-1", "txt-2"]]);
  });

  it("preserves multi-placement embedded image association across pages", async () => {
    const image = { ...ref("embedded", "page/image"), placements: [
      { pageNumber: 1, fidelity: "exact" as const }, { pageNumber: 2, fidelity: "exact" as const },
    ] };
    const seen: number[] = [];
    const adapter: ArtifactGraphAdapter = { id: "ocr", accepts: ["page/image"], emits: ["page/text"], scope: "page",
      async run(inputs, ctx) { expect(inputs.map((a) => a.id)).toEqual(["embedded"]); seen.push(ctx.pageNumber!); return [ref(`text-${ctx.pageNumber}`, "page/text", ["embedded"], ctx.pageNumber, "ocr")]; } };
    const result = await executeArtifactGraph({ sourceDocumentId: "doc", initial: [image], target: ["page/text"], adapters: [adapter] });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([1, 2]);
    expect(result.artifacts[0].placements.map((p) => p.pageNumber)).toEqual([1, 2]);
  });
});
