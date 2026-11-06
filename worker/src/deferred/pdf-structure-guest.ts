import type { OutlineNode, PdfStructure } from "./pdf-structure.js";

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

