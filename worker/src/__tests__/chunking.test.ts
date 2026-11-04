import { describe, expect, it } from "vitest";

import { chunkText, chunkTextWithMeta } from "../pipeline/chunking.js";
import { estimateTokens } from "../lib/unicode-text.js";
import { buildChunks, buildChunksCooperative } from "../stages/embedding-runtime.js";

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

// ---------------------------------------------------------------------------
// Unicode and token-limit behaviour
// ---------------------------------------------------------------------------

describe("chunking non-Latin text", () => {
  const hasLoneSurrogate = (value: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);

  it("cuts Japanese at sentence ends, not mid-sentence", () => {
    const sentences = ["請求書の支払期限は来月末日です。", "お支払いは銀行振込でお願いします。", "ご不明な点はお問い合わせください。"];
    const chunks = [...chunkText(sentences.join(""), 40)];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
      expect(chunk.endsWith("。")).toBe(true);
    }
    expect(chunks.join("")).toBe(sentences.join(""));
  });

  it("cuts Russian at sentence ends and never inside a word", () => {
    const text = "Москва является столицей России. Санкт-Петербург был столицей раньше. Новосибирск находится в Сибири.";
    const chunks = [...chunkText(text, 60)];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.endsWith(".")).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });

  it("splits a long unbroken run without separating surrogate pairs or emoji clusters", () => {
    const family = "👨‍👩‍👧‍👦"; // ZWJ sequence, 11 UTF-16 units
    const text = family.repeat(30) + "𠮷".repeat(40);
    for (const max of [10, 11, 12, 25]) {
      const chunks = [...chunkText(text, max)];
      for (const chunk of chunks) {
        expect(hasLoneSurrogate(chunk)).toBe(false);
        expect(chunk.length).toBeLessThanOrEqual(Math.max(max, family.length));
        expect(chunk.normalize("NFC")).toBe(chunk);
      }
      expect(chunks.join("")).toBe(text);
    }
  });

  it("keeps a combining-mark cluster together", () => {
    const text = ("é".repeat(7) + " ").repeat(10);
    for (const chunk of chunkText(text, 8)) expect(chunk.startsWith("́")).toBe(false);
  });

  it("normalizes decomposed text to NFC before chunking", () => {
    const [chunk] = [...chunkText("Müller zahlt", 100)];
    expect(chunk).toBe("Müller zahlt");
  });

  it("keeps a fenced code block whole when it fits", () => {
    const code = "```sh\n# build\nmake all. Then install.\nmake install\n```";
    const text = `${"Intro sentence here. ".repeat(4)}\n\n${code}\n\n${"Closing sentence here. ".repeat(4)}`;
    const chunks = [...chunkText(text, code.length + 10)];
    expect(chunks.filter((chunk) => chunk.includes("make all"))).toHaveLength(1);
    const holder = chunks.find((chunk) => chunk.includes("make all"))!;
    expect(holder).toContain(code);
  });

  it("emits no overlap chunk when the overlap rounds to zero characters (slice(-0))", () => {
    const text = Array.from({ length: 40 }, (_, index) => `Sentence number ${index} ends here.`).join(" ");
    const chunks = [...chunkTextWithMeta(text, 120, { overlapFraction: 0.001 })];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.overlapIndex === 0)).toBe(true);
  });

  it("keeps overlap on word boundaries", () => {
    const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima. ".repeat(6);
    const chunks = [...chunkTextWithMeta(text, 120, { overlapFraction: 0.5 })].filter((chunk) => chunk.overlapIndex === 1);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      for (const word of chunk.text.split(/\s+/)) expect(text).toContain(word);
    }
  });

  it("sizes chunks in model tokens so a small context window never truncates the tail", () => {
    const text = "Это предложение довольно длинное и содержит много слов для проверки. ".repeat(12);
    const maxTokens = 40;
    const chunks = [...chunkText(text, 1800, { maxTokens })];
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(maxTokens);
  });

  it("budgets every Han character as a token", () => {
    const text = "契約".repeat(300) + "。";
    const chunks = [...chunkText(text, 1800, { maxTokens: 64 })];
    for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(64);
    expect(chunks.join("")).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Scale: chunking runs on the worker's event loop, which also answers the activity heartbeat
// ---------------------------------------------------------------------------

describe("chunking large documents", () => {
  const sentence = "The committee reviewed the quarterly report and agreed that the new schedule should begin after the winter break. ";
  const checkAll = (text: string, maxChars: number, maxTokens: number) => {
    const chunks = [...chunkTextWithMeta(text, maxChars, { maxTokens })];
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(maxTokens);
    }
    return chunks;
  };

  // Each case was 3 to 23 seconds (and up to 945 MB) when every level re-counted the whole text; linear it is
  // 0.2 to 0.5 seconds. The bound leaves a slow CI machine ten times as much.
  it.each([
    ["one 2.8M-character English paragraph", () => sentence.repeat(25_000), 5_000],
    ["2.8M characters of words with no sentence end", () => "the committee reviewed the quarterly report and agreed ".repeat(52_000), 5_000],
    ["1.1M characters of Chinese", () => "委员会审议了季度报告，并同意在冬季休假之后开始执行新的时间表。".repeat(36_000), 5_000],
    ["one 1M-character token", () => "a".repeat(1_000_000), 5_000],
    ["3M characters of unbroken Hangul", () => "위원회는분기보고서를검토하고".repeat(210_000), 5_000],
  ])("%s chunks in linear time", (_name, make, budgetMs) => {
    const text = make();
    const started = performance.now();
    const chunks = checkAll(text, 1800, 256);
    expect(performance.now() - started).toBeLessThan(budgetMs);
    expect(chunks.length).toBeGreaterThan(100);
  });

  it("chunks ten thousand pages of mixed prose, lists and code in a few seconds", () => {
    const page = (i: number) => `# Page ${i}\n\n${sentence.repeat(8)}\n\n- item one\n- item two\n\n\`\`\`\ncode line ${i}\n\`\`\`\n`;
    const text = Array.from({ length: 10_000 }, (_, i) => page(i)).join("\f");
    const started = performance.now();
    const chunks = [...chunkTextWithMeta(text, 1800, { maxTokens: 256 })];
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(chunks.length).toBeGreaterThanOrEqual(10_000);
  });

  it("returns control between chunks often enough for a heartbeat while a large document is chunked", async () => {
    const text = Array.from({ length: 4_000 }, (_, i) => `## Section ${i}\n\n${sentence.repeat(6)}`).join("\n\n");
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const { texts } = await buildChunksCooperative(text, "fallback", { maxTokens: 256 });
    clearInterval(timer);
    expect(texts).toEqual(buildChunks(text, "fallback", { maxTokens: 256 }).texts);
    expect(ticks).toBeGreaterThan(0);
  });

  it("keeps Unicode intact at scale: no split surrogate pair, grapheme cluster or fenced block", () => {
    const family = "👨‍👩‍👧‍👦";
    const fence = "```ts\n" + "const value = compute(input);\n".repeat(3) + "```\n";
    const text = [`${family}`.repeat(3_000), "é́".repeat(2_000), "你好吗？".repeat(3_000), fence + sentence.repeat(30)].join("\n\n");
    const chunks = checkAll(text, 400, 64);
    const all = chunks.map((chunk) => chunk.text).join("\n");
    expect(all).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    for (const chunk of chunks) {
      const clusters = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(chunk.text)].map((part) => part.segment);
      expect(clusters.join("")).toBe(chunk.text);
      expect(chunk.text.startsWith("‍")).toBe(false);
      expect(chunk.text.startsWith("́")).toBe(false);
    }
    expect(chunks.some((chunk) => chunk.text.includes("```ts\nconst value = compute(input);\n") && chunk.text.trimEnd().endsWith("```"))).toBe(true);
  });
});
