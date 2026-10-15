import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { CommandPlan } from "../tools/runner.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { ExtractorAttemptLedger } from "../extractors/attempt-ledger.js";
import { documentExtractorRegistry } from "../extractors/registry.js";

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

describe("extract markdown PDF routing", () => {
  it("prefers Kreuzberg for fast PDF extraction", async () => {
    const stage = new ExtractMarkdownStage(
      {
        extractMarkdown: async () => ({ binary: "pandoc", args: [], available: true }),
        doclingMarkdown: async () => ({ binary: "docling", args: [], available: true }),
        pyMuPdf4llmMarkdown: async () => ({ binary: "python3", args: [], available: true }),
        pyMuPdfText: async () => ({ binary: "python3", args: [], available: true }),
        kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: true })
      } as any,
      {} as any,
      {} as any
    );

    const planned = await (stage as any).planExtractors({
      tempFile: "/tmp/sample.pdf",
      format: "pdf",
      order: {},
      options: {},
      multiStrategyVoting: false,
      secondaryId: "next-in-order",
      attemptLedger: new ExtractorAttemptLedger()
    });

    expect(planned.primary.label).toBe("kreuzberg");
    expect(planned.secondary).toBeNull();
    expect(planned.tableAware).toBe(true);
  });

  it("falls back to PyMuPDF when Kreuzberg is unavailable", async () => {
    const stage = new ExtractMarkdownStage(
      {
        extractMarkdown: async () => ({ binary: "pandoc", args: [], available: true }),
        doclingMarkdown: async () => ({ binary: "docling", args: [], available: true }),
        pyMuPdf4llmMarkdown: async () => ({ binary: "python3", args: [], available: true }),
        pyMuPdfText: async () => ({ binary: "python3", args: [], available: true }),
        kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: false })
      } as any,
      {} as any,
      {} as any
    );

    const planned = await (stage as any).planExtractors({
      tempFile: "/tmp/sample.pdf",
      format: "pdf",
      order: {},
      options: {},
      multiStrategyVoting: false,
      secondaryId: "next-in-order",
      attemptLedger: new ExtractorAttemptLedger()
    });

    expect(planned.primary.label).toBe("pymupdf");
    expect(planned.secondary).toBeNull();
    expect(planned.tableAware).toBe(false);
  });

  it("uses Kreuzberg before Pandoc for non-PDF extraction", async () => {
    const stage = new ExtractMarkdownStage(
      {
        extractMarkdown: async () => ({ binary: "pandoc", args: [], available: true }),
        kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: true })
      } as any,
      {} as any,
      {} as any
    );

    const planned = await (stage as any).planExtractors({
      tempFile: "/tmp/brief.docx",
      format: "office-word",
      order: {},
      options: {},
      multiStrategyVoting: false,
      secondaryId: "next-in-order",
      attemptLedger: new ExtractorAttemptLedger()
    });

    expect(planned.primary.label).toBe("kreuzberg");
    expect(planned.secondary).toBeNull();
    expect(planned.tableAware).toBe(true);
  });

  it("honors docling retry overrides for PDFs", async () => {
    const stage = new ExtractMarkdownStage(
      {
        extractMarkdown: async () => ({ binary: "pandoc", args: [], available: true }),
        doclingMarkdown: async () => ({ binary: "docling", args: [], available: true }),
        pyMuPdf4llmMarkdown: async () => ({ binary: "python3", args: [], available: true }),
        pyMuPdfText: async () => ({ binary: "python3", args: [], available: true }),
        kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: false })
      } as any,
      {} as any,
      {} as any
    );

    const attemptLedger = new ExtractorAttemptLedger();
    attemptLedger.reserve("kreuzberg");
    const planned = await (stage as any).planExtractors({
      tempFile: "/tmp/sample.pdf",
      format: "pdf",
      order: { pdf: ["kreuzberg", "docling", "pymupdf"] },
      options: {},
      multiStrategyVoting: false,
      secondaryId: "next-in-order",
      attemptLedger,
    });

    expect(planned.primary.label).toBe("docling");
    expect(planned.tableAware).toBe(true);
  });

  it("does not plan an unavailable tool or reattempt a voting candidate on retry", async () => {
    const stage = new ExtractMarkdownStage(
      {
        kreuzbergMarkdown: async () => ({ binary: "kreuzberg", args: [], available: false }),
        pyMuPdfText: async () => ({ binary: "pymupdf", args: [], available: true }),
        doclingMarkdown: async () => ({ binary: "docling", args: [], available: true }),
        pyMuPdf4llmMarkdown: async () => ({ binary: "pymupdf4llm", args: [], available: true }),
      } as any,
      {} as any,
      {} as any,
    );
    const attemptLedger = new ExtractorAttemptLedger();
    const args = {
      tempFile: "/tmp/sample.pdf", format: "pdf", order: {}, options: {},
      multiStrategyVoting: true, secondaryId: "next-in-order", attemptLedger,
    };
    const first = await (stage as any).planExtractors(args);
    expect([first.primary.label, first.secondary.label]).toEqual(["pymupdf", "docling"]);
    expect(attemptLedger.snapshot()).toEqual({ attempted: [], unavailable: ["kreuzberg"] });
    attemptLedger.reserve(first.primary.label);
    attemptLedger.reserve(first.secondary.label);
    const retry = await (stage as any).planExtractors(args);
    expect(retry.primary.label).toBe("pymupdf4llm");
    expect(retry.secondary).toBeNull();
    attemptLedger.reserve(retry.primary.label);
    expect(await (stage as any).planExtractors(args)).toBeNull();
  });

  it("does not reattempt an explicit voting secondary on retry", async () => {
    const stage = new ExtractMarkdownStage(
      {
        kreuzbergMarkdown: async () => ({ binary: "kreuzberg", args: [], available: true }),
        pyMuPdfText: async () => ({ binary: "pymupdf", args: [], available: true }),
        doclingMarkdown: async () => ({ binary: "docling", args: [], available: true }),
      } as any,
      {} as any,
      {} as any,
    );
    const attemptLedger = new ExtractorAttemptLedger();
    const args = {
      tempFile: "/tmp/sample.pdf", format: "pdf",
      order: { pdf: ["kreuzberg", "pymupdf"] }, options: {},
      multiStrategyVoting: true, secondaryId: "docling", attemptLedger,
    };
    const first = await (stage as any).planExtractors(args);
    expect([first.primary.label, first.secondary.label]).toEqual(["kreuzberg", "docling"]);
    attemptLedger.reserve(first.primary.label);
    attemptLedger.reserve(first.secondary.label);
    const retry = await (stage as any).planExtractors(args);
    expect(retry.primary.label).toBe("pymupdf");
    expect(retry.secondary).toBeNull();
  });

  it("uploads file-backed extractor output for PyMuPDF candidates", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-pymupdf-test-"));
    const sourceTemp = path.join(scratch, "source.pdf");
    const outputPath = `${sourceTemp}.pymupdf.txt`;
    await writeFile(sourceTemp, "pdf");

    const uploaded = createUploadCapture();
    const stage = new ExtractMarkdownStage(
      {
        run: async (_plan: CommandPlan) => {
          await writeFile(outputPath, "pymupdf text");
          return { stdout: "", stderr: "" };
        }
      } as any,
      {
        createMultipartUploadStream: () => uploaded,
        uri: (key: string) => `s3://docslurp/${key}`
      } as any,
      {} as any
    );

    const candidate = await (stage as any).extractCandidate(
      await documentExtractorRegistry.prepare("pymupdf", {
        pyMuPdfText: async () => ({ binary: "python3", args: [], available: true }),
      } as any, sourceTemp),
      "demo-user/run-1/markdown/doc-1.pymupdf.md",
      sourceTemp
    );

    expect(candidate.textUri).toBe("s3://docslurp/demo-user/run-1/markdown/doc-1.pymupdf.md");
    expect(candidate.tempTextPath).toBe(outputPath);
    expect(uploaded.read()).toBe("pymupdf text");
    await uploaded.done;
  });

  it("plans the in-process JSON extractor for structured-json instead of failing", async () => {
    const stage = new ExtractMarkdownStage({} as any, {} as any, {} as any);
    const attemptLedger = new ExtractorAttemptLedger();
    const planned = await (stage as any).planExtractors({
      tempFile: "/tmp/records.json",
      format: "structured-json",
      order: {},
      options: {},
      multiStrategyVoting: true,
      secondaryId: "next-in-order",
      attemptLedger,
    });

    expect(planned).not.toBeNull();
    expect(planned.primary.label).toBe("json");
    expect(planned.primary.plan).toEqual({ binary: "in-process:json", args: [], available: true });
    expect(planned.secondary).toBeNull();
  });

  it("converts JSON in process and uploads the Markdown candidate", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-json-test-"));
    const sourceTemp = path.join(scratch, "source.json");
    await writeFile(sourceTemp, '{"id":1,"name":"first"}\n{oops\n{"id":2,"name":"second"}\n');

    const uploaded = createUploadCapture();
    const stage = new ExtractMarkdownStage(
      {} as any,
      {
        createMultipartUploadStream: () => uploaded,
        uri: (key: string) => `s3://docslurp/${key}`
      } as any,
      {} as any
    );

    const candidate = await (stage as any).extractCandidate(
      await documentExtractorRegistry.prepare("json", {} as any, sourceTemp),
      "demo-user/run-1/markdown/doc-1.json.md",
      sourceTemp
    );
    await uploaded.done;

    expect(candidate.label).toBe("json");
    expect(candidate.tempTextPath).toBe(`${sourceTemp}.json.md`);
    expect(candidate.textUri).toBe("s3://docslurp/demo-user/run-1/markdown/doc-1.json.md");
    expect(uploaded.read()).toContain("## Record 2 (line 3)");
    expect(uploaded.read()).toContain("- `name`: second");
    expect(uploaded.read()).toContain("- line 2: ");
  });

  it("skips optional parser artifacts when an auxiliary parser times out", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-parser-timeout-"));
    const sourceTemp = path.join(scratch, "source.pdf");
    const pymupdfOutput = `${sourceTemp}.pymupdf.json`;
    await writeFile(sourceTemp, "pdf");

    const stage = new ExtractMarkdownStage(
      {
        pyMuPdfJson: async () => ({ binary: "python3", args: ["pymupdf"], available: true }),
        unstructuredPartition: async () => ({ binary: "python3", args: ["unstructured"], available: true }),
        run: async (plan: CommandPlan, signal?: AbortSignal) => {
          if (plan.args[0] === "pymupdf") {
            await writeFile(pymupdfOutput, JSON.stringify({ blocks: [] }));
            return { stdout: "", stderr: "" };
          }

          await new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
              { once: true }
            );
          });

          return { stdout: "", stderr: "" };
        }
      } as any,
      {
        putJson: async () => undefined,
        uri: (key: string) => `s3://docslurp/${key}`
      } as any,
      {
        parserArtifactTimeoutMs: 10
      } as any
    );

    const artifacts = await (stage as any).buildParserArtifacts(
      {
        id: "doc-1",
        runId: "run-1",
        userId: "user-1",
        filename: "sample.pdf",
        mimeType: "application/pdf"
      },
      sourceTemp,
      // Minimal state stub — pdfRegionExtraction not set so region extraction is skipped
      { run: { pipeline: { preserveTables: true } }, artifacts: {}, pendingPerformance: [] },
      { hasTablePages: true }
    );

    expect(artifacts).toEqual([
      {
        parser: "pymupdf",
        uri: "s3://docslurp/user-1/run-1/parser/doc-1.pymupdf.json",
        payload: { blocks: [] }
      }
    ]);
  });

  it("runs unstructured parser artifacts on two-page PDF chunks and offsets pages", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-parser-chunks-"));
    const sourceTemp = path.join(scratch, "source.pdf");
    await writeFile(sourceTemp, "pdf");
    const ranges: string[] = [];
    const uploaded: Array<{ key: string; payload: unknown }> = [];

    const stage = new ExtractMarkdownStage(
      {
        pyMuPdfJson: async () => ({ binary: "python3", args: ["pymupdf"], available: false }),
        extractPdfPageRange: async (_source: string, output: string, range: string) => {
          ranges.push(range);
          return { binary: "qpdf", args: ["qpdf", range, output], available: true };
        },
        unstructuredPartition: async (_source: string, output: string) => ({
          binary: "python3",
          args: ["unstructured", output],
          available: true
        }),
        run: async (plan: CommandPlan) => {
          if (plan.binary === "qpdf") {
            await writeFile(plan.args[2], "slice");
            return { stdout: "", stderr: "" };
          }
          if (plan.args[0] === "unstructured") {
            await writeFile(
              plan.args[1],
              JSON.stringify([
                { type: "NarrativeText", text: "a", metadata: { page_number: 1 } },
                { type: "NarrativeText", text: "b", metadata: { page_number: 2 } }
              ])
            );
          }
          return { stdout: "", stderr: "" };
        }
      } as any,
      {
        putJson: async (key: string, payload: unknown) => {
          uploaded.push({ key, payload });
        },
        uri: (key: string) => `s3://docslurp/${key}`
      } as any,
      {
        parserArtifactTimeoutMs: 10_000,
        unstructuredParserInitialChunkPages: 1,
        unstructuredParserMaxChunkPages: 2,
        unstructuredParserMaxConcurrency: 3
      } as any
    );

    const artifacts = await (stage as any).buildParserArtifacts(
      {
        id: "doc-1",
        runId: "run-1",
        userId: "user-1",
        filename: "sample.pdf",
        mimeType: "application/pdf",
        pageCount: 5
      },
      sourceTemp,
      { run: { pipeline: { preserveTables: true } }, artifacts: {}, pendingPerformance: [] },
      { hasTablePages: true }
    );

    expect(ranges).toEqual(["1-1", "2-3", "4-5"]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.parser).toBe("unstructured");
    expect(uploaded[0]?.key).toBe("user-1/run-1/parser/doc-1.unstructured.json");
    expect((uploaded[0]?.payload as any[]).map((entry) => entry.metadata.page_number)).toEqual([
      1,
      2,
      3,
      4,
      5
    ]);
  });

  it("retries failed multi-page unstructured chunks as single pages", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-parser-chunk-retry-"));
    const sourceTemp = path.join(scratch, "source.pdf");
    await writeFile(sourceTemp, "pdf");
    const ranges: string[] = [];
    const failedRanges = new Set<string>();

    const stage = new ExtractMarkdownStage(
      {
        pyMuPdfJson: async () => ({ binary: "python3", args: ["pymupdf"], available: false }),
        extractPdfPageRange: async (_source: string, output: string, range: string) => {
          ranges.push(range);
          return { binary: "qpdf", args: ["qpdf", range, output], available: true };
        },
        unstructuredPartition: async (_source: string, output: string) => ({
          binary: "python3",
          args: ["unstructured", output],
          available: true
        }),
        run: async (plan: CommandPlan) => {
          if (plan.binary === "qpdf") {
            await writeFile(plan.args[2], "slice");
            return { stdout: "", stderr: "" };
          }
          if (plan.args[0] === "unstructured") {
            const output = plan.args[1]!;
            if (output.includes("pages-2-3") && !failedRanges.has("2-3")) {
              failedRanges.add("2-3");
              throw new Error("slice failed");
            }
            await writeFile(
              output,
              JSON.stringify([
                { type: "NarrativeText", text: "a", metadata: { page_number: 1 } },
                { type: "NarrativeText", text: "b", metadata: { page_number: 2 } }
              ])
            );
          }
          return { stdout: "", stderr: "" };
        }
      } as any,
      {
        putJson: async () => undefined,
        uri: (key: string) => `s3://docslurp/${key}`
      } as any,
      {
        parserArtifactTimeoutMs: 10_000,
        unstructuredParserInitialChunkPages: 1,
        unstructuredParserMaxChunkPages: 2,
        unstructuredParserMaxConcurrency: 3
      } as any
    );

    const artifacts = await (stage as any).buildParserArtifacts(
      {
        id: "doc-1",
        runId: "run-1",
        userId: "user-1",
        filename: "sample.pdf",
        mimeType: "application/pdf",
        pageCount: 4
      },
      sourceTemp,
      { run: { pipeline: { preserveTables: true } }, artifacts: {}, pendingPerformance: [] },
      { hasTablePages: true }
    );

    expect(ranges).toEqual(["1-1", "2-3", "4-4", "2-2", "3-3"]);
    expect(artifacts).toHaveLength(1);
  });

  it("skips the unstructured parser sidecar for ordinary text PDFs", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-parser-skip-unstructured-"));
    const sourceTemp = path.join(scratch, "source.pdf");
    const pymupdfOutput = `${sourceTemp}.pymupdf.json`;
    await writeFile(sourceTemp, "pdf");
    let unstructuredPlanned = false;

    const stage = new ExtractMarkdownStage(
      {
        pyMuPdfJson: async () => ({ binary: "python3", args: ["pymupdf"], available: true }),
        unstructuredPartition: async () => {
          unstructuredPlanned = true;
          return { binary: "python3", args: ["unstructured"], available: true };
        },
        run: async () => {
          await writeFile(pymupdfOutput, JSON.stringify({ blocks: [] }));
          return { stdout: "", stderr: "" };
        }
      } as any,
      {
        putJson: async () => undefined,
        uri: (key: string) => `s3://docslurp/${key}`
      } as any,
      {
        parserArtifactTimeoutMs: 10_000,
        unstructuredParserChunkTimeoutMs: 20_000
      } as any
    );

    const artifacts = await (stage as any).buildParserArtifacts(
      {
        id: "doc-1",
        runId: "run-1",
        userId: "user-1",
        filename: "sample.pdf",
        mimeType: "application/pdf",
        pageCount: 5
      },
      sourceTemp,
      { run: { pipeline: { preserveTables: true } }, artifacts: {}, pendingPerformance: [] }
    );

    expect(unstructuredPlanned).toBe(false);
    expect(artifacts.map((artifact: { parser: string }) => artifact.parser)).toEqual(["pymupdf"]);
  });

  it("serializes candidate extraction when low-memory mode is enabled", async () => {
    const stage = new ExtractMarkdownStage(
      {} as any,
      {} as any,
      {
        serializePdfCandidateExtraction: true
      } as any
    );

    let active = 0;
    let maxActive = 0;
    const events: string[] = [];

    (stage as any).extractCandidate = async (extractor: { label: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${extractor.label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${extractor.label}`);
      active -= 1;
      return {
        label: extractor.label,
        plan: { binary: extractor.label, args: [], available: true },
        textUri: `s3://docslurp/${extractor.label}.md`,
        tempTextPath: `/tmp/${extractor.label}.md`
      };
    };

    const [resultA, resultB] = await (stage as any).collectCandidateResults({
      primary: { label: "docling", plan: { binary: "docling", args: [], available: true }, mode: "docling" },
      primaryKey: "primary.md",
      secondary: { label: "pymupdf", plan: { binary: "python3", args: [], available: true }, mode: "file", outputPath: "/tmp/pymupdf.md" },
      secondaryKey: "secondary.md",
      sourceTempFile: "/tmp/source.pdf"
    });

    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");
    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "start:docling",
      "end:docling",
      "start:pymupdf",
      "end:pymupdf"
    ]);
  });
});
