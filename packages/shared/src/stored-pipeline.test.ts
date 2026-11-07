import { afterEach, describe, expect, it } from "vitest";

import { vi } from "vitest";

import { documentExtractionConfigSchema, sanitizeStoredDocumentExtraction } from "./extraction.js";
import { hostPdfExtractorsUnderSandbox } from "./extractors.js";
import { defaultPipelineFeatures, normalizePipelineFeatures, normalizeStoredPipelineFeatures, parseStoredPipelineFeatures, sanitizeStoredPipeline } from "./pipeline.js";

describe("parseStoredPipelineFeatures", () => {
  it("reads historical snapshots with retired keys and nulls (prod /v1/runs 500)", () => {
    const stored = structuredClone(defaultPipelineFeatures) as unknown as Record<string, any>;
    stored.documentExtraction = { ...stored.documentExtraction, pages: null };
    stored.vision = { ...stored.vision, model: "gpt-4o", baseUrl: "https://x", runtime: "remote", remoteFallbackModel: "y" };
    expect(() => normalizePipelineFeatures(stored as never)).toThrow();
    const parsed = parseStoredPipelineFeatures(stored);
    expect(parsed.vision).not.toHaveProperty("baseUrl");
    expect(Array.isArray(parsed.documentExtraction.pages) || parsed.documentExtraction.pages === undefined).toBe(true);
    expect(parsed.quality).toBe(defaultPipelineFeatures.quality);
  });

  it("keeps valid settings and falls back to defaults for garbage", () => {
    expect(parseStoredPipelineFeatures({ ...defaultPipelineFeatures, summarize: true }).summarize).toBe(true);
    expect(parseStoredPipelineFeatures(null).summarize).toBe(defaultPipelineFeatures.summarize);
    expect(parseStoredPipelineFeatures("nonsense").embed).toBe(true);
  });
});


describe("stored PII policies with patterns that no longer exist", () => {
  const stored = (patterns: unknown[], extra: Record<string, unknown> = {}) => ({
    ...structuredClone(defaultPipelineFeatures),
    piiPolicy: { enabled: true, patterns, action: "block_indexing", allowlistPatterns: ["internal-.*"], ...extra },
  }) as never;

  it("drops the unknown pattern with a loud log and keeps the policy and the known patterns instead of failing the whole read", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const features = normalizeStoredPipelineFeatures(stored(["ssn", "retired-detector", "credit-card", "another-gone"]), "project w1");
    expect(features.piiPolicy).toMatchObject({ enabled: true, patterns: ["ssn", "credit-card"], action: "block_indexing", allowlistPatterns: ["internal-.*"] });
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]![0])).toMatch(/project w1.*retired-detector.*another-gone/);
    error.mockRestore();
  });

  it("does not drop anything from a policy whose patterns all exist, and does not log", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const input = stored(["ssn", "private-key"]);
    expect(sanitizeStoredPipeline(input, "project w1")).toBe(input);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("an unknown pattern is still refused on new writes (strict parse)", () => {
    expect(() => normalizePipelineFeatures(stored(["ssn", "retired-detector"]))).toThrow();
  });

  it("does not hide a pattern list that is not a list: that still fails the read", () => {
    expect(() => normalizeStoredPipelineFeatures(stored("ssn" as never), "project w1")).toThrow();
  });

  it("drops an unknown pattern and a stale extractor setting in the same read", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const input = stored(["ssn", "gone"]) as unknown as Record<string, any>;
    input.documentExtraction = { ...input.documentExtraction, pages: null };
    const features = normalizeStoredPipelineFeatures(input as never, "run r1");
    expect(features.piiPolicy.patterns).toEqual(["ssn"]);
    error.mockRestore();
  });
});

describe("a stored host PDF extractor under a sandboxed PDF deployment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is dropped on read (the PDF takes the sandboxed default) and refused on write", () => {
    vi.stubEnv("DOCSLURP_VM_PDF_INSTALLED", "1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stored = { order: { pdf: ["poppler-text"], image: ["ocr"] }, pages: ["ocr", "vm-pdf"], enrich: ["poppler-text"], voting: { enabled: true, secondary: "native-pdf" } };
    const { value, dropped } = sanitizeStoredDocumentExtraction(stored);
    expect(dropped).toEqual(["documentExtraction.order.pdf", "documentExtraction.pages", "documentExtraction.enrich", "documentExtraction.voting.secondary"]);
    expect(value).toMatchObject({ order: { image: ["ocr"] }, pages: ["vm-pdf"], enrich: [], voting: { enabled: true, secondary: "next-in-order" } });
    expect(hostPdfExtractorsUnderSandbox(value)).toEqual([]);
    const refused = documentExtractionConfigSchema.safeParse(stored);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path.join("."))).toEqual(["order.pdf.0", "pages.0", "enrich.0", "voting.secondary"]);
  });

  it("is left alone when the deployment parses PDFs on the host", () => {
    const stored = { order: { pdf: ["poppler-text"] }, voting: { enabled: true, secondary: "native-pdf" } };
    expect(sanitizeStoredDocumentExtraction(stored).dropped).toEqual([]);
    expect(documentExtractionConfigSchema.safeParse(stored).success).toBe(true);
  });
});
