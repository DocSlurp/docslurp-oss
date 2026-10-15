#!/usr/bin/env node
// Pin a built vendor bundle in worker/vendor-bundles.json (the trust root the
// worker verifies downloads against).
//
//   node scripts/vendor-bundles/update-manifest.mjs --entry .scratch/bundles/docling-linux-x64-py3.13.json \
//     [--archive .scratch/bundles/docling-linux-x64-py3.13.tar.zst] [--manifest worker/vendor-bundles.json]
//
// With --archive the archive's sha256 and size are recomputed and must match the
// entry. The artifact for the entry's platform is replaced; others are kept.
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function applyEntry(manifest, entry) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.bundle ?? "")) throw new Error("entry needs a valid bundle name");
  if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) throw new Error("entry needs a 64-hex sha256");
  if (!/^[a-z0-9.-]+$/.test(entry.platform ?? "")) throw new Error("entry needs a platform");
  for (const field of ["size", "unpackedSize"]) {
    if (!Number.isSafeInteger(entry[field]) || entry[field] <= 0) throw new Error(`entry needs a positive ${field}`);
  }
  const bundle = manifest.bundles?.[entry.bundle];
  if (!bundle) throw new Error(`bundle "${entry.bundle}" is not declared in the manifest; add its definition first`);
  const artifact = { platform: entry.platform, sha256: entry.sha256, size: entry.size, unpackedSize: entry.unpackedSize, ...(entry.file ? { file: entry.file } : {}) };
  bundle.artifacts = [...(bundle.artifacts ?? []).filter((item) => item.platform !== entry.platform), artifact]
    .sort((a, b) => a.platform.localeCompare(b.platform));
  return manifest;
}

async function main() {
  const entryFile = arg("entry");
  if (!entryFile) throw new Error("--entry is required");
  const manifestFile = path.resolve(arg("manifest") ?? path.join(root, "worker/vendor-bundles.json"));
  const entry = JSON.parse(readFileSync(entryFile, "utf8"));
  const archive = arg("archive");
  if (archive) {
    const [sha256, size] = [await sha256File(archive), statSync(archive).size];
    if (sha256 !== entry.sha256 || size !== entry.size) throw new Error(`archive does not match entry (sha256 ${sha256}, size ${size})`);
  }
  const manifest = applyEntry(JSON.parse(readFileSync(manifestFile, "utf8")), entry);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[vendor-bundles] pinned ${entry.bundle} ${entry.platform} sha256=${entry.sha256.slice(0, 12)} in ${path.relative(root, manifestFile)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[vendor-bundles] ${error.message}`);
    process.exit(1);
  });
}
