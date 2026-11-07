import { describe, expect, it } from "vitest";

import {
  OPEN_CREDITS_PER_PAGE,
  QUALITY_MODES,
  qualityModeInfo,
  defaultPipelineFeatures,
  blankPages,
  defaultDocumentExtractionConfig,
  documentExtractionConfigSchema,
  type DocumentExtractionConfig,
  documentExtractionForQuality,
  isPageImageReferenceBlock,
  pageImageExtension,
  pageImageReferencePages,
  projectTemplates,
  legacyQualityMode,
  mergePipelineFeatures,
  migrateLegacyQualitySettings,
  normalizePipelineFeatures,
  normalizeStoredPipelineFeatures,
  parseExtractorOptions,
  pageImageReferenceMarkdown,
  parseStoredPipelineFeatures,
  parserPlaybookForQuality,
  pipelineFeatureOverridesSchema,
  pipelineFeaturesSchema,
  qualityAllowsPageReading,
  qualityModePriceRange,
  qualityReadsEveryPage,
} from "../index.js";

describe("pipeline.quality", () => {
  it("defaults to auto and derives the balanced playbook", () => {
    expect(defaultPipelineFeatures.quality).toBe("auto");
    expect(normalizePipelineFeatures(null).quality).toBe("auto");
    expect(pipelineFeaturesSchema.parse({}).quality).toBe("auto");
    expect(parserPlaybookForQuality("auto")).toBe("balanced");
    expect(parserPlaybookForQuality(undefined)).toBe("balanced");
  });

  it("maps each mode to its internal playbook and vision behaviour", () => {
    expect(parserPlaybookForQuality("fast")).toBe("fast");
    expect(parserPlaybookForQuality("good")).toBe("review-grade");
    expect(qualityReadsEveryPage("good")).toBe(true);
    expect(qualityReadsEveryPage("auto")).toBe(false);
    expect(qualityAllowsPageReading("fast")).toBe(false);
    expect(qualityAllowsPageReading("auto")).toBe(true);
    expect(qualityAllowsPageReading("good")).toBe(true);
  });

  it("rejects unknown modes", () => {
    expect(() => normalizePipelineFeatures({ quality: "best" as never })).toThrow();
    expect(pipelineFeatureOverridesSchema.safeParse({ quality: "deep" }).success).toBe(false);
  });

  it("no longer exposes parserPlaybook or vision.forceAllPages", () => {
    const parsed = normalizePipelineFeatures(null) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("parserPlaybook");
    expect(parsed.vision).not.toHaveProperty("forceAllPages");
  });
});

