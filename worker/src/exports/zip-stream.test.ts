import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { zipStream, type ZipStreamEntry } from "./zip-stream.js";

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function* streamOf(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

describe("zipStream", () => {
  it("writes strings, bytes and streams into a readable archive", async () => {
    const entries: ZipStreamEntry[] = [
      { path: "doc/doc.md", compress: true, body: async () => "# Title\n" },
      { path: "doc/images/page-0001.png", compress: false, body: async () => new Uint8Array([137, 80, 78, 71]) },
      { path: "doc/original/Résumé.txt", compress: true, body: async () => ({ stream: streamOf("one ", "two"), size: 7 }) },
    ];

    const files = unzipSync(await collect(zipStream(entries)));

    expect(Object.keys(files)).toEqual(["doc/doc.md", "doc/images/page-0001.png", "doc/original/Résumé.txt"]);
    expect(strFromU8(files["doc/doc.md"]!)).toBe("# Title\n");
    expect(Array.from(files["doc/images/page-0001.png"]!)).toEqual([137, 80, 78, 71]);
    expect(strFromU8(files["doc/original/Résumé.txt"]!)).toBe("one two");
  });

  it("leaves out unreadable or empty entries and reports them", async () => {
    const skipped: string[] = [];
    const entries: ZipStreamEntry[] = [
      { path: "a.md", compress: true, body: async () => { throw new Error("gone"); } },
      { path: "b.md", compress: true, body: async () => null },
      { path: "c.md", compress: true, body: async () => "kept" },
    ];

    const files = unzipSync(await collect(zipStream(entries, { onSkip: (path, reason) => skipped.push(`${path}: ${reason}`) })));

    expect(Object.keys(files)).toEqual(["c.md"]);
    expect(skipped).toEqual(["a.md: gone"]);
  });

  it("stops adding files at the size limit", async () => {
    const skipped: string[] = [];
    const entries: ZipStreamEntry[] = [
      { path: "small.md", compress: true, body: async () => "12345" },
      { path: "big.bin", compress: false, body: async () => ({ stream: streamOf("x".repeat(20)), size: 20 }) },
    ];

    const files = unzipSync(await collect(zipStream(entries, { maxBytes: 10, onSkip: (path) => skipped.push(path) })));

    expect(Object.keys(files)).toEqual(["small.md"]);
    expect(skipped).toEqual(["big.bin"]);
  });
});
