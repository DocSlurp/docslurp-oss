import { constants } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import {
  imageAnchorMarkdown, insertImageAnchors, markdownBlocks, planImageRouting,
  type ImageInsertion,
} from "@docslurp/shared";

import { embeddedImageArtifactId, validateEmbeddedImageSet } from "./embedded-images.js";
import type { EmbeddedImageSet } from "./plugins.js";

export const MAX_ANCHORED_MARKDOWN_BYTES = 128 * 1024 * 1024;

export interface ImageAnchorOutcome {
  /** References inserted into the Markdown. */
  anchored: number;
  /** References placed at the end of their page because the producer's block count disagreed with this side's. */
  blockMismatch: number;
  /** Images the router left out (decorative, blank, duplicate, backed by a text layer) and masks. */
  omitted: number;
  /** Set when nothing was inserted for a reason that applies to the whole document. */
  reason?: "page-slots";
}

/**
 * Insert a reference for every routed-in image at the reading-order position the producer computed. Pure: the
 * Markdown in, the Markdown out, everything else byte for byte. The producer counted Markdown blocks over the same
 * text; when this side counts a different number, or the producer had no position, the reference goes at the end of
 * its page.
 */
export function anchorImagesInMarkdown(markdown: string, images: EmbeddedImageSet, sourceDocumentId: string): { markdown: string; outcome: ImageAnchorOutcome } {
  const pages = markdown.split("\f");
  const outcome: ImageAnchorOutcome = { anchored: 0, blockMismatch: 0, omitted: 0 };
  if (pages.length !== images.pageCount) return { markdown, outcome: { ...outcome, omitted: images.placements.length, reason: "page-slots" } };
  const planned = planImageRouting(images.placements, { pageCount: images.pageCount });
  const mediaTypes = new Map(images.assets.map((asset) => [asset.sha256, asset.mediaType]));
  const blocks = pages.map((page) => markdownBlocks(page).length);
  const ordered: Array<{ insertion: ImageInsertion; y: number; x: number; occurrence: number }> = [];
  images.placements.forEach((p, index) => {
    if (!planned[index]!.markdownIncluded) { outcome.omitted += 1; return; }
    const count = blocks[p.pageNumber - 1]!;
    const trusted = p.anchor !== null && p.anchor.blocks === count;
    if (!trusted) outcome.blockMismatch += 1;
    const [x, y] = p.placement.status === "known" ? [p.placement.bbox[0], p.placement.bbox[1]] : [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    ordered.push({
      insertion: {
        pageNumber: p.pageNumber, block: trusted ? p.anchor!.block : count,
        line: imageAnchorMarkdown({
          artifactId: embeddedImageArtifactId(sourceDocumentId, p.sha256, mediaTypes.get(p.sha256)),
          pageNumber: p.pageNumber, occurrence: p.occurrence, alt: p.alt?.text,
        }),
      },
      y, x, occurrence: p.occurrence,
    });
    outcome.anchored += 1;
  });
  // Several references before one block read top to bottom, then left to right.
  ordered.sort((a, b) => a.insertion.pageNumber - b.insertion.pageNumber || a.insertion.block - b.insertion.block || a.y - b.y || a.x - b.x || a.occurrence - b.occurrence);
  return { markdown: insertImageAnchors(markdown, ordered.map((o) => o.insertion)), outcome };
}

/** Rewrite a Markdown file in place (atomically) with its image references. */
export async function anchorImageMarkdownFile(args: { markdownPath: string; images: EmbeddedImageSet; sourceDocumentId: string }): Promise<ImageAnchorOutcome> {
  const images = validateEmbeddedImageSet(args.images, args.images.pageCount);
  const file = await open(args.markdownPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_ANCHORED_MARKDOWN_BYTES) throw new Error("Invalid extractor Markdown for image references");
    text = await file.readFile("utf8");
  } finally { await file.close(); }
  const { markdown, outcome } = anchorImagesInMarkdown(text, images, args.sourceDocumentId);
  if (markdown !== text) {
    const staged = `${args.markdownPath}.anchored`;
    await writeFile(staged, markdown, { flag: "wx", mode: 0o600 });
    await rename(staged, args.markdownPath);
  }
  console.log(`[embedded-images] markdown document=${args.sourceDocumentId} anchored=${outcome.anchored} omitted=${outcome.omitted} blockMismatch=${outcome.blockMismatch}${outcome.reason ? ` reason=${outcome.reason}` : ""}`);
  return outcome;
}