describe("legacy quality input", () => {
  it.each([
    [{ parserPlaybook: "fast" }, "fast"],
    [{ parserPlaybook: "balanced" }, "auto"],
    [{ parserPlaybook: "layout-aware" }, "auto"],
    [{ parserPlaybook: "agentic" }, "auto"],
    // review-grade never read every page: it maps to auto, not good (which would multiply spend).
    [{ parserPlaybook: "review-grade" }, "auto"],
    [{ parserPlaybook: "review-grade", vision: { forceAllPages: false } }, "auto"],
    [{ parserPlaybook: "agentic", vision: { forceAllPages: false } }, "auto"],
    [{ parserPlaybook: "review-grade", vision: { forceAllPages: true } }, "good"],
    [{ vision: { forceAllPages: true } }, "good"],
    [{ parserPlaybook: "fast", vision: { forceAllPages: true } }, "good"],
  ] as const)("maps %j to %s", (legacy, expected) => {
    expect(legacyQualityMode(legacy)).toBe(expected);
    expect(normalizePipelineFeatures(legacy as never).quality).toBe(expected);
    expect(parseStoredPipelineFeatures(legacy).quality).toBe(expected);
  });

  it("treats forceAllPages: false alone as saying nothing", () => {
    expect(legacyQualityMode({ vision: { forceAllPages: false } })).toBeNull();
    expect(normalizePipelineFeatures({ vision: { forceAllPages: false } } as never).quality).toBe("auto");
  });

  it("lets an explicit quality win over legacy keys", () => {
    expect(normalizePipelineFeatures({ quality: "fast", parserPlaybook: "review-grade" } as never).quality).toBe("fast");
  });

  it("parses a full stored pipeline that carries the retired keys", () => {
    const stored = {
      ...structuredClone(defaultPipelineFeatures),
      parserPlaybook: "review-grade",
      vision: { ...defaultPipelineFeatures.vision, forceAllPages: false, maxPagesPerDocument: 4 },
    } as Record<string, unknown>;
    delete stored.quality;
    const parsed = parseStoredPipelineFeatures(stored) as Record<string, unknown>;
    expect(parsed.quality).toBe("auto");
    expect(parsed).not.toHaveProperty("parserPlaybook");
    expect(parsed.vision).not.toHaveProperty("forceAllPages");
  });

  it("accepts legacy request overrides and merges them as quality", () => {
    const override = pipelineFeatureOverridesSchema.parse({ parserPlaybook: "fast" });
    expect(override).toEqual({ quality: "fast" });
    const forced = pipelineFeatureOverridesSchema.parse({ vision: { forceAllPages: true } });
    expect(forced).toEqual({ quality: "good", vision: {} });

    const project = normalizePipelineFeatures({ quality: "good" });
    expect(mergePipelineFeatures(project, { parserPlaybook: "fast" } as never).quality).toBe("fast");
    expect(mergePipelineFeatures(project, { vision: { forceAllPages: false } } as never).quality).toBe("good");
    expect(mergePipelineFeatures(project, { quality: "auto" }).quality).toBe("auto");
  });

  it("keeps an in-flight review-grade run row (forceAllPages: false) on auto through normalizePipelineFeatures", () => {
    // A project_runs.pipeline row written before quality existed, read back by the worker mid-run.
    const runRow = JSON.parse(JSON.stringify({
      ...defaultPipelineFeatures,
      quality: undefined,
      parserPlaybook: "review-grade",
      visionFallback: true,
      vision: { ...defaultPipelineFeatures.vision, forceAllPages: false },
    }));
    const pipeline = normalizePipelineFeatures(runRow);
    expect(pipeline.quality).toBe("auto");
    expect(qualityReadsEveryPage(pipeline.quality)).toBe(false);
    expect(mergePipelineFeatures(runRow, {}).quality).toBe("auto");
  });

  it("ships the Legal Contracts and Medical Records templates on auto, locked", () => {
    for (const key of ["legal-contracts", "medical-records"]) {
      const template = projectTemplates.find((entry) => entry.key === key)!;
      expect(template, key).toBeDefined();
      expect(template.pipeline.quality).toBe("auto");
      expect(template.lockedSettings).toContain("quality");
    }
  });

  it("returns sources without legacy keys unchanged", () => {
    const source = { summarize: true };
    expect(migrateLegacyQualitySettings(source)).toBe(source);
  });
});

describe("quality good turns vision on", () => {
  it("normalizes { quality: good, visionFallback: false } to vision on", () => {
    expect(normalizePipelineFeatures({ quality: "good", visionFallback: false }).visionFallback).toBe(true);
    expect(normalizePipelineFeatures({ quality: "auto", visionFallback: false }).visionFallback).toBe(false);
  });

  it("enables vision when Good merges into a project with fallback disabled", () => {
    const project = normalizePipelineFeatures({ quality: "auto", visionFallback: false });
    const merged = mergePipelineFeatures(project, { quality: "good" });
    expect(merged.quality).toBe("good");
    expect(merged.visionFallback).toBe(true);
    // Switching back to Auto leaves vision on (the merged project value); turning it off stays allowed.
    expect(mergePipelineFeatures(merged, { quality: "auto", visionFallback: false }).visionFallback).toBe(false);
  });

});

