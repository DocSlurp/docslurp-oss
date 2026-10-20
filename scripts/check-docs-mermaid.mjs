#!/usr/bin/env node
// Renders every ```mermaid block in the public docs so a syntax error fails CI.
//
//   node scripts/check-docs-mermaid.mjs [files...]
//
// Defaults to README.md, docs/**/*.md (except historical docs/superpowers),
// and packages/*/README.md. Other files can be passed explicitly. The renderer is
// fetched on demand with npx at a pinned version (it downloads Chromium, so it
// is deliberately not a devDependency). Set MMDC to a local mmdc binary to
// skip npx. Set PUPPETEER_EXECUTABLE_PATH to use an installed Chrome or Chromium
// when puppeteer has not downloaded its own browser.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicDocsFiles } from "./check-docs-links.mjs";

export const MERMAID_CLI_VERSION = "11.17.0";

/** Mermaid fenced blocks in a Markdown file: `{ line, source }` where line is the opening fence. */
export function extractMermaid(markdown) {
  const blocks = [];
  let open = null;
  markdown.split("\n").forEach((text, index) => {
    const fence = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/.exec(text);
    if (open) {
      if (fence && fence[1][0] === open.marker[0] && fence[1].length >= open.marker.length && text.trim() === fence[1]) {
        if (open.mermaid) blocks.push({ line: open.line, source: open.lines.join("\n") });
        open = null;
      } else open.lines.push(text);
    } else if (fence) {
      open = { marker: fence[1], mermaid: fence[2].toLowerCase() === "mermaid", line: index + 1, lines: [] };
    }
  });
  return blocks;
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.map((f) => resolve(f)) : publicDocsFiles();
  const blocks = files.flatMap((file) => extractMermaid(readFileSync(file, "utf8")).map((block) => ({ ...block, file })));
  if (blocks.length === 0) {
    console.log("no mermaid blocks");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "docs-mermaid-"));
  const puppeteer = join(dir, "puppeteer.json");
  writeFileSync(puppeteer, JSON.stringify({ args: ["--no-sandbox"] }));
  const command = process.env.MMDC ? [process.env.MMDC] : ["npx", "--yes", `@mermaid-js/mermaid-cli@${MERMAID_CLI_VERSION}`];
  const failures = [];
  try {
    blocks.forEach((block, index) => {
      const input = join(dir, `block-${index}.mmd`);
      writeFileSync(input, `${block.source}\n`);
      const result = spawnSync(command[0], [...command.slice(1), "-i", input, "-o", `${input}.svg`, "-p", puppeteer], { encoding: "utf8", timeout: 120000 });
      const location = `${relative(process.cwd(), block.file)}:${block.line}`;
      if (result.status !== 0) {
        failures.push(location);
        console.log(`${location}: mermaid block failed to render`);
        const detail = `${result.stderr ?? ""}${result.stdout ?? ""}${result.error ? String(result.error) : ""}`.trim();
        if (detail) console.log(detail.split("\n").map((l) => `  ${l}`).join("\n"));
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`${failures.length} of ${blocks.length} mermaid block(s) failed`);
    process.exit(1);
  }
  console.log(`rendered ${blocks.length} mermaid block(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
