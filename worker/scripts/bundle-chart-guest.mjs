// Build step: bundle the chart-export parser-VM guest (dist/chart-export/extractors/guest-entry.js and everything it
// imports, zod included) into ONE module, dist/chart-export/guest.bundle.mjs. The guest is a fresh Node process per VM
// command; resolving and loading ~200 small ESM files cost more CPU than the extraction itself on a typical chart
// (performance/chart-export-free-rungs). Same code, same zod version: only the module layout changes.
//
// Guards, each failing the build:
// - Import allowlist: every bundled input must be one of the guest's own modules, the three @docslurp/shared modules it
//   needs, or zod. Pulling the shared package index back in (OpenTelemetry, pricing: ~0.3 s CPU per run) is refused.
// - Byte budget for the bundle.
// It also writes guest.bundle.inputs.json, a SHA-256 over the worker's own dist inputs, so the VM contract
// (scripts/parser-vm-contract.mjs) refuses a bundle older than the dist it ships with (a `tsc`-only rebuild).
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { BUNDLE_MAX_BYTES, BUNDLE_PATH, INPUTS_PATH, WORKER_ROOT, bundleInputsHash } from "./chart-guest-bundle.mjs";

const result = await build({
  entryPoints: [path.join(WORKER_ROOT, "dist/chart-export/extractors/guest-entry.js")],
  outfile: BUNDLE_PATH,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "inline",
  logLevel: "warning",
  metafile: true,
  absWorkingDir: WORKER_ROOT,
});

// Metafile paths are relative to the worker root; pnpm links resolve to real paths under node_modules/.pnpm.
const ALLOWED = [
  /^dist\/chart-export\/extractors\/[\w-]+\.js$/,
  /^dist\/lib\/(quarantine-bytes|archive-nesting|pdf-encryption-structure)\.js$/,
  /^dist\/tools\/clam-limits\.js$/,
  /^\.\.\/packages\/shared\/dist\/(chart-export|file-sniff|file-formats)\.js$/,
  /(^|\/)node_modules\/(\.pnpm\/zod@[^/]+\/node_modules\/)?zod\//,
];
const inputs = Object.keys(result.metafile.inputs);
const refused = inputs.filter((file) => !ALLOWED.some((re) => re.test(file)));
if (refused.length) {
  throw new Error(`chart guest bundle: imports outside the allowlist (keep the guest off the @docslurp/shared index):\n  ${refused.join("\n  ")}`);
}
const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? Infinity;
if (bytes > BUNDLE_MAX_BYTES) throw new Error(`chart guest bundle: ${bytes} bytes exceeds the ${BUNDLE_MAX_BYTES}-byte budget`);

const own = inputs.filter((file) => file.startsWith("dist/")).sort();
await writeFile(INPUTS_PATH, `${JSON.stringify({ inputs: own, sha256: await bundleInputsHash(own) }, null, 2)}\n`);
