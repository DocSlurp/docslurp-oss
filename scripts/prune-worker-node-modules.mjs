#!/usr/bin/env node
// Trim a `pnpm deploy --prod` worker directory before it is copied into an image.
//
//   node scripts/prune-worker-node-modules.mjs --dir /prod/worker [--arch x64|arm64] [--dry-run]
//
// 1. Drops top-level packages the worker does not declare (pnpm deploy also
//    installs the workspace root's dependencies, e.g. better-auth + prisma).
// 2. Cuts optional edges the worker never loads (LanceDB's embedding-registry
//    copy of @huggingface/transformers 3 with its own onnxruntime-node/web).
// 3. Garbage-collects every .pnpm package no longer reachable from (1).
// 4. Removes native binaries for other operating systems and CPU architectures.
// 5. Removes source maps, TypeScript declarations and Markdown docs (licenses stay).
//
// Prints a before/after size summary. Every removal is listed with --verbose.
import { lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, existsSync } from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const dir = path.resolve(arg("dir", "."));
const nodeArch = arg("arch", process.arch);
const dryRun = process.argv.includes("--dry-run");
const verbose = process.argv.includes("--verbose");
const modules = path.join(dir, "node_modules");
const store = path.join(modules, ".pnpm");

/** Optional dependency edges that are never loaded by the worker: [package dir prefix in .pnpm, dependency name]. */
const DROP_EDGES = [["@lancedb+lancedb@", "@huggingface/transformers"], ["@lancedb+lancedb@", "openai"]];

const archNames = {
  x64: { node: "x64", triple: "x86_64", alt: ["amd64", "x86_64"] },
  arm64: { node: "arm64", triple: "aarch64", alt: ["arm64", "aarch64"] },
}[nodeArch];
if (!archNames) throw new Error(`unsupported --arch ${nodeArch}`);
const otherArchTokens = ["x64", "arm64", "ia32", "arm", "x86_64", "aarch64", "amd64", "armv7", "s390x", "ppc64", "ppc64le", "riscv64", "loong64"]
  .filter((token) => ![archNames.node, archNames.triple, ...archNames.alt].includes(token));
const otherOsTokens = ["darwin", "win32", "windows", "apple", "freebsd", "android", "musl", "msvc", "openbsd", "sunos", "aix"];

let removedBytes = 0;
function sizeOf(target) {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of readdirSync(target)) total += sizeOf(path.join(target, entry));
  return total;
}
function remove(target, why) {
  if (!existsSync(target) && !isLink(target)) return;
  const bytes = sizeOf(target);
  removedBytes += bytes;
  if (verbose) console.log(`[prune] ${why}: ${path.relative(dir, target)} (${(bytes / 1048576).toFixed(1)} MiB)`);
  if (!dryRun) rmSync(target, { recursive: true, force: true });
}
function isLink(target) {
  try { return lstatSync(target).isSymbolicLink(); } catch { return false; }
}
function packageEntries(nodeModulesDir) {
  if (!existsSync(nodeModulesDir)) return [];
  const result = [];
  for (const name of readdirSync(nodeModulesDir)) {
    if (name.startsWith(".")) continue;
    const entry = path.join(nodeModulesDir, name);
    if (name.startsWith("@") && !isLink(entry) && statSync(entry).isDirectory()) {
      for (const scoped of readdirSync(entry)) result.push({ name: `${name}/${scoped}`, path: path.join(entry, scoped) });
    } else result.push({ name, path: entry });
  }
  return result;
}
/** The .pnpm/<dir> a node_modules entry resolves into, if any. */
function storeDirOf(entryPath) {
  let resolved = entryPath;
  try {
    if (isLink(entryPath)) resolved = path.resolve(path.dirname(entryPath), readlinkSync(entryPath));
  } catch { return null; }
  const relative = path.relative(store, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0];
}

const before = sizeOf(modules);
const worker = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
const declared = new Set([...Object.keys(worker.dependencies ?? {}), ...Object.keys(worker.optionalDependencies ?? {})]);

