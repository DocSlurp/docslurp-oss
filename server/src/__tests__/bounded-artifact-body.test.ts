import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readBoundedArtifactText } from "../lib/bounded-artifact-body.js";

describe("bounded artifact body", () => {
  it("preserves UTF-8 characters split across chunks", async () => {
    const bytes = Buffer.from("hello 🌍");
    const stream = Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]);
    expect(await readBoundedArtifactText(stream, bytes.length)).toBe("hello 🌍");
  });

  it("rejects an oversized stream and closes it without reading the remainder", async () => {
    let reads = 0;
    let closed = false;
    async function* chunks() {
      try {
        for (let i = 0; i < 100; i++) { reads++; yield Buffer.alloc(4); }
      } finally { closed = true; }
    }
    await expect(readBoundedArtifactText(chunks(), 5)).rejects.toThrow("read limit");
    expect(reads).toBe(2);
    expect(closed).toBe(true);
  });
});
