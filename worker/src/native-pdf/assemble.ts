import type { Bbox, NativePdfImagePlacement, NativePdfLink, NativePdfSpan, NativePdfWord } from "./types.js";

/**
 * Markdown assembly for one page: the engine's Markdown is the base layer and
 * these generic typography rules repair elements it does not emit (links,
 * images, code, optional emphasis) and flag the ones it cannot (multi-column
 * order, RTL, math). Nothing here knows about any particular document.
 */

export interface PageSignals {
  pageNumber: number;
  markdown: string;
  spans?: NativePdfSpan[];
  words?: NativePdfWord[];
  links?: NativePdfLink[];
  images?: NativePdfImagePlacement[];
  size?: { widthPt: number; heightPt: number };
  /** Page-level unmapped glyph count (glyphStats); span-level counts are not always populated. */
  unmappedGlyphs?: number;
  /**
   * Raw text runs from the engine's one-pass scan. When `spans` were not fetched (planSpanPass found no repair that
   * needs them) runs stand in for spans' font, size and visibility in column geometry and the page warnings.
   */
  runs?: NativePdfSpan[];
  /** Column analysis the caller already computed from the same signals (planSpanPass). */
  columns?: ColumnAnalysis;
}

export interface AssembleOptions {
  /** Bold/italic from font names; off by default because mis-emphasis costs on strict scorers. */
  emphasis?: boolean;
}

export interface AssembledPage {
  markdown: string;
  /** Repairs applied, e.g. `links:2`, `code:1`, `images:1`. */
  repairs: string[];
  /** Conditions the local repairs cannot fix; callers may reroute the page. */
  warnings: string[];
  columns: ColumnAnalysis;
}


const MONO_FONT = /(mono|courier|consolas|menlo|lucida\s*console|typewriter|source\s*code|fira\s*code|dejavusansmono|inconsolata|andale)/i;
const BOLD_FONT = /(bold|black|heavy|semibold|demi)/i;
const ITALIC_FONT = /(italic|oblique)/i;
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;
const MATH_CHAR = /[∀-⋿⅀-⅏⨀-⫿ΣΠ∫√∑∏]/g;

export function isMonospaceFont(font: string): boolean {
  return MONO_FONT.test(font);
}

const norm = (value: string): string => value.replace(/\s+/g, " ").trim();
const mid = (bbox: Bbox): [number, number] => [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];

interface SpanLine {
  spans: NativePdfSpan[];
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  mono: boolean;
}

/**
 * Spans that make up the page's text. Invisible spans (render mode 3) are normally hidden junk and dropped, but an OCR
 * layer under a scan image is the page's only text: when invisible characters outnumber visible ones the invisible
 * spans are kept, so the repairs see the same text the engine emitted. Tiny invisible fragments over visible text
 * stay excluded.
 */
export function textLayerSpans(spans: NativePdfSpan[]): NativePdfSpan[] {
  const nonEmpty = spans.filter((span) => span.text.trim() !== "");
  const chars = (list: NativePdfSpan[]) => list.reduce((sum, span) => sum + span.text.replace(/\s/g, "").length, 0);
  const invisible = nonEmpty.filter((span) => span.invisible);
  if (invisible.length === 0) return nonEmpty;
  const visible = nonEmpty.filter((span) => !span.invisible);
  return chars(invisible) > chars(visible) ? nonEmpty : visible;
}

