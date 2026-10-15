import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExtractionArtifactRef } from "@docslurp/shared";
import { createLocalArtifactAdapters, availableLocalArtifactAdapters, localArtifactToolAvailability } from "./local-artifact-adapters.js";
import { executeArtifactGraph } from "./artifact-graph.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pdf = path.join(root, "worker/testdata/pdf-fixtures/tables-multipage-financials.pdf");

describe("local artifact adapters", () => {
  it("declares local tool availability and output limits", async () => {
    const available = await localArtifactToolAvailability();
    expect(typeof available.pdftotext).toBe("boolean");
    expect(() => createLocalArtifactAdapters({ outputDir: tmpdir(), imageScaleTo: 5000 })).toThrow();
  });

  it("preserves page ancestry across PDF text to Markdown and page render", async () => {
    const available = await localArtifactToolAvailability();
    if (!available.pdftotext || !available.pandoc || !available.pdftoppm) return;
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-local-adapters-"));
    try {
      const bytes = await readFile(pdf);
      const source: ExtractionArtifactRef = {
        id: "source", kind: "source/pdf", uri: pdf, mediaType: "application/pdf",
        sha256: createHash("sha256").update(bytes).digest("hex"), sourceDocumentId: "test-document",
        derivedFrom: [], placements: [], producer: { id: "test", optionsDigest: "test" },
      };
      const adapters = createLocalArtifactAdapters({ outputDir: scratch, imageScaleTo: 500 });
      const context = { sourceDocumentId: "test-document", pageNumber: 1 };
      const text = (await adapters.find(adapter => adapter.id === "poppler-page-text")!.run([source], context))[0];
      expect(text.derivedFrom).toEqual(["source"]);
      expect(text.placements).toEqual([{ pageNumber: 1, fidelity: "page-only" }]);
      expect((await readFile(text.uri, "utf8")).toLowerCase()).toContain("revenue");
      const markdown = (await adapters.find(adapter => adapter.id === "pandoc-text-markdown")!.run([text], context))[0];
      expect(markdown.derivedFrom).toEqual([text.id]);
      expect(markdown.placements[0].pageNumber).toBe(1);
      const image = (await adapters.find(adapter => adapter.id === "poppler-page-image")!.run([source], context))[0];
      expect(image.mediaType).toBe("image/png");
      expect(image.placements[0].bbox).toBeUndefined();
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
  it("builds document Markdown and a page-associated media map through the graph", async () => {
    const tools = await localArtifactToolAvailability();
    if (!tools.pdftotext || !tools.pandoc || !tools.pdfimages) return;
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-local-graph-"));
    try {
      const sourcePath = path.join(root, "worker/testdata/pdf-fixtures/image-heavy-ocr.pdf");
      const bytes = await readFile(sourcePath);
      const source: ExtractionArtifactRef = {
        id: "graph-source", kind: "source/pdf", uri: sourcePath, mediaType: "application/pdf",
        sha256: createHash("sha256").update(bytes).digest("hex"), sourceDocumentId: "graph-document",
        derivedFrom: [], placements: [], producer: { id: "test", optionsDigest: "test" },
      };
      const adapters = await availableLocalArtifactAdapters({ outputDir: scratch });
      expect(adapters.some(adapter => adapter.id === "assemble-page-markdown")).toBe(true);
      expect(adapters.some(adapter => adapter.id === "assemble-media-map")).toBe(true);
      const result = await executeArtifactGraph({ sourceDocumentId: "graph-document", initial: [source], target: ["document/markdown", "document/media-map"], adapters, pageNumbers: [1, 2] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const markdown = result.targets.find(ref => ref.kind === "document/markdown")!;
      const media = result.targets.find(ref => ref.kind === "document/media-map")!;
      const text = await readFile(markdown.uri, "utf8");
      expect(text).toContain("<!-- page 1;");
      expect(text).toContain("<!-- page 2;");
      expect(markdown.derivedFrom).toHaveLength(2);
      const map = JSON.parse(await readFile(media.uri, "utf8")) as { images: Array<{ pageNumber: number; artifactId: string; placement: string; uri?: string }> };
      expect(map.images.map(image => image.pageNumber)).toEqual([1, 2]);
      expect(map.images.every(image => image.placement === "page-only" && image.uri === undefined)).toBe(true);
      expect(media.derivedFrom).toHaveLength(2);
      expect(result.artifacts.filter(ref => ref.kind === "page/embedded-image").map(ref => ref.id)).toEqual(map.images.map(image => image.artifactId));
      expect(media.placements).toEqual([]);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

  it("produces an empty media map when PDF pages have no embedded images", async () => {
    const tools = await localArtifactToolAvailability();
    if (!tools.pdfimages) return;
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-empty-media-"));
    try {
      const bytes = await readFile(pdf);
      const source: ExtractionArtifactRef = {
        id: "empty-source", kind: "source/pdf", uri: pdf, mediaType: "application/pdf",
        sha256: createHash("sha256").update(bytes).digest("hex"), sourceDocumentId: "empty-media-document",
        derivedFrom: [], placements: [], producer: { id: "test", optionsDigest: "test" },
      };
      const adapters = await availableLocalArtifactAdapters({ outputDir: scratch });
      const result = await executeArtifactGraph({ sourceDocumentId: source.sourceDocumentId, initial: [source], target: ["document/media-map"], adapters, pageNumbers: [1, 2, 3] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const media = result.targets.find(ref => ref.kind === "document/media-map")!;
      const map = JSON.parse(await readFile(media.uri, "utf8")) as { images: unknown[] };
      expect(map.images).toEqual([]);
      expect(media.derivedFrom).toHaveLength(3);
      expect(result.artifacts.filter(ref => ref.kind === "page/embedded-image-set")).toHaveLength(3);
      expect(result.artifacts.filter(ref => ref.kind === "page/embedded-image")).toHaveLength(0);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

});
