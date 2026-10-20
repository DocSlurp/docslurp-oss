import type { MapDraft, MapNode } from "./siphon-agent.js";

export interface OutlineNode { title: string; level: number; physicalPage: number | null; children: OutlineNode[] }

export interface PdfStructure { pageCount: number; outline: OutlineNode[]; pageLabels: string[] | null }

const MAX_OUTLINE_NODES = 5000;
const MAX_OUTLINE_DEPTH = 8;

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

interface RawOutlineItem { title?: string; dest?: unknown; items?: RawOutlineItem[] }

/** Free structure: page count, outline (bookmarks) with resolved physical pages, and `/PageLabels`. Never renders or OCRs. */
export async function readPdfStructure(bytes: Uint8Array): Promise<PdfStructure> {
  const lib = await loadPdfJs();
  let task: ReturnType<PdfJs["getDocument"]> | null = null;
  try {
    task = lib.getDocument({
      data: new Uint8Array(bytes), // pdf.js takes ownership of the buffer
      useSystemFonts: false, disableFontFace: true, verbosity: 0, stopAtErrors: false,
    });
    const doc = await task.promise;
    const pageCount = doc.numPages;
    const raw = (await doc.getOutline().catch(() => null)) as RawOutlineItem[] | null;
    let budget = MAX_OUTLINE_NODES;
    const resolvePage = async (dest: unknown): Promise<number | null> => {
      try {
        const explicit = typeof dest === "string" ? await doc.getDestination(dest) : (dest as unknown[] | null);
        if (!Array.isArray(explicit) || explicit.length === 0) return null;
        const target = explicit[0];
        if (typeof target === "number") return target >= 0 && target < pageCount ? target + 1 : null;
        if (target && typeof target === "object") {
          const index = await doc.getPageIndex(target as never);
          return index >= 0 && index < pageCount ? index + 1 : null;
        }
        return null;
      } catch {
        return null;
      }
    };
    const convert = async (items: RawOutlineItem[], level: number): Promise<OutlineNode[]> => {
      const out: OutlineNode[] = [];
      for (const item of items) {
        if (budget <= 0) break;
        budget--;
        const title = (item.title ?? "").replace(/\s+/g, " ").trim();
        const children = level < MAX_OUTLINE_DEPTH && item.items?.length ? await convert(item.items, level + 1) : [];
        if (!title) { out.push(...children); continue; }
        out.push({ title, level, physicalPage: await resolvePage(item.dest), children });
      }
      return out;
    };
    const outline = raw ? await convert(raw, 1) : [];
    const labels = (await doc.getPageLabels().catch(() => null)) as string[] | null;
    return { pageCount, outline, pageLabels: labels && labels.length === pageCount ? labels : null };
  } finally {
    await task?.destroy();
  }
}

/** Depth-first flat list in reading order. */
export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((n) => [n, ...flattenOutline(n.children)]);
}

// ---- deterministic text parsing (TOC / index / glossary) ------------------------------------

const PAGE_TOKEN = "(?:[ivxlcdm]{1,8}|\\d{1,5})";
const TOC_LINE = new RegExp(`^(.+?)\\s*\\.{2,}\\s*(${PAGE_TOKEN})$`, "i");
const INDEX_LINE = /^([A-Za-z][^,]{1,78}?),\s*((?:\d{1,5}(?:\s*[–-]\s*\d{1,5})?)(?:\s*,\s*\d{1,5}(?:\s*[–-]\s*\d{1,5})?)*)$/;

function normalizeLeaders(line: string): string {
  // ". . . . 12" and "…… 12" leaders become a single dotted run.
  return line.replace(/(?:\s?[.·•…]){3,}/g, " .... ").replace(/\s{2,}/g, "  ").trim();
}

export interface TocEntry { title: string; level: number; printed: string }

/** Table-of-contents lines with dotted leaders; level from `1.2.3` numbering depth. */
export function parseTocText(pageTexts: string[]): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const text of pageTexts) {
    const pageEntries: TocEntry[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = normalizeLeaders(rawLine.trim());
      const match = TOC_LINE.exec(line);
      if (!match) continue;
      const title = match[1]!.replace(/\s+/g, " ").trim();
      if (title.length < 2 || title.length > 200 || !/[A-Za-z]/.test(title)) continue;
      const numbering = /^(\d+(?:\.\d+)*)[.)]?\s/.exec(title);
      const level = numbering ? Math.min(6, numbering[1]!.split(".").length) : 1;
      pageEntries.push({ title, level, printed: match[2]! });
    }
    // A real contents page has several entries; one stray dotted line is prose.
    if (pageEntries.length >= 3) entries.push(...pageEntries);
  }
  return entries;
}

export interface IndexEntry { term: string; printedPages: string[] }

/** Back-of-book index lines: `term, 12, 45–47`. Ranges expand to at most 20 pages. */
export function parseIndexText(pageTexts: string[]): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const text of pageTexts) {
    const pageEntries: IndexEntry[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const match = INDEX_LINE.exec(rawLine.trim());
      if (!match) continue;
      const pages: string[] = [];
      for (const part of match[2]!.split(",")) {
        const range = /^\s*(\d+)\s*[–-]\s*(\d+)\s*$/.exec(part);
        if (range) {
          const from = Number.parseInt(range[1]!, 10), to = Number.parseInt(range[2]!, 10);
          for (let p = from; p <= Math.min(to, from + 19); p++) pages.push(String(p));
        } else pages.push(part.trim());
      }
      pageEntries.push({ term: match[1]!.trim(), printedPages: pages });
    }
    if (pageEntries.length >= 6) entries.push(...pageEntries);
  }
  return entries;
}

/** First heading-like line of a page (for titling and glossary/index section detection). */
export function firstHeading(pageText: string): string | null {
  for (const line of pageText.split(/\r?\n/).slice(0, 12)) {
    const t = line.trim();
    if (t.length >= 3 && t.length <= 120 && /[A-Za-z]{3}/.test(t) && !/^\d+$/.test(t)) return t;
  }
  return null;
}

export function sectionKind(pageText: string): "index" | "glossary" | null {
  const heading = firstHeading(pageText)?.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (heading === "index" || heading === "subject index" || heading === "general index") return "index";
  if (heading === "glossary" || heading === "glossary of terms") return "glossary";
  return null;
}

export type { MapDraft, MapNode };
