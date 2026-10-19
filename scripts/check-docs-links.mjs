#!/usr/bin/env node
// Checks relative links and heading anchors in the public Markdown docs.
//
//   node scripts/check-docs-links.mjs [files...]
//
// With no arguments it checks README.md, docs/**/*.md (except docs/superpowers)
// and packages/*/README.md. Exit 1 prints one `path:line: broken link <target>`
// line per failure. External links (any URL scheme) are not fetched.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** GitHub's heading anchor for one heading's text (without duplicate suffixes). */
export function githubSlug(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`/g, "")
    .replace(/\*+/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu, "$1")
    .replace(/(?<=[\p{L}\p{N}])_+(?=$|[^\p{L}\p{N}_])/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/** Lines of Markdown with fenced code blocks and inline code blanked, keeping line numbers. */
function proseLines(markdown) {
  const lines = markdown.split("\n");
  let fence = null;
  return lines.map((line) => {
    const match = FENCE.exec(line);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && line.trim() === match[1]) fence = null;
      return null;
    }
    if (match) {
      fence = match[1];
      return null;
    }
    return line.replace(/(`+)[^`]*?\1/g, (code) => " ".repeat(code.length));
  });
}

/** Link targets (inline, image and reference definitions) outside code, without external schemes. */
export function extractLinks(markdown) {
  const links = [];
  proseLines(markdown).forEach((line, index) => {
    if (line === null) return;
    const add = (raw) => {
      const target = raw.trim().replace(/^<(.*)>$/, "$1");
      if (target && !SCHEME.test(target)) links.push({ target, line: index + 1 });
    };
    const definition = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
    if (definition) add(definition[1]);
    for (const m of line.matchAll(/\]\(\s*(<[^>]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) add(m[1]);
  });
  return links;
}

/** Every anchor a Markdown file defines: heading slugs (with -1, -2 suffixes) and explicit ids. */
function anchorsOf(markdown) {
  const anchors = new Set();
  const seen = new Map();
  for (const line of proseLines(markdown)) {
    if (line === null) continue;
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) {
      const slug = githubSlug(heading[1]);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${count}`);
    }
    for (const m of line.matchAll(/<a\s[^>]*?\b(?:id|name)=["']([^"']+)["']/gi)) anchors.add(m[1]);
  }
  return anchors;
}

const anchorCache = new Map();
function anchorsForFile(path) {
  if (!anchorCache.has(path)) anchorCache.set(path, anchorsOf(readFileSync(path, "utf8")));
  return anchorCache.get(path);
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Broken links in one Markdown file. */
export function checkFile(path) {
  const file = resolve(path);
  const broken = [];
  for (const { target, line } of extractLinks(readFileSync(file, "utf8"))) {
    const hashAt = target.indexOf("#");
    const rawPath = (hashAt < 0 ? target : target.slice(0, hashAt)).replace(/\?.*$/, "");
    const anchor = hashAt < 0 ? "" : decode(target.slice(hashAt + 1));
    const dest = rawPath === "" ? file : rawPath.startsWith("/") ? join(ROOT, decode(rawPath)) : resolve(dirname(file), decode(rawPath));
    let ok = existsSync(dest);
    if (ok && anchor && statSync(dest).isFile() && dest.endsWith(".md")) ok = anchorsForFile(dest).has(anchor.toLowerCase()) || anchorsForFile(dest).has(anchor);
    if (!ok) broken.push({ line, target });
  }
  return broken;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(ROOT, full) === join("docs", "superpowers")) continue;
      walk(full, out);
    } else if (entry.name.endsWith(".md")) out.push(full);
  }
}

/** README.md, docs/**\/*.md (minus docs/superpowers) and packages/*\/README.md as absolute paths. */
export function defaultFiles() {
  const files = [];
  if (existsSync(join(ROOT, "README.md"))) files.push(join(ROOT, "README.md"));
  if (existsSync(join(ROOT, "docs"))) walk(join(ROOT, "docs"), files);
  for (const pkg of existsSync(join(ROOT, "packages")) ? readdirSync(join(ROOT, "packages")) : []) {
    const readme = join(ROOT, "packages", pkg, "README.md");
    if (existsSync(readme)) files.push(readme);
  }
  return files;
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.map((f) => resolve(f)) : defaultFiles();
  let failures = 0;
  for (const file of files) {
    for (const { line, target } of checkFile(file)) {
      console.log(`${relative(process.cwd(), file)}:${line}: broken link ${target}`);
      failures += 1;
    }
  }
  if (failures > 0) {
    console.error(`${failures} broken link(s)`);
    process.exit(1);
  }
  console.log(`checked ${files.length} file(s): no broken links`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
