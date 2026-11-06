import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRunner } from "../tools/runner.js";
import { resolveScriptsDir } from "../tools/scripts-dir.js";
import type { MapDraft, MapNode } from "./siphon-agent.js";

export interface OutlineNode { title: string; level: number; physicalPage: number | null; children: OutlineNode[] }

export interface PdfStructure { pageCount: number; outline: OutlineNode[]; pageLabels: string[] | null }

/** PDF.js runs in the parser VM; only typed structure JSON returns to the worker. */
export async function readPdfStructure(bytes: Uint8Array): Promise<PdfStructure> {
  if (process.env.NODE_ENV !== "production") {
    return (await import("./pdf-structure-guest.js")).readPdfStructure(bytes);
  }
  if (bytes.byteLength > 500 * 1024 * 1024) throw new Error("PDF structure input exceeds 500 MiB");
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-pdf-structure-"));
  try {
    const input = path.join(dir, "input.pdf");
    const output = path.join(dir, "structure.json");
    await writeFile(input, bytes, { mode: 0o600 });
    await new CommandRunner().run({ binary: "node", args: [path.join(resolveScriptsDir(), "pdf-structure.mjs"), input, output], available: true, readOnlyInputs: true, timeoutMs: 60_000 });
    if ((await stat(output)).size > 4 * 1024 * 1024) throw new Error("PDF structure output exceeds 4 MiB");
    const result = JSON.parse(await readFile(output, "utf8")) as PdfStructure;
    if (!Number.isSafeInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > 1_000_000 || !Array.isArray(result.outline)) throw new Error("invalid PDF structure result");
    if (result.pageLabels !== null && (!Array.isArray(result.pageLabels) || result.pageLabels.length !== result.pageCount || result.pageLabels.some((label) => typeof label !== "string" || label.length > 1024))) throw new Error("invalid PDF page labels");
    const pending = result.outline.map((node) => ({ node, depth: 1 }));
    let count = 0;
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (++count > 5000 || depth > 8 || !node || typeof node.title !== "string" || node.title.length > 4096 || !Number.isSafeInteger(node.level) || node.level < 1 || node.level > 8 || !Array.isArray(node.children) || !(node.physicalPage === null || Number.isSafeInteger(node.physicalPage) && node.physicalPage >= 1 && node.physicalPage <= result.pageCount)) throw new Error("invalid PDF outline");
      if (pending.length + node.children.length > 5000) throw new Error("PDF outline exceeds node limit");
      for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
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
