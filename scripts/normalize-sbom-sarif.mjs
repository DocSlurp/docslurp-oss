import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// SPDX package findings may lack source locations. Reference the scanned build
// artifact rather than inventing a source path/line or dropping the finding.
export function normalizeSbomSarif(report, sbomUri) {
  if (!sbomUri || !Array.isArray(report.runs)) throw new Error("SARIF runs and scanned SBOM URI are required");
  for (const run of report.runs) {
    for (const result of run.results ?? []) {
      if (!result.locations?.length) result.locations = [{}];
      for (const location of result.locations) {
        const artifact = location.physicalLocation?.artifactLocation;
        const indexed = Number.isInteger(artifact?.index) && run.artifacts?.[artifact.index]?.location?.uri;
        if (artifact?.uri?.trim() || indexed) continue;
        location.physicalLocation = { artifactLocation: { uri: sbomUri } };
        location.message = { text: "Package finding in the scanned SBOM; source file location was not supplied by the scanner." };
      }
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, sbom] = process.argv.slice(2);
  if (!input || !output || !sbom) throw new Error("Usage: normalize-sbom-sarif.mjs input output scanned-sbom");
  readFileSync(sbom); // Fail if the fallback artifact is not the actual retained scan input.
  writeFileSync(output, JSON.stringify(normalizeSbomSarif(JSON.parse(readFileSync(input, "utf8")), sbom), null, 2));
}
