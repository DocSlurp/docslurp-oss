// Build step: bundle the chart-export parser-VM guest (dist/chart-export/extractors/guest-entry.js and everything it
// imports, zod included) into ONE module, dist/chart-export/guest.bundle.mjs. The guest is a fresh Node process per VM
// command; resolving and loading ~200 small ESM files cost more CPU than the extraction itself on a typical chart
// (performance/chart-export-free-rungs). Same code, same zod version: only the module layout changes.
//
// Guards, each failing the build:
// - Input allowlist: every bundled input must be one of the guest's own modules, the three @docslurp/shared modules it
//   needs, or zod. Pulling the shared package index back in (OpenTelemetry, pricing: ~0.3 s CPU per run) is refused.
// - Run-time loads: the bundle may import only `node:zlib` and `node:path` statically. A non-literal `import(x)` or
//   `require(x)` is a build error (esbuild cannot bundle it), and `createRequire`, `getBuiltinModule` or esbuild's
//   `__require` shim in the output fail the build, so nothing can load unbundled code at run time. Our own bundled
//   sources (everything but zod) may not use the Function constructor, eval or process bindings either. zod keeps its
//   JIT in the text, but the guest turns it off first (`@docslurp/shared/zod-jitless`) and the host runs it with V8's
//   --disallow-code-generation-from-strings. This scan only guards against accidents; the V8 flag is the enforcement.
// - Byte budget for the bundle.
// It also writes guest.bundle.inputs.json (hashes of every input and of the bundle itself), so the VM contract
// (scripts/parser-vm-contract.mjs) refuses a bundle older than the code it ships with.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { BUNDLE_MAX_BYTES, BUNDLE_PATH, INPUTS_PATH, WORKER_ROOT, bundleManifest } from "./chart-guest-bundle.mjs";

const result = await build({
  entryPoints: [path.join(WORKER_ROOT, "dist/chart-export/extractors/guest-entry.js")],
  outfile: BUNDLE_PATH,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "inline",
  logLevel: "warning",
  // The production guest has no fault hooks: dead code under this constant (council r9 L3; see guest-entry.ts).
  define: { __CHART_GUEST_TEST_HOOKS__: "false" },
  logOverride: { "unsupported-dynamic-import": "error", "unsupported-require-call": "error" },
  metafile: true,
  absWorkingDir: WORKER_ROOT,
});

// Metafile paths are relative to the worker root; pnpm links resolve to real paths under node_modules/.pnpm.
const ALLOWED = [
  /^dist\/chart-export\/extractors\/[\w-]+\.js$/,
  /^dist\/lib\/(quarantine-bytes|archive-nesting|pdf-encryption-structure)\.js$/,
  /^dist\/tools\/clam-limits\.js$/,
  /^\.\.\/packages\/shared\/dist\/(chart-export|file-sniff|file-formats|zod-jitless)\.js$/,
  /(^|\/)node_modules\/(\.pnpm\/zod@[^/]+\/node_modules\/)?zod\//,
];
const inputs = Object.keys(result.metafile.inputs);
const refused = inputs.filter((file) => !ALLOWED.some((re) => re.test(file)));
if (refused.length) {
  throw new Error(`chart guest bundle: inputs outside the allowlist (keep the guest off the @docslurp/shared index):\n  ${refused.join("\n  ")}`);
}
const [output] = Object.values(result.metafile.outputs);
const RUNTIME_IMPORTS = new Set(["node:zlib", "node:path"]);
const loads = output.imports.filter((i) => !(i.external && i.kind === "import-statement" && RUNTIME_IMPORTS.has(i.path)));
if (loads.length) throw new Error(`chart guest bundle: run-time imports outside node:zlib/node:path: ${loads.map((i) => `${i.kind} ${i.path}`).join(", ")}`);
const ZOD = /(^|\/)node_modules\/(\.pnpm\/zod@[^/]+\/node_modules\/)?zod\//;
const CODE_LOADERS = /\bFunction\s*\(|new\s+Function\b|\beval\s*\(|\bprocess\s*(\.|\[)\s*["']?(binding|_linkedBinding|dlopen|getBuiltinModule)\b|\bcreateRequire\b|\bimport\s*\(/;
for (const file of inputs.filter((f) => !ZOD.test(f))) {
  const found = CODE_LOADERS.exec(await readFile(path.join(WORKER_ROOT, file), "utf8"));
  if (found) throw new Error(`chart guest bundle: ${file} uses \`${found[0]}\`; the guest must not generate or load code at run time`);
}
const text = await readFile(BUNDLE_PATH, "utf8");
const loader = /\b(createRequire|getBuiltinModule|__require)\b/.exec(text);
if (loader) throw new Error(`chart guest bundle: contains \`${loader[1]}\`; the guest must not load modules at run time`);
// The fault hooks compile to `false ? {...} : null` (council r9 L3): the constant must be substituted, never read at run time.
if (text.includes("__CHART_GUEST_TEST_HOOKS__") || !/var testHooks = false \?/.test(text)) throw new Error("chart guest bundle: the test-hook constant was not compiled out");
if (output.bytes > BUNDLE_MAX_BYTES) throw new Error(`chart guest bundle: ${output.bytes} bytes exceeds the ${BUNDLE_MAX_BYTES}-byte budget`);

await writeFile(INPUTS_PATH, `${JSON.stringify(await bundleManifest(inputs), null, 2)}\n`);
