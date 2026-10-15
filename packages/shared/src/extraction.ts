import { z } from "zod";
import { layoutRegionSchema } from "./layout.js";

export const extractionAdapterSchema = z.enum([
  "auto",
  "kreuzberg",
  "dolphin",
]);
export type ExtractionAdapter = z.infer<typeof extractionAdapterSchema>;

export const extractionOutputFormatSchema = z.enum([
  "plain",
  "markdown",
  "djot",
  "html",
]);
export type ExtractionOutputFormat = z.infer<
  typeof extractionOutputFormatSchema
>;

export const extractionResultFormatSchema = z.enum([
  "unified",
  "element_based",
]);
export type ExtractionResultFormat = z.infer<
  typeof extractionResultFormatSchema
>;

export const extractionOcrBackendSchema = z.enum([
  "tesseract",
  "paddleocr",
  "easyocr",
]);
export type ExtractionOcrBackend = z.infer<typeof extractionOcrBackendSchema>;

export const extractionOcrModelTierSchema = z.enum(["mobile", "server"]);
export type ExtractionOcrModelTier = z.infer<
  typeof extractionOcrModelTierSchema
>;

export const extractionTokenReductionStrategySchema = z.enum([
  "whitespace",
  "stemming",
]);
export type ExtractionTokenReductionStrategy = z.infer<
  typeof extractionTokenReductionStrategySchema
>;

export const dolphinModeSchema = z.enum(["page", "layout"]);
export type DolphinMode = z.infer<typeof dolphinModeSchema>;

export const dolphinModelFlavorSchema = z.enum([
  "Dolphin-0.3B",
  "Dolphin-1.5",
  "Dolphin-v2",
]);
export type DolphinModelFlavor = z.infer<typeof dolphinModelFlavorSchema>;

export const extractionOcrConfigSchema = z.object({
  backend: extractionOcrBackendSchema.default("tesseract"),
  language: z.string().trim().min(2).max(16).default("eng"),
  autoRotate: z.boolean().default(true),
  modelTier: extractionOcrModelTierSchema.default("mobile"),
  padding: z.number().int().min(0).max(100).default(10),
});
export type ExtractionOcrConfig = z.infer<typeof extractionOcrConfigSchema>;

export const extractionImageConfigSchema = z.object({
  enabled: z.boolean().default(false),
  minWidth: z.number().int().min(1).max(4096).default(100),
  minHeight: z.number().int().min(1).max(4096).default(100),
});
export type ExtractionImageConfig = z.infer<
  typeof extractionImageConfigSchema
>;

export const extractionPdfOptionsSchema = z.object({
  extractMetadata: z.boolean().default(true),
  extractImages: z.boolean().default(false),
  allowSingleColumnTables: z.boolean().default(false),
  passwords: z.array(z.string().min(1)).max(8).default([]),
});
export type ExtractionPdfOptions = z.infer<typeof extractionPdfOptionsSchema>;

export const extractionTokenReductionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  strategy: extractionTokenReductionStrategySchema.default("whitespace"),
});
export type ExtractionTokenReductionConfig = z.infer<
  typeof extractionTokenReductionConfigSchema
>;

export const extractionLanguageDetectionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  confidenceThreshold: z.number().min(0).max(1).default(0.5),
});
export type ExtractionLanguageDetectionConfig = z.infer<
  typeof extractionLanguageDetectionConfigSchema
>;

export const extractionPostProcessorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  processors: z.array(z.string().min(1)).max(16).default([]),
});
export type ExtractionPostProcessorConfig = z.infer<
  typeof extractionPostProcessorConfigSchema
>;

export const extractionJsonOptionsSchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .default(null);

export const dolphinAdapterConfigSchema = z.object({
  mode: dolphinModeSchema.default("page"),
  modelFlavor: dolphinModelFlavorSchema.default("Dolphin-v2"),
  maxBatchSize: z.number().int().min(1).max(32).default(8),
  repoPath: z.string().trim().min(1).nullable().default(null),
  modelPath: z.string().trim().min(1).nullable().default(null),
  preferGpu: z.boolean().default(true),
});
export type DolphinAdapterConfig = z.infer<typeof dolphinAdapterConfigSchema>;

