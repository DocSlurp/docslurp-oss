/**
 * Chunk and embed every corpus source, writing one chunk artifact per document
 * under the external eval root.
 *
 *   tsx scripts/summary-tree-eval/corpus.mts MANIFEST [--dry-run]
 *
 * `--dry-run` chunks only (no provider call) and prints the size of the paid work.
 */
import { writeFileSync } from "node:fs";

import { buildCanonicalChunksFromDocument, buildCanonicalDocumentFromMarkdown } from "../../worker/src/lib/canonical-document.js";
import { artifactPath, buildDocument, leavesOf, loadManifest, sourceText } from "./lib.mts";

const [manifestPath, flag] = process.argv.slice(2);
if (!manifestPath) throw new Error("Usage: corpus.mts MANIFEST [--dry-run]");
const sources = loadManifest(manifestPath).sources.filter((source) => source.role === "corpus");
let chunks = 0, chars = 0;
for (const source of sources) {
  if (flag === "--dry-run") {
    const text = sourceText(source.id);
    const drafts = buildCanonicalChunksFromDocument(buildCanonicalDocumentFromMarkdown({ documentId: source.id, text, pageCount: text.split("\f").length, extractor: "eval" }), source.title, {});
    chunks += drafts.length; chars += drafts.reduce((sum, chunk) => sum + chunk.text.length, 0);
    const paths = new Set(drafts.map((chunk) => chunk.headingPath.join(" > ")));
    console.log(source.id, drafts.length, "chunks", paths.size, "heading paths", Math.round(drafts.reduce((sum, chunk) => sum + chunk.text.length, 0) / drafts.length), "chars/chunk");
    continue;
  }
  const document = await buildDocument(source, { step: "corpus" });
  writeFileSync(artifactPath(document.id), JSON.stringify(document));
  const { leaves } = leavesOf(document);
  console.log(document.id, document.pages, "pages", document.chunks.length, "chunks", leaves.length, "leaves");
}
if (flag === "--dry-run") console.log("total", chunks, "chunks", chars, "chars");
process.exit(0);
