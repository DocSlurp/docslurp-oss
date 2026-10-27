import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { buildCanonicalChunksFromDocument, buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { sanitizeExtractedMarkdown } from "../lib/extracted-markdown.js";
import { leadingFrontmatterLineCount, plainHeadingText, stripLeadingFrontmatter } from "../lib/markdown-structure.js";
import { chunkTextWithMeta } from "../pipeline/chunking.js";
import { buildHeuristicDocumentSummary } from "../stages/embedding-runtime.js";

const scriptsDir = fileURLToPath(new URL("../../scripts/", import.meta.url));
type MissingTables = (content: string, tables: unknown) => string[];
const { missingTableMarkdown } = (await import(path.join(scriptsDir, "kreuzberg_tables.mjs"))) as { missingTableMarkdown: MissingTables };

// What an HTML converter emits for `<title>`/`<meta>`: an unterminated metadata block whose
// last `key: value` line was read as a setext H2.
const MANGLED_METADATA = "---\nmeta-description: Upload from any language.\n\n## title: Widget API | Example docs\n\n";

function chunksFor(markdown: string) {
  const text = sanitizeExtractedMarkdown(markdown).markdown;
  const document = buildCanonicalDocumentFromMarkdown({ documentId: "doc", text, pageCount: 1, extractor: "test" });
  return { document, chunks: buildCanonicalChunksFromDocument(document, text, { maxChars: 400 }) };
}

describe("leading metadata blocks", () => {
  it("recognizes well-formed frontmatter", () => {
    const lines = "---\ntitle: Widget API\ntags:\n  - api\n---\n\n# Widget API\n".split("\n");
    expect(leadingFrontmatterLineCount(lines)).toBe(5);
  });

  it("recognizes an unterminated block whose last key became a heading", () => {
    expect(stripLeadingFrontmatter(`${MANGLED_METADATA}# Widget API\n\nBody.`).markdown).toBe("# Widget API\n\nBody.");
    expect(stripLeadingFrontmatter("---\n\n## title: Widget API | Example docs\n\n# Widget API").markdown).toBe("# Widget API");
  });

  it("leaves leading rules, prose and real headings alone", () => {
    for (const text of [
      "---\n\n## Note: read this first\n\nBody.",
      "---\nSome prose after a rule.\n---\n",
      "# Title\n\n---\ntitle: not at the start\n---",
      "---\n---\nBody",
    ]) {
      expect(stripLeadingFrontmatter(text).strippedLines).toBe(0);
    }
  });

  it("is removed by extraction sanitization", () => {
    const sanitized = sanitizeExtractedMarkdown(`${MANGLED_METADATA}# Widget API\n\nBody.`);
    expect(sanitized.markdown).toBe("# Widget API\n\nBody.");
    expect(sanitized.strippedFrontmatterLines).toBe(4);
  });
});

describe("plainHeadingText", () => {
  it("strips link, image, code and emphasis markup", () => {
    expect(plainHeadingText("[Self-host](/docs/self-host)")).toBe("Self-host");
    expect(plainHeadingText("Hello [World](/x \"t\") ![icon](a.svg)")).toBe("Hello World icon");
    expect(plainHeadingText("The `search` **endpoint** _today_ ##")).toBe("The search endpoint today");
    expect(plainHeadingText("<a id=\"x\"></a>Rate limits")).toBe("Rate limits");
    expect(plainHeadingText("snake_case_name and 2 * 3 * 4")).toBe("snake_case_name and 2 * 3 * 4");
  });
});

describe("canonical heading paths for converted HTML pages", () => {
  const page = [
    MANGLED_METADATA,
    "# [Widget API](/docs/widgets)",
    "",
    "One POST from any language.",
    "",
    "## Limits",
    "",
    "Requests are limited per key.",
    "",
    "```bash",
    "# Not a heading: a shell comment",
    "curl https://example.test",
    "```",
    "",
    "| Header | Meaning |",
    "| --- | --- |",
    "| Retry-After | Seconds to wait |",
  ].join("\n");

  it("never turns metadata into a heading or chunk text", () => {
    const { document, chunks } = chunksFor(page);
    expect(document.blocks.some((block) => block.text.includes("title:"))).toBe(false);
    for (const chunk of chunks) {
      expect(chunk.headingPath.some((heading) => heading.includes("title:"))).toBe(false);
      expect(chunk.text).not.toMatch(/^---/);
    }
  });

  it("uses plain heading text and the heading the chunk sits under", () => {
    const { chunks } = chunksFor(page);
    expect(chunks[0]?.headingPath).toEqual(["Widget API"]);
    const table = chunks.find((chunk) => chunk.text.includes("Retry-After"));
    expect(table?.headingPath).toEqual(["Widget API", "Limits"]);
  });

  it("does the same in the plain-text chunker, ignoring headings inside code fences", () => {
    const paths = [...chunkTextWithMeta(page, 400)].map((chunk) => chunk.headingPath);
    expect(paths.flat()).not.toContain("title: Widget API | Example docs");
    expect(paths.flat().some((heading) => heading.includes("Not a heading"))).toBe(false);
    expect(paths.at(-1)).toEqual(["Widget API", "Limits"]);
    expect(paths.flat().some((heading) => heading.includes("]("))).toBe(false);
  });

  it("builds chunk context from prose, not metadata or heading markup", () => {
    expect(buildHeuristicDocumentSummary("Widget API", page)).toBe("One POST from any language.");
  });
});

describe("missingTableMarkdown", () => {
  const padded = "## Limits\n\n| Header      | Meaning         |\n| ----------- | --------------- |\n| Retry-After | Seconds to wait |\n\n## Later section\n\nText.";
  const compact = { markdown: "| Header | Meaning |\n| --- | --- |\n| Retry-After | Seconds to wait |\n" };

  it("does not append a table the content already renders with padded cells", () => {
    expect(missingTableMarkdown(padded, [compact, compact])).toEqual([]);
  });

  it("appends a genuinely missing table once", () => {
    const other = { markdown: "| Code | Meaning |\n| --- | --- |\n| 402 | Out of credits |" };
    expect(missingTableMarkdown(padded, [other, other, compact])).toEqual([other.markdown]);
  });
});

describe("kreuzberg_extract.mjs on a minimal HTML docs page", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("produces chunks whose heading paths follow the page's own headings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kreuzberg-html-"));
    dirs.push(dir);
    const input = path.join(dir, "page.html");
    const output = path.join(dir, "page.md");
    await writeFile(input, [
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>Widget API | Example docs</title>",
      "<meta name=\"description\" content=\"Upload from any language.\"></head><body><main>",
      "<h1><a href=\"/docs/widgets\">Widget API</a></h1><p>One POST from any language.</p>",
      "<h2 id=\"limits\">Limits</h2><p>Requests are limited per key.</p>",
      "<table><thead><tr><th>Header</th><th>Meaning</th></tr></thead><tbody>",
      "<tr><td>Retry-After</td><td>Seconds to wait before retrying the request</td></tr>",
      "<tr><td>X-Limit</td><td>Requests allowed</td></tr></tbody></table>",
      "<h2>Sponsor</h2><p>Thanks to our sponsor.</p><h3>Footnotes</h3><p>Last words.</p>",
      "</main></body></html>",
    ].join(""));
    await promisify(execFile)(process.execPath, [path.join(scriptsDir, "kreuzberg_extract.mjs"), "--input", input, "--output", output], { timeout: 60_000 });
    const raw = await readFile(output, "utf8");
    // The table is rendered inline once and not appended again after the last heading.
    expect(raw.match(/Retry-After/g)).toHaveLength(1);

    const { chunks } = chunksFor(raw);
    const headings = new Set(chunks.flatMap((chunk) => chunk.headingPath));
    expect([...headings]).toEqual(["Widget API", "Limits", "Sponsor", "Footnotes"]);
    const table = chunks.find((chunk) => chunk.text.includes("Retry-After"));
    expect(table?.headingPath).toEqual(["Widget API", "Limits"]);
  });
});