/** A workspace policy. The document router can emit the same ordered IDs per document. */
export const documentExtractionConfigSchema = z.object({
  target: z.string().min(1).default("document/markdown"),
  enrich: z.array(z.string().min(1)).default([]),
  order: z.record(z.string(), z.array(z.string().min(1)).min(1)).default({}),
  components: z.object({
    tables: z.array(z.string().min(1)).default([]),
    formulas: z.array(z.string().min(1)).default([]),
    images: z.array(z.string().min(1)).default([]),
  }).default({ tables: [], formulas: [], images: [] }),
  pages: z.array(z.string().min(1)).default([]),
  voting: z.object({
    enabled: z.boolean().default(false),
    secondary: z.string().min(1).default("next-in-order"),
  }).default({ enabled: false, secondary: "next-in-order" }),
  options: z.record(z.string(), z.unknown()).default({}),
  forceOcr: z.boolean().default(false),
  ocr: z.object({
    language: z.string().trim().min(2).max(16).default("eng"),
    autoRotate: z.boolean().default(true),
  }).default({ language: "eng", autoRotate: true }),
});
export type DocumentExtractionConfig = z.infer<typeof documentExtractionConfigSchema>;

export const defaultDocumentExtractionConfig: DocumentExtractionConfig = {
  target: "document/markdown",
  enrich: [],
  order: {},
  components: { tables: [], formulas: [], images: [] },
  pages: [],
  voting: { enabled: false, secondary: "next-in-order" },
  options: {},
  forceOcr: false,
  ocr: { language: "eng", autoRotate: true },
};

export const extractionImageSchema = z.object({
  id: z.string(),
  path: z.string(), // relative to markdown
  description: z.string().nullable().default(null),
  pageNumber: z.number().int().positive(),
  bbox: layoutRegionSchema.nullable().default(null),
});
export type ExtractionImage = z.infer<typeof extractionImageSchema>;

export const extractionChartSchema = z.object({
  id: z.string(),
  path: z.string(),
  description: z.string().nullable().default(null),
  data: z.record(z.string(), z.unknown()).nullable().default(null),
  pageNumber: z.number().int().positive(),
  bbox: layoutRegionSchema.nullable().default(null),
});
export type ExtractionChart = z.infer<typeof extractionChartSchema>;

export const extractionTableSchema = z.object({
  id: z.string(),
  markdown: z.string(),
  rowCount: z.number().int().nonnegative(),
  colCount: z.number().int().nonnegative(),
  pageNumber: z.number().int().positive(),
  bbox: layoutRegionSchema.nullable().default(null),
});
export type ExtractionTable = z.infer<typeof extractionTableSchema>;

export const extractionHeaderSchema = z.object({
  level: z.number().int().min(1).max(6),
  text: z.string(),
  pageNumber: z.number().int().positive().nullable().default(null),
});
export type ExtractionHeader = z.infer<typeof extractionHeaderSchema>;

export const extractionLinkSchema = z.object({
  text: z.string(),
  url: z.string(),
  pageNumber: z.number().int().positive().nullable().default(null),
});
export type ExtractionLink = z.infer<typeof extractionLinkSchema>;

export const extractionContractSchema = z.object({
  documentId: z.string(),
  // Main content
  markdown: z.string(),
  rawText: z.string(),

  // Rich artifacts
  images: z.array(extractionImageSchema).default([]),
  charts: z.array(extractionChartSchema).default([]),
  tables: z.array(extractionTableSchema).default([]),

  // Structure
  headers: z.array(extractionHeaderSchema).default([]),
  links: z.array(extractionLinkSchema).default([]),

  // Features presence
  hasToC: z.boolean().default(false),
  hasLaTeX: z.boolean().default(false),
  hasCode: z.boolean().default(false),
  hasQRCodes: z.boolean().default(false),

  // Metadata & Metrics
  metadata: z.object({
    tokenCount: z.number().int().nonnegative(),
    chunkCount: z.number().int().nonnegative(),
    ocrStats: z
      .object({
        method: z.string(),
        confidence: z.number().min(0).max(1),
        pageCount: z.number().int().nonnegative(),
      })
      .nullable()
      .default(null),
    extractionTimeMs: z.number().nonnegative(),
    extractor: z.string(),
    strategy: z.string(),
    plausibilityScore: z.number().min(0).max(1),
    plausibilitySignals: z.object({
      charYield: z.number().min(0).max(1),
      averageWordLengthPlausibility: z.number().min(0).max(1),
      whitespacePlausibility: z.number().min(0).max(1),
      charCount: z.number().int().nonnegative(),
      wordCount: z.number().int().nonnegative(),
    }),
  }),
});
export type ExtractionContract = z.infer<typeof extractionContractSchema>;
