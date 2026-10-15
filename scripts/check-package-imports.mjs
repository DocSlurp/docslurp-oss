#!/usr/bin/env node
// Also enforces the server/ import boundary (see lib/server-boundary.mjs).
// Import every JavaScript export of every released package on the current
// Node version, so CI can prove the published engines floor without a full
// test suite for each package. Run after the packages are built.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releasePackages } from "./package-release.mjs";
import { checkAppServerImports, checkServerBoundary } from "./lib/server-boundary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// Static boundary rule: server/ must stay extractable without app/ or other
// packages' sources. `--boundaries` runs only this check (no build required).
const boundaryViolations = [...checkServerBoundary(root), ...checkAppServerImports(root)];
for (const violation of boundaryViolations) console.error(`✖ server boundary: ${violation}`);
if (boundaryViolations.length) {
  console.error(`${boundaryViolations.length} server import-boundary violation(s)`);
  process.exit(1);
}
console.log("✔ server/ import boundaries (no app/ imports, no package src/ deep imports, worker only via @docslurp/worker/testing in tests); server/db/ is covered");
if (process.argv.includes("--boundaries")) process.exit(0);

function jsTargets(exportsField, main) {
  const targets = new Set();
  const walk = (condition, value) => {
    if (typeof value === "string") {
      if (/\.m?js$/.test(value) && condition !== "types") targets.add(value);
    } else if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) walk(key, nested);
    }
  };
  walk("", exportsField ?? (main ? { ".": main } : {}));
  return [...targets];
}

let failures = 0;
for (const directory of releasePackages) {
  const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
  for (const target of jsTargets(manifest.exports, manifest.main)) {
    const file = join(root, directory, target);
    if (!existsSync(file)) {
      console.error(`✖ ${manifest.name} ${target}: not built`);
      failures++;
      continue;
    }
    try {
      await import(pathToFileURL(file).href);
      console.log(`✔ ${manifest.name} ${target}`);
    } catch (error) {
      console.error(`✖ ${manifest.name} ${target}: ${error?.stack ?? error}`);
      failures++;
    }
  }
}

console.log(`Node ${process.version}: ${failures ? `${failures} package export(s) failed to import` : "every package export imports"}`);
process.exit(failures ? 1 : 0);
