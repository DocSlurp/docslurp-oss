/**
 * Chart export's visual group markers (`chart-export/markdown.ts`): HTML comments around each exported block, carrying
 * the visual id and a per-export nonce so a reprocess finds exactly the groups it wrote. They matter only to that
 * reprocess, so text projections for search (chunks, embeddings, snippets, chat context) drop them.
 */

/**
 * `<!-- docslurp:visual <id> <nonce> -->` and `<!-- /docslurp:visual <id> <nonce> -->`, each on a line of its own (the
 * export always writes them so: `wrapVisualGroup`). Whole lines only, so removing one can never join the text on either
 * side into a token, such as a tag name split by a marker (council round 5 M3).
 */
export const VISUAL_MARKER_COMMENT = /^[ \t]*<!-- \/?docslurp:visual [A-Za-z0-9_-]{1,64} [0-9a-f]{16} -->[ \t]*(?:\n|$)/gm;

/** Text without visual group markers (the blocks themselves stay: they are searchable content). */
export function stripVisualMarkerComments(text: string): string {
  if (!text.includes("docslurp:visual")) return text;
  return text.replace(VISUAL_MARKER_COMMENT, "");
}
