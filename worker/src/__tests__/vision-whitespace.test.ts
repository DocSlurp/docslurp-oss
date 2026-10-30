import { describe, expect, it } from "vitest";

import { postProcessVisionText } from "../tools/vision-model-profiles.js";
import { normalizeVisionWhitespace as normalize } from "../tools/vision-whitespace.js";

const IDEO = "\u3000";
const NBSP = "\u00A0";

describe("normalizeVisionWhitespace", () => {
  it("collapses Luna-style ideographic padding on an English page", () => {
    const padded = `# Annual report${IDEO.repeat(40)}\n\nRevenue grew${IDEO.repeat(12)}by 4%.${IDEO.repeat(30)}\n${IDEO.repeat(60)}\n${IDEO.repeat(60)}\n\n\n\nNext paragraph.`;
    expect(normalize(padded)).toBe("# Annual report\n\nRevenue grew by 4%.\n\n\nNext paragraph.");
  });

  it("collapses mixed wide and ASCII space runs, and leaves ASCII-only runs alone", () => {
    expect(normalize(`a \u2003 \u2009b`)).toBe("a b");
    expect(normalize(`a${"\u205F\u202F"}b`)).toBe("a b");
    expect(normalize("a    b")).toBe("a    b");
  });

  it("keeps a single U+3000 between CJK characters and as a paragraph indent", () => {
    expect(normalize(`東京${IDEO}大阪`)).toBe(`東京${IDEO}大阪`);
    expect(normalize(`東京${IDEO.repeat(5)}大阪`)).toBe(`東京${IDEO}大阪`);
    expect(normalize(`${IDEO.repeat(2)}本文が始まる。`)).toBe(`${IDEO}本文が始まる。`);
    expect(normalize(`한국어${IDEO.repeat(3)}문장`)).toBe(`한국어${IDEO}문장`);
    // Between Latin text the run is padding, not typography.
    expect(normalize(`Total${IDEO.repeat(3)}42`)).toBe("Total 42");
    // Extension-B ideographs are surrogate pairs.
    expect(normalize(`𠀋${IDEO.repeat(3)}𠀋`)).toBe(`𠀋${IDEO}𠀋`);
  });

  it("keeps single NBSPs in tables and collapses NBSP padding", () => {
    expect(normalize(`| 10${NBSP}kg | €${NBSP}5 |`)).toBe(`| 10${NBSP}kg | €${NBSP}5 |`);
    expect(normalize(`| Item${NBSP.repeat(8)}| Price${NBSP.repeat(4)} |${NBSP.repeat(3)}`)).toBe("| Item | Price |");
  });

  it("removes zero-width padding but keeps joiners inside words", () => {
    expect(normalize("\uFEFFHello\u200B world\u200B")).toBe("Hello world");
    expect(normalize("a,\u200D b \u200C")).toBe("a, b");
    // ZWNJ inside a Persian word and ZWJ inside an emoji sequence carry meaning.
    expect(normalize("می\u200Cخواهم")).toBe("می\u200Cخواهم");
  });

  it("leaves fenced code untouched", () => {
    const code = `\`\`\`python\nx = 1${IDEO.repeat(4)}\n\n\n\n\ny${NBSP.repeat(3)}= 2   \n\`\`\``;
    expect(normalize(`Intro${IDEO.repeat(3)}\n${code}\nAfter${IDEO.repeat(3)}`)).toBe(`Intro\n${code}\nAfter`);
    const tilde = `~~~~\n\`\`\`\na${IDEO.repeat(2)}b\n~~~~`;
    expect(normalize(tilde)).toBe(tilde);
    // An inline code span with three backticks on one line is not a fence.
    expect(normalize(`\`\`\`x\`\`\` a${IDEO.repeat(2)}b`)).toBe("```x``` a b");
  });

  it("strips trailing whitespace and caps blank runs at two", () => {
    expect(normalize("a  \t\r\n\n\n\n\nb\t")).toBe("a\n\n\nb");
  });

  it("is idempotent and returns clean text as is", () => {
    const samples = [
      `# T${IDEO.repeat(9)}\n\n東京${IDEO.repeat(3)}大阪\n${IDEO.repeat(2)}段落\n| a${NBSP.repeat(4)}| b |\n\`\`\`\nx${IDEO.repeat(3)}\n\`\`\`\n\n\n\n\nend  `,
      "plain text\n\nwith paragraphs",
      "",
    ];
    for (const sample of samples) {
      const once = normalize(sample);
      expect(normalize(once)).toBe(once);
    }
    expect(normalize("plain text\n\nwith paragraphs")).toBe("plain text\n\nwith paragraphs");
  });

  it("runs for every model through postProcessVisionText, after the profile repair", () => {
    expect(postProcessVisionText("google/gemini-3.1-flash-lite", `a${IDEO.repeat(4)}b`)).toBe("a b");
    // Luna's whole-page fence is unwrapped first, so its padding is collapsed rather than kept as code.
    expect(postProcessVisionText("openai/gpt-6-luna", `\`\`\`markdown\n# Page${IDEO.repeat(5)}\n\`\`\``)).toBe("# Page");
  });
});
