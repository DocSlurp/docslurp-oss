import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandPlan } from "../tools/runner.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { ExtractorAttemptLedger } from "../extractors/attempt-ledger.js";
import { documentExtractorRegistry } from "../extractors/registry.js";
import { setNativePdfEngineForTesting } from "../native-pdf/loader.js";
import type { NativePdfEngine } from "../native-pdf/types.js";

const popplerText = async () => ({ binary: "pdftotext", args: [], available: true });

/** An engine whose single page holds one text span: enough for the block payload and availability checks. */
function fakeNativeEngine(): NativePdfEngine {
  const page = {
    size: async () => ({ widthPt: 612, heightPt: 792, rotation: 0 }),
    spans: async () => [{ text: "Hello world.", bbox: [50, 50, 200, 62], font: "Helvetica", size: 11, renderMode: 0, invisible: false, unmapped: 0 }],
  };
  return {
    id: "fake",
    version: () => ({ engine: "native-pdf", version: "0.0.0", gitSha: "", features: [] }),
    openPath: async () => ({ pageCount: async () => 1, metadata: async () => ({ encrypted: false }), page: () => page, close: async () => undefined }),
  } as unknown as NativePdfEngine;
}

// Hermetic: a locally installed private engine must not change which extractors are planned.
beforeEach(() => setNativePdfEngineForTesting("absent"));
afterEach(() => setNativePdfEngineForTesting(null));

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
        extractText: popplerText,
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

  it("falls back to the native-pdf engine, then Poppler, when Kreuzberg is unavailable", async () => {
    const stage = new ExtractMarkdownStage(
      {
        extractMarkdown: async () => ({ binary: "pandoc", args: [], available: true }),
        extractText: popplerText,
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

    expect(planned.primary.label).toBe("poppler-text");
    expect(planned.secondary).toBeNull();
    expect(planned.tableAware).toBe(false);
  });

it("prefers the native-pdf engine over Poppler when it is installed", async () => {
    const stage = new ExtractMarkdownStage(
      {
        extractMarkdown: async () => ({ binary: "pandoc", args: [], available: true }),
        extractText: popplerText,
        kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: false })
      } as any,
      {} as any,
      {} as any
    );

    setNativePdfEngineForTesting(fakeNativeEngine());
    const planned = await (stage as any).planExtractors({
      tempFile: "/tmp/sample.pdf",
      format: "pdf",
      order: {},
      options: {},
      multiStrategyVoting: false,
      secondaryId: "next-in-order",
      attemptLedger: new ExtractorAttemptLedger()
    });

    expect(planned.primary.label).toBe("native-pdf");
    expect(planned.secondary).toBeNull();
    expect(planned.tableAware).toBe(true);
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

  it("honors Poppler retry overrides for PDFs", async () => {
    const stage = new ExtractMarkdownStage(
      {
        extractMarkdown: async () => ({ binary: "pandoc", args: [], available: true }),
        extractText: popplerText,
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
      order: { pdf: ["kreuzberg", "poppler-text"] },
      options: {},
      multiStrategyVoting: false,
      secondaryId: "next-in-order",
      attemptLedger,
    });

    expect(planned.primary.label).toBe("poppler-text");
    expect(planned.tableAware).toBe(false);
  });

  it("does not plan an unavailable tool or reattempt a voting candidate on retry", async () => {
    const stage = new ExtractMarkdownStage(
      {
        kreuzbergMarkdown: async () => ({ binary: "kreuzberg", args: [], available: false }),
        extractText: popplerText,
      } as any,
      {} as any,
      {} as any,
    );
    const attemptLedger = new ExtractorAttemptLedger();
    const args = {
      tempFile: "/tmp/sample.pdf", format: "pdf", order: {}, options: {},
      multiStrategyVoting: true, secondaryId: "next-in-order", attemptLedger,
    };
    setNativePdfEngineForTesting(fakeNativeEngine());
    const first = await (stage as any).planExtractors(args);
    expect([first.primary.label, first.secondary.label]).toEqual(["native-pdf", "poppler-text"]);
    expect(attemptLedger.snapshot()).toEqual({ attempted: [], unavailable: ["kreuzberg"] });
    attemptLedger.reserve(first.primary.label);
    attemptLedger.reserve(first.secondary.label);
    const retry = await (stage as any).planExtractors(args);
    expect(retry).toBeNull();
  });

  it("does not reattempt an explicit voting secondary on retry", async () => {
    const stage = new ExtractMarkdownStage(
      {
        kreuzbergMarkdown: async () => ({ binary: "kreuzberg", args: [], available: true }),
        extractText: popplerText,
      } as any,
      {} as any,
      {} as any,
    );
    const attemptLedger = new ExtractorAttemptLedger();
    const args = {
      tempFile: "/tmp/sample.pdf", format: "pdf",
      order: { pdf: ["kreuzberg", "poppler-text"] }, options: {},
      multiStrategyVoting: true, secondaryId: "poppler-text", attemptLedger,
    };
    const first = await (stage as any).planExtractors(args);
    expect([first.primary.label, first.secondary.label]).toEqual(["kreuzberg", "poppler-text"]);
    attemptLedger.reserve(first.primary.label);
    attemptLedger.reserve(first.secondary.label);
    const retry = await (stage as any).planExtractors(args);
    expect(retry).toBeNull();
  });

  it("uploads file-backed extractor output for Kreuzberg candidates", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-kreuzberg-test-"));
    const sourceTemp = path.join(scratch, "source.pdf");
    const outputPath = `${sourceTemp}.kreuzberg.md`;
    await writeFile(sourceTemp, "pdf");

    const uploaded = createUploadCapture();
    const stage = new ExtractMarkdownStage(
      {
        run: async (_plan: CommandPlan) => {
          await writeFile(outputPath, "kreuzberg text");
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
      await documentExtractorRegistry.prepare("kreuzberg", {
        kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: true }),
      } as any, sourceTemp),
      "demo-user/run-1/markdown/doc-1.kreuzberg.md",
      sourceTemp
    );

    expect(candidate.textUri).toBe("s3://docslurp/demo-user/run-1/markdown/doc-1.kreuzberg.md");
    expect(candidate.tempTextPath).toBe(outputPath);
    expect(uploaded.read()).toBe("kreuzberg text");
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
    await writeFile(sourceTemp, "pdf");
    setNativePdfEngineForTesting(fakeNativeEngine());

    const stage = new ExtractMarkdownStage(
      {
        unstructuredPartition: async () => ({ binary: "python3", args: ["unstructured"], available: true }),
        run: async (_plan: CommandPlan, signal?: AbortSignal) => {
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
        parser: "native-pdf",
        uri: "s3://docslurp/user-1/run-1/parser/doc-1.native-pdf.json",
        payload: {
          engine: "native-pdf",
          pages: [expect.objectContaining({ number: 1, width: 612, height: 792, blocks: [expect.objectContaining({ type: 0 })] })]
        }
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
    await writeFile(sourceTemp, "pdf");
    setNativePdfEngineForTesting(fakeNativeEngine());
    let unstructuredPlanned = false;

    const stage = new ExtractMarkdownStage(
      {
        unstructuredPartition: async () => {
          unstructuredPlanned = true;
          return { binary: "python3", args: ["unstructured"], available: true };
        },
        run: async () => ({ stdout: "", stderr: "" })
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
    expect(artifacts.map((artifact: { parser: string }) => artifact.parser)).toEqual(["native-pdf"]);
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
      primary: { label: "poppler-text", plan: { binary: "pdftotext", args: [], available: true }, mode: "stream" },
      primaryKey: "primary.md",
      secondary: { label: "kreuzberg", plan: { binary: "node", args: [], available: true }, mode: "file", outputPath: "/tmp/kreuzberg.md" },
      secondaryKey: "secondary.md",
      sourceTempFile: "/tmp/source.pdf"
    });

    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");
    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "start:poppler-text",
      "end:poppler-text",
      "start:kreuzberg",
      "end:kreuzberg"
    ]);
  });
});
