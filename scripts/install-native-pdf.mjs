#!/usr/bin/env node
// Installs the private native PDF engine tarball pinned in
// vendor-artifacts/native-pdf/manifest.json (package, version, tarball, sha256).
// The tarball is gitignored and supplied by the build (artifact path or build
// context). No manifest, or no tarball with --optional, is a normal no-op: the
// worker then runs Kreuzberg as before. A sha256 mismatch always fails.
//
// DOCSLURP_NATIVE_PDF=1 (a Docker build arg) makes the engine required: a missing
// tarball or a binding that does not load fails the build even with --optional,
// so an image that sets DOCSLURP_NATIVE_PDF_INSTALLED=1 really ships it.
// After installing, the binding is loaded once. Under --optional a binding that
// fails to load is removed again, so vendor-artifacts/native-pdf/node_modules
// exists only when a loadable engine is installed (the worker loader and the
// app's /extractors check rely on that).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(process.env.DOCSLURP_NATIVE_PDF_DIR || path.join(root, "vendor-artifacts/native-pdf"));
const requiredFlag = (process.env.DOCSLURP_NATIVE_PDF ?? "").trim().toLowerCase();
if (requiredFlag !== "" && requiredFlag !== "1" && requiredFlag !== "true") {
  console.error(`[native-pdf] DOCSLURP_NATIVE_PDF must be 1, true or empty, got ${JSON.stringify(process.env.DOCSLURP_NATIVE_PDF)}`);
  process.exit(1);
}
const optional = process.argv.includes("--optional") && requiredFlag === "";
const manifestPath = path.join(dir, "manifest.json");

if (!existsSync(manifestPath)) {
  if (requiredFlag) { console.error(`[native-pdf] DOCSLURP_NATIVE_PDF is set but there is no manifest at ${manifestPath}`); process.exit(1); }
  console.log(`[native-pdf] no manifest at ${manifestPath}; skipping`);
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const tarball = path.resolve(dir, manifest.tarball || "");
if (!manifest.package || !manifest.tarball || !/^[0-9a-f]{64}$/.test(manifest.sha256 || "")) {
  console.error("[native-pdf] manifest needs package, tarball and a 64-hex sha256");
  process.exit(1);
}
if (!existsSync(tarball)) {
  const message = `[native-pdf] tarball ${tarball} not present`;
  if (optional) { console.log(`${message}; skipping (optional)`); process.exit(0); }
  console.error(message);
  process.exit(1);
}
const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
if (actual !== manifest.sha256) {
  console.error(`[native-pdf] sha256 mismatch for ${manifest.tarball}: expected ${manifest.sha256}, got ${actual}`);
  process.exit(1);
}
execFileSync("npm", ["install", "--prefix", dir, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { stdio: "inherit" });

// Load check in a child process (a crashing native addon must not take this script down).
const probe = `const b = require(require.resolve(${JSON.stringify(manifest.package)}, { paths: [${JSON.stringify(dir)}] }));
if (typeof b.version !== "function" || typeof b.openPath !== "function") throw new Error("not a native-pdf binding");
const v = b.version(); process.stdout.write(v.version + "+" + String(v.gitSha).slice(0, 7));`;
let loaded;
try {
  loaded = execFileSync(process.execPath, ["-e", probe], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
} catch (error) {
  const reason = String(error.stderr || error.message).trim().split("\n").slice(-1)[0];
  if (!optional) { console.error(`[native-pdf] installed binding does not load: ${reason}`); process.exit(1); }
  rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
  console.log(`[native-pdf] installed binding does not load (${reason}); removed, skipping (optional)`);
  process.exit(0);
}
console.log(`[native-pdf] installed ${manifest.package}@${manifest.version} (engine ${loaded}) sha256=${actual.slice(0, 12)}`);
