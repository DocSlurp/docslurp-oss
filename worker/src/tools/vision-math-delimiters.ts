/** General Markdown repair for page transcriptions whose math lost its `$` / `$$` delimiters. */

/** Structured-math LaTeX that never appears in ordinary prose or a Markdown table. */
const STRUCTURED_LATEX = /\\(?:begin|end)\{[a-z]+\*?\}|\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|mathbf|mathcal|mathrm|vec|hat|bar|partial|nabla|infty|cdot|times|le|ge|neq|approx|alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega|pi)(?![a-zA-Z])/;

/**
 * Restore math delimiters a model sometimes drops. Converts `\(…\)` / `\[…\]` to
 * `$…$` / `$$…$$`, and wraps a stand-alone line of bare structured LaTeX (no `$`,
 * not a heading, list item, quote, table row or code-like line) in `$$…$$`; a
 * bare `\begin{env}` line is wrapped through its matching `\end{env}`. Fenced
 * code and existing `$$` blocks are left as they are.
 */
export function normalizeMarkdownMathDelimiters(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fenced = false;
  let display = false;
  // An unclosed `\(` or `\[` spanning lines: leave everything verbatim until it closes.
  let openSpan: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) fenced = !fenced;
    if (fenced || /^(```|~~~)/.test(trimmed)) {
      out.push(line);
      continue;
    }
    if (openSpan) {
      if (line.includes(openSpan)) openSpan = null;
      out.push(line);
      continue;
    }
    if (display) {
      if (trimmed === "\\]") {
        out.push("$$");
        display = false;
        continue;
      }
      if (trimmed.endsWith("$$")) display = false;
      out.push(line);
      continue;
    }
    if (trimmed === "\\[") {
      out.push("$$");
      display = true;
      continue;
    }
    if (trimmed.startsWith("$$") && (trimmed === "$$" || !trimmed.slice(2).includes("$$"))) {
      display = true;
      out.push(line);
      continue;
    }
    const converted = line
      .replace(/(?<!\\)\\\[(.+?)(?<!\\)\\\]/g, (_m, body: string) => `$$${body}$$`)
      .replace(/(?<!\\)\\\((.+?)(?<!\\)\\\)/g, (_m, body: string) => `$${body}$`);
    const unclosed = /(?<!\\)\\([([])/.exec(converted);
    if (unclosed) {
      openSpan = unclosed[1] === "(" ? "\\)" : "\\]";
      out.push(line);
      continue;
    }
    const bare = converted.trim();
    const candidate = bare && !bare.includes("$") && !/^(#|\||>|[-*+]\s|\d+[.)]\s)/.test(bare) && STRUCTURED_LATEX.test(bare);
    const env = candidate ? /^\\begin\{([^}]+)\}/.exec(bare)?.[1] : undefined;
    const multiline = Boolean(env) && !bare.includes(`\\end{${env}}`);
    if (multiline) {
      const end = lines.findIndex((l, j) => j > i && l.includes(`\\end{${env}}`));
      if (end > i && lines.slice(i + 1, end + 1).every((l) => !l.includes("$") && !/^\s*(```|~~~)/.test(l))) {
        out.push("$$", ...lines.slice(i, end + 1), "$$");
        i = end;
        continue;
      }
    }
    // A bare `;` (not the `\;` space) or a trailing `{` reads as code, not a formula.
    out.push(candidate && !multiline && !/(?<!\\);|\{\s*$/.test(bare) ? `$$${bare}$$` : converted);
  }
  return out.join("\n");
}
