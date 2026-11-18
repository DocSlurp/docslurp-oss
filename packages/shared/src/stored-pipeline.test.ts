import { afterEach, describe, expect, it } from "vitest";

import { vi } from "vitest";

import { documentExtractionConfigSchema, sanitizeStoredDocumentExtraction } from "./extraction.js";
import { hostPdfExtractorsUnderSandbox } from "./extractors.js";
import { defaultPipelineFeatures, normalizePipelineFeatures, normalizeStoredPipelineFeatures, parseStoredPipelineFeatures, readStoredPipelineSettings, sanitizeStoredPipeline, strictestStoredPipelineFeatures } from "./pipeline.js";

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

describe("readStoredPipelineSettings: drop the invalid field, keep the rest, never weaken a guarded setting", () => {
  afterEach(() => vi.restoreAllMocks());
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("reads a valid row as is, with no repairs", () => {
    const read = readStoredPipelineSettings({ summarize: true, privacyMode: "standard" }, "project p1");
    expect(read.repairs).toEqual([]);
    expect(read.features.summarize).toBe(true);
  });

  it("drops one bad enum and keeps every other stored setting", () => {
    quiet();
    const read = readStoredPipelineSettings({ inferenceLane: "warp", summarize: true, webTools: false }, "project p1");
    expect(read.features).toMatchObject({ inferenceLane: defaultPipelineFeatures.inferenceLane, summarize: true, webTools: false });
    expect(read.repairs).toEqual([{ path: "pipeline.inferenceLane", reason: "invalid" }]);
  });

  it("reports a refused vision model as retired, by setting name only", () => {
    quiet();
    const read = readStoredPipelineSettings({ vision: { profile: "good-fast-hosted", modelUri: "llm://openrouter/no-such/model" } }, "project p1");
    expect(read.repairs).toEqual([{ path: "pipeline.vision", reason: "retired" }]);
    expect(JSON.stringify(read.repairs)).not.toContain("no-such");
  });

  it("guarded settings that do not validate fall to their strictest value", () => {
    quiet();
    const read = readStoredPipelineSettings({
      privacyMode: "Local-Only",
      piiPolicy: { enabled: "yes" },
      webTools: "off",
      webhooks: { enabled: true, events: "run.completed" },
      maxCostCents: -5,
      ladder: { maxRung: "gold" },
      visionFallback: "sometimes",
      mediaVideo: { enabled: true, maxFrames: 999_999 },
      pageRouter: { mode: "active", router: "decision-model", budgetPerDocumentUsd: 5000 },
      embedding: { profile: "cheapest-local" },
      vision: { profile: "cheapest-local" },
    }, "project p1");
    expect(read.features).toMatchObject({
      privacyMode: "strict-privacy",
      piiPolicy: { enabled: true, action: "block_indexing" },
      webTools: false,
      webhooks: { enabled: false, events: [] },
      maxCostCents: 1,
      ladder: { maxRung: "fast" },
      visionFallback: false,
      mediaVideo: { enabled: false },
    });
    expect(read.features.piiPolicy.patterns.length).toBeGreaterThan(5);
    expect(read.features.pageRouter.mode).toBeUndefined();
    expect(read.features.pageRouter.router).toBe("baseline");
    for (const key of ["privacyMode", "piiPolicy", "webTools", "webhooks", "maxCostCents", "ladder", "visionFallback", "mediaVideo", "pageRouter"]) {
      expect(read.repairs).toContainEqual({ path: `pipeline.${key}`, reason: "restricted" });
    }
  });

  it("a cost cap is never read as no cap: a positive value is floored, garbage is 1 cent", () => {
    quiet();
    expect(readStoredPipelineSettings({ maxCostCents: 250.7 }, "p").features.maxCostCents).toBe(250);
    expect(readStoredPipelineSettings({ maxCostCents: "500" }, "p").features.maxCostCents).toBe(500);
    expect(readStoredPipelineSettings({ maxCostCents: "lots" }, "p").features.maxCostCents).toBe(1);
    expect(readStoredPipelineSettings({ maxCostCents: 0.5 }, "p").features.maxCostCents).toBe(1);
    expect(readStoredPipelineSettings({ maxCostCents: null }, "p").features.maxCostCents).toBeNull();
  });

  it("under a restricted privacy mode a dropped model profile becomes local, never the hosted default", () => {
    quiet();
    const read = readStoredPipelineSettings({ privacyMode: "local-only", vision: { profile: "retired-profile" }, embedding: "garbage" }, "project p1");
    expect(read.features.privacyMode).toBe("local-only");
    expect(read.features.vision.profile).toBe("cheapest-local");
    expect(read.features.embedding.profile).toBe("cheapest-local");
    expect(read.repairs).toContainEqual({ path: "pipeline.vision", reason: "restricted" });
  });

  it("a pipeline stored as a non-object reads as defaults with every guarded setting at its strictest", () => {
    quiet();
    for (const stored of ["nonsense", 42, ["a"], true]) {
      const read = readStoredPipelineSettings(stored, "project p1");
      expect(read.repairs).toEqual([{ path: "pipeline", reason: "restricted" }]);
      expect(read.features).toMatchObject({ privacyMode: "strict-privacy", webTools: false, webhooks: { enabled: false }, maxCostCents: 1, visionFallback: false, mediaVideo: { enabled: false } });
      expect(read.features.piiPolicy).toMatchObject({ enabled: true, action: "block_indexing" });
      expect(read.features.embedding.profile).toBe("cheapest-local");
    }
    expect(readStoredPipelineSettings(null, "p").repairs).toEqual([]);
  });

  it("a conflict on a setting the row does not hold takes the narrower value", () => {
    quiet();
    const read = readStoredPipelineSettings({ embed: false, summarize: true }, "project p1");
    expect(read.features).toMatchObject({ embed: false, indexVectors: false, summarize: true });
  });

  it("the strict reader still throws on the same rows (requests stay strict)", () => {
    quiet();
    expect(() => normalizeStoredPipelineFeatures({ quality: "no-such-quality" } as never, "p")).toThrow();
    expect(() => normalizePipelineFeatures({ maxCostCents: -5 } as never)).toThrow();
  });
});

