#!/usr/bin/env node
// Fetches the OCR models pinned in worker/ocr-models.json into one directory and verifies each sha256.
// Any mismatch, missing pin or unsafe file name fails; nothing unverified is left in <out>.
//
//   node scripts/fetch-ocr-models.mjs --manifest worker/ocr-models.json --out DIR [--cache DIR] [--source-dir DIR]
//
// --cache keeps verified downloads (by sha256) for later runs. --source-dir reads the files from a local
// mirror instead of the network (same names as in <out>); they are verified the same way.
// The worker never downloads models: images bake this directory read-only and docslurp_ocr.py loads
// models only by explicit path (docs/extraction/ocr.md).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Model entries of the manifest: [{ file, url, sha256 }]. Accepts `models` as an array or a name-keyed object. */
export function manifestModels(manifest) {
  const raw = manifest?.models ?? manifest?.files;
  if (!raw || typeof raw !== "object") throw new Error("manifest has no models");
  const entries = Array.isArray(raw)
    ? raw.map((entry) => [entry?.name, entry])
    : Object.entries(raw).map(([key, entry]) => [key, entry]);
  if (entries.length === 0) throw new Error("manifest has no models");
  const seen = new Set();
  return entries.map(([key, entry]) => {
    if (!entry || typeof entry !== "object") throw new Error(`model ${key ?? "?"} is not an object`);
    const url = entry.url;
    if (typeof url !== "string" || !url.startsWith("https://")) throw new Error(`model ${key ?? "?"}: url must be https`);
    const digest = String(entry.sha256 ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`model ${key ?? url}: sha256 must be 64 hex characters`);
    const file = entry.file ?? entry.filename ?? entry.path ?? decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    // Flat directory, plain names only: no separators, no dot names, nothing a manifest edit could use to escape <out>.
    if (typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(file) || file.includes("..")) {
      throw new Error(`model ${key ?? url}: unsafe file name ${JSON.stringify(file)}`);
    }
    if (seen.has(file)) throw new Error(`model file ${file} is listed twice`);
    seen.add(file);
    const size = entry.size ?? entry.bytes;
    return { name: key ?? file, file, url, sha256: digest, size: Number.isInteger(size) ? size : undefined };
  });
}

function verify(model, bytes, source) {
  const actual = sha256(bytes);
  if (actual !== model.sha256) {
    throw Object.assign(new Error(`sha256 mismatch for ${model.file} from ${source}: expected ${model.sha256}, got ${actual}`), { fatal: true });
  }
  if (model.size !== undefined && bytes.length !== model.size) {
    throw Object.assign(new Error(`size mismatch for ${model.file}: expected ${model.size}, got ${bytes.length}`), { fatal: true });
  }
  return bytes;
}

async function fetchModel(model, { cacheDir, sourceDir }) {
  if (sourceDir) return verify(model, await readFile(path.join(sourceDir, model.file)), path.join(sourceDir, model.file));
  const cached = cacheDir ? path.join(cacheDir, model.sha256) : null;
  if (cached && existsSync(cached)) {
    const bytes = await readFile(cached);
    if (sha256(bytes) === model.sha256) return bytes;
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(model.url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = verify(model, Buffer.from(await response.arrayBuffer()), model.url);
      if (cached) {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(`${cached}.tmp`, bytes);
        await rename(`${cached}.tmp`, cached);
      }
      return bytes;
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw new Error(`download failed for ${model.url}: ${lastError?.message ?? lastError}`);
}

/** Fetches and verifies every model, then writes them into outDir. Returns the written entries. */
export async function fetchOcrModels({ manifestPath, outDir, cacheDir, sourceDir }) {
  const models = manifestModels(JSON.parse(await readFile(manifestPath, "utf8")));
  const fetched = [];
  // Verify everything before writing anything, so a bad pin never leaves a partial model directory.
  for (const model of models) fetched.push([model, await fetchModel(model, { cacheDir, sourceDir })]);
  await mkdir(outDir, { recursive: true });
  for (const [model, bytes] of fetched) {
    const target = path.join(outDir, model.file);
    await rm(`${target}.tmp`, { force: true });
    await writeFile(`${target}.tmp`, bytes);
    await rename(`${target}.tmp`, target);
    console.log(`[ocr-models] ${model.file} ${bytes.length} bytes sha256=${model.sha256}`);
  }
  return models;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") throw new Error(`${flag} needs a value`);
    if (flag === "--manifest") options.manifestPath = value;
    else if (flag === "--out") options.outDir = value;
    else if (flag === "--cache") options.cacheDir = value;
    else if (flag === "--source-dir") options.sourceDir = value;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!options.manifestPath || !options.outDir) throw new Error("--manifest and --out are required");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const models = await fetchOcrModels(parseArgs(process.argv.slice(2)));
    console.log(`[ocr-models] verified ${models.length} models`);
  } catch (error) {
    console.error(`[ocr-models] ${error.message}`);
    console.error("Usage: node scripts/fetch-ocr-models.mjs --manifest worker/ocr-models.json --out DIR [--cache DIR] [--source-dir DIR]");
    process.exit(1);
  }
}
