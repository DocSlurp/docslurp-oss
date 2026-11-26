import { it } from "vitest";

import { mapTextMatchesToCanonical } from "../lib/pii-page-withholding.js";

// Timing only (logs ms); run with PII_LOCATOR_BENCH=1. Synthetic: 20,000 distinct SSN-shaped values, one per block.
it.runIf(process.env.PII_LOCATOR_BENCH === "1")("locator with 20,000 matches", () => {
  const values = Array.from({ length: 20_000 }, (_, i) => `${String(100 + (i % 800)).padStart(3, "0")}-${String(10 + (i % 89)).padStart(2, "0")}-${String(i).padStart(4, "0")}`);
  const blocks = values.map((value, i) => ({ id: `b${i}`, type: "paragraph", order: i, text: `Record ${i}: SSN ${value}.`, headingPath: [], pageNumber: 1, metadata: {} }));
  const text = blocks.map((block) => block.text).join("\n\n");
  let at = 0;
  const matches = values.map((value) => {
    const offset = text.indexOf(value, at);
    at = offset + value.length;
    return { patternType: "ssn", charOffset: offset, length: value.length } as never;
  });
  const started = performance.now();
  const mapped = mapTextMatchesToCanonical(blocks, text, matches, 1);
  console.log(`[bench] locator matches=${matches.length} textChars=${text.length} ms=${(performance.now() - started).toFixed(0)} unmapped=${mapped.unmapped.length}`);
});
