#!/usr/bin/env node
// Retired npm names (0.3.0 consolidation): deprecate them and optionally publish
// the final shim release. Both commands are idempotent and refuse to run until the
// replacement packages are live at the shared release version.
//
//   node scripts/retire-packages.mjs deprecate [--dry-run]
//   node scripts/retire-packages.mjs publish-shims <shimDir> [--dry-run] [--provenance]
//
// Build the shim directory first: node scripts/deprecated-shims/build.mjs <dir> <version>.
// Deprecation needs an npm token (NODE_AUTH_TOKEN); trusted publishing covers publish only.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkRelease } from "./package-release.mjs";

const docs = "https://docslurp.io/docs/packages";
export const retiredPackages = {
  "@docslurp/embed-sdk": { replacement: "@docslurp/sdk", message: `Moved to @docslurp/sdk/embed (npm install @docslurp/sdk). See ${docs}/sdk` },
  "@docslurp/compat-algolia": { replacement: "@docslurp/contrib-search-compat", message: `Moved to @docslurp/contrib-search-compat/algolia. See ${docs}/contrib-search-compat` },
  "@docslurp/compat-meilisearch": { replacement: "@docslurp/contrib-search-compat", message: `Moved to @docslurp/contrib-search-compat/meilisearch. See ${docs}/contrib-search-compat` },
  "@docslurp/compat-typesense": { replacement: "@docslurp/contrib-search-compat", message: `Moved to @docslurp/contrib-search-compat/typesense. See ${docs}/contrib-search-compat` },
  "@docslurp/compat-pagefind": { replacement: "@docslurp/contrib-search-compat", message: `Moved to @docslurp/contrib-search-compat/pagefind. See ${docs}/contrib-search-compat` },
  "@docslurp/compat-algolia-server": { replacement: "@docslurp/contrib-algolia-server", message: `Renamed to @docslurp/contrib-algolia-server. See ${docs}/contrib-algolia-server` },
  "@docslurp/astro": { replacement: "@docslurp/contrib-astro", message: `Renamed to @docslurp/contrib-astro. See ${docs}/contrib-astro` },
};

// Versions of a packument that still need the deprecation message (idempotency).
export function versionsNeedingDeprecation(packument, message) {
  return Object.entries(packument.versions ?? {}).filter(([, record]) => record.deprecated !== message).map(([version]) => version);
}

async function packument(name) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, { signal: AbortSignal.timeout(20000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry returned ${response.status} for ${name}`);
  return response.json();
}

async function requireReplacementsLive(version) {
  const names = [...new Set(Object.values(retiredPackages).map((retired) => retired.replacement))];
  for (const name of names) {
    const record = await packument(name);
    if (!record?.versions?.[version]) throw new Error(`${name}@${version} is not on npm yet; publish the release before retiring old names`);
  }
}

const npm = (args) => execFileSync("npm", args, { stdio: "inherit" });

async function deprecate(dryRun, version) {
  await requireReplacementsLive(version);
  for (const [name, { message }] of Object.entries(retiredPackages)) {
    const record = await packument(name);
    if (!record) { console.log(`${name}: not on npm, nothing to deprecate`); continue; }
    const pending = versionsNeedingDeprecation(record, message);
    if (!pending.length) { console.log(`${name}: all ${Object.keys(record.versions).length} versions already deprecated`); continue; }
    console.log(`${name}: deprecating ${pending.length} version(s) (${pending.join(", ")})`);
    if (!dryRun) npm(["deprecate", `${name}@*`, message]);
  }
}

async function publishShims(dir, dryRun, provenance, version) {
  await requireReplacementsLive(version);
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const cwd = join(dir, entry.name);
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    if (!retiredPackages[manifest.name]) throw new Error(`${manifest.name} is not a retired package name`);
    if (manifest.version !== version) throw new Error(`${manifest.name} shim is ${manifest.version}; expected ${version}`);
    const record = await packument(manifest.name);
    if (record?.versions?.[version]) { console.log(`${manifest.name}@${version} already published; skipping`); continue; }
    console.log(`${manifest.name}@${version}: publishing shim${dryRun ? " (dry run)" : ""}`);
    const args = ["publish", "--access", "public", ...(provenance ? ["--provenance"] : []), ...(dryRun ? ["--dry-run"] : [])];
    execFileSync("npm", args, { cwd, stdio: "inherit" });
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  const { version } = checkRelease(new URL("../", import.meta.url));
  if (command === "deprecate") await deprecate(flags.has("--dry-run"), version);
  else if (command === "publish-shims" && positional[0]) await publishShims(positional[0], flags.has("--dry-run"), flags.has("--provenance"), version);
  else throw new Error("Usage: retire-packages.mjs deprecate [--dry-run] | publish-shims <shimDir> [--dry-run] [--provenance]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