/** Cluster the page's text spans into visual lines, top to bottom. */
export function groupLines(spans: NativePdfSpan[], gapFactor = 4): SpanLine[] {
  const visible = textLayerSpans(spans);
  const sorted = [...visible].sort((a, b) => mid(a.bbox)[1] - mid(b.bbox)[1] || a.bbox[0] - b.bbox[0]);
  // First cluster by baseline; then split each cluster at wide horizontal gaps so columns stay apart.
  const rows: NativePdfSpan[][] = [];
  for (const span of sorted) {
    const last = rows[rows.length - 1];
    const ref = last?.[0];
    if (ref && Math.abs(mid(ref.bbox)[1] - mid(span.bbox)[1]) < Math.max(ref.size, span.size, 1) * 0.5) last!.push(span);
    else rows.push([span]);
  }
  const lines: NativePdfSpan[][] = [];
  for (const row of rows) {
    row.sort((a, b) => a.bbox[0] - b.bbox[0]);
    let segment: NativePdfSpan[] = [];
    for (const span of row) {
      const tail = segment[segment.length - 1];
      if (tail && span.bbox[0] - tail.bbox[2] > Math.max(tail.size, 1) * gapFactor) { lines.push(segment); segment = []; }
      segment.push(span);
    }
    if (segment.length) lines.push(segment);
  }
  lines.sort((a, b) => mid(a[0]!.bbox)[1] - mid(b[0]!.bbox)[1] || a[0]!.bbox[0] - b[0]!.bbox[0]);
  return lines.map((group) => ({
    spans: group,
    text: norm(group.map((span) => span.text).join(" ")),
    x0: Math.min(...group.map((s) => s.bbox[0])),
    x1: Math.max(...group.map((s) => s.bbox[2])),
    y0: Math.min(...group.map((s) => s.bbox[1])),
    y1: Math.max(...group.map((s) => s.bbox[3])),
    mono: group.every((span) => isMonospaceFont(span.font)),
  }));
}

/**
 * Word boxes carry the geometry spans lose when columns share a baseline; font
 * and size come from the span that contains each word.
 */
export function wordsAsSpans(words: NativePdfWord[], spans: NativePdfSpan[]): NativePdfSpan[] {
  return words.map((word) => {
    const [cx, cy] = mid(word.bbox);
    let owner: NativePdfSpan | undefined;
    let area = Infinity;
    for (const span of spans) {
      const [x0, y0, x1, y1] = span.bbox;
      const a = (x1 - x0) * (y1 - y0);
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1 && a < area) { owner = span; area = a; }
    }
    return {
      text: word.text, bbox: word.bbox, font: owner?.font ?? "",
      size: owner?.size ?? Math.max(1, (word.bbox[3] - word.bbox[1]) / 1.2),
      renderMode: owner?.renderMode ?? 0, invisible: owner?.invisible ?? false, unmapped: 0,
    };
  });
}

/** Column structure of a page: vertical whitespace gutters between side-by-side text regions. */
export interface ColumnAnalysis {
  /** Most text columns side by side anywhere on the page (1 when no gutter). */
  columns: number;
  /** True when the Markdown does not follow each column top to bottom. */
  interleaved: boolean;
  /** Gutter centre x positions in points, left to right. */
  gutters: number[];
  /** Side of a narrow edge column (sidebar, pull-quote rail), if any. */
  sidebar: "left" | "right" | null;
}

const ONE_COLUMN: ColumnAnalysis = { columns: 1, interleaved: false, gutters: [], sidebar: null };

const words = (text: string): string[] =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

interface ActiveGutter {
  x: number;
  /** Vertical extent in which text sits on both sides of the gutter. */
  y0: number;
  y1: number;
}

interface Band {
  /** Segments of the band, grouped by column (left to right), each top to bottom. */
  regions: SpanLine[][];
  /** Index (within `regions`) of a narrow edge column, when there is one. */
  narrow: "left" | "right" | null;
}

/**
 * Find gutters. A candidate is an x range (two or more of 100 bins) that few
 * segments touch; it counts only where a vertical run of segments has at least
 * three entirely left of it and three entirely right of it with nothing
 * crossing in between, so a sidebar that covers part of the page still counts
 * and a ragged right margin does not.
 */