// 1. Undeclared top-level packages.
for (const entry of packageEntries(modules)) {
  if (!declared.has(entry.name)) remove(entry.path, "undeclared top-level package");
}
for (const scope of readdirSync(modules).filter((name) => name.startsWith("@"))) {
  const scopeDir = path.join(modules, scope);
  if (!dryRun && existsSync(scopeDir) && readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true });
}

// 2. Unused optional edges.
if (existsSync(store)) {
  for (const storeDir of readdirSync(store)) {
    for (const [prefix, dependency] of DROP_EDGES) {
      if (!storeDir.startsWith(prefix)) continue;
      const edge = path.join(store, storeDir, "node_modules", dependency);
      if (isLink(edge)) remove(edge, "unused optional dependency edge");
    }
  }
}

// 3. Reachability GC over the .pnpm virtual store.
if (existsSync(store)) {
  const reachable = new Set();
  const queue = [];
  const visit = (entryPath) => {
    const storeDir = storeDirOf(entryPath);
    if (storeDir && !reachable.has(storeDir)) { reachable.add(storeDir); queue.push(storeDir); }
  };
  for (const entry of packageEntries(modules)) visit(entry.path);
  while (queue.length) {
    const storeDir = queue.shift();
    for (const entry of packageEntries(path.join(store, storeDir, "node_modules"))) visit(entry.path);
  }
  for (const storeDir of readdirSync(store)) {
    if (storeDir === "node_modules" || storeDir.startsWith(".")) continue;
    if (!reachable.has(storeDir)) remove(path.join(store, storeDir), "unreachable package");
  }
  // Hoisted links to removed packages.
  const hoisted = path.join(store, "node_modules");
  for (const entry of packageEntries(hoisted)) {
    if (isLink(entry.path) && !existsSync(entry.path)) remove(entry.path, "dangling hoisted link");
  }
}

// 4 + 5. Foreign native binaries and non-runtime files.
const NATIVE_DIR_PARENTS = new Set(["napi-v3", "napi-v6", "releases", "prebuilds", "bin"]);
function foreignPlatformDir(name) {
  const tokens = name.toLowerCase().split(/[-_.]/);
  if (tokens.some((token) => otherOsTokens.includes(token))) return true;
  if (tokens.some((token) => otherArchTokens.includes(token))) return true;
  return false;
}
function walk(current, depth) {
  for (const name of readdirSync(current)) {
    const target = path.join(current, name);
    let info;
    try { info = lstatSync(target); } catch { continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      const parent = path.basename(current);
      // onnxruntime-node bin/napi-v6/<os>/<arch>, temporal releases/<triple>, node-gyp-build prebuilds/<os-arch>
      if (NATIVE_DIR_PARENTS.has(parent) && foreignPlatformDir(name)) { remove(target, "foreign native binaries"); continue; }
      if (/^(napi-v\d+)$/.test(parent) && ["linux"].includes(name)) { walk(target, depth + 1); continue; }
      if (path.basename(path.dirname(current)).startsWith("napi-v") && parent === "linux" && foreignPlatformDir(name)) { remove(target, "foreign native binaries"); continue; }
      walk(target, depth + 1);
      continue;
    }
    // CPU-only image: GPU execution providers are never loaded (ONNXRUNTIME_NODE_INSTALL_CUDA=skip upstream).
    if (/^libonnxruntime_providers_(cuda|tensorrt|rocm|migraphx|openvino)\.so/.test(name)) remove(target, "GPU execution provider");
    else if (/\.(map|d\.ts|d\.mts|d\.cts)$/.test(name)) remove(target, "non-runtime file");
    else if (/^(README|CHANGELOG|HISTORY|CONTRIBUTING)(\..*)?$/i.test(name) || (/\.md$/i.test(name) && !/licen[cs]e|notice|copying/i.test(name))) remove(target, "documentation");
  }
}
walk(modules, 0);

const after = before - removedBytes;
console.log(`[prune] node_modules ${(before / 1048576).toFixed(0)} MiB -> ${(after / 1048576).toFixed(0)} MiB (removed ${(removedBytes / 1048576).toFixed(0)} MiB${dryRun ? ", dry run" : ""}) arch=${nodeArch}`);
