import { sandboxedPdfProvider, VM_PDF_EXTRACTOR_ID } from "./plugins.js";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import { builtInDocumentExtractorDescriptors, canonicalExtractorId, configureExtractorIdAliases, parseExtractorOptions, PDF_EXTRACTION_UNCONFIGURED, resolvePdfMode, RETIRED_EXTRACTOR_IDS, type ExtractorDescriptor } from "@docslurp/shared";
import type { CommandPlan, CommandRunner } from "../tools/runner.js";
import { planArtifactGraph, type GraphAdapter } from "./graph.js";
import { availableLocalArtifactAdapters } from "./local-artifact-adapters.js";
import { extractStructuredJsonFile } from "./structured-json.js";
import { resolveNativePdfEngine } from "../native-pdf/engine.js";
import { extractNativePdf } from "../native-pdf/extract.js";
import { nativePdfAdapterVersion } from "../native-pdf/loader.js";
import { nativePdfEmphasisEnabled } from "../native-pdf/mode.js";
import { NativePdfError, logNativePdfFallback } from "../native-pdf/types.js";
import { resolveOcrMode } from "../ocr/mode.js";

export interface ExtractedCandidate {
  label: string;
  plan: CommandPlan;
  textKey: string;
  textUri: string;
  tempTextPath: string;
  /**
   * Pages whose text this extractor OCR'd itself and reports (the graph extractor's OCR adapter). The OCR engine charges
   * its own reads (ocr/ledger.ts); the stage only records the reads an extractor reports without having charged them.
   */
  ocrPages?: number[];
  /** The extractor already charged its OCR reads through the ledger (the OCR engine does); the stage must not again. */
  ocrCharged?: boolean;
}

