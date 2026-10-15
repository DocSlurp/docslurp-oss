import {
  NativePdfError,
  toNativePdfError,
  unsupported,
  type Bbox,
  type NativePdfDocument,
  type NativePdfEngine,
  type NativePdfEngineVersion,
  type NativePdfGlyphStats,
  type NativePdfOcrFillOptions,
  type NativePdfPage,
  type NativePdfPageScan,
  type NativePdfScanStats,
  type NativePdfRenderOptions,
  type TableStrategy,
} from "./types.js";

/**
 * Open limits for every in-process use (extraction, rasters, probe): the binding's server-ingestion profile
 * (binding 0.13.0 `worker`: 512 MiB file, 2,000 pages, 2 GiB cumulative decompressed, 4 Mi text glyphs per
 * document). The `web` profile (10 MiB, 200 pages, 128 MiB) rejects ordinary scans: 23 of 280 dev documents in
 * wild-v2 vs 0 with `worker`. Documents past these limits reject with PDF_LIMIT and fall back.
 */
export const NATIVE_PDF_OPEN_LIMITS = { profile: "worker" } as const;

/**
 * Shape of the private in-process Node binding (frozen v1 interface plus extras; the current build is 0.13.0,
 * see vendor-artifacts/native-pdf/manifest.json). Kept structural so the adapter compiles without the
 * package installed. Optional members are extras older bindings lack; the adapter reports them unsupported.
 */
export interface NativePdfBindingPage {
  size(): { widthPt: number; heightPt: number; rotation: 0 | 90 | 180 | 270 };
  text(): string;
  markdown(opts?: { tableStrategy?: TableStrategy }): string;
  markdownAsync?(opts?: { tableStrategy?: TableStrategy }): Promise<string>;
  spans(): Array<{ text: string; bbox: Bbox; font: string; size: number; renderMode: number; invisible: boolean; unmapped: number }>;
  words?(): Array<{ text: string; bbox: Bbox }>;
  images(): Array<{ index: number; bbox: Bbox; widthPx: number; heightPx: number; effectiveDpi: number }>;
  drawings(): { lineCount: number; rectCount: number; longRuleCount: number; vectorArea: number };
  links(): Array<{ uri?: string; destPage?: number; bbox: Bbox }>;
  glyphStats?(): NativePdfGlyphStats;
  scan?(opts?: { spans?: boolean; images?: boolean }): {
    spans: Array<{ text: string; bbox: Bbox; font: string; size: number; renderMode: number; invisible: boolean; unmapped: number;
      glyphs: number; overImage: number; controlChars: number; type3: boolean }>;
    images: Array<{ index: number; bbox: Bbox; widthPx: number; heightPx: number; dpi: number }>;
    stats: NativePdfScanStats;
  };
  tables(opts?: { strategy?: "lines" | "text" }): Array<{ bbox: Bbox; rows: string[][] }>;
  render(opts: NativePdfRenderOptions): Buffer;
  renderAsync?(opts: NativePdfRenderOptions): Promise<Buffer>;
  ocrFillAsync?(opts?: NativePdfOcrFillOptions): Promise<{
    text: string; markdown: string; filledRegions: number; engine: string; replacedPages?: number }>;
}

export interface NativePdfBindingDoc {
  pageCount(): number;
  metadata(): { producer?: string; creator?: string; title?: string; encrypted: boolean; permissions?: string[] };
  page(i: number): NativePdfBindingPage;
  close(): void;
}

export interface NativePdfBindingModule {
  version(): { version: string; gitSha: string; features: string[] };
  openPath(path: string, opts?: { password?: string; limits?: { profile?: "web" | "worker" } }): NativePdfBindingDoc;
}

export function isNativePdfBindingModule(value: unknown): value is NativePdfBindingModule {
  const candidate = value as Partial<NativePdfBindingModule> | null;
  return typeof candidate?.version === "function" && typeof candidate?.openPath === "function";
}

/** Run a binding call, mapping thrown binding errors to NativePdfError. */
async function call<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toNativePdfError(error);
  }
}

