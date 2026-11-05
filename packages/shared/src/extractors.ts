/** Maximum PDF source size the isolated VM PDF route (`vm-pdf`) accepts. */
export const VM_PDF_MAX_SOURCE_BYTES = 500 * 1024 * 1024;

/** The extractor ids DOCSLURP_PDF_EXTRACTOR accepts. Empty selects the built-in PDF order. */
export const PDF_EXTRACTOR_SETTINGS = ["vm-pdf"] as const;
export type PdfExtractorSetting = (typeof PDF_EXTRACTOR_SETTINGS)[number];

/**
 * DOCSLURP_PDF_EXTRACTOR, trimmed: null for the built-in order, or a known id. Any other value throws, so a typo or a
 * retired value stops the process instead of silently parsing PDFs on the worker host. Worker and API both use this.
 */
export function resolvePdfExtractorSetting(env: Record<string, string | undefined> = process.env): PdfExtractorSetting | null {
  const raw = env.DOCSLURP_PDF_EXTRACTOR?.trim() ?? "";
  if (!raw) return null;
  if ((PDF_EXTRACTOR_SETTINGS as readonly string[]).includes(raw)) return raw as PdfExtractorSetting;
  throw new Error(`DOCSLURP_PDF_EXTRACTOR must be empty or one of: ${PDF_EXTRACTOR_SETTINGS.join(", ")}`);
}

/**
 * True when the deployment uses the sandboxed PDF provider: DOCSLURP_PDF_EXTRACTOR=vm-pdf or
 * DOCSLURP_VM_PDF_INSTALLED=1. Throws on an unknown value of either, for the same reason.
 */
export function sandboxedPdfConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const installed = env.DOCSLURP_VM_PDF_INSTALLED?.trim() ?? "";
  if (!["", "0", "1"].includes(installed)) throw new Error("DOCSLURP_VM_PDF_INSTALLED must be empty, 0 or 1");
  return resolvePdfExtractorSetting(env) === "vm-pdf" || installed === "1";
}

import type { ExtractionImage, ExtractionTable } from "./extraction.js";
import type { UsageEvent } from "./usage.js";

/** JSON-safe metadata. Executable methods and options validators live in the worker. */
export type ExtractorKind = "document" | "converter" | "component" | "page";
export type ExtractorOutputField =
  | "markdown"
  | "text"
  | "html"
  | "pdf"
  | "tables"
  | "formulas"
  | "images"
  | "metadata"
  | "pages"
  | "bbox"
  | "headings"
  | "links";
export type ExtractorCostClass = "local-cpu" | "local-gpu" | "hosted-api" | "agent";

export interface ExtractorDescriptor {
  id: string;
  kind: ExtractorKind;
  label: string;
  description: string;
  /** Each transform is one valid input combination; its accepted inputs are AND requirements. */
  transforms?: Array<{ accepts: string[]; emits: string[]; scope: "document" | "page" | "region" }>;
  capabilities: {
    /** Canonical input format IDs, such as pdf or office-word. */
    formats: string[];
    /** Native fields this implementation can emit, not scored quality claims. */
    produces: ExtractorOutputField[];
    costClass: ExtractorCostClass;
  };
}

export interface NormalizedDocMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  created?: string;
  modified?: string;
  pageCount?: number;
  language?: string;
}

/** The caller owns scratch storage; an artifact path is valid only until that scope ends. */
export interface ExtractorOutput {
  markdown?: string;
  text?: string;
  artifact?: { path: string; format: string };
  metadata?: NormalizedDocMetadata;
  pages?: Array<{ pageNumber: number; markdown: string }>;
  tables?: ExtractionTable[];
  formulas?: Array<{ latex: string; display: boolean; pageNumber?: number }>;
  images?: ExtractionImage[];
  structured?: unknown;
  usage: UsageEvent[];
  diagnostics: { latencyMs: number; warnings: string[]; toolVersion?: string };
}

