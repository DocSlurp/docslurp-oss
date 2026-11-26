import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { defaultPipelineFeatures, getPipelineStageOrder, mergePipelineFeatures, pipelineFeatureOverridesSchema } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const staged: string[] = [];
vi.mock("../sandbox/source-integrity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox/source-integrity.js")>();
  return {
    ...actual,
    // The host decoders all start from these bytes: any call is a host read of the customer source.
    readSourceBytes: vi.fn(async () => { throw new Error("host read of the source"); }),
    // The staged file the parser VM reads (hash checks are covered by source-integrity's own tests).
    stageSourceFile: vi.fn(async () => staged.at(-1)!),
  };
});

const delimited = await import("../lib/delimited-table.js");
const { extractTextForEmbedding, SourceTextUnavailableError } = await import("../stages/embedding-runtime.js");
const integrity = await import("../sandbox/source-integrity.js");

/**
 * Council item 3 (DocSlurp/app issue 599): with Markdown extraction off, embed, PII and page-index read the source text
 * themselves. Reachable from a public upload override; under the VM-only floor the source is never decoded or parsed on the
 * worker host: Pandoc in the parser VM reads it, or the document fails loudly.
 */
describe("the embed source fallback under the VM-only floor", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), "embed-fallback-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("is reachable: an upload override turns Markdown extraction off and no plan step turns it back on", () => {
    for (const override of [{ markdownExtraction: false }, { markdownExtraction: false, quality: "auto" }, { markdownExtraction: false, htmlExtraction: true }, { markdownExtraction: false, pageIndex: true }]) {
      const parsed = pipelineFeatureOverridesSchema.parse(override);
      const features = mergePipelineFeatures(defaultPipelineFeatures, parsed);
      expect(features.markdownExtraction).toBe(false);
      const stages = getPipelineStageOrder(features);
      expect(stages).not.toContain("extract-markdown");
      expect(stages).toContain("embed");
    }
  });

  const documentOf = (filename: string, mimeType: string) => ({ id: `doc-${filename}`, filename, mimeType, pageCount: 1, sourceKey: `raw/${filename}` }) as never;
  const runnerWith = (stdout: string) => ({
    extractMarkdown: vi.fn(async (source: string, reader?: string | null) => ({ binary: "pandoc", args: [reader ?? "", source], available: true })),
    extractText: vi.fn(async () => ({ binary: "pdftotext", args: [], available: true })),
    run: vi.fn(async () => ({ stdout, stderr: "", exitCode: 0 })),
  });

  it.each([
    ["huge.json", "application/json", `{"a":[${"1,".repeat(200_000)}1]}`, "markdown"],
    ["huge.csv", "text/csv", "a,b\n".repeat(200_000), "csv"],
    ["rows.tsv", "text/tab-separated-values", "a\tb\n".repeat(1000), "tsv"],
    ["notes.txt", "text/plain", "plain words\n".repeat(1000), "markdown"],
  ])("%s: never reaches a host decoder or parser; the VM's Pandoc reads it with the reader its format needs", async (name, mime, content, reader) => {
    vi.stubEnv("DOCSLURP_PROFILE", "service");
    vi.stubEnv("NODE_ENV", "production");
    // cleanupTempFile removes the staged file's own directory, as it does for a real download.
    const file = path.join(await mkdtemp(path.join(dir, "case-")), name);
    await writeFile(file, content);
    staged.push(file);
    const parse = vi.spyOn(JSON, "parse");
    const decode = vi.spyOn(delimited, "decodeDelimitedBytes");
    const runner = runnerWith("extracted in the VM");
    const result = await extractTextForEmbedding(documentOf(name, mime), runner as never, {} as never, undefined, undefined, undefined);
    expect(result).toMatchObject({ text: "extracted in the VM", extractor: "pandoc" });
    expect(runner.extractMarkdown).toHaveBeenCalledWith(file, reader);
    expect(integrity.readSourceBytes).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    // No JSON.parse of the source: only small JSON elsewhere could be parsed, never this file's text.
    expect(parse.mock.calls.some(([text]) => typeof text === "string" && text.length >= content.length)).toBe(false);
    parse.mockRestore();
  });

  it("fails the document loudly when the VM produces no text, still without a host decode", async () => {
    vi.stubEnv("DOCSLURP_PROFILE", "service");
    vi.stubEnv("NODE_ENV", "production");
    const file = path.join(await mkdtemp(path.join(dir, "case-")), "empty.json");
    await writeFile(file, "{}");
    staged.push(file);
    const failure = await extractTextForEmbedding(documentOf("empty.json", "application/json"), runnerWith("   ") as never, {} as never, undefined, undefined, undefined).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SourceTextUnavailableError);
    expect(String((failure as Error).message)).toMatch(/source-text-unavailable/);
    expect(integrity.readSourceBytes).not.toHaveBeenCalled();
  });

  it("in development the in-process fallback still runs (unchanged)", async () => {
    vi.mocked(integrity.readSourceBytes).mockResolvedValueOnce(Buffer.from("hello world") as never);
    const result = await extractTextForEmbedding(documentOf("dev.txt", "text/plain"), runnerWith("") as never, {} as never, undefined, undefined, undefined);
    expect(result).toMatchObject({ text: "hello world", extractor: "raw-text" });
  });
});
