import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parsePageLayoutFacts, type PageLayoutFacts } from "../stages/classify-route.js";
import type { CommandRunner } from "../tools/runner.js";

/** Pages the layout walker is run over at most per document (its own bound is 5,000). */
export const MAX_LAYOUT_PAGES = 5_000;

/**
 * Structural page layout for routing (pdf-layout-facts@1), collected through the runner, so the commands run in the parser
 * sandbox: `pdfimages -list`, `pdftotext -bbox-layout` and the open layout walker (scripts/pdf_layout_facts.py) over the
 * extractor's Markdown. For customer-owned local mode and the routing eval; a VM deployment gets the same facts from the
 * PDF VM's result. Null when a step is unavailable or fails: routing then has no layout facts, never invented ones.
 */
export async function collectPageLayoutFacts(args: {
  runner: Pick<CommandRunner, "listPdfImages" | "pdfWordBoxes" | "pdfLayoutFacts" | "run">;
  sourcePath: string;
  pageCount: number;
  markdown: string;
  /** Word boxes already produced (the routing eval's recorded Doppler XHTML); otherwise they are extracted here. */
  wordBoxesFile?: string;
  signal?: AbortSignal;
}): Promise<Map<number, PageLayoutFacts> | null> {
  if (!Number.isSafeInteger(args.pageCount) || args.pageCount < 1 || args.pageCount > MAX_LAYOUT_PAGES) return null;
  const scratch = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "docslurp-layout-"));
  try {
    const listingPlan = await args.runner.listPdfImages(args.sourcePath, 1, args.pageCount);
    const wordBoxes = args.wordBoxesFile ?? path.join(scratch, "words.xhtml");
    const wordPlan = args.wordBoxesFile ? null : await args.runner.pdfWordBoxes(args.sourcePath, 1, args.pageCount, wordBoxes);
    if (!listingPlan.available || (wordPlan && !wordPlan.available)) return null;
    const listing = path.join(scratch, "listing.txt");
    await writeFile(listing, (await args.runner.run(listingPlan, args.signal)).stdout);
    if (wordPlan) await args.runner.run(wordPlan, args.signal);
    const markdown = path.join(scratch, "extracted.md");
    await writeFile(markdown, args.markdown);
    const factsPlan = await args.runner.pdfLayoutFacts({ source: args.sourcePath, lastPage: args.pageCount, listing, wordBoxes, markdown });
    if (!factsPlan.available) return null;
    const pages = parsePageLayoutFacts(JSON.parse((await args.runner.run(factsPlan, args.signal)).stdout));
    return pages.size > 0 ? pages : null;
  } catch (error) {
    console.warn(`[layout] facts unavailable: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