class BindingPage implements NativePdfPage {
  private handle: NativePdfBindingPage | null = null;

  constructor(private readonly doc: NativePdfBindingDoc, private readonly index: number) {}

  private get page(): NativePdfBindingPage {
    this.handle ??= this.doc.page(this.index);
    return this.handle;
  }

  size() { return call(() => this.page.size()); }
  text() { return call(() => this.page.text()); }
  markdown(opts?: { tableStrategy?: TableStrategy }) {
    return call(() => this.page.markdownAsync ? this.page.markdownAsync(opts) : this.page.markdown(opts));
  }
  spans() { return call(() => this.page.spans()); }
  words() {
    return call(() => {
      if (!this.page.words) throw unsupported("words", "binding");
      return this.page.words();
    });
  }
  images() { return call(() => this.page.images()); }
  drawings() { return call(() => this.page.drawings()); }
  glyphStats() {
    return call(() => {
      if (!this.page.glyphStats) throw unsupported("glyphStats", "binding");
      return this.page.glyphStats();
    });
  }
  scan() {
    return call((): NativePdfPageScan => {
      if (!this.page.scan) throw unsupported("scan", "binding");
      const raw = this.page.scan();
      return {
        runs: raw.spans.map((run) => ({
          text: run.text, bbox: run.bbox, font: run.font, size: run.size, renderMode: run.renderMode, invisible: run.invisible,
          unmapped: run.unmapped, glyphs: run.glyphs, overImage: run.overImage, controlChars: run.controlChars, type3: run.type3,
        })),
        images: raw.images.map((image) => ({
          index: image.index, bbox: image.bbox, widthPx: image.widthPx, heightPx: image.heightPx, effectiveDpi: image.dpi,
        })),
        stats: raw.stats,
      };
    });
  }
  links() { return call(() => this.page.links()); }
  tables(opts?: { strategy?: "lines" | "text" }) { return call(() => this.page.tables(opts)); }
  render(opts: NativePdfRenderOptions) {
    return call(() => this.page.renderAsync ? this.page.renderAsync(opts) : this.page.render(opts));
  }
  ocrFill(opts?: NativePdfOcrFillOptions) {
    return call(async () => {
      if (!this.page.ocrFillAsync) throw unsupported("ocrFill", "binding");
      // Model directory, threads and concurrency come from the process env (loader.ts NATIVE_PDF_ENGINE_ENV).
      const out = await this.page.ocrFillAsync(opts);
      return {
        text: out.text,
        markdown: out.markdown,
        filledRegions: out.filledRegions,
        engine: out.engine,
        replacedPages: out.replacedPages ?? 0,
      };
    });
  }
}

class BindingDocument implements NativePdfDocument {
  private closed = false;

  constructor(private readonly doc: NativePdfBindingDoc) {}

  pageCount() { return call(() => this.doc.pageCount()); }
  metadata() { return call(() => this.doc.metadata()); }
  page(index: number): NativePdfPage { return new BindingPage(this.doc, index); }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await call(() => this.doc.close());
  }
}

export class BindingNativePdfEngine implements NativePdfEngine {
  readonly id = "binding";
  private readonly info: NativePdfEngineVersion;

  constructor(private readonly binding: NativePdfBindingModule) {
    const raw = binding.version();
    this.info = { engine: "native-pdf", version: raw.version, gitSha: raw.gitSha, features: [...raw.features] };
  }

  version(): NativePdfEngineVersion {
    return this.info;
  }

  async openPath(path: string, opts?: { password?: string; signal?: AbortSignal }): Promise<NativePdfDocument> {
    if (opts?.signal?.aborted) throw new NativePdfError("NATIVE_PDF_FAILED", "aborted before open");
    const options = { limits: NATIVE_PDF_OPEN_LIMITS, ...(opts?.password ? { password: opts.password } : {}) };
    const doc = await call(() => this.binding.openPath(path, options));
    return new BindingDocument(doc);
  }
}
