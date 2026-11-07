#!/usr/bin/env node
// Build dist/docslurp_estimate.wasm (cargo, wasm32-unknown-unknown, release) and enforce its size budget.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Raw module size limit; it gzips to about 40%. Raise deliberately, with the reason in the commit. */
const MAX_WASM_BYTES = 1_500_000;

const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, "target");
execFileSync("cargo", ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown", "--lib"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
});
const built = join(targetDir, "wasm32-unknown-unknown", "release", "docslurp_estimate.wasm");
mkdirSync(join(root, "dist"), { recursive: true });
copyFileSync(built, join(root, "dist", "docslurp_estimate.wasm"));
const size = statSync(built).size;
console.log(`dist/docslurp_estimate.wasm: ${size} bytes (budget ${MAX_WASM_BYTES})`);
if (size > MAX_WASM_BYTES) {
  console.error("The WebAssembly module is over its size budget.");
  process.exit(1);
}
