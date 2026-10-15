#!/usr/bin/env node
// tsc does not copy JSON that is read at runtime. The page router loads its policy
// packs and the model price list from beside the compiled module (dist/routing/policies),
// so the build copies them there. Runs after `tsc -p tsconfig.json`.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(workerDir, "src", "routing", "policies");
const target = path.join(workerDir, "dist", "routing", "policies");
mkdirSync(target, { recursive: true });
for (const file of readdirSync(source)) {
  if (file.endsWith(".json")) cpSync(path.join(source, file), path.join(target, file));
}
const prices = path.resolve(workerDir, "..", "scripts", "lib", "model-prices.json");
if (existsSync(prices)) {
  cpSync(prices, path.join(target, "model-prices.json"));
} else {
  console.warn(`[copy-routing-assets] ${prices} not found; the page router will have no hosted VLM targets`);
}
