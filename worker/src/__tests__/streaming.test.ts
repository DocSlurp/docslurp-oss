import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import type { CommandPlan, CommandRunner } from "../tools/runner.js";
import { documentExtractorRegistry } from "../extractors/registry.js";
import { ExtractHtmlStage } from "../stages/extract-html.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import type { Document, WorkspaceRun } from "../models.js";

function createRun(): WorkspaceRun {
  return {
    id: "run-1",
    orgId: "org-1",
    userId: "demo-user",
    kind: "bulk-upload",
    status: "queued",
    stage: "queued",
    totalDocuments: 1,
    processedDocuments: 0,
    pagesTotal: 1,
    pagesProcessed: 0,
    spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, htmlExtraction: true },
    error: null,
    stats: {},
    artifacts: {},
    claimId: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

function createDocument(sourceKey: string): Document {
  return {
    id: "doc-1",
    userId: "demo-user",
    runId: "run-1",
    filename: "sample.pdf",
    mimeType: "application/pdf",
    sourceKey,
    status: "queued",
    extractionMode: "hybrid",
    pageCount: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

function createUploadCapture() {
  let data = "";
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const writable = new Writable({
    write(chunk, _encoding, callback) {
      data += chunk.toString();
      callback();
    },
    final(callback) {
      resolveDone();
      callback();
    }
  });

  return {
    writable,
    done,
    read: () => data
  };
}

describe("streaming extraction", () => {
  it("fans markdown extraction into the temp artifact and upload stream", async () => {
    const uploaded = createUploadCapture();
    const stage = new ExtractMarkdownStage(
      {
        runToWritable: async (_plan: CommandPlan, destination: Writable) => {
          destination.write("streamed markdown");
          destination.end();
          return { stderr: "" };
        }
      } as any,
      {
        createMultipartUploadStream: () => uploaded,
        uri: (key: string) => `s3://docslurp/${key}`
      } as any,
      {} as any
    );

    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-stream-test-"));
    const sourceTemp = path.join(scratch, "source.pdf");
    await writeFile(sourceTemp, "pdf");

    const prepared = await documentExtractorRegistry.prepare("pandoc", {
      extractMarkdown: async () => ({ binary: "pandoc", args: [], available: true }),
    } as unknown as CommandRunner, sourceTemp);
    const candidate = await (stage as any).extractCandidate(
      prepared,
      "demo-user/run-1/markdown/doc-1.md",
      sourceTemp
    );
    const tempText = await readFile(candidate.tempTextPath, "utf8");

    expect(candidate.textUri).toBe("s3://docslurp/demo-user/run-1/markdown/doc-1.md");
    expect(tempText).toBe("streamed markdown");
    expect(uploaded.read()).toBe("streamed markdown");
    await (stage as any).cleanupCandidate(candidate);
    await uploaded.done;
  });

  it("streams html extraction output directly into the storage writer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "docslurp-html-stage-"));
    const sourceFile = path.join(directory, "source.pdf");
    await writeFile(sourceFile, "pdf");

    const uploaded = createUploadCapture();
    const manifests = new Map<string, unknown>();

    const storage = {
      downloadToTempFile: async () => sourceFile,
      createMultipartUploadStream: () => uploaded,
      putJson: async (key: string, value: unknown) => {
        manifests.set(key, value);
      },
      uri: (key: string) => `s3://docslurp/${key}`
    };

    const runner = {
      extractHtml: async () => ({ binary: "pdftohtml", args: [], available: true }),
      runToWritable: async (_plan: CommandPlan, destination: Writable) => {
        destination.write("<html>streamed</html>");
        destination.end();
        return { stderr: "" };
      }
    };

    const state = WorkflowState.create(createRun(), [createDocument("bucket/source.pdf")]);
    state.artifactLedger.recordDocument(
      "doc-1",
      "extraction-contract",
      "s3://docslurp/demo-user/run-1/extraction/doc-1.contract.json",
    );
    const stage = new ExtractHtmlStage(runner as any, storage as any);
    await stage.run(state);

    expect(uploaded.read()).toBe("<html>streamed</html>");
    expect(state.artifacts["doc-1:html"]).toBe("s3://docslurp/demo-user/run-1/html/doc-1.html");
    expect(state.artifacts["doc-1:extraction-contract"]).toBe(
      "s3://docslurp/demo-user/run-1/extraction/doc-1.contract.json",
    );
    expect([...manifests.keys()]).toEqual(["demo-user/run-1/html/doc-1.json"]);
    expect(manifests.get("demo-user/run-1/html/doc-1.json")).toBeDefined();
  });
});