describe("documentExtractionForQuality", () => {
  // An unparsed config: documentExtractionForQuality must hold even for keys the schema would strip.
  const hostile = {
    ...defaultDocumentExtractionConfig,
    order: { pdf: ["dolphin", "graph-local", "poppler-text"], image: ["dolphin"] },
    options: { dolphin: { mode: "layout" } },
    enrich: ["page/ocr-text"],
    voting: { enabled: true, secondary: "dolphin" },
    forceOcr: true,
  } as unknown as DocumentExtractionConfig;

  it("leaves auto and good unchanged", () => {
    expect(documentExtractionForQuality(hostile, "auto")).toEqual({ config: hostile, removed: [] });
    expect(documentExtractionForQuality(hostile, "good").config).toBe(hostile);
  });

  it("restricts fast to text-layer extractors", () => {
    const { config, removed } = documentExtractionForQuality(hostile, "fast");
    expect(config.order).toEqual({ pdf: ["poppler-text"] });
    expect(config.options).toEqual({});
    expect(config.enrich).toEqual([]);
    expect(config.voting.secondary).toBe("next-in-order");
    expect(config.forceOcr).toBe(false);
    expect(removed).toEqual(expect.arrayContaining([
      "order.pdf:dolphin", "order.pdf:graph-local", "order.image:dolphin", "options.dolphin",
      "enrich", "voting.secondary:dolphin", "forceOcr",
    ]));
  });

  it("adds nothing when nothing was configured", () => {
    const { config, removed } = documentExtractionForQuality(defaultDocumentExtractionConfig, "fast");
    expect(config.options).toEqual({});
    expect(removed).toEqual([]);
  });

  it("counts the office sidecars and Pandoc as text-layer extractors", () => {
    const config = { ...defaultDocumentExtractionConfig, order: { "office-pptx": ["pptx"], "office-excel": ["xlsx"], "office-word": ["pandoc"] } };
    expect(documentExtractionForQuality(config, "fast").config.order).toEqual(config.order);
  });
});

describe("OCR language setting", () => {
  it("constrains OCR languages to three-letter language codes (L2)", () => {
    for (const language of ["eng", "deu", "chi_sim", "chi_sim_vert", "chi_tra_vert", "jpn_vert", "eng+deu", "eng+chi_tra+jpn", "eng+chi_sim_vert"]) {
      expect(documentExtractionConfigSchema.parse({ ocr: { language } }).ocr.language).toBe(language);
    }
    for (const language of ["../../etc/passwd", "eng;rm -rf /", "en", "ENG", "eng+", "+eng", "eng deu", "--psm 0", "e".repeat(9), "eng\nX",
      "chi_sim_vert_x", "eng_", "_eng", "eng__sim", "eng/../x", "eng|id", "$(id)", "`id`", "eng&deu", "eng_sim1", "chi_sim_toolongx"]) {
      expect(() => documentExtractionConfigSchema.parse({ ocr: { language } }), language).toThrow();
    }
  });
});

describe("retired extractors (kreuzberg, liteparse)", () => {
  it("drops them from requests: orders fall back to the deployment default, options and secondaries go", () => {
    const parsed = documentExtractionConfigSchema.parse({
      order: { pdf: ["kreuzberg"], "office-word": ["kreuzberg", "pandoc"], html: ["liteparse"] },
      voting: { enabled: true, secondary: "kreuzberg" },
      options: { kreuzberg: { forceOcr: true, ocr: { backend: "tesseract" } }, liteparse: { ocr: true }, dolphin: { mode: "page" } },
      components: { tables: ["liteparse"], formulas: [], images: [] },
    });
    expect(parsed.order).toEqual({ "office-word": ["pandoc"] });
    expect(parsed.voting).toEqual({ enabled: true, secondary: "next-in-order" });
    expect(parsed.options).toEqual({ dolphin: { mode: "page" } });
    expect(parsed.components.tables).toEqual([]);
  });

  it("still rejects unknown option keys and ids that were never extractors", () => {
    expect(() => documentExtractionConfigSchema.parse({ options: { tesseract: {} } })).toThrow();
    expect(() => documentExtractionConfigSchema.parse({ options: { dolphin: { repoPath: "/tmp/x" } } })).toThrow();
  });
});

