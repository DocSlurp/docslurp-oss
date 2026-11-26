import { it } from "vitest";

import { mapTextMatchesToCanonical } from "../lib/pii-page-withholding.js";

// Timing only (logs ms); run with PII_LOCATOR_BENCH=1. Synthetic values, one per block, padded to the target text size.
function run(label: string, values: string[], targetChars: number) {
  const filler = "lorem ipsum dolor sit amet ".repeat(Math.max(0, Math.ceil((targetChars / Math.max(1, values.length) - 40) / 27)));
  const blocks = values.map((value, i) => ({ id: `b${i}`, type: "paragraph", order: i, text: `Record ${i}: ${value}. ${filler}`, headingPath: [], pageNumber: 1, metadata: {} }));
  const text = blocks.map((block) => block.text).join("\n\n");
  let at = 0;
  const matches = values.map((value) => {
    const offset = text.indexOf(value, at);
    at = offset + value.length;
    return { patternType: "jwt", charOffset: offset, length: value.length } as never;
  });
  const started = performance.now();
  const mapped = mapTextMatchesToCanonical(blocks, text, matches, 1);
  console.log(`[bench] ${label} matches=${matches.length} textChars=${text.length} ms=${(performance.now() - started).toFixed(0)} unmapped=${mapped.unmapped.length}`);
}

it.runIf(process.env.PII_LOCATOR_BENCH === "1")("locator timings", () => {
  run("20k-ssn", Array.from({ length: 20_000 }, (_, i) => `${String(100 + (i % 800)).padStart(3, "0")}-${String(10 + (i % 89)).padStart(2, "0")}-${String(i).padStart(4, "0")}`), 640_000);
  run("30-emails-2MB", Array.from({ length: 30 }, (_, i) => `person.${i}@example${i}.test`), 2_000_000);
  run("100-long-lengths-2MB", Array.from({ length: 100 }, (_, i) => `eyJ${"A".repeat(40 + i * 37)}${i}`), 2_000_000);
  run("5000-distinct-2MB", Array.from({ length: 5_000 }, (_, i) => `key-${String(i).padStart(6, "0")}-${"z".repeat(i % 50)}`), 2_000_000);
});
