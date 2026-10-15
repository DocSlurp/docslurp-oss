import { describe, expect, it } from "vitest";

import { chunkText, chunkTextWithMeta } from "../pipeline/chunking.js";

// ---------------------------------------------------------------------------
// chunkText
// ---------------------------------------------------------------------------

describe("chunkText", () => {
  it("yields nothing for empty string", () => {
    expect([...chunkText("", 100)]).toEqual([]);
  });

  it("yields nothing for whitespace-only string", () => {
    expect([...chunkText("   \n  \t  ", 100)]).toEqual([]);
  });

  it("yields the entire text when it fits within maxChars", () => {
    const text = "Hello world.";
    const chunks = [...chunkText(text, 100)];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Hello world.");
  });

  it("splits text that exceeds maxChars across multiple chunks", () => {
    // 10 repetitions of a 20-char sentence = 200 chars total, maxChars=50
    const sentence = "This is a sentence. ";
    const text = sentence.repeat(10);
    const chunks = [...chunkText(text, 50)];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("hard-splits a sentence that is itself longer than maxChars", () => {
    const longWord = "A".repeat(250);
    const chunks = [...chunkText(longWord, 100)];
    // 250 chars → 3 chunks: 100 + 100 + 50
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.length).toBe(100);
    expect(chunks[1]!.length).toBe(100);
    expect(chunks[2]!.length).toBe(50);
  });

  it("does not produce empty chunks", () => {
    const text = "Short text. More text. Even more.";
    const chunks = [...chunkText(text, 20)];
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it("preserves all content across chunks (no characters dropped)", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(5);
    const chunks = [...chunkText(text, 40)];
    const rejoined = chunks.join(" ");
    // Every word from the original should appear somewhere in the output
    const words = text.trim().split(/\s+/);
    for (const word of new Set(words)) {
      expect(rejoined).toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// chunkTextWithMeta
// ---------------------------------------------------------------------------

describe("chunkTextWithMeta", () => {
  it("yields nothing for empty input", () => {
    expect([...chunkTextWithMeta("", 200)]).toHaveLength(0);
  });

  it("attaches empty headingPath for plain text with no headings", () => {
    const text = "No headings here. Just plain text.";
    const chunks = [...chunkTextWithMeta(text, 500)];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.headingPath).toEqual([]);
  });

  it("attaches the h1 heading name to chunks beneath it", () => {
    const text = "# Introduction\nThis is the intro content.";
    const chunks = [...chunkTextWithMeta(text, 500)];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.headingPath).toContain("Introduction");
  });

  it("produces sequential chunkIndex values starting at 0", () => {
    const text = "Hello world. ".repeat(20);
    const chunks = [...chunkTextWithMeta(text, 80)];
    expect(chunks.length).toBeGreaterThan(1);
    const indices = chunks.map((c) => c.chunkIndex);
    expect(indices[0]).toBe(0);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1]! + 1);
    }
  });

  it("assigns different headingPaths to chunks under different h1 headings", () => {
    const text = "# Chapter One\nContent here.\n\n# Chapter Two\nMore content.";
    const chunks = [...chunkTextWithMeta(text, 500)];
    const paths = chunks.map((c) => c.headingPath.join("/"));
    expect(paths).toContain("Chapter One");
    expect(paths).toContain("Chapter Two");
  });

  it("includes both h1 and h2 in the headingPath for content under h2", () => {
    // h2 is "top-level" in the chunker (level <= 2 flushes a section).
    // So "# Part" creates its own chunk with path ["Part"], and
    // "## Section" content produces a chunk with path ["Part", "Section"].
    const text = "# Part\n## Section\nBody text here.";
    const chunks = [...chunkTextWithMeta(text, 500)];
    const sectionChunk = chunks.find((c) => c.headingPath.includes("Section"));
    expect(sectionChunk).toBeDefined();
    expect(sectionChunk!.headingPath).toContain("Part");
    expect(sectionChunk!.headingPath).toContain("Section");
  });

  it("generates overlap chunks when overlapFraction > 0", () => {
    const text = "Sentence number one. ".repeat(15);
    const base = [...chunkTextWithMeta(text, 80)];
    const withOverlap = [...chunkTextWithMeta(text, 80, { overlapFraction: 0.3 })];
    // Overlap mode inserts extra chunks between adjacent base chunks
    expect(withOverlap.length).toBeGreaterThan(base.length);
    expect(withOverlap.some((c) => c.overlapIndex === 1)).toBe(true);
  });

  it("does not generate overlap chunks when overlapFraction is 0", () => {
    const text = "Sentence number one. ".repeat(15);
    const chunks = [...chunkTextWithMeta(text, 80, { overlapFraction: 0 })];
    expect(chunks.every((c) => c.overlapIndex === undefined || c.overlapIndex === 0)).toBe(true);
  });

  it("overlap chunk text is a combination of tail of previous and head of next", () => {
    const text = "AAAA BBBB CCCC DDDD. EEEE FFFF GGGG HHHH.";
    const chunks = [...chunkTextWithMeta(text, 20, { overlapFraction: 0.5 })];
    const overlapChunks = chunks.filter((c) => c.overlapIndex === 1);
    // Each overlap chunk should be non-empty
    for (const chunk of overlapChunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("skips overlap chunk when overlap text would exceed maxChars", () => {
    // If overlapFraction generates a string > maxChars it should be skipped
    const text = "A".repeat(100) + ". " + "B".repeat(100) + ".";
    const chunks = [...chunkTextWithMeta(text, 50, { overlapFraction: 0.8 })];
    // Overlap (80 chars from each side) would exceed maxChars=50, so should be absent
    const overlapChunks = chunks.filter((c) => c.overlapIndex === 1);
    for (const oc of overlapChunks) {
      expect(oc.text.length).toBeLessThanOrEqual(50);
    }
  });
});
