#!/usr/bin/env node
// Inspect packed release tarballs before anything can publish: manifest
// metadata, licence, README line, files that must not ship, and that every
// bin/main/exports target exists inside the tarball.
// Usage: check-package-contents.mjs <tarball>...
import { execFileSync } from "node:child_process";
import { releasePackages } from "./package-release.mjs";

export const expectedLicenses = {
  "@docslurp/sdk": "MIT",
  "@docslurp/contrib-search-compat": "MIT",
  "@docslurp/contrib-astro": "MIT",
  "@docslurp/cli": "SEE LICENSE IN LICENSE",
  "@docslurp/contrib-algolia-server": "MIT",
};
const sspl = new Set(["@docslurp/cli"]);
const forbidden = [/(^|\/)\.env/, /\.map$/, /(^|\/)src\//, /(^|\/)test\//, /\.test\.[cm]?[jt]sx?$/, /(^|\/)node_modules\//, /\.tsbuildinfo$/, /\.(pem|key)$/];

function targets(value, out = new Set()) {
  if (typeof value === "string") out.add(value);
  else if (value && typeof value === "object") for (const nested of Object.values(value)) targets(nested, out);
  return out;
}

export function checkPackage({ manifest, files, readme, license }) {
  const problems = [];
  const name = manifest.name;
  const slug = name.replace("@docslurp/", "");
  const has = (path) => files.has(path.replace(/^\.\//, ""));
  if (manifest.license !== expectedLicenses[name]) problems.push(`license must be ${expectedLicenses[name]}, found ${manifest.license}`);
  if (manifest.homepage !== `https://docslurp.io/docs/packages/${slug}`) problems.push("homepage must be the official package docs page");
  if (!manifest.repository?.url?.includes("github.com/DocSlurp/docslurp-oss") || manifest.repository.directory !== `packages/${slug}`) problems.push("repository must point at DocSlurp/docslurp-oss with directory packages/<name>");
  if (!manifest.bugs?.url?.startsWith("https://github.com/DocSlurp/docslurp-oss")) problems.push("bugs.url must point at GitHub issues");
  if (manifest.publishConfig?.access !== "public") problems.push("publishConfig.access must be public");
  if (manifest.private) problems.push("package is private");
  if (!files.has("LICENSE")) problems.push("LICENSE missing from tarball");
  else if (sspl.has(name) !== /Server Side Public License|SSPL/i.test(license)) problems.push(sspl.has(name) ? "LICENSE is not SSPL" : "LICENSE unexpectedly SSPL");
  if (!files.has("README.md")) problems.push("README.md missing from tarball");
  else if (!readme.split("\n", 1)[0].startsWith(`# ${name}`) || !/\[Package docs\]\(https:\/\/docslurp\.io\/docs\/packages\/[^)]+\) · \[GitHub\]\(.+\) · \[npm\]\(.+\)/.test(readme.split("\n").slice(1, 4).join("\n"))) problems.push("README must start with the title then a `Package docs · GitHub · npm` line");
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) if (/^(workspace|link|file):/.test(range)) problems.push(`${field}.${dep} is ${range}`);
  }
  const entries = new Set();
  for (const field of ["main", "module", "types", "bin", "exports"]) targets(manifest[field], entries);
  for (const target of entries) if (target.startsWith("./") || target.startsWith("dist/")) if (!has(target)) problems.push(`${target} is declared but not in the tarball`);
  for (const file of files) if (forbidden.some((pattern) => pattern.test(file))) problems.push(`must not ship: ${file}`);
  return problems;
}

function main() {
  const tarballs = process.argv.slice(2);
  if (!tarballs.length) throw new Error("Usage: check-package-contents.mjs <tarball>...");
  let failures = 0;
  if (tarballs.length !== releasePackages.length) { console.error(`Expected ${releasePackages.length} tarballs, got ${tarballs.length}`); failures++; }
  for (const tarball of tarballs) {
    const tar = (...args) => execFileSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const files = new Set(tar("tzf", tarball).split("\n").filter(Boolean).filter((f) => !f.endsWith("/")).map((f) => f.replace(/^package\//, "")));
    const read = (path) => (files.has(path) ? tar("xzOf", tarball, `package/${path}`) : "");
    const manifest = JSON.parse(read("package.json"));
    const problems = checkPackage({ manifest, files, readme: read("README.md"), license: read("LICENSE") });
    console.log(`${problems.length ? "✖" : "✔"} ${manifest.name}@${manifest.version} (${files.size} files)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    failures += problems.length;
  }
  process.exit(failures ? 1 : 0);
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}
