import type { CommandPlan, CommandResult } from "../tools/runner.js";
import {
  NativePdfError,
  unsupported,
  type NativePdfDocument,
  type NativePdfEngine,
  type NativePdfEngineVersion,
  type NativePdfPage,
} from "./types.js";

/** The subset of CommandRunner the poppler engine needs (sandboxed pdftotext). */
export interface PopplerRunner {
  extractText(source: string, preservePageBreaks?: boolean): Promise<CommandPlan>;
  run(plan: CommandPlan, signal?: AbortSignal): Promise<CommandResult>;
}

/** pdftotext -layout keeps visual spacing; Markdown wants prose lines. */
export function layoutTextToMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.replace(/\s+/g, " ").trim());
  const out: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * Fallback engine for the text/markdown subset. Runs one sandboxed pdftotext
 * per document and serves pages from its form-feed separated output; every
 * geometry method rejects with NATIVE_PDF_UNSUPPORTED.
 */
export class PopplerNativePdfEngine implements NativePdfEngine {
  readonly id = "poppler";

  constructor(private readonly runner: PopplerRunner) {}

  version(): NativePdfEngineVersion {
    return { engine: "poppler", version: "pdftotext", gitSha: "", features: ["text", "markdown"] };
  }

  async openPath(path: string, opts?: { password?: string; signal?: AbortSignal }): Promise<NativePdfDocument> {
    if (opts?.password) throw unsupported("password", this.id);
    const plan = await this.runner.extractText(path, true);
    if (!plan.available) throw new NativePdfError("NATIVE_PDF_UNAVAILABLE", "pdftotext is not installed");
    let pages: string[] | null = null;
    const load = async () => {
      if (pages) return pages;
      const { stdout } = await this.runner.run(plan, opts?.signal);
      const split = stdout.split("\f");
      // pdftotext terminates every page with \f, leaving one trailing empty entry.
      if (split.length > 1 && split[split.length - 1]!.trim() === "") split.pop();
      pages = split;
      return pages;
    };
    const engine = this.id;
    const page = (index: number): NativePdfPage => ({
      size: async () => { throw unsupported("size", engine); },
      text: async () => (await load())[index] ?? "",
      markdown: async () => layoutTextToMarkdown((await load())[index] ?? ""),
      spans: async () => { throw unsupported("spans", engine); },
      words: async () => { throw unsupported("words", engine); },
      images: async () => { throw unsupported("images", engine); },
      drawings: async () => { throw unsupported("drawings", engine); },
      glyphStats: async () => { throw unsupported("glyphStats", engine); },
      links: async () => { throw unsupported("links", engine); },
      tables: async () => { throw unsupported("tables", engine); },
      render: async () => { throw unsupported("render", engine); },
      ocrFill: async () => { throw unsupported("ocrFill", engine); },
    });
    return {
      pageCount: async () => (await load()).length,
      metadata: async () => ({ encrypted: false }),
      page,
      close: async () => { pages = null; },
    };
  }
}
