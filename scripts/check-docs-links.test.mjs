import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { checkFile, defaultFiles, extractLinks, githubSlug, publicDocsFiles } from "./check-docs-links.mjs";

const fixtures = [];
after(() => fixtures.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "docs-links-"));
  fixtures.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

test("githubSlug follows GitHub rules", () => {
  assert.equal(githubSlug("Storage configuration"), "storage-configuration");
  assert.equal(githubSlug("Client IP behind a proxy or CDN"), "client-ip-behind-a-proxy-or-cdn");
  assert.equal(githubSlug("Data, upgrades, and recovery"), "data-upgrades-and-recovery");
  assert.equal(githubSlug("`STORAGE_URI` options"), "storage_uri-options");
});

test("extractLinks ignores fenced code, inline code and external schemes", () => {
  const md = [
    "[a](one.md)",
    "```",
    "[b](fenced.md)",
    "```",
    "`[c](inline.md)` and [d](two.md#x)",
    "[e](https://example.com) [f](http://example.com) [g](mailto:a@b.c)",
    "[ref]: three.md",
  ].join("\n");
  assert.deepEqual(extractLinks(md), [
    { target: "one.md", line: 1 },
    { target: "two.md#x", line: 5 },
    { target: "three.md", line: 7 },
  ]);
});

test("missing files are broken, directories are valid", () => {
  const dir = fixture({ "a.md": "[x](missing.md) [y](sub) [z](b.md)\n", "b.md": "# B\n", "sub/c.md": "# C\n" });
  assert.deepEqual(checkFile(join(dir, "a.md")), [{ line: 1, target: "missing.md" }]);
});

test("anchors are checked in other files and the same file", () => {
  const dir = fixture({
    "a.md": "# Top\n[ok](#top) [bad](#nope) [ok2](b.md#hello-world) [bad2](b.md#missing-anchor)\n",
    "b.md": "## Hello, World\n<a id=\"explicit\"></a>\n",
    "c.md": "[x](b.md#explicit)\n",
  });
  assert.deepEqual(checkFile(join(dir, "a.md")), [
    { line: 2, target: "#nope" },
    { line: 2, target: "b.md#missing-anchor" },
  ]);
  assert.deepEqual(checkFile(join(dir, "c.md")), []);
});

test("duplicate headings get numeric suffixes", () => {
  const dir = fixture({ "a.md": "## Setup\n## Setup\n[1](#setup) [2](#setup-1) [3](#setup-2)\n" });
  assert.deepEqual(checkFile(join(dir, "a.md")), [{ line: 3, target: "#setup-2" }]);
});

test("headings inside fenced blocks are not anchors", () => {
  const dir = fixture({ "a.md": "```\n## Fake\n```\n[x](#fake)\n" });
  assert.deepEqual(checkFile(join(dir, "a.md")), [{ line: 4, target: "#fake" }]);
});

test("reference-style links are checked", () => {
  const dir = fixture({ "a.md": "[x][ref]\n\n[ref]: nope.md\n[ok]: a.md\n" });
  assert.deepEqual(checkFile(join(dir, "a.md")), [{ line: 3, target: "nope.md" }]);
});


test("discovery covers the repository, includes new docs and skips deleted or ignored files", () => {
  const dir = fixture({
    "ROOT.md": "# Root",
    "performance/run.md": "# Run",
    "worker/notes.md": "# Worker",
    "worker/guide.mdx": "# MDX",
    "worker/guide.markdown": "# Markdown",
    "docs/superpowers/specs/history.md": "# Historical",
    "docs/public.md": "# Public",
    "docs/public.mdx": "# Public MDX",
    "packages/sdk/README.md": "# SDK",
    "removed.md": "# Deleted",
    "file with spaces.md": "# Spaces",
    "line\nbreak.md": "# Newline",
    "script.mjs": "",
    ".gitignore": "ignored/\n",
  });
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "--quiet");
  git("add", ".");
  rmSync(join(dir, "removed.md"));
  mkdirSync(join(dir, "ignored"));
  writeFileSync(join(dir, "ignored/new.md"), "# Ignored");
  writeFileSync(join(dir, "ignored/tracked.md"), "# Tracked despite ignore");
  git("add", "--force", "ignored/tracked.md");
  writeFileSync(join(dir, "new.md"), "# New");
  const names = (files) => files.map((file) => relative(dir, file));
  assert.deepEqual(names(defaultFiles(dir)), [
    "ROOT.md", "docs/public.md", "docs/public.mdx", "docs/superpowers/specs/history.md",
    "file with spaces.md", "ignored/tracked.md", "line\nbreak.md", "new.md",
    "packages/sdk/README.md", "performance/run.md", "worker/guide.markdown", "worker/guide.mdx", "worker/notes.md",
  ]);
  assert.deepEqual(names(publicDocsFiles(dir)), ["docs/public.md", "packages/sdk/README.md"]);
});

test("discovery reports git failures instead of silently checking zero files", () => {
  const dir = fixture({});
  assert.throws(() => defaultFiles(dir), /git/);
});
