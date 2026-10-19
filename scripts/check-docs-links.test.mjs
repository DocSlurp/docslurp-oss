import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkFile, extractLinks, githubSlug } from "./check-docs-links.mjs";

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "docs-links-"));
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
