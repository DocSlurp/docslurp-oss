import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Design section 5 (extraction-config-simplification): no raw SQL read of a retired extraction key outside
 * packages/shared/src/pipeline-sql.ts. A raw `pipeline->>'visionFallback'` (or `quality`, `figures`, `chartExport`,
 * `visuals`) bypasses the read-time mapping and the run's stamped `effective` values; use the helpers there.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const scanned = ["server/src", "worker/src", "packages/shared/src"];
const allowed = new Set(["packages/shared/src/pipeline-sql.ts"]);
const RETIRED = /pipeline\s*(?:->>?|#>>?)\s*'(?:\{\s*)?(visionFallback|quality|figures|chartExport|visuals|parserPlaybook)\b/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|mts|mjs|js)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) yield path;
  }
}

describe("raw pipeline readers", () => {
  it("read retired extraction keys only through pipeline-sql.ts", () => {
    const offenders: string[] = [];
    for (const dir of scanned) {
      for (const file of sourceFiles(join(root, dir))) {
        const rel = relative(root, file);
        if (allowed.has(rel)) continue;
        readFileSync(file, "utf8").split("\n").forEach((line, index) => {
          if (RETIRED.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the pattern catches the forms it guards", () => {
    for (const sample of [
      "coalesce((r.pipeline->>'visionFallback')::boolean,false)",
      "runs.pipeline->>'quality'",
      "p.pipeline -> 'figures'",
      "r.pipeline -> 'chartExport' ->> 'tier'",
      "pipeline #>> '{chartExport,tier}'",
    ]) expect(RETIRED.test(sample)).toBe(true);
    expect(RETIRED.test("r.pipeline->>'maxCostCents'")).toBe(false);
  });
});