describe("extractor options (M4: one strict schema per extractor id)", () => {
  it("accepts only Dolphin's mode and maxBatchSize", () => {
    expect(documentExtractionConfigSchema.parse({ options: { dolphin: { mode: "layout", maxBatchSize: 4 } } }).options)
      .toEqual({ dolphin: { mode: "layout", maxBatchSize: 4 } });
    expect(parseExtractorOptions("dolphin", { mode: "page" })).toEqual({ mode: "page" });
  });

  it("rejects Dolphin repo, model and Python paths, and any other key", () => {
    for (const dolphin of [
      { repoPath: "/tmp/attacker" },
      { modelPath: "/tmp/attacker-model" },
      { mode: "page", repoPath: "/project/uploads/evil" },
      { pythonBin: "/bin/sh" },
      { dolphin: { repoPath: "/tmp/attacker" } },
      { modelFlavor: "Dolphin-v2" },
      { mode: "shell" },
      { maxBatchSize: 1000 },
    ]) {
      expect(() => documentExtractionConfigSchema.parse({ options: { dolphin } }), JSON.stringify(dolphin)).toThrow();
      expect(() => normalizePipelineFeatures({ documentExtraction: { options: { dolphin } } } as never)).toThrow();
      expect(() => parseExtractorOptions("dolphin", dolphin)).toThrow();
    }
  });

  it("rejects options for extractor ids without an option schema", () => {
    for (const id of ["pandoc", "pptx", "xlsx", "native-pdf", "poppler-text", "graph-local", "json", "unknown", "__proto__", "constructor", "toString"]) {
      expect(() => documentExtractionConfigSchema.parse({ options: { [id]: {} } }), id).toThrow();
      expect(() => parseExtractorOptions(id, {}), id).toThrow(/takes no options/);
    }
  });
});

describe("stored pipelines with settings the strict schemas reject (round 4 M2)", () => {
  const stored = {
    quality: "fast",
    documentExtraction: {
      order: { pdf: ["liteparse", "kreuzberg"] },
      options: {
        liteparse: { ocr: true },
        kreuzberg: { useCache: false, forceOcr: false, ocr: { backend: "tesseract", language: "en", vlmConfig: { model: "x" } } },
        dolphin: { mode: "page", repoPath: "/tmp/attacker", modelPath: "/tmp/model" },
        ["__proto__"]: { polluted: true },
      },
      ocr: { language: "en", autoRotate: false },
    },
  };

  it("loads with every rejected path dropped and logged, keeping quality and the valid settings", () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      const parsed = normalizeStoredPipelineFeatures(JSON.parse(JSON.stringify(stored)) as never, "project ws_1");
      expect(parsed.quality).toBe("fast");
      // Both retired ids go, so the PDF order falls back to the deployment default.
      expect(parsed.documentExtraction.order.pdf).toBeUndefined();
      expect(parsed.documentExtraction.options).toEqual({ dolphin: { mode: "page" } });
      expect(JSON.stringify(parsed)).not.toContain("/tmp/attacker");
      expect(JSON.stringify(parsed)).not.toContain("/tmp/model");
      expect(parsed.documentExtraction.ocr).toEqual({ language: "auto", autoRotate: false });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("project ws_1");
      for (const path of [
        "documentExtraction.ocr.language", "documentExtraction.options.liteparse", "documentExtraction.options.__proto__",
        "documentExtraction.options.kreuzberg", "documentExtraction.order.pdf:liteparse", "documentExtraction.order.pdf:kreuzberg",
        "documentExtraction.options.dolphin.repoPath",
        "documentExtraction.options.dolphin.modelPath",
      ]) expect(errors[0]).toContain(path);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      // parseStoredPipelineFeatures (run history) reads the same row the same way.
      expect(parseStoredPipelineFeatures(JSON.parse(JSON.stringify(stored)), "run r1").documentExtraction.options).toEqual(parsed.documentExtraction.options);
    } finally {
      console.error = original;
    }
  });

  it("drops an extractor whose options cannot be repaired, and options that are not an object", () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(normalizeStoredPipelineFeatures({ documentExtraction: { options: { dolphin: "repoPath=/tmp/x", kreuzberg: { ocr: "x" } } } } as never, "run r2")
        .documentExtraction.options).toEqual({});
      expect(normalizeStoredPipelineFeatures({ documentExtraction: { options: ["dolphin"] } } as never, "run r3").documentExtraction.options).toEqual({});
    } finally {
      console.error = quiet;
    }
  });

  it("stays strict for requests and for every other invalid setting, quality included", () => {
    expect(() => normalizePipelineFeatures(stored as never)).toThrow();
    expect(pipelineFeatureOverridesSchema.safeParse({ documentExtraction: { options: { dolphin: { repoPath: "/tmp/attacker" } } } }).success).toBe(false);
    expect(() => normalizeStoredPipelineFeatures({ quality: "ultra" } as never, "project ws_2")).toThrow();
  });

  it("does not log or copy a clean stored pipeline", () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const clean = { quality: "auto", documentExtraction: { options: { dolphin: { mode: "page" } } } };
      expect(normalizeStoredPipelineFeatures(clean as never, "project ws_3").documentExtraction.options).toEqual({ dolphin: { mode: "page" } });
      expect(errors).toEqual([]);
    } finally {
      console.error = original;
    }
  });
});

