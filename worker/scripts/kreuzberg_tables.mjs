/**
 * Tables Kreuzberg reports separately that the main content does not already
 * contain. Comparison ignores Markdown table syntax and column padding, so a
 * table rendered inline with padded cells is not appended a second time (an
 * appended copy lands after the document's last heading and inherits its
 * section). Duplicate entries in `tables` are reported once.
 */
export function missingTableMarkdown(content, tables) {
  if (!Array.isArray(tables) || tables.length === 0) return [];
  const haystack = normalizeTableText(content);
  const seen = new Set();
  const missing = [];
  for (const table of tables) {
    const markdown = typeof table?.markdown === "string" ? table.markdown.trim() : "";
    if (!markdown) continue;
    const key = normalizeTableText(markdown);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (haystack.includes(key.slice(0, 120))) continue;
    missing.push(markdown);
  }
  return missing;
}

function normalizeTableText(text) {
  return String(text)
    .toLowerCase()
    .split("\n")
    // Delimiter rows (`| --- | :-: |`) carry no content.
    .filter((line) => !(/^[\s|:-]+$/.test(line) && line.includes("-")))
    .join(" ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
