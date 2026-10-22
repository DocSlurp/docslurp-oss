/** General Markdown repair for page transcriptions that arrive wrapped in one Markdown code fence. */

const WHOLE_MARKDOWN_FENCE = /^```(?:markdown|md|gfm)[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/i;

/**
 * Removes one `markdown` / `md` / `gfm` fence that wraps the entire output. Untagged or other-language
 * fences (a page that is a code listing), fences that do not span the whole text and outputs with
 * inner fences are kept.
 */
export function unwrapWholeMarkdownFence(text: string): string {
  const match = WHOLE_MARKDOWN_FENCE.exec(text.trim());
  if (!match || match[1]!.includes("\n```")) return text;
  return match[1]!.trim();
}
