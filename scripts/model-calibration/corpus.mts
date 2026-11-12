// Corpus helpers: documents, heading sections, pseudo pages and deterministic dev/held-out splits.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const dir = new URL("./corpus/", import.meta.url);
export const facts: Array<{ id: string; title: string; kind: string; language: string; facts: string[] }> =
  JSON.parse(readFileSync(new URL("facts.json", dir), "utf8"));
export const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));

export function docText(id: string): string {
  return readFileSync(new URL(`${id}.md`, dir), "utf8");
}
export function docTitle(id: string): string {
  return facts.find((f) => f.id === id)!.title;
}
export const docIds = facts.map((f) => f.id);

export interface Section { id: string; doc: string; heading: string; path: string; text: string; page: number }

/** Split a document on `#`/`##`/`###` headings; each section is one retrievable passage. */
export function sections(doc: string): Section[] {
  const lines = docText(doc).split("\n");
  const out: Section[] = [];
  const trail: string[] = [];
  let current: { heading: string; path: string; lines: string[] } | null = null;
  const flush = () => {
    if (current && current.lines.join("\n").trim().length > 40) {
      out.push({ id: `${doc}#${out.length + 1}`, doc, heading: current.heading, path: current.path, text: current.lines.join("\n").trim(), page: out.length + 1 });
    }
  };
  for (const line of lines) {
    const match = /^(#{1,3})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      const level = match[1]!.length;
      trail.length = level - 1;
      trail[level - 1] = match[2]!.trim();
      current = { heading: match[2]!.trim(), path: trail.filter(Boolean).join(" > "), lines: [line] };
    } else {
      current ??= { heading: "(preamble)", path: "(preamble)", lines: [] };
      current.lines.push(line);
    }
  }
  flush();
  return out;
}

/** The section that contains every gold alternative group (first match), or the best partial. */
export function goldSection(doc: string, gold: string[][] | undefined): Section | undefined {
  if (!gold?.length) return undefined;
  let best: { section: Section; hits: number } | undefined;
  for (const section of sections(doc)) {
    const hits = gold.filter((group) => group.some((alt) => section.text.includes(alt))).length;
    if (!best || hits > best.hits) best = { section, hits };
  }
  return best && best.hits > 0 ? best.section : undefined;
}

/** Pseudo pages of ~350 words for page-oriented features (document map). */
export function pages(doc: string): string[] {
  const words = docText(doc).split(/(?<=\n)/);
  const out: string[] = []; let buffer = "";
  for (const piece of words) {
    buffer += piece;
    if (buffer.split(/\s+/).length > 350) { out.push(buffer); buffer = ""; }
  }
  if (buffer.trim()) out.push(buffer);
  return out;
}

/** Stable split: about one third of cases are held out and never used to choose a setting. */
export function split(caseId: string): "dev" | "heldout" {
  return createHash("sha256").update(`mm31-v1:${caseId}`).digest()[0]! % 3 === 0 ? "heldout" : "dev";
}

export function seededShuffle<T>(items: T[], seed: string): T[] {
  return items
    .map((item, index) => ({ item, key: createHash("sha256").update(`${seed}:${index}`).digest().readUInt32BE(0) }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}

/** Retrieval stand-in: the gold section plus four distractors (two same-document, two other-document). */
export function evidenceFor(caseId: string, doc: string, gold?: string[][]): Section[] {
  const own = sections(doc);
  const target = goldSection(doc, gold);
  const sameDoc = seededShuffle(own.filter((s) => s !== target), `${caseId}:same`).slice(0, target ? 2 : 3);
  const others = seededShuffle(docIds.filter((d) => d !== doc).flatMap((d) => sections(d)), `${caseId}:other`).slice(0, 2);
  return seededShuffle([...(target ? [target] : []), ...sameDoc, ...others], `${caseId}:order`);
}
