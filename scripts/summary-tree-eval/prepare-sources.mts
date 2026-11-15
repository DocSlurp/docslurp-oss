/**
 * Summary-tree phase-0 eval: turn externally stored public-domain sources into
 * the paged Markdown the harness chunks.
 *
 *   tsx scripts/summary-tree-eval/prepare-sources.mts MANIFEST ROOT [--write-hashes]
 *
 * ROOT holds `raw/` (downloaded bytes, never in this repository) and receives
 * `sources/<id>.md`. The manifest names each source's URL, licence, converter
 * and hashes. A hash mismatch fails; `--write-hashes` records hashes for a new
 * manifest entry and is the only mode that edits the manifest.
 *
 * Conversion is mechanical and generic: pandoc for HTML and EPUB, the
 * publisher's own plain-text rendition otherwise, with the distributor's
 * licence wrapper cut at its documented marker lines. Pages are the product's
 * text page rule (measuredTextPages), with breaks placed on paragraph
 * boundaries so no paragraph straddles a page.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { measuredTextPages } from "../../packages/shared/dist/index.js";

export type SourceEntry = {
  id: string; title: string; author: string; licence: string; url: string; retrieved: string;
  rawFile: string; rawSha256?: string; converter: "pandoc-html" | "pandoc-epub" | "plain-text";
  wrapper?: "gutenberg"; preparedSha256?: string; pages?: number; role: "corpus" | "version-pair";
  /** Version-pair renditions name the corpus document they re-extract. */
  renditionOf?: string;
};

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Cut the distributor's wrapper: everything outside its START/END marker lines. */
export function cutGutenbergWrapper(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /\*{3}\s*START OF TH(E|IS) PROJECT GUTENBERG/i.test(line.replaceAll("\\", "")));
  const end = lines.findIndex((line) => /\*{3}\s*END OF TH(E|IS) PROJECT GUTENBERG/i.test(line.replaceAll("\\", "")));
  if (start < 0 || end < 0 || end <= start) throw new Error("Distributor wrapper markers not found");
  return lines.slice(start + 1, end).join("\n").trim();
}

/** Exactly `measuredTextPages(text)` pages, each break on the paragraph boundary nearest its even share. */
export function paginate(text: string): { text: string; pages: number } {
  const clean = text.replace(/\r\n/g, "\n").replace(/\f/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const paragraphs = clean.split("\n\n");
  const pages = Math.min(measuredTextPages(clean), paragraphs.length);
  const out: string[][] = [[]];
  let consumed = 0;
  for (const paragraph of paragraphs) {
    const target = (out.length * clean.length) / pages;
    if (out.length < pages && out[out.length - 1]!.length > 0 && consumed + paragraph.length / 2 > target) out.push([]);
    out[out.length - 1]!.push(paragraph);
    consumed += paragraph.length + 2;
  }
  // Fewer breaks than pages can only happen with giant paragraphs; the page count is then what was produced.
  return { text: out.map((page) => page.join("\n\n")).join("\n\f\n"), pages: out.length };
}

export function convert(entry: SourceEntry, rawPath: string): string {
  const pandoc = (from: string) => execFileSync("pandoc", ["-f", from, "-t", "gfm-raw_html", "--wrap=none", rawPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const text = entry.converter === "pandoc-html" ? pandoc("html") : entry.converter === "pandoc-epub" ? pandoc("epub") : readFileSync(rawPath, "utf8").replace(/^﻿/, "");
  return entry.wrapper === "gutenberg" ? cutGutenbergWrapper(text.replace(/\r\n/g, "\n")) : text.replace(/\r\n/g, "\n").trim();
}

if (process.argv[1]?.endsWith("prepare-sources.mts")) {
  const [manifestPath, root, flag] = process.argv.slice(2);
  if (!manifestPath || !root) throw new Error("Usage: prepare-sources.mts MANIFEST ROOT [--write-hashes]");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sources: SourceEntry[] };
  mkdirSync(join(root, "sources"), { recursive: true });
  for (const entry of manifest.sources) {
    const rawPath = join(root, "raw", entry.rawFile);
    const rawSha = sha(readFileSync(rawPath));
    const prepared = paginate(convert(entry, rawPath));
    const preparedSha = sha(prepared.text);
    if (flag === "--write-hashes") Object.assign(entry, { rawSha256: rawSha, preparedSha256: preparedSha, pages: prepared.pages });
    else if (entry.rawSha256 !== rawSha || entry.preparedSha256 !== preparedSha || entry.pages !== prepared.pages) throw new Error(`Hash or page mismatch for ${entry.id}; sources changed since the manifest was frozen`);
    writeFileSync(join(root, "sources", `${entry.id}.md`), prepared.text);
    console.log(entry.id, prepared.pages, "pages", prepared.text.length, "chars", (prepared.text.match(/^#{1,6} /gm) ?? []).length, "headings");
  }
  if (flag === "--write-hashes") writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
