#!/usr/bin/env node
// Copy the built wasm module into the Python package (run build-wasm.mjs first).
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
copyFileSync(join(root, "dist", "docslurp_estimate.wasm"), join(root, "python", "src", "docslurp_estimate", "docslurp_estimate.wasm"));
console.log("python/src/docslurp_estimate/docslurp_estimate.wasm updated");