describe("QUALITY_MODES", () => {
  it("prices each mode from the pricing provider (the open default here)", () => {
    for (const mode of ["fast", "auto", "good"] as const) {
      expect(qualityModeInfo(mode)).toMatchObject({ ...QUALITY_MODES[mode], creditsPer1kPages: { min: OPEN_CREDITS_PER_PAGE * 1000, max: OPEN_CREDITS_PER_PAGE * 1000 } });
    }
  });

  it("formats the price per 1,000 pages", () => {
    expect(qualityModePriceRange("fast")).toBe("$1.00");
    expect(qualityModePriceRange("good")).toBe("$1.00");
  });

  it("says Fast keeps scans as images", () => {
    expect(QUALITY_MODES.fast.description).toMatch(/Scanned pages are kept as images, not read/);
  });
});

describe("Fast page-image references", () => {
  it("references the export page image with alt text naming the page", () => {
    expect(pageImageReferenceMarkdown(3)).toBe("![Page 3: scanned page image, no text layer](images/page-0003.png)");
  });

  it.each([
    ["s3://bucket/run/images/doc/v2-150dpi/page-1.jpg", "jpg"],
    ["images/doc/page-2.WEBP", "webp"],
    ["page-3.gif?x=1", "gif"],
    ["page-4.png", "png"],
    ["page-5", "png"],
    ["page-6.exe", "png"],
  ])("names the reference after the stored image format (%s -> %s)", (uri, extension) => {
    expect(pageImageExtension(uri)).toBe(extension);
    expect(pageImageReferenceMarkdown(7, pageImageExtension(uri))).toContain(`(images/page-0007.${extension})`);
  });

  it("recognizes references structurally, never by their text", () => {
    const text = pageImageReferenceMarkdown(2);
    const reference = { pageNumber: 2, text, metadata: { extractor: "page-image" } };
    // A text layer that contains the exact reference string is ordinary text.
    const spoof = { pageNumber: 3, text, metadata: { extractor: "native-pdf" } };
    expect(isPageImageReferenceBlock(reference)).toBe(true);
    expect(isPageImageReferenceBlock(spoof)).toBe(false);
    expect(isPageImageReferenceBlock({ metadata: {} })).toBe(false);
    expect([...pageImageReferencePages([reference, spoof])]).toEqual([2]);
    // A reference page that also has real text is not a reference page.
    expect([...pageImageReferencePages([reference, { pageNumber: 2, text: "real", metadata: {} }])]).toEqual([]);
    expect(blankPages(`Intro\f${text}\f${text}`, new Set([2]))).toBe(`Intro\f\f${text}`);
  });
});

it("keeps explicit image preservation in Fast while disabling OCR enrichment",()=>{
  const config={...defaultDocumentExtractionConfig,enrich:["document/media-map","page/ocr-text"],
    order:{pdf:["vm-pdf"]},options:{"vm-pdf":{images:{enabled:true,minWidth:20,minHeight:30}}}};
  const result=documentExtractionForQuality(config,"fast");
  expect(result.config.enrich).toEqual(["document/media-map"]);
  expect(result.config.options["vm-pdf"]).toEqual(config.options["vm-pdf"]);
  expect(result.config.forceOcr).toBe(false);
});

it("accepts bounded VM PDF image options and rejects executable or out-of-range settings",()=>{
  expect(parseExtractorOptions("vm-pdf",{images:{enabled:true}})).toEqual({images:{enabled:true,minWidth:100,minHeight:100}});
  expect(parseExtractorOptions("vm-pdf",{pdf:{extractImages:true}})).toEqual({pdf:{extractImages:true}});
  for(const bad of [{binary:"custom"},{images:{enabled:true,minWidth:0}},{images:{minHeight:4097}},{pdf:{passwords:["secret"]}}]) {
    expect(()=>parseExtractorOptions("vm-pdf",bad)).toThrow();
  }
});