/** Router output for one document. It has the same method IDs as workspace policy. */
export interface ResolvedExtractionPlan {
  target: string;
  enrich: string[];
  format: string;
  document: string[];
  components: { tables: string[]; formulas: string[]; images: string[] };
  pages: string[];
  voting: { enabled: boolean; secondary: string };
  options: Record<string, unknown>;
  forceOcr: boolean;
  ocr: { language: string; autoRotate: boolean };
}

/** Public catalog data; runtime methods and availability live in the worker. */
export const builtInDocumentExtractorDescriptors: ExtractorDescriptor[] = [
  {
    id: "kreuzberg", kind: "document", label: "Kreuzberg",
    description: "Local document parser with broad format support. Never OCRs: images go to the OCR engine.",

    transforms: [{ accepts: ["source/pdf"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/office-word"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/office-pptx"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/office-excel"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/office-other"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/epub"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/html"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/plain-text"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/markdown"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/structured-csv"], emits: ["document/markdown"], scope: "document" }],
    capabilities: {
      formats: ["pdf", "office-word", "office-pptx", "office-excel", "office-other", "epub", "html", "plain-text", "markdown", "structured-csv"],
      produces: ["markdown"], costClass: "local-cpu",
    },
  },
  {
    id: "pandoc", kind: "document", label: "Pandoc",
    description: "Local document format converter to Markdown.",

    transforms: [{ accepts: ["source/office-word"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/office-other"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/epub"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/html"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/plain-text"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/markdown"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/latex"], emits: ["document/markdown"], scope: "document" }],
    capabilities: {
      formats: ["office-word", "office-other", "epub", "html", "plain-text", "markdown", "latex"],
      produces: ["markdown"], costClass: "local-cpu",
    },
  },
  {
    id: "native-pdf", kind: "document", label: "Native PDF engine",
    description: "In-process PDF engine with per-page Markdown, links, image placements and layout checks; falls back to Kreuzberg.",
    transforms: [{ accepts: ["source/pdf"], emits: ["document/markdown"], scope: "document" }],
    capabilities: { formats: ["pdf"], produces: ["markdown", "pages", "links", "images"], costClass: "local-cpu" },
  },
  {
    id: "liteparse", kind: "document", label: "LiteParse",
    description: "Local PDF parser with page output.",
    transforms: [{ accepts: ["source/pdf"], emits: ["document/markdown"], scope: "document" }],
    capabilities: { formats: ["pdf"], produces: ["markdown", "pages"], costClass: "local-cpu" },
  },
  {
    id: "poppler-text", kind: "document", label: "Poppler text",
    description: "Local PDF text extraction with Poppler.",
    transforms: [{ accepts: ["source/pdf"], emits: ["document/text"], scope: "document" }],
    capabilities: { formats: ["pdf"], produces: ["text"], costClass: "local-cpu" },
  },
  {
    id: "vm-pdf", kind: "document", label: "Isolated VM PDF",
    description: "Layout-aware PDF Markdown and tables from a deployment-provided extractor, one offline VM per document.",
    transforms: [{ accepts: ["source/pdf"], emits: ["document/markdown"], scope: "document" }],
    capabilities: { formats: ["pdf"], produces: ["markdown", "pages"], costClass: "local-cpu" },
  },
  {
    id: "ocr", kind: "document", label: "OCR",
    description: "PP-OCR text from images, every frame of a multi-frame TIFF, read in the deployment's OCR boundary (an isolated VM in production).",
    transforms: [{ accepts: ["source/image"], emits: ["document/markdown"], scope: "document" }],
    capabilities: { formats: ["image"], produces: ["markdown", "pages"], costClass: "local-cpu" },
  },
  {
    id: "graph-local", kind: "document", label: "Local artifact graph",
    description: "Compose local PDF, page and assembly adapters into Markdown.",
    transforms: [{ accepts: ["source/pdf"], emits: ["document/markdown"], scope: "document" }],
    capabilities: { formats: ["pdf"], produces: ["markdown"], costClass: "local-cpu" },
  },
  {
    id: "json", kind: "document", label: "JSON / JSONL",
    description: "In-process JSON and JSON Lines conversion to searchable Markdown tables and key paths.",
    transforms: [{ accepts: ["source/structured-json"], emits: ["document/markdown"], scope: "document" }],
    capabilities: { formats: ["structured-json"], produces: ["markdown"], costClass: "local-cpu" },
  },
  {
    id: "dolphin", kind: "document", label: "Dolphin",
    description: "Local vision parser for PDF pages.",
    transforms: [{ accepts: ["source/pdf"], emits: ["document/markdown"], scope: "document" }],
    capabilities: { formats: ["pdf"], produces: ["markdown"], costClass: "local-gpu" },
  },
];

/** Source coordinates are preserved, never silently treated as another space. */
export interface ArtifactPlacement {
  pageNumber: number;
  bbox?: [number, number, number, number];
  coordinateSpace?: "pdf-points" | "pixels" | "normalized";
  fidelity: "exact" | "approximate" | "page-only";
}

/** One immutable intermediate artifact in a document's extraction graph. */
export interface ExtractionArtifactRef {
  id: string;
  kind: string;
  uri: string;
  mediaType: string;
  sha256: string;
  sourceDocumentId: string;
  derivedFrom: string[];
  placements: ArtifactPlacement[];
  /** Producer ID, options digest and tool version make the artifact reproducible. */
  producer: { id: string; optionsDigest: string; toolVersion?: string };
}

/**
 * The extractor catalog as shown publicly. Optional-engine extractors are
 * hidden unless the deployment reports the engine as installed
 * (`DOCSLURP_NATIVE_PDF_INSTALLED=1`, or a configured module / vendored package).
 */
export function publicDocumentExtractorDescriptors(options: { nativePdfInstalled: boolean; vmPdfInstalled?: boolean }): ExtractorDescriptor[] {
  return builtInDocumentExtractorDescriptors.filter(
    (entry) => (entry.id !== "native-pdf" || options.nativePdfInstalled) && (entry.id !== "vm-pdf" || options.vmPdfInstalled === true),
  );
}

/** The only PDF extractor a sandboxed deployment runs. */
export const SANDBOXED_PDF_EXTRACTOR_ID = "vm-pdf";

/**
 * Under a sandboxed PDF deployment (sandboxedPdfConfigured), every extractor a workspace's documentExtraction names for
 * PDFs must be the sandboxed one: anything else would parse customer PDFs on the worker host. Returns each offending
 * place (`order.pdf.0`, `pages.1`, `enrich.0`, `voting.secondary`) with its id; empty when the deployment is not sandboxed
 * or the config names none. `pages` and `enrich` are not per format, so they are held to the same rule. Ids are compared
 * as given: callers normalize configured aliases first.
 */
export function hostPdfExtractorsUnderSandbox(
  config: unknown,
  env: Record<string, string | undefined> = process.env,
): Array<{ path: Array<string | number>; id: string }> {
  if (!sandboxedPdfConfigured(env) || typeof config !== "object" || config === null) return [];
  const value = config as { order?: unknown; pages?: unknown; enrich?: unknown; voting?: unknown };
  const found: Array<{ path: Array<string | number>; id: string }> = [];
  const list = (path: Array<string | number>, ids: unknown) => {
    if (!Array.isArray(ids)) return;
    ids.forEach((id, index) => {
      if (id !== SANDBOXED_PDF_EXTRACTOR_ID) found.push({ path: [...path, index], id: String(id) });
    });
  };
  if (typeof value.order === "object" && value.order !== null) list(["order", "pdf"], (value.order as Record<string, unknown>).pdf);
  list(["pages"], value.pages);
  list(["enrich"], value.enrich);
  const secondary = typeof value.voting === "object" && value.voting !== null ? (value.voting as { secondary?: unknown }).secondary : undefined;
  if (secondary !== undefined && secondary !== "next-in-order" && secondary !== SANDBOXED_PDF_EXTRACTOR_ID) {
    found.push({ path: ["voting", "secondary"], id: String(secondary) });
  }
  return found;
}
