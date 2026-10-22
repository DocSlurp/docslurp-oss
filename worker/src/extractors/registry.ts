import { writeFile } from "node:fs/promises";
import path from "node:path";
import { builtInDocumentExtractorDescriptors, type ExtractorDescriptor } from "@docslurp/shared";
import type { DocumentExtractionResult } from "../lib/document-extraction-adapter.js";
import type { CommandPlan, CommandRunner } from "../tools/runner.js";
import { planArtifactGraph, type GraphAdapter } from "./graph.js";
import { availableLocalArtifactAdapters } from "./local-artifact-adapters.js";
import { extractStructuredJsonFile } from "./structured-json.js";
import { resolveNativePdfEngine } from "../native-pdf/engine.js";
import { extractNativePdf } from "../native-pdf/extract.js";
import { nativePdfAdapterVersion } from "../native-pdf/loader.js";
import { nativePdfEmphasisEnabled, resolveNativePdfMode } from "../native-pdf/mode.js";
import { NativePdfError, logNativePdfFallback } from "../native-pdf/types.js";

export interface ExtractedCandidate {
  label: string;
  plan: CommandPlan;
  textKey: string;
  textUri: string;
  tempTextPath: string;
  structuredResult?: DocumentExtractionResult;
  structuredArtifactUri?: string;
}

export interface CandidateExecutors {
  stream(plan: CommandPlan, label: string, textKey: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
  file(plan: CommandPlan, label: string, textKey: string, outputPath: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
  liteparse(candidate: PreparedExtractor, textKey: string, sourcePath: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
  graph?(candidate: PreparedExtractor, textKey: string, sourcePath: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
  /** Publish Markdown an in-process extractor already wrote to `outputPath`. */
  markdownFile?(candidate: PreparedExtractor, textKey: string, outputPath: string, signal?: AbortSignal): Promise<ExtractedCandidate>;
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

type Preparation = (runner: CommandRunner, sourcePath: string, configJson?: string) => Promise<CommandPlan>;
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
const liteparse: Execution = (candidate, executors, key, source, signal) =>
  executors.liteparse(candidate, key, source, signal);
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
 * kind, and the stage's retry strategies move on to the next extractor in order (kreuzberg by default). A locked
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
  definition({ id: "kreuzberg", outputSuffix: ".kreuzberg.md", tableAware: true, execute: file,
    prepare: (runner, source, config) => runner.kreuzbergMarkdown(source, `${source}.kreuzberg.md`, config) }),
  definition({ id: "native-pdf", outputSuffix: ".native-pdf.md", tableAware: true, execute: nativePdf,
    prepare: async (runner) => {
      const engine = await resolveNativePdfEngine(runner);
      return { ...inProcessPlan("native-pdf"), available: engine !== null };
    } }),
  definition({ id: "pandoc", execute: stream,
    prepare: (runner, source) => runner.extractMarkdown(source) }),
  definition({ id: "liteparse", outputSuffix: ".liteparse.json", execute: liteparse,
    prepare: (runner, source) => runner.liteParseExtract(source, `${source}.liteparse.json`, false) }),
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

export const defaultDocumentExtractorOrder: Record<string, string[]> = {
  pdf: ["kreuzberg", "native-pdf", "poppler-text"],
  "structured-json": ["json"],
  default: ["kreuzberg", "pandoc"],
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
    // DOCSLURP_PDF_ENGINE=native-pdf puts the native engine first; kreuzberg stays next as its fallback.
    const defaults = format === "pdf" && resolveNativePdfMode() === "native-pdf" ? ["native-pdf", ...base] : base;
    const ids = configured ?? defaults.filter((id) =>
      this.entries.get(id)?.descriptor.capabilities.formats.includes(format),
    );
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

  async prepare(id: string, runner: CommandRunner, sourcePath: string, configJson?: string): Promise<PreparedExtractor> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown extractor ${id}; registered: ${[...this.entries.keys()].join(", ")}`);
    const plan = await entry.prepare(runner, sourcePath, configJson);
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

export function serializeExtractorOptions(options: Record<string, unknown>, id: string): string | undefined {
  return options[id] === undefined ? undefined : JSON.stringify(options[id]);
}

export const documentExtractorRegistry = new ExtractorRegistry();
