/**
 * Printed (book) page numbers vs physical PDF pages. Front matter is usually roman, the body
 * restarts at 1, and plates/inserts shift the offset again, so labels are piecewise segments:
 * `physical = printed + offset` inside each segment's physical range.
 */
export interface LabelSegment {
  physicalStart: number;
  physicalEnd: number;
  printedStart: number;
  style: "roman" | "arabic" | "other";
  offset: number;
}

/** Roman numerals above this are almost certainly words ("mix", "dim"), not front-matter pages. */
const MAX_ROMAN_PAGE = 60;

const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

export function romanToInt(input: string): number | null {
  const s = input.trim();
  if (!s || (s !== s.toLowerCase() && s !== s.toUpperCase())) return null;
  const lower = s.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(lower)) return null;
  let total = 0;
  for (let i = 0; i < lower.length; i++) {
    const v = ROMAN_VALUES[lower[i]!]!;
    const next = ROMAN_VALUES[lower[i + 1] ?? ""] ?? 0;
    total += v < next ? -v : v;
  }
  // Reject non-canonical numerals ("iiii", "vx") by round-tripping.
  return intToRoman(total) === lower ? total : null;
}

export function intToRoman(n: number): string {
  const table: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let rest = Math.max(0, Math.floor(n));
  let out = "";
  for (const [value, glyph] of table) {
    while (rest >= value) { out += glyph; rest -= value; }
  }
  return out;
}

interface ParsedLabel { style: "roman" | "arabic" | "other"; value: number }

export function parseLabel(label: string): ParsedLabel {
  const s = label.trim();
  if (/^\d{1,5}$/.test(s)) return { style: "arabic", value: Number.parseInt(s, 10) };
  const roman = romanToInt(s);
  if (roman !== null && roman <= MAX_ROMAN_PAGE) return { style: "roman", value: roman };
  return { style: "other", value: 0 };
}

/** Segments from the PDF's own `/PageLabels` (one label string per physical page). */
export function segmentsFromPageLabels(labels: string[]): LabelSegment[] {
  const segments: LabelSegment[] = [];
  let current: LabelSegment | null = null;
  let previous: ParsedLabel | null = null;
  labels.forEach((label, index) => {
    const physical = index + 1;
    const parsed = parseLabel(label);
    const continues = current !== null && previous !== null && parsed.style === current.style
      && (parsed.style === "other" || parsed.value === previous.value + 1);
    if (continues && current) {
      current.physicalEnd = physical;
    } else {
      current = { physicalStart: physical, physicalEnd: physical, printedStart: parsed.value, style: parsed.style, offset: parsed.style === "other" ? 0 : physical - parsed.value };
      segments.push(current);
    }
    previous = parsed;
  });
  return segments;
}

/**
 * Piecewise offsets from observed (physical page, printed number) pairs. Observations that share
 * a style and offset form a run; a run needs at least two agreeing observations to become a
 * segment, so a single stray number never creates one. A segment lasts until the next one starts.
 */
export function calibrateSegments(observations: Array<{ physicalPage: number; printed: string }>, pageCount: number): LabelSegment[] {
  const parsed = observations
    .map((o) => ({ physical: o.physicalPage, ...parseLabel(o.printed) }))
    .filter((o): o is { physical: number; style: "roman" | "arabic"; value: number } => o.style !== "other" && o.physical >= 1 && o.physical <= pageCount)
    .sort((a, b) => a.physical - b.physical);

  type Run = { style: "roman" | "arabic"; offset: number; items: typeof parsed };
  const runs: Run[] = [];
  for (const o of parsed) {
    const offset = o.physical - o.value;
    const last = runs[runs.length - 1];
    if (last && last.style === o.style && last.offset === offset) last.items.push(o);
    else runs.push({ style: o.style, offset, items: [o] });
  }
  // Re-merge runs split only by an isolated outlier observation between two agreeing neighbours.
  const merged: Run[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const prev = merged[merged.length - 1];
    const before = runs[i - 1];
    if (prev && before && run.items.length === 1 && before.items.length >= 2 && runs[i + 1]
      && runs[i + 1]!.style === prev.style && runs[i + 1]!.offset === prev.offset && runs[i + 1]!.items.length >= 2) continue;
    if (prev && prev.style === run.style && prev.offset === run.offset) prev.items.push(...run.items);
    else merged.push({ ...run, items: [...run.items] });
  }
  const agreed = merged.filter((r) => r.items.length >= 2);
  return agreed.map((run, i) => {
    const first = run.items[0]!;
    const next = agreed[i + 1];
    return {
      physicalStart: first.physical,
      physicalEnd: next ? next.items[0]!.physical - 1 : pageCount,
      printedStart: first.value,
      style: run.style,
      offset: run.offset,
    };
  });
}

/** Physical page for a printed label, or null when no segment can contain it. */
export function resolvePrintedPage(printed: string, segments: LabelSegment[]): number | null {
  const parsed = parseLabel(printed);
  if (parsed.style === "other") return null;
  for (const segment of segments) {
    if (segment.style !== parsed.style) continue;
    const physical = parsed.value + segment.offset;
    if (physical >= segment.physicalStart && physical <= segment.physicalEnd) return physical;
  }
  return null;
}

const STANDALONE_NUMBER = /^(?:page\s+|p\.\s*)?[-–—\s]*(\d{1,5}|[ivxlcdm]{1,8}|[IVXLCDM]{1,8})[-–—\s]*$/;

/** The printed page number in a page's header/footer: a standalone number or roman in its first/last three lines. */
export function readPrintedPageNumber(pageText: string): string | null {
  const lines = pageText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const candidates = [...lines.slice(-3).reverse(), ...lines.slice(0, 3)];
  for (const line of candidates) {
    if (line.length > 14) continue;
    const match = STANDALONE_NUMBER.exec(line);
    const token = match?.[1];
    if (!token) continue;
    const parsed = parseLabel(token);
    if (parsed.style === "other" || (parsed.style === "arabic" && parsed.value === 0)) continue;
    return token;
  }
  return null;
}
