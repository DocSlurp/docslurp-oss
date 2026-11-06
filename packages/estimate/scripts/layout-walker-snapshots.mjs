#!/usr/bin/env node
// Record the core layout walker's facts (worker/scripts/pdf_layout_facts.py, pdf-layout-facts@1) for the routing eval's
// fixtures, so the profiler's Rust port is cross-checked against them (tests/layout_walker.rs). Inputs are the walker's
// own: the PDF, Poppler's `pdfimages -list`, and the recorded Doppler `-bbox-layout -rules` XHTML and Markdown
// (worker/testdata/pdf-fixtures/doppler-md). Needs python3 and pdfimages.
//
//   node scripts/layout-walker-snapshots.mjs           write tests/layout-walker/*.json
//   node scripts/layout-walker-snapshots.mjs --check   exit 1 when a snapshot differs from the walker's current output
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = resolve(root, "../..");
const fixtures = join(core, "worker/testdata/pdf-fixtures");
const recorded = join(fixtures, "doppler-md");
const walker = join(core, "worker/scripts/pdf_layout_facts.py");
const out = join(root, "tests/layout-walker");
const check = process.argv.includes("--check");

/** The fixtures with a recorded Doppler run, by name. */
export function walkerFixtures() {
  return readdirSync(recorded)
    .filter((name) => name.endsWith(".pdf.xhtml"))
    .map((name) => name.slice(0, -".xhtml".length))
    .filter((name) => existsSync(join(fixtures, name)))
    .sort();
}

/** The walker's facts for one fixture, kept to the fields the profiler mirrors. */
export function walkerFacts(name, scratch) {
  const pdf = join(fixtures, name);
  const listing = join(scratch, `${name}.list`);
  writeFileSync(listing, execFileSync("pdfimages", ["-list", pdf]));
  const xhtml = readFileSync(join(recorded, `${name}.xhtml`), "utf8");
  const pages = Math.max(1, (xhtml.match(/<page /g) ?? []).length);
  const args = [
    "-I", walker, "--input", pdf, "--first", "1", "--last", String(pages), "--listing", listing,
    "--xhtml", join(recorded, `${name}.xhtml`), "--markdown", join(recorded, `${name}.md`),
  ];
  const facts = JSON.parse(execFileSync("python3", args, { encoding: "utf8" }));
  return {
    walker: facts.version,
    pages: facts.pages.map((page) => ({
      pageNumber: page.pageNumber,
      known: page.known,
      words: page.words,
      widthPt: page.widthPt ?? null,
      heightPt: page.heightPt ?? null,
      images: page.images?.map((image) => ({
        bbox: image.bbox, coverage: image.coverage, widthPx: image.widthPx, heightPx: image.heightPx,
        bitsPerComponent: image.bitsPerComponent, encoding: image.encoding, ppi: image.ppi, bytesPerPixel: image.bytesPerPixel,
        repeated: image.repeated, wordsInside: image.wordsInside,
      })) ?? null,
      grids: page.grids ?? null,
      tableCoverage: page.tableCoverage ?? null,
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "layout-walker-"));
  let stale = 0;
  try {
    for (const name of walkerFixtures()) {
      const text = `${JSON.stringify(walkerFacts(name, scratch), null, 1)}\n`;
      const file = join(out, `${name}.json`);
      if (check) {
        if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
          stale += 1;
          console.error(`stale: ${file}`);
        }
      } else {
        writeFileSync(file, text);
        console.log(`wrote ${file}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (stale > 0) process.exit(1);
}
