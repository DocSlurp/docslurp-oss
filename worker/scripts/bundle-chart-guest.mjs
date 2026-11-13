// Build step: bundle the chart-export parser-VM guest (dist/chart-export/extractors/guest-entry.js and everything it
// imports, zod included) into ONE module, dist/chart-export/guest.bundle.mjs. The guest is a fresh Node process per VM
// command; resolving and loading ~200 small ESM files cost more CPU than the extraction itself on a typical chart
// (performance/chart-export-free-rungs). Same code, same zod version: only the module layout changes.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/chart-export/", import.meta.url));
await build({
  entryPoints: [`${dist}extractors/guest-entry.js`],
  outfile: `${dist}guest.bundle.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "inline",
  logLevel: "warning",
});
