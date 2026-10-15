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
    description: "Local document parser with broad format support.",

    transforms: [{ accepts: ["source/pdf"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/office-word"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/office-pptx"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/office-excel"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/office-other"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/epub"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/html"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/image"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/plain-text"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/markdown"], emits: ["document/markdown"], scope: "document" }, { accepts: ["source/structured-csv"], emits: ["document/markdown"], scope: "document" }],
    capabilities: {
      formats: ["pdf", "office-word", "office-pptx", "office-excel", "office-other", "epub", "html", "image", "plain-text", "markdown", "structured-csv"],
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
    id: "docling", kind: "document", label: "Docling",
    description: "Local PDF document converter.",
    transforms: [{ accepts: ["source/pdf"], emits: ["document/markdown"], scope: "document" }],
    capabilities: { formats: ["pdf"], produces: ["markdown"], costClass: "local-cpu" },
  },
  {
    id: "poppler-text", kind: "document", label: "Poppler text",
    description: "Local PDF text extraction with Poppler.",
    transforms: [{ accepts: ["source/pdf"], emits: ["document/text"], scope: "document" }],
    capabilities: { formats: ["pdf"], produces: ["text"], costClass: "local-cpu" },
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
export function publicDocumentExtractorDescriptors(options: { nativePdfInstalled: boolean }): ExtractorDescriptor[] {
  return builtInDocumentExtractorDescriptors.filter(
    (entry) => entry.id !== "native-pdf" || options.nativePdfInstalled,
  );
}