describe("readStoredPipelineSettings: council follow-ups (#494)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an unreadable quality, preamble or figures switch is the cheapest value", () => {
    const read = readStoredPipelineSettings({ quality: "no-such-quality", contextualChunkPreambles: "yes", figures: 1 }, "p");
    expect(read.features).toMatchObject({ quality: "fast", contextualChunkPreambles: false, figures: false });
    for (const key of ["quality", "contextualChunkPreambles", "figures"]) expect(read.repairs).toContainEqual({ path: `pipeline.${key}`, reason: "restricted" });
    // Visual mode refuses Fast, so a visual row falls to Auto.
    expect(readStoredPipelineSettings({ quality: "nope", indexingMode: "visual" }, "p").features.quality).toBe("auto");
  });

  it("embed off with graph features on turns the graph features off, never embedding on", () => {
    const read = readStoredPipelineSettings({ embed: false, indexVectors: false, graphRag: true, entityIndex: true, graphCommunitySummaries: true, quality: "bogus" }, "p");
    expect(read.features).toMatchObject({ embed: false, indexVectors: false, graphRag: false, entityIndex: false, graphCommunitySummaries: false });
  });

  it("a stored false named by a refinement is never deleted", () => {
    const read = readStoredPipelineSettings({ embed: false, graphRag: true, quality: "bogus" }, "p");
    expect(read.features.embed).toBe(false);
    expect(read.features.indexVectors).toBe(false);
  });

  it("an enabled PII policy whose detectors are all unknown, or not names, is the strictest policy", () => {
    for (const patterns of [["retired-a", "retired-b"], ["ssn", 42]]) {
      const read = readStoredPipelineSettings({ piiPolicy: { enabled: true, action: "flag_for_review", patterns } }, "p");
      expect(read.features.piiPolicy).toMatchObject({ enabled: true, action: "block_indexing" });
      expect(read.features.piiPolicy.patterns.length).toBeGreaterThan(5);
      expect(read.repairs).toContainEqual({ path: "pipeline.piiPolicy", reason: "restricted" });
    }
    // A policy that keeps a known detector keeps its own action.
    expect(readStoredPipelineSettings({ piiPolicy: { enabled: true, action: "flag_for_review", patterns: ["ssn", "gone"] } }, "p").features.piiPolicy)
      .toMatchObject({ action: "flag_for_review", patterns: ["ssn"] });
  });

  it("restricted privacy with a bad vision sub-key drops the key, reads the local profile and keeps the other fields", () => {
    const read = readStoredPipelineSettings({ privacyMode: "local-only", summarize: true, vision: { profile: "cheapest-local", maxPagesPerDocument: "many" }, embedding: { profile: "cheapest-local" } }, "p");
    expect(read.features).toMatchObject({ privacyMode: "local-only", summarize: true, vision: { profile: "cheapest-local" } });
    expect(read.repairs).not.toContainEqual({ path: "pipeline", reason: "invalid" });
  });

  it("a legacy vision model the migration cannot place goes, the section reads local, the other fields stay", () => {
    for (const privacyMode of ["local-only", "standard"]) {
      for (const vision of [{ model: 123, profile: "cheapest-local" }, { model: "no-such", baseUrl: "https://x.example/v1" }]) {
        const read = readStoredPipelineSettings({ privacyMode, summarize: true, embedding: { profile: "cheapest-local" }, vision }, "p");
        expect(read.features).toMatchObject({ privacyMode, summarize: true, vision: { profile: "cheapest-local", target: "local" } });
        expect(read.repairs).toEqual([{ path: "pipeline.vision", reason: "restricted" }]);
      }
    }
  });

  it("a Nitro model without Speed boost loses the model, not the row", () => {
    const read = readStoredPipelineSettings({ summarize: true, speedBoost: false, textGeneration: { model: "qwen/qwen3.5-flash-02-23:nitro", models: {} } }, "p");
    expect(read.features.summarize).toBe(true);
    expect(read.features.speedBoost).toBe(false);
    expect(read.features.textGeneration.model).toBeNull();
    expect(read.repairs).toEqual([{ path: "pipeline.textGeneration", reason: "invalid" }]);
  });

  it("never logs itself; parseStoredPipelineFeatures logs once per row and outcome", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    readStoredPipelineSettings({ inferenceLane: "warp" }, "project log-1");
    expect(error).not.toHaveBeenCalled();
    parseStoredPipelineFeatures({ inferenceLane: "warp" }, "project log-1");
    parseStoredPipelineFeatures({ inferenceLane: "warp" }, "project log-1");
    expect(error).toHaveBeenCalledOnce();
  });

  it("a newer configVersion still fails the read; the strictest features are what lists show", () => {
    expect(() => readStoredPipelineSettings({ configVersion: 99 }, "p")).toThrow(/configVersion 99/);
    expect(strictestStoredPipelineFeatures()).toMatchObject({ privacyMode: "strict-privacy", quality: "fast", webTools: false, maxCostCents: 1 });
  });
});
