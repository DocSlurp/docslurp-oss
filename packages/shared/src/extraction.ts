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

/**
 * An OCR language list as Tesseract names it (`eng`, `chi_sim`, `chi_sim_vert`, `eng+deu`): a three-letter code with
 * up to two `_suffix` parts, joined by `+`. No paths, flags or other characters.
 */
export const ocrLanguageSchema = z.string().trim()
  .regex(/^[a-z]{3}(_[a-z]{2,5}){0,2}(\+[a-z]{3}(_[a-z]{2,5}){0,2})*$/, "OCR language must be Tesseract codes such as eng, chi_sim_vert or eng+deu")
  .max(64);

/**
 * Dolphin options a workspace may set. The repository and model paths, and the Python binary, come only from the
 * worker environment (DOLPHIN_REPO_PATH, DOLPHIN_MODEL_PATH, DOLPHIN_PYTHON_BIN): a path from a workspace would
 * let it choose which script the worker runs.
 */
export const dolphinExtractorOptionsSchema = z.object({
  mode: dolphinModeSchema.optional(),
  maxBatchSize: z.number().int().min(1).max(32).optional(),
}).strict();
export type DolphinExtractorOptions = z.infer<typeof dolphinExtractorOptionsSchema>;

/**
 * Kreuzberg options a workspace may set. The worker spreads them into Kreuzberg's extractFile config, so only these
 * keys are accepted: anything else (structured extraction, a VLM OCR config with its own base URL, cache
 * namespaces) would let a workspace make the parser call out or share caches. Unknown keys are rejected.
 *
 * `disableOcr` is a marker for the worker, not a Kreuzberg switch: @kreuzberg/node 4.10.2 drops it (and
 * `ocr.enabled`) in normalizeExtractionConfig and OCRs every image regardless, so the extractor registry refuses
 * image inputs to Kreuzberg when it is set (Fast sets it).
 */
export const kreuzbergExtractorOptionsSchema = z.object({
  outputFormat: z.literal("markdown").optional(),
  forceOcr: z.boolean().optional(),
  forceOcrPages: z.array(z.number().int().positive()).max(5_000).optional(),
  disableOcr: z.boolean().optional(),
  ocr: z.object({
    backend: extractionOcrBackendSchema.optional(),
    language: ocrLanguageSchema.optional(),
  }).strict().optional(),
}).strict();
export type KreuzbergExtractorOptions = z.infer<typeof kreuzbergExtractorOptionsSchema>;

/**
 * Option schemas by extractor id. Only these extractors take options; every other id, and every key a schema does
 * not name, is rejected. The worker re-parses each id before handing options to a script (parseExtractorOptions).
 */
export const extractorOptionSchemas = {
  kreuzberg: kreuzbergExtractorOptionsSchema,
  dolphin: dolphinExtractorOptionsSchema,
} as const;

/** Extractor options by extractor id (extractorOptionSchemas); unknown ids and keys are rejected. */
export const documentExtractorOptionsSchema = z
  .object({ kreuzberg: kreuzbergExtractorOptionsSchema.optional(), dolphin: dolphinExtractorOptionsSchema.optional() })
  .strict();

/**
 * One extractor's options, validated against its own schema. Throws for an id without an option schema and for any
 * key the schema does not allow, so a stored or hand-built config can never pass unchecked options to a script.
 */
export function parseExtractorOptions(id: string, value: unknown): Record<string, unknown> {
  const schema = (extractorOptionSchemas as Record<string, z.ZodType<Record<string, unknown>>>)[id];
  if (!schema || !Object.hasOwn(extractorOptionSchemas, id)) throw new Error(`extractor ${id} takes no options`);
  return schema.parse(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deletes what a failed parse reports (unknown keys, invalid leaves) until `value` parses; false if it never does. */
function dropInvalid(schema: z.ZodTypeAny, value: Record<string, unknown>, prefix: string, dropped: string[]): boolean {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return true;
    for (const issue of parsed.error.issues as Array<{ code: string; path: PropertyKey[]; keys?: string[] }>) {
      let node: unknown = value;
      const parents = issue.code === "unrecognized_keys" ? issue.path : issue.path.slice(0, -1);
      for (const segment of parents) node = isPlainObject(node) ? node[segment as string] : undefined;
      if (!isPlainObject(node)) continue;
      const keys = issue.code === "unrecognized_keys" ? (issue.keys ?? []) : issue.path.length ? [String(issue.path.at(-1))] : [];
      if (keys.length === 0) return false;
      for (const key of keys) {
        if (!Object.hasOwn(node, key)) continue;
        delete node[key];
        dropped.push([prefix, ...parents.map(String), key].join("."));
      }
    }
  }
  return schema.safeParse(value).success;
}

/**
 * Reads the `documentExtraction` of a stored pipeline (a workspace row, a run row) that predates the strict extractor
 * option schemas: drops options for extractor ids without a schema, keys a schema does not allow, invalid option
 * values and an invalid `ocr.language`, and lists every dropped path. Nothing dropped is kept, so a stored
 * `dolphin.repoPath` never reaches a script. Requests stay strict (`documentExtractionConfigSchema` rejects all of
 * these); only reads of stored settings use this, so one stale row cannot fail an org's workspace list or a run load.
 */
export function sanitizeStoredDocumentExtraction(value: unknown): { value: unknown; dropped: string[] } {
  if (!isPlainObject(value)) return { value, dropped: [] };
  const next: Record<string, unknown> = structuredClone(value);
  const dropped: string[] = [];
  if (isPlainObject(next.ocr) && next.ocr.language !== undefined && !ocrLanguageSchema.safeParse(next.ocr.language).success) {
    delete next.ocr.language;
    dropped.push("documentExtraction.ocr.language");
  }
  if (next.options !== undefined && next.options !== null && !isPlainObject(next.options)) {
    delete next.options;
    dropped.push("documentExtraction.options");
  } else if (isPlainObject(next.options)) {
    const options = next.options;
    for (const id of Object.keys(options)) {
      const schema = Object.hasOwn(extractorOptionSchemas, id)
        ? (extractorOptionSchemas as Record<string, z.ZodTypeAny>)[id]
        : undefined;
      const prefix = `documentExtraction.options.${id}`;
      if (options[id] === undefined) continue;
      if (!schema || !isPlainObject(options[id]) || !dropInvalid(schema, options[id] as Record<string, unknown>, prefix, dropped)) {
        delete options[id];
        dropped.push(prefix);
      }
    }
  }
  return { value: next, dropped };
}

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
  options: documentExtractorOptionsSchema.default({}),
  forceOcr: z.boolean().default(false),
  ocr: z.object({
    language: ocrLanguageSchema.default("eng"),
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
