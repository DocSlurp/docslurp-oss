#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const assignmentPattern = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const defaultFiles = [".env.example", ".env", ".env.production"];
const requestedFiles = process.argv.slice(2);
const files = (requestedFiles.length > 0 ? requestedFiles : defaultFiles).filter(existsSync);

function readKeys(file) {
  const occurrences = new Map();

  for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    const match = line.match(assignmentPattern);
    if (!match) continue;

    const lines = occurrences.get(match[1]) ?? [];
    lines.push(index + 1);
    occurrences.set(match[1], lines);
  }

  return occurrences;
}

function readDocumentedKeys(file) {
  const keys = new Set(readKeys(file).keys());
  const commentedAssignmentPattern = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(commentedAssignmentPattern);
    if (match) keys.add(match[1]);
  }

  return keys;
}

if (!existsSync(".env.example")) {
  console.error("Missing .env.example; cannot validate environment files.");
  process.exitCode = 1;
} else {
  const documentedKeys = readDocumentedKeys(".env.example");
  let failed = false;

  for (const file of files) {
    const occurrences = readKeys(file);
    const duplicates = [...occurrences]
      .filter(([, lines]) => lines.length > 1)
      .map(([key, lines]) => `${key} (lines ${lines.join(", ")})`);
    const undocumented = file === ".env.example"
      ? []
      : [...occurrences.keys()].filter((key) => !documentedKeys.has(key)).sort();

    if (duplicates.length === 0 && undocumented.length === 0) {
      console.log(`${file}: ok (${occurrences.size} variables)`);
      continue;
    }

    failed = true;
    console.error(`${file}:`);
    if (duplicates.length > 0) console.error(`  duplicate variables: ${duplicates.join("; ")}`);
    if (undocumented.length > 0) console.error(`  undocumented variables: ${undocumented.join(", ")}`);
  }

  if (failed) process.exitCode = 1;
}
