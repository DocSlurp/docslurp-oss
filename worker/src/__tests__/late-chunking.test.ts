import { describe, expect, it } from "vitest";

import { estimateTokens } from "../lib/unicode-text.js";
import { buildLateChunkedEmbeddingInputs } from "../stages/embed.js";

/** A chunk that costs exactly `tokens` in `estimateTokens` plus the 2 the builder adds. */
const chunkOf = (tokens: number, label: string): string => `${label} ${"x ".repeat(Math.max(0, tokens - 1))}`.trim();

describe("late chunking keeps every input inside the model window", () => {
  it("stops at the first neighbour that does not fit instead of skipping it and taking a farther one", () => {
    // Costs 7, 242, 82, 242, 7 (the estimate plus 2 each) with a 256-token window: the old loop skipped the 242-token
    // neighbours, joined the chunks beyond them, and the 585-token result cut the focus chunk off the window.
    const chunks = [chunkOf(5, "alpha"), chunkOf(240, "beta"), chunkOf(80, "focus"), chunkOf(240, "delta"), chunkOf(5, "omega")];
    const inputs = buildLateChunkedEmbeddingInputs(chunks, true, 2, 256);
    expect(inputs).toHaveLength(5);
    for (const input of inputs) expect(estimateTokens(input)).toBeLessThanOrEqual(256);
    expect(inputs[2]).toContain("focus");
    expect(inputs[2]).not.toContain("alpha");
    expect(inputs[2]).not.toContain("omega");
    expect(inputs[2]).not.toContain("beta");
    expect(inputs[2]).not.toContain("delta");
  });

  it("joins neighbours nearest first and on both sides while they fit", () => {
    const chunks = Array.from({ length: 7 }, (_, i) => chunkOf(10, `c${i}`));
    const [, , , middle] = buildLateChunkedEmbeddingInputs(chunks, true, 2, 256);
    expect(middle).toContain("Context before:\nc1");
    expect(middle).toContain("Focus chunk:\nc3");
    expect(middle).toMatch(/Context after:\nc4/);
    expect(middle).not.toContain("c0");
    expect(middle).not.toContain("c6");
  });

  it("never exceeds the window whatever the chunk sizes", () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 200; round++) {
      const max = 128 + Math.floor(rnd() * 400);
      const chunks = Array.from({ length: 2 + Math.floor(rnd() * 9) }, (_, i) => chunkOf(1 + Math.floor(rnd() * (max - 40)), `k${i}`));
      for (const input of buildLateChunkedEmbeddingInputs(chunks, true, 1 + Math.floor(rnd() * 6), max)) {
        expect(estimateTokens(input)).toBeLessThanOrEqual(max);
      }
    }
  });

  it("returns the chunks untouched when disabled or alone", () => {
    expect(buildLateChunkedEmbeddingInputs(["a b"], true, 2, 256)).toEqual(["a b"]);
    expect(buildLateChunkedEmbeddingInputs(["a", "b"], false, 2, 256)).toEqual(["a", "b"]);
  });
});
