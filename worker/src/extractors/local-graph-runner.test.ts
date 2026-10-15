import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runLocalPdfArtifactGraph } from "./local-graph-runner.js";

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../testdata/pdf-fixtures/image-heavy-ocr.pdf");

describe("runLocalPdfArtifactGraph", () => {
  it("produces Markdown and a media map from a real two-page PDF", async () => {
    const scratchDir = await mkdtemp(path.join(tmpdir(), "docslurp-local-graph-"));
    try {
      const sha256 = createHash("sha256").update(await readFile(fixture)).digest("hex");
      const result = await runLocalPdfArtifactGraph({ sourcePath: fixture, sourceDocumentId: "two-pages", sha256, pageCount: 2,
        targetKinds: ["document/markdown", "document/media-map"], scratchDir });
      expect(result.targets.map((a) => a.kind).sort()).toEqual(["document/markdown", "document/media-map"]);
      expect(result.artifacts.filter((a) => a.kind === "page/embedded-image").map((a) => a.placements[0].pageNumber)).toEqual([1, 2]);
      expect((await readFile(result.targets.find((a) => a.kind === "document/markdown")!.uri, "utf8"))).toContain("page 2");
      const media = JSON.parse(await readFile(result.targets.find((a) => a.kind === "document/media-map")!.uri, "utf8"));
      expect(media.images.map((image: { pageNumber: number }) => image.pageNumber)).toEqual([1, 2]);
    } finally { await rm(scratchDir, { recursive: true, force: true }); }
  }, 30_000);

  it("rejects incorrect source hash and excessive pages before execution", async () => {
    await expect(runLocalPdfArtifactGraph({ sourcePath: fixture, sourceDocumentId: "doc", sha256: "0".repeat(64), pageCount: 2,
      targetKinds: ["document/markdown"], scratchDir: tmpdir() })).rejects.toThrow("sha256 mismatch");
    await expect(runLocalPdfArtifactGraph({ sourcePath: fixture, sourceDocumentId: "doc", sha256: "0".repeat(64), pageCount: 65,
      targetKinds: ["document/markdown"], scratchDir: tmpdir() })).rejects.toThrow("pageCount");
  });
});
