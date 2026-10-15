import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ExtractMarkdownStage, assertSupportedDocumentTarget } from "../stages/extract-markdown.js";
import type { LocalPdfGraphInput } from "../extractors/local-graph-runner.js";
import { documentExtractorRegistry } from "../extractors/registry.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("extract markdown artifact enrichment", () => {
  it("persists page sidecars and a graph manifest with parentage and placements", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-graph-stage-test-"));
    try {
      const sourcePath = path.join(dir, "source.pdf");
      const source = Buffer.from("pdf bytes");
      await writeFile(sourcePath, source);
      const sidecarPath = path.join(dir, "page.png");
      const image = Buffer.from("image bytes");
      await writeFile(sidecarPath, image);
      const stored = new Map<string, Buffer>();
      let manifest: any;
      const storage = {
        streamToStorage: async (key: string, stream: AsyncIterable<Buffer>) => {
          const parts: Buffer[] = [];
          for await (const part of stream) parts.push(part);
          stored.set(key, Buffer.concat(parts));
        },
        putJson: async (_key: string, value: unknown) => { manifest = value; },
        uri: (key: string) => `s3://test/${key}`,
      };
      const stage = new ExtractMarkdownStage({} as any, storage as any, {} as any);
      const result = await (stage as any).enrichDocumentArtifacts({
        document: { id: "doc-1", userId: "user-1", sourceKey: "source/file.pdf", mimeType: "application/pdf" },
        sourcePath, sourceHash: digest(source), format: "pdf", targets: ["page/image"],
        pageNumbers: [1], runId: "run-1",
        graphRunner: async (input: LocalPdfGraphInput) => {
          expect(input.targetKinds).toEqual(["page/image"]);
          expect(input.pageCount).toBe(1);
          const sourceRef = {
            id: "source-ref", kind: "source/pdf", uri: sourcePath,
            mediaType: "application/pdf", sha256: digest(source), sourceDocumentId: "doc-1",
            derivedFrom: [], placements: [], producer: { id: "source", optionsDigest: "test" },
          };
          const pageRef = {
            id: "page-1", kind: "page/image", uri: sidecarPath,
            mediaType: "image/png", sha256: digest(image), sourceDocumentId: "doc-1",
            derivedFrom: [sourceRef.id],
            placements: [{ pageNumber: 1, fidelity: "page-only" as const }],
            producer: { id: "test-page-image", optionsDigest: "test" },
          };
          return { artifacts: [sourceRef, pageRef], targets: [pageRef], steps: ["test-page-image@1"] };
        },
      });
      expect(result.targetIds).toEqual(["page-1"]);
      expect(result.steps).toEqual(["test-page-image@1"]);
      expect(result.outputCount).toBe(1);
      expect(stored.size).toBe(1);
      expect([...stored.values()][0]).toEqual(image);
      expect(manifest.artifacts[0].uri).toBe("s3://test/source/file.pdf");
      expect(manifest.artifacts[1].uri).toMatch(/^s3:\/\/test\/user-1\/run-1\/artifact-graph\/doc-1\//);
      expect(manifest.artifacts[1].derivedFrom).toEqual([manifest.artifacts[0].id]);
      expect(manifest.artifacts[1].placements).toEqual([{ pageNumber: 1, fidelity: "page-only" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs graph-local as a selectable production Markdown candidate", async () => {
    const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../testdata/pdf-fixtures/image-heavy-ocr.pdf");
    const sha256 = digest(await readFile(fixture));
    const chunks: Buffer[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const storage = {
      createMultipartUploadStream: () => ({
        writable: new Writable({
          write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
          final(callback) { resolveDone(); callback(); },
        }),
        done,
      }),
      uri: (key: string) => `s3://test/${key}`,
    };
    const stage = new ExtractMarkdownStage({} as any, storage as any, {} as any);
    const prepared = await documentExtractorRegistry.prepare("graph-local", {} as any, fixture);
    expect(prepared.plan.available).toBe(true);
    const candidate = await (stage as any).extractCandidate(
      prepared, "user/run/doc.graph-local.md", fixture, undefined,
      { sourceHash: sha256, pageCount: 2, documentId: "doc" },
    );
    expect(candidate.label).toBe("graph-local");
    expect(candidate.textUri).toBe("s3://test/user/run/doc.graph-local.md");
    expect(Buffer.concat(chunks).toString("utf8")).toContain("page 2");
    await (stage as any).cleanupCandidate(candidate);
  }, 30_000);

  it("fails clearly when a requested target has no route or the document target is unsupported", async () => {
    const stage = new ExtractMarkdownStage({} as any, {} as any, {} as any);
    await expect((stage as any).enrichDocumentArtifacts({
      document: { id: "doc-1", userId: "user-1", sourceKey: "source/file.pdf", mimeType: "application/pdf" },
      sourcePath: "/tmp/source.pdf", sourceHash: "a".repeat(64), format: "pdf",
      targets: ["page/image"], pageNumbers: [1], runId: "run-1",
      graphRunner: async () => { throw new Error("Local PDF artifact graph unreachable; missing: page/image"); },
    })).rejects.toThrow(/unreachable; missing: page\/image/);
    expect(() => assertSupportedDocumentTarget("document/html")).toThrow(/unsupported document extraction target/);
    expect(() => assertSupportedDocumentTarget("document/markdown")).not.toThrow();
  });
});