function findGutters(lines: SpanLine[], pageWidth: number): ActiveGutter[] {
  const voters = lines.filter((line) => line.x1 - line.x0 <= pageWidth * 0.7);
  if (voters.length < 8) return [];
  const bins = 100;
  const coverage = new Array<number>(bins).fill(0);
  for (const line of voters) {
    for (const span of line.spans) {
      const from = Math.max(0, Math.floor((span.bbox[0] / pageWidth) * bins));
      const to = Math.min(bins - 1, Math.floor((span.bbox[2] / pageWidth) * bins));
      for (let i = from; i <= to; i += 1) coverage[i]! += 1;
    }
  }
  const lo = Math.ceil((Math.min(...voters.map((l) => l.x0)) / pageWidth) * bins) + 1;
  const hi = Math.floor((Math.max(...voters.map((l) => l.x1)) / pageWidth) * bins) - 1;
  const tolerance = Math.max(1, Math.floor(Math.max(...coverage) * 0.25));
  const candidates: Array<[number, number]> = [];
  let start = -1;
  for (let i = lo; i <= hi + 1; i += 1) {
    const open = i <= hi && coverage[i]! <= tolerance;
    if (open && start < 0) start = i;
    if (!open && start >= 0) { if (i - start >= 2) candidates.push([start, i - 1]); start = -1; }
  }
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0);
  const out: ActiveGutter[] = [];
  for (const [from, to] of candidates) {
    const centre = (((from + to + 1) / 2) / bins) * pageWidth;
    // Longest run of consecutive segments none of which crosses the centre line, with real space between the sides.
    let best: ActiveGutter | null = null;
    let run: SpanLine[] = [];
    const close = () => {
      const left = run.filter((x) => x.x1 <= centre);
      const right = run.filter((x) => x.x0 >= centre);
      if (left.length >= 3 && right.length >= 3) {
        const space = Math.min(...right.map((x) => x.x0)) - Math.max(...left.map((x) => x.x1));
        if (space >= pageWidth * 0.015) {
          const candidate = { x: centre, y0: Math.min(...run.map((x) => x.y0)), y1: Math.max(...run.map((x) => x.y1)) };
          if (!best || candidate.y1 - candidate.y0 > best.y1 - best.y0) best = candidate;
        }
      }
      run = [];
    };
    for (const line of sorted) {
      if (line.x1 <= centre || line.x0 >= centre) run.push(line);
      else close();
    }
    close();
    if (best) out.push(best);
  }
  // Keep at most five; merge candidates that are the same gutter seen in different runs.
  return out.sort((a, b) => a.x - b.x).slice(0, 5);
}

/** Split reading-order segments into bands: full-width lines and changes in the active gutter set start a new band. */
function buildBands(lines: SpanLine[], gutters: ActiveGutter[]): Band[] {
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const activeAt = (line: SpanLine) => gutters.filter((g) => line.y0 >= g.y0 - 1 && line.y1 <= g.y1 + 1);
  const bands: Band[] = [];
  let current: { lines: SpanLine[]; active: ActiveGutter[] } | null = null;
  const sameSet = (a: ActiveGutter[], b: ActiveGutter[]) => a.length === b.length && a.every((g, i) => g === b[i]);
  const flush = () => {
    if (!current) return;
    const { active } = current;
    const regions: SpanLine[][] = Array.from({ length: active.length + 1 }, () => []);
    for (const line of current.lines) regions[active.filter((g) => g.x < line.x0).length]!.push(line);
    const kept = regions.filter((r) => r.length > 0).map((r) => r.sort((a, b) => a.y0 - b.y0));
    let narrow: Band["narrow"] = null;
    if (kept.length >= 2) {
      const widths = kept.map((r) => Math.max(...r.map((l) => l.x1)) - Math.min(...r.map((l) => l.x0)));
      const widest = Math.max(...widths);
      if (widths[0]! < widest * 0.6) narrow = "left";
      else if (widths[widths.length - 1]! < widest * 0.6) narrow = "right";
    }
    bands.push({ regions: kept, narrow });
    current = null;
  };
  for (const line of sorted) {
    const active = activeAt(line);
    const crosses = active.some((g) => line.x0 < g.x && line.x1 > g.x);
    if (crosses) { flush(); bands.push({ regions: [[line]], narrow: null }); continue; }
    if (!current || !sameSet(current.active, active)) { flush(); current = { lines: [], active }; }
    current.lines.push(line);
  }
  flush();
  return bands;
}