export interface CandidateExecutors {
  stream(plan: CommandPlan, label: string, textKey: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
  file(plan: CommandPlan, label: string, textKey: string, outputPath: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
  graph?(candidate: PreparedExtractor, textKey: string, sourcePath: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
  /** Publish Markdown an in-process extractor already wrote to `outputPath`. */
  markdownFile?(candidate: PreparedExtractor, textKey: string, outputPath: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
  /** OCR an image (every frame) in the configured OCR boundary and publish its Markdown (ocr/read-document.ts). */
  ocr?(candidate: PreparedExtractor, textKey: string, sourcePath: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
}

export interface PreparedExtractor {
  label: string;
  plan: CommandPlan;
  outputPath?: string;
  tableAware: boolean;
  /** Runner the extractor was prepared with, for in-process extractors that fall back to its tools. */
  runner?: CommandRunner;
  execute(executors: CandidateExecutors, textKey: string, sourcePath: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
}

/** What the planner knows about the document beyond its path. */
export interface PrepareContext {
  /** Canonical input format ID, such as pdf or image. */
  format?: string;
  /** Environment used for capability probes; defaults to the worker's. */
  env?: NodeJS.ProcessEnv;
  /** The bytes' sniffed MIME type (quarantine's file facts); extractors that detect formats get it explicitly. */
  mimeType?: string | null;
}

type Preparation = (runner: CommandRunner, sourcePath: string, configJson?: string, context?: PrepareContext) => Promise<CommandPlan>;
type Execution = (candidate: PreparedExtractor, executors: CandidateExecutors, textKey: string, sourcePath: string, signal?: AbortSignal) => Promise<ExtractedCandidate>;

interface WorkerExtractor {
  descriptor: ExtractorDescriptor;
  prepare: Preparation;
  execute: Execution;
  outputSuffix?: string;
  tableAware?: boolean;
}

const stream: Execution = (candidate, executors, key, _source, signal) =>
  executors.stream(candidate.plan, candidate.label, key, signal);
const file: Execution = (candidate, executors, key, _source, signal) =>
  executors.file(candidate.plan, candidate.label, key, candidate.outputPath!, signal);
const ocr: Execution = (candidate, executors, key, source, signal) => {
  if (!executors.ocr) throw new Error("ocr extraction requires an ocr candidate executor");
  return executors.ocr(candidate, key, source, signal);
};
const graph: Execution = (candidate, executors, key, source, signal) => {
  if (!executors.graph) throw new Error("graph-local execution requires a graph candidate executor");
  return executors.graph(candidate, key, source, signal);
};

/** In-process extractors write Markdown themselves; no external binary runs. */
const inProcessPlan = (id: string): CommandPlan => ({ binary: `in-process:${id}`, args: [], available: true });
const structuredJson: Execution = async (candidate, executors, key, source, signal) => {
  if (!executors.markdownFile) throw new Error("json extraction requires a markdownFile candidate executor");
  await extractStructuredJsonFile(source, candidate.outputPath!, {}, signal);
  return executors.markdownFile(candidate, key, candidate.outputPath!, signal);
};

/**
 * Per-page Markdown from the in-process native PDF engine. Every failure (locked or unsupported encryption,
 * resource limits, missing engine, rejected output, engine errors) rejects with a NativePdfError, logged once by
 * kind, and the stage's retry strategies move on to the next extractor in order (poppler-text by default). A locked
 * PDF therefore takes the same path it takes without native-pdf.
 */
const nativePdf: Execution = async (candidate, executors, key, source, signal) => {
  if (!executors.markdownFile) throw new Error("native-pdf extraction requires a markdownFile candidate executor");
  const engine = await resolveNativePdfEngine(candidate.runner!);
  if (!engine) throw new NativePdfError("NATIVE_PDF_UNAVAILABLE", "native-pdf engine is not installed");
  let result: Awaited<ReturnType<typeof extractNativePdf>>;
  try {
    result = await extractNativePdf(engine, source, { signal, emphasis: nativePdfEmphasisEnabled() });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw logNativePdfFallback("extract", error);
  }
  await writeFile(candidate.outputPath!, result.markdown, "utf8");
  console.error(
    `[native-pdf] extracted adapter=${nativePdfAdapterVersion(engine)} engine=${engine.id} pages=${result.pageCount} ` +
      `ms=${Math.round(result.totalMs)} warnings=${result.warnings.join(",") || "none"}`,
  );
  return executors.markdownFile(candidate, key, candidate.outputPath!, signal);
};

function definition(args: {
  id: string;
  prepare: Preparation;
  execute: Execution;
  outputSuffix?: string;
  tableAware?: boolean;
}): WorkerExtractor {
  const descriptor = builtInDocumentExtractorDescriptors.find((entry) => entry.id === args.id);
  if (!descriptor) throw new Error(`missing shared descriptor for extractor ${args.id}`);
  return {
    descriptor,
    prepare: args.prepare,
    execute: args.execute,
    outputSuffix: args.outputSuffix,
    tableAware: args.tableAware,
  };
}

const registered = [
  // Served by the sandboxed PDF provider plugin; without one, preparing it refuses (no host fallback).
  definition({ id: VM_PDF_EXTRACTOR_ID, outputSuffix: ".vm-pdf.md", tableAware: true, execute: file,
    prepare: (runner, source) => runner.sandboxedPdfMarkdown(source, `${source}.vm-pdf.md`) }),
  // Office Open XML through the sandboxed python-pptx / openpyxl sidecar (scripts/office_markdown.py). Legacy binary
  // .ppt and .xls have no reader here: they plan as unavailable and the document fails with no extractor output.
  definition({ id: "pptx", outputSuffix: ".pptx.md", tableAware: true, execute: file,
    prepare: async (runner, source, _config, context) => officeOpenXml(await runner.officeMarkdown("pptx", source, `${source}.pptx.md`), source, context) }),
  definition({ id: "xlsx", outputSuffix: ".xlsx.md", tableAware: true, execute: file,
    prepare: async (runner, source, _config, context) => officeOpenXml(await runner.officeMarkdown("xlsx", source, `${source}.xlsx.md`), source, context) }),
  // Images, every frame of a multi-frame TIFF: read in the configured OCR boundary (DOCSLURP_OCR_MODE). Unavailable
  // when OCR is off; a refused or failed read fails the document, never falling back to another reader.
  definition({ id: "ocr", execute: ocr,
    prepare: async (_runner, _source, _config, context) => ({
      ...inProcessPlan("ocr"),
      available: resolveOcrMode(context?.env ?? process.env) !== "off",
    }) }),
  definition({ id: "native-pdf", outputSuffix: ".native-pdf.md", tableAware: true, execute: nativePdf,
    prepare: async (runner) => {
      const engine = await resolveNativePdfEngine(runner);
      return { ...inProcessPlan("native-pdf"), available: engine !== null };
    } }),
  // Word .docx: Pandoc plus the source context body extraction omits (headers, footers, comments; office_markdown.py).
  // Every other format: Pandoc with the reader the sniffed format names, never one the file name picks.
  definition({ id: "pandoc", outputSuffix: ".pandoc.md", tableAware: true,
    execute: (candidate, executors, key, source, signal) => candidate.plan.args.some((arg) => path.basename(arg) === "office_markdown.py")
      ? file(candidate, executors, key, source, signal)
      : stream(candidate, executors, key, source, signal),
    prepare: async (runner, source, _config, context) => {
      const reader = pandocReader(source, context);
      if (reader === "docx") return await runner.officeMarkdown("docx", source, `${source}.pandoc.md`);
      return await runner.extractMarkdown(source, reader);
    } }),
  // Doppler's PDF Markdown on the worker host (a separate executable in the parser sandbox): customer-owned local mode only
  // (DOCSLURP_PDF_MODE=local; prepare refuses every host PDF extractor elsewhere). A missing converter is an error, never a
  // quiet step down to another host parser.
  definition({ id: "doppler-md", tableAware: true, execute: stream,
    prepare: async (runner, source) => {
      const plan = await runner.dopplerMarkdown(source);
      // Startup refuses local mode without the converter; one missing now is an error the ingest report shows as a fallback.
      if (!plan.available) console.error(`[extractors] doppler-md unavailable: pdftomarkdown is not installed at ${plan.binary}`);
      return plan;
    } }),
  definition({ id: "poppler-text", execute: stream,
    prepare: (runner, source) => runner.extractText(source, true) }),
  definition({ id: "graph-local", execute: graph,
    prepare: async (_runner, source) => {
      const adapters = await availableLocalArtifactAdapters({ outputDir: path.dirname(source) });
      const route = planArtifactGraph({
        initial: ["source/pdf"], target: ["document/markdown"], adapters,
      });
      return {
        binary: "local-artifact-graph",
        args: route.ok ? route.steps.map((step) => step.id) : [],
        available: route.ok,
      };
    } }),
  definition({ id: "json", outputSuffix: ".json.md", tableAware: true, execute: structuredJson,
    prepare: async () => inProcessPlan("json") }),
  definition({ id: "dolphin", outputSuffix: ".dolphin.md", execute: file,
    prepare: (runner, source, config) => runner.dolphinMarkdown(source, `${source}.dolphin.md`, config) }),
];

/**
 * Default order per format. PDFs are Doppler's, and where they run is the PDF mode (resolvePdfMode): `vm-pdf` alone in a
 * VM deployment; in customer-owned local mode `doppler-md`, then the in-process native engine (when installed) and Poppler
 * text only when Doppler failed on the file, a fallback the ingest report shows per file; refused with neither (resolve),
 * so no host parser runs. No extractor here links an OCR engine: images go to the `ocr` extractor, in the OCR boundary.
 */
export const defaultDocumentExtractorOrder: Record<string, string[]> = {
  pdf: ["doppler-md", "native-pdf", "poppler-text"],
  image: ["ocr"],
  "structured-json": ["json"],
  "office-pptx": ["pptx"],
  "office-excel": ["xlsx"],
  default: ["pandoc"],
};

export interface RegisteredGraphAdapter extends GraphAdapter {
  extractorId: string;
}

export class ExtractorRegistry {
  private readonly entries = new Map<string, WorkerExtractor>();

  constructor(extractors: WorkerExtractor[] = registered) {
    for (const extractor of extractors) {
      if (this.entries.has(extractor.descriptor.id)) throw new Error(`duplicate extractor: ${extractor.descriptor.id}`);
      const transforms = extractor.descriptor.transforms ?? [];
      if (transforms.length === 0) throw new Error(`extractor ${extractor.descriptor.id} has no graph transforms`);
      for (const format of extractor.descriptor.capabilities.formats) {
        if (!transforms.some((edge) => edge.accepts.includes(`source/${format}`))) {
          throw new Error(`extractor ${extractor.descriptor.id} lacks a source/${format} transform`);
        }
      }
      this.entries.set(extractor.descriptor.id, extractor);
    }
  }

  list(): ExtractorDescriptor[] {
    return [...this.entries.values()].map((entry) => entry.descriptor);
  }

  graphAdapters(): RegisteredGraphAdapter[] {
    return [...this.entries.values()].flatMap((entry) =>
      (entry.descriptor.transforms ?? []).map((edge, index) => ({
        id: `${entry.descriptor.id}#${index}`,
        extractorId: entry.descriptor.id,
        accepts: edge.accepts,
        emits: edge.emits,
      })),
    );
  }

  resolve(format: string, configured?: string[]): string[] {
    const base = defaultDocumentExtractorOrder[format] ?? defaultDocumentExtractorOrder.default;
    // PDFs: a VM deployment (DOCSLURP_PDF_MODE=vm, DOCSLURP_PDF_EXTRACTOR=vm-pdf, DOCSLURP_VM_PDF_INSTALLED=1 or
    // DOCSLURP_SERVICE_PROFILE=service) runs them only in vm-pdf; with neither a VM nor local mode they are refused here,
    // whatever a workspace names, so no host parser runs.
    const pdfMode = format === "pdf" ? resolvePdfMode() : null;
    if (pdfMode === "off") throw new Error(PDF_EXTRACTION_UNCONFIGURED);
    const sandboxedPdf = pdfMode === "vm";
    const defaults = sandboxedPdf ? [VM_PDF_EXTRACTOR_ID] : base;
    // A configured legacy id (DOCSLURP_EXTRACTOR_ID_ALIASES) resolves to its canonical extractor; a retired id
    // (RETIRED_EXTRACTOR_IDS) is dropped, and an order it emptied uses the defaults. Unknown ids still throw.
    const kept = configured?.filter((id) => !RETIRED_EXTRACTOR_IDS.has(id)).map(canonicalExtractorId);
    if (configured && kept && kept.length < configured.length) {
      console.warn(`[extractors] ${format} extractor order names a retired extractor; dropped it order=${configured.join(",")}`);
    }
    // Only an order emptied by retired ids takes the defaults; an explicitly empty order still fails closed below.
    const emptiedByRetired = configured !== undefined && configured.length > 0 && kept!.length === 0;
    const ids = kept && !emptiedByRetired ? kept : defaults.filter((id) =>
      this.entries.get(id)?.descriptor.capabilities.formats.includes(format),
    );
    // Fail closed: a workspace order naming a host parser under a sandboxed deployment is refused, never run.
    const hostIds = sandboxedPdf ? ids.filter((id) => id !== VM_PDF_EXTRACTOR_ID) : [];
    if (hostIds.length > 0) {
      throw new Error(`extractor ${hostIds.join(", ")} refused for pdf: this deployment runs PDFs only in ${VM_PDF_EXTRACTOR_ID}`);
    }
    if (ids.length === 0) throw new Error(`no extractor configured for ${format}`);
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`unknown extractor ${id}; registered: ${[...this.entries.keys()].join(", ")}`);
      if (!entry.descriptor.capabilities.formats.includes(format)) {
        throw new Error(`extractor ${id} does not support ${format}`);
      }
    }
    return [...new Set(ids)];
  }

  async prepare(requested: string, runner: CommandRunner, sourcePath: string, configJson?: string, context?: PrepareContext): Promise<PreparedExtractor> {
    const id = canonicalExtractorId(requested);
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown extractor ${id}; registered: ${[...this.entries.keys()].join(", ")}`);
    // Host PDF parsers run only in customer-owned local mode, however they were reached (an order, a voting secondary).
    if (context?.format === "pdf" && id !== VM_PDF_EXTRACTOR_ID) {
      const mode = resolvePdfMode(context.env ?? process.env);
      if (mode !== "local") {
        console.error(`[extractors] ${id} refused for pdf: pdf mode is ${mode}; host PDF parsing needs DOCSLURP_PDF_MODE=local`);
        throw new Error(mode === "off" ? PDF_EXTRACTION_UNCONFIGURED : `extractor ${id} refused for pdf: this deployment runs PDFs only in ${VM_PDF_EXTRACTOR_ID}`);
      }
    }
    const plan = await entry.prepare(runner, sourcePath, configJson, context);
    const candidate: PreparedExtractor = {
      label: id,
      plan,
      outputPath: entry.outputSuffix ? `${sourcePath}${entry.outputSuffix}` : undefined,
      tableAware: entry.tableAware ?? false,
      runner,
      execute: (executors, key, source, signal) => entry.execute(candidate, executors, key, source, signal),
    };
    return candidate;
  }
}

/**
 * One extractor's options as the JSON its script receives. Every extractor's options are re-parsed through their
 * shared strict schema (parseExtractorOptions) even when the pipeline already was, so no other id or key reaches a
 * script: Dolphin's paths come only from the worker environment.
 */
export function serializeExtractorOptions(options: Record<string, unknown>, id: string): string | undefined {
  // Every id is re-parsed against its own strict schema; an id without one, or an unknown key, throws (fail closed).
  for (const [other, value] of Object.entries(options)) if (value !== undefined) parseExtractorOptions(other, value);
  const value = Object.hasOwn(options, id) ? options[id] : undefined;
  if (value === undefined) return undefined;
  return JSON.stringify(parseExtractorOptions(id, value));
}

/** Pandoc's reader for a source: the sniffed format first, the extension only within it. Null: Pandoc cannot read it. */
export function pandocReader(source: string, context?: PrepareContext): string | null | undefined {
  const extension = path.extname(source).toLowerCase();
  switch (context?.format) {
    case "office-word": return "docx";
    case "office-other": return extension === ".odt" ? "odt" : extension === ".rtf" ? "rtf" : null;
    case "epub": return "epub";
    case "html": return "html";
    case "markdown":
    case "plain-text": return "markdown";
    case "structured-csv": return extension === ".tsv" ? "tsv" : "csv";
    case "latex": return "latex";
    default: return undefined;
  }
}

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const OFFICE_FORMATS = new Set(["office-word", "office-other", "office-pptx", "office-excel"]);
const LEGACY_OFFICE = /\.(doc|ppt|xls|dot|pps|xlt)$/i;
const LEGACY_OFFICE_MIME = /^application\/(msword|vnd\.ms-(powerpoint|excel)|x-ole-storage)$/i;

/**
 * Why an Office source has no reader in this worker, or null. Legacy binary Word, PowerPoint and Excel files and
 * password-protected Office Open XML files (both are OLE compound files) are not read by any extractor here: the stage
 * fails them as an unsupported format instead of handing them to a reader that would return nothing.
 */
export async function unsupportedSourceReason(sourcePath: string, context: PrepareContext & { filename?: string }): Promise<string | null> {
  if (!OFFICE_FORMATS.has(context.format ?? "")) return null;
  let head = Buffer.alloc(0);
  try {
    const handle = await open(sourcePath, "r");
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(8), 0, 8, 0);
      head = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  } catch { /* unreadable: the extractor reports it */ }
  const ole = head.equals(OLE_MAGIC);
  const legacyName = LEGACY_OFFICE.test(context.filename ?? sourcePath);
  if (!ole && !(legacyName && LEGACY_OFFICE_MIME.test(context.mimeType ?? ""))) return null;
  return legacyName || !/\.(docx|pptx|xlsx)$/i.test(context.filename ?? sourcePath)
    ? `unsupported format: legacy binary Office file (${context.format}); convert it to .docx, .pptx or .xlsx`
    : `unsupported format: encrypted or password-protected Office file (${context.format}); remove the password and upload again`;
}

/** An Office Open XML sidecar plan, unavailable for the legacy binary format of the same family (.ppt, .xls). */
function officeOpenXml(plan: CommandPlan, source: string, context: PrepareContext | undefined): CommandPlan {
  const legacy = [".ppt", ".xls"].includes(path.extname(source).toLowerCase()) || /^application\/vnd\.ms-(powerpoint|excel)$/i.test(context?.mimeType ?? "");
  if (legacy) console.warn(`[extractors] no reader for legacy binary Office files format=${context?.format ?? "unknown"} mime=${context?.mimeType}`);
  return legacy ? { ...plan, available: false } : plan;
}

export const documentExtractorRegistry = new ExtractorRegistry();

/** The extractor ids this worker can run: every registered one, and `vm-pdf` only with a provider plugin loaded. */
export function servedExtractorIds(registry: ExtractorRegistry = documentExtractorRegistry): string[] {
  return registry.list().map((descriptor) => descriptor.id).filter((id) => id !== VM_PDF_EXTRACTOR_ID || sandboxedPdfProvider() !== null);
}

/**
 * Install DOCSLURP_EXTRACTOR_ID_ALIASES against the ids this worker serves. Call after the plugins load: an alias to
 * `vm-pdf` without a provider, to an unknown id, or over a built-in id throws and the worker does not start.
 */
export function configureWorkerExtractorIdAliases(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, string> {
  return configureExtractorIdAliases(servedExtractorIds(), env);
}