/**
 * Generic N-column and sidebar detection. `interleaved` compares the Markdown
 * with each column's own continuity: the last words of a segment must be
 * followed by the first words of the next segment in the same column.
 */
export function analyzeColumns(lines: SpanLine[], pageWidth: number, markdown: string): ColumnAnalysis {
  if (!(pageWidth > 0) || lines.length < 8) return ONE_COLUMN;
  const gutters = findGutters(lines, pageWidth);
  if (gutters.length === 0) return ONE_COLUMN;
  const bands = buildBands(lines, gutters);
  const multi = bands.filter((band) => band.regions.length >= 2);
  if (multi.length === 0) return ONE_COLUMN;

  const flat = " " + words(markdown.replace(/[|#>*_`]/g, " ")).join(" ") + " ";
  let pairs = 0;
  let broken = 0;
  for (const band of multi) {
    for (const region of band.regions) {
      for (let i = 0; i + 1 < region.length; i += 1) {
        const tail = words(region[i]!.text).slice(-3);
        const head = words(region[i + 1]!.text).slice(0, 3);
        if (tail.length < 3 || head.length < 3) continue;
        pairs += 1;
        if (!flat.includes(` ${[...tail, ...head].join(" ")} `)) broken += 1;
      }
    }
  }
  return {
    columns: Math.max(...multi.map((band) => band.regions.length)),
    interleaved: pairs >= 6 && broken / pairs > 0.3,
    gutters: gutters.map((g) => g.x),
    sidebar: multi.find((band) => band.narrow)?.narrow ?? null,
  };
}

/**
 * Reading order for bands of columns: each band reads its columns left to
 * right, top to bottom, with a narrow left sidebar read after the main text.
 * Larger type becomes headings.
 */
function columnOrderedMarkdown(lines: SpanLine[], pageWidth: number): string {
  const bands = buildBands(lines, findGutters(lines, pageWidth));
  const ordered: SpanLine[] = [];
  for (const band of bands) {
    const regions = band.narrow === "left" ? [...band.regions.slice(1), band.regions[0]!] : band.regions;
    for (const region of regions) ordered.push(...region);
  }
  const sizes = lines.map((l) => l.spans[0]!.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] ?? 10;
  const out: string[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => { if (paragraph.length) { out.push(paragraph.join(" ")); paragraph = []; } };
  let prev: SpanLine | null = null;
  for (const line of ordered) {
    const size = line.spans[0]!.size;
    const heading = size >= body * 1.25 && line.text.length < 120;
    const prevHeading = prev !== null && prev.spans[0]!.size >= body * 1.25 && prev.text.length < 120;
    // A new block starts at a vertical jump, a move to another column, or after a heading.
    const newBlock = !prev || line.y0 - prev.y1 > Math.max(prev.spans[0]!.size, 1) * 0.9 || line.y0 < prev.y0 - 1;
    if (heading || newBlock || prevHeading) endParagraph();
    if (heading) out.push(`${size >= body * 1.6 ? "#" : "##"} ${line.text}`);
    else paragraph.push(line.text);
    prev = line;
  }
  endParagraph();
  return out.join("\n\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when index falls inside an existing Markdown link or code span. */
function insideMarkup(markdown: string, index: number): boolean {
  const lineStart = markdown.lastIndexOf("\n", index) + 1;
  const prefix = markdown.slice(lineStart, index);
  if ((prefix.match(/`/g) ?? []).length % 2 === 1) return true;
  const open = prefix.lastIndexOf("[");
  return open >= 0 && !prefix.slice(open).includes("](");
}

function applyLinks(markdown: string, spans: NativePdfSpan[], links: NativePdfLink[]): { markdown: string; count: number } {
  let count = 0;
  let out = markdown;
  const seen = new Set<string>();
  for (const link of links) {
    const target = link.uri ?? (link.destPage !== undefined ? `#page-${link.destPage + 1}` : undefined);
    if (!target || !linkable(link)) continue;
    const [x0, y0, x1, y1] = link.bbox;
    const inside = spans
      .filter((span) => {
        const [cx, cy] = mid(span.bbox);
        return !span.invisible && cx >= x0 - 1 && cx <= x1 + 1 && cy >= y0 - 1 && cy <= y1 + 1;
      })
      .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    const anchor = norm(inside.map((span) => span.text).join(" "));
    const key = `${anchor}\u0000${target}`;
    if (anchor.length < 2 || /[[\]]/.test(anchor) || seen.has(key)) continue;
    seen.add(key);
    const pattern = new RegExp(escapeRegex(anchor).replace(/\\? /g, "\\s+"), "g");
    for (const match of out.matchAll(pattern)) {
      if (insideMarkup(out, match.index!)) continue;
      out = `${out.slice(0, match.index!)}[${match[0]}](${target})${out.slice(match.index! + match[0].length)}`;
      count += 1;
      break;
    }
  }
  return { markdown: out, count };
}

function applyCode(markdown: string, lines: SpanLine[]): { markdown: string; count: number } {
  const monoText = new Map<string, SpanLine>();
  for (const line of lines) if (line.mono && line.text.length > 0) monoText.set(line.text, line);
  if (monoText.size === 0) return { markdown, count: 0 };
  const rows = markdown.split("\n");
  const out: string[] = [];
  let count = 0;
  let i = 0;
  const lookup = (row: string) => monoText.get(norm(row.replace(/^\s*[-*]\s+/, "")));
  while (i < rows.length) {
    if (rows[i]!.trimStart().startsWith("```")) {
      // Already fenced by the engine: copy through.
      out.push(rows[i]!);
      i += 1;
      while (i < rows.length && !rows[i]!.trimStart().startsWith("```")) { out.push(rows[i]!); i += 1; }
      if (i < rows.length) { out.push(rows[i]!); i += 1; }
      continue;
    }
    const first = lookup(rows[i]!);
    if (!first) { out.push(rows[i]!); i += 1; continue; }
    const run: SpanLine[] = [];
    let j = i;
    while (j < rows.length) {
      const hit = lookup(rows[j]!);
      if (hit) { run.push(hit); j += 1; continue; }
      // Blank lines inside a block are kept when another mono line follows.
      if (rows[j]!.trim() === "" && j + 1 < rows.length && lookup(rows[j + 1]!)) { run.push(null as unknown as SpanLine); j += 1; continue; }
      break;
    }
    const real = run.filter(Boolean);
    if (real.length >= 2) {
      const left = Math.min(...real.map((l) => l.x0));
      out.push("```");
      for (const [k, line] of run.entries()) {
        if (!line) {
          // The engine separates every line with a paragraph break; keep a blank only where the page has a real gap.
          const prev = run[k - 1];
          const next = run[k + 1];
          if (prev && next && next.y0 - prev.y1 > (prev.spans[0]?.size ?? 10)) out.push("");
          continue;
        }
        const charWidth = Math.max(line.spans[0]!.size * 0.6, 1);
        out.push(" ".repeat(Math.max(0, Math.round((line.x0 - left) / charWidth))) + line.text);
      }
      out.push("```");
      count += 1;
    } else {
      // A lone monospace line is inline code.
      out.push(`\`${first.text}\``);
      count += 1;
    }
    i = j;
  }
  return { markdown: out.join("\n"), count };
}

function applyEmphasis(markdown: string, spans: NativePdfSpan[]): { markdown: string; count: number } {
  const sizes = spans.map((s) => s.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] ?? 0;
  let out = markdown;
  let count = 0;
  for (const span of spans) {
    const text = norm(span.text);
    if (span.invisible || text.length < 3 || isMonospaceFont(span.font)) continue;
    // Headings and larger display text already carry structure.
    if (span.size > body * 1.15) continue;
    const bold = BOLD_FONT.test(span.font);
    const italic = ITALIC_FONT.test(span.font);
    if (!bold && !italic) continue;
    const pattern = new RegExp(escapeRegex(text).replace(/\\? /g, "\\s+"), "g");
    const matches = [...out.matchAll(pattern)];
    // Ambiguous text (repeated) is left alone rather than guessed.
    if (matches.length !== 1 || insideMarkup(out, matches[0]!.index!)) continue;
    const m = matches[0]!;
    const before = out.slice(Math.max(0, m.index! - 1), m.index!);
    if (before === "*" || before === "#") continue;
    const mark = bold && italic ? "***" : bold ? "**" : "*";
    out = `${out.slice(0, m.index!)}${mark}${m[0]}${mark}${out.slice(m.index! + m[0].length)}`;
    count += 1;
  }
  return { markdown: out, count };
}

function applyImages(markdown: string, lines: SpanLine[], images: NativePdfImagePlacement[], size: PageSignals["size"], pageNumber: number): { markdown: string; count: number } {
  const kept = keptImages(images, size, markdown.trim().length > 0)
    .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  if (kept.length === 0) return { markdown, count: 0 };
  const rows = markdown.split("\n");
  // Insert from the bottom so earlier indexes stay valid.
  const placed: Array<{ at: number; text: string }> = [];
  kept.forEach((image, k) => {
    const above = lines.filter((line) => line.y1 <= image.bbox[1] + 2).slice(-1)[0];
    let at = rows.length;
    if (above) {
      const index = rows.findIndex((row) => norm(row).includes(above.text) || (above.text.length > 12 && above.text.includes(norm(row)) && norm(row).length > 12));
      if (index >= 0) at = index + 1;
      else at = rows.length;
    } else {
      at = 0;
    }
    placed.push({ at, text: `![image p${pageNumber}#${k + 1}](docslurp:image/p${pageNumber}-${k + 1})` });
  });
  for (const { at, text } of placed.sort((a, b) => b.at - a.at)) rows.splice(at, 0, "", text, "");
  return { markdown: rows.join("\n").replace(/\n{3,}/g, "\n\n"), count: placed.length };
}

const LINK_TARGET = /^(https?:|mailto:|ftp:)/i;

/** Links the link repair can apply: http(s)/mailto/ftp URIs and internal page destinations. */
function linkable(link: NativePdfLink): boolean {
  return link.uri ? LINK_TARGET.test(link.uri) : link.destPage !== undefined;
}

/** Images the placeholder repair keeps: not tiny, not a page-sized scan layer behind text. */
function keptImages(images: NativePdfImagePlacement[], size: PageSignals["size"], hasText: boolean): NativePdfImagePlacement[] {
  const pageArea = size ? size.widthPt * size.heightPt : 0;
  return images
    .filter((image) => image.widthPx >= 32 && image.heightPx >= 32)
    .filter((image) => {
      if (!pageArea) return true;
      const area = Math.max(0, image.bbox[2] - image.bbox[0]) * Math.max(0, image.bbox[3] - image.bbox[1]);
      if (area < pageArea * 0.01) return false;
      // A page-sized image behind real text is a scan layer, not a figure.
      return !(hasText && area > pageArea * 0.9);
    });
}

export interface SpanPassPlan {
  /** Why merged spans are needed (empty: the page's repairs cannot apply and spans() is skipped). */
  reasons: Array<"links" | "images" | "code" | "emphasis" | "columns" | "no-words">;
  /** Column analysis from word boxes with run fonts; reuse it when spans are skipped. */
  columns: ColumnAnalysis;
}

/**
 * Decide from cheap signals (scan runs, words, links, image placements) whether any span-based repair can change the
 * page. Each reason mirrors the guard of one repair in assemblePageMarkdown, so skipping spans leaves those repairs
 * as no-ops: links need a linkable target, image placeholders a kept image, code a monospace run, emphasis a bold or
 * italic run, and the column rebuild an interleaved page.
 */
export function planSpanPass(
  input: Pick<PageSignals, "markdown" | "runs" | "words" | "links" | "images" | "size">,
  options: AssembleOptions = {},
): SpanPassPlan {
  const reasons: SpanPassPlan["reasons"] = [];
  const runs = textLayerSpans(input.runs ?? []);
  if (input.links?.some(linkable)) reasons.push("links");
  if (input.images && keptImages(input.images, input.size, input.markdown.trim().length > 0).length > 0) reasons.push("images");
  if (runs.some((run) => isMonospaceFont(run.font))) reasons.push("code");
  if (options.emphasis && runs.some((run) => BOLD_FONT.test(run.font) || ITALIC_FONT.test(run.font))) reasons.push("emphasis");
  let columns = ONE_COLUMN;
  if (!input.words || input.words.length === 0) {
    if (runs.length > 0) reasons.push("no-words");
  } else if (input.size) {
    columns = analyzeColumns(groupLines(wordsAsSpans(input.words, input.runs ?? []), 1.5), input.size.widthPt, input.markdown);
    if (columns.interleaved) reasons.push("columns");
  }
  return { reasons, columns };
}

export function assemblePageMarkdown(input: PageSignals, options: AssembleOptions = {}): AssembledPage {
  let markdown = input.markdown;
  const repairs: string[] = [];
  const warnings: string[] = [];
  const spans = input.spans ?? [];
  const lines = spans.length > 0 ? groupLines(spans) : [];
  let columns: ColumnAnalysis = ONE_COLUMN;

  // Column geometry prefers word boxes: spans merge text that shares a baseline across columns.
  const owners = spans.length > 0 ? spans : input.runs ?? [];
  const columnLines = input.words && input.words.length > 0
    ? groupLines(wordsAsSpans(input.words, owners), 1.5)
    : lines;
  if (columnLines.length > 0 && input.size) {
    columns = input.columns ?? analyzeColumns(columnLines, input.size.widthPt, markdown);
    if (columns.interleaved) {
      const hasTable = /^\s*\|.*\|\s*$/m.test(markdown);
      if (hasTable) {
        warnings.push("multi-column-interleave");
      } else {
        markdown = columnOrderedMarkdown(columnLines, input.size.widthPt);
        repairs.push("column-order");
      }
    }
  }

  // Warnings count characters only, so unmerged runs serve as well as spans.
  const visibleText = lines.length > 0
    ? lines.map((line) => line.text).join(" ")
    : textLayerSpans(input.runs ?? []).map((run) => norm(run.text)).join(" ");
  if (visibleText) {
    const rtl = (visibleText.match(RTL_CHAR) ?? []).length / Math.max(1, visibleText.replace(/\s/g, "").length);
    if (rtl > 0.2) warnings.push("rtl-visual-order");
    const math = (visibleText.match(MATH_CHAR) ?? []).length;
    if (math >= 8) warnings.push("math-needs-latex");
    const unmapped = input.unmappedGlyphs ?? spans.reduce((sum, span) => sum + span.unmapped, 0);
    if (unmapped > 0) warnings.push(`unmapped-glyphs:${unmapped}`);
  }

  // Link and emphasis anchors are span text; skip them once the column reorder rebuilt the page.
  if (input.links && input.links.length > 0 && spans.length > 0) {
    const result = applyLinks(markdown, spans, input.links);
    if (result.count > 0) { markdown = result.markdown; repairs.push(`links:${result.count}`); }
  }
  if (lines.length > 0) {
    const result = applyCode(markdown, lines);
    if (result.count > 0) { markdown = result.markdown; repairs.push(`code:${result.count}`); }
  }
  if (options.emphasis && spans.length > 0) {
    const result = applyEmphasis(markdown, spans);
    if (result.count > 0) { markdown = result.markdown; repairs.push(`emphasis:${result.count}`); }
  }
  if (input.images && input.images.length > 0) {
    const result = applyImages(markdown, lines, input.images, input.size, input.pageNumber);
    if (result.count > 0) { markdown = result.markdown; repairs.push(`images:${result.count}`); }
  }
  return { markdown: markdown.trim(), repairs, warnings, columns };
}
