import { describe, expect, it } from "vitest";

import {
  PAGE_OFFSETS_MAX_BYTES, PAGE_OFFSETS_MAX_LINE_BYTES, PAGE_OFFSETS_MAX_PAGES, PAGE_OFFSETS_SCHEMA,
  buildPageOffsetsJsonl, pageByteRange, pageOffsetsKey, parsePageOffsets,
} from "./page-offsets.js";

const ID = "doc-1";
const URI = "s3://bucket/u1/run-1/markdown/doc-1.md";

function build(text: string, pageCount: number): string | null {
  return buildPageOffsetsJsonl({ markdown: Buffer.from(text, "utf8"), pageCount, documentId: ID, sourceUri: URI });
}
function read(jsonl: string, over: Partial<{ documentId: string; sourceUri: string; sourceBytes: number }> = {}) {
  return parsePageOffsets(Buffer.from(jsonl, "utf8"), { documentId: ID, sourceUri: URI, sourceBytes: 0, ...over });
}
function roundTrip(text: string, pageCount: number) {
  const buffer = Buffer.from(text, "utf8");
  const jsonl = build(text, pageCount);
  expect(jsonl).not.toBeNull();
  const index = parsePageOffsets(Buffer.from(jsonl!), { documentId: ID, sourceUri: URI, sourceBytes: buffer.length });
  expect(index).not.toBeNull();
  return { buffer, index: index!, jsonl: jsonl! };
}
function pagesOf(buffer: Buffer, index: NonNullable<ReturnType<typeof parsePageOffsets>>): string[] {
  return index.starts.map((start, i) => buffer.subarray(start, start + index.lengths[i]!).toString("utf8"));
}
const lines = (jsonl: string) => jsonl.split("\n").slice(0, -1);
const join = (parts: string[]) => `${parts.join("\n")}\n`;

describe("buildPageOffsetsJsonl / parsePageOffsets", () => {
  it("round-trips and writes the documented lines", () => {
    const text = "# One\fSecond page\fThird";
    const { jsonl, index, buffer } = roundTrip(text, 3);
    const rows = lines(jsonl).map((line) => JSON.parse(line));
    expect(rows[0]).toEqual({ type: "doc", schema: PAGE_OFFSETS_SCHEMA, documentId: ID, sourceUri: URI, sourceBytes: buffer.length, pageCount: 3 });
    expect(rows[1]).toEqual({ type: "page", page: 1, start: 0, bytes: 5 });
    expect(rows[2]).toEqual({ type: "page", page: 2, start: 6, bytes: 11 });
    expect(rows.at(-1)).toEqual({ type: "end", pages: 3 });
    expect(pagesOf(buffer, index)).toEqual(["# One", "Second page", "Third"]);
    expect(jsonl.endsWith("\n")).toBe(true);
  });

  it("uses byte offsets with emoji, CJK and combining marks beside page breaks", () => {
    const pages = ["漢字テキスト😀", "😀é́ 中", "é̂", "ends 🎉", "\u{1F468}‍\u{1F469}x"];
    const text = pages.join("\f");
    const { buffer, index } = roundTrip(text, pages.length);
    expect(pagesOf(buffer, index)).toEqual(pages);
    expect(index.lengths[0]).toBe(Buffer.byteLength(pages[0]!));
    expect(index.starts[1]).toBe(Buffer.byteLength(pages[0]!) + 1);
    expect(index.sourceBytes).toBe(Buffer.byteLength(text));
  });

  it("keeps empty pages", () => {
    const { buffer, index } = roundTrip("\fa\f\f\fb\f", 5);
    expect(pagesOf(buffer, index)).toEqual(["", "a", "", "", "b"]);
    expect(index.lengths).toEqual([0, 1, 0, 0, 1]);
  });

  it("treats a trailing form feed as terminating the last page", () => {
    const { buffer, index } = roundTrip("one\ftwo\f", 2);
    expect(pagesOf(buffer, index)).toEqual(["one", "two"]);
    // The unterminated reading would be 3 pages: that count is not accepted.
    expect(build("one\ftwo\f", 3)).toBeNull();
  });

  it("handles one page, an empty document and a lone form feed", () => {
    expect(roundTrip("just one page", 1).index.lengths).toEqual([13]);
    expect(roundTrip("", 1).index.lengths).toEqual([0]);
    expect(roundTrip("\f", 1).index.lengths).toEqual([0]);
  });

  it("returns null when the form-feed page count differs or the count is unusable", () => {
    expect(build("a\fb", 3)).toBeNull();
    expect(build("a\fb\fc", 2)).toBeNull();
    expect(build("a", 0)).toBeNull();
    expect(build("a", -1)).toBeNull();
    expect(build("a", 1.5)).toBeNull();
    expect(build("a", Number.NaN)).toBeNull();
    expect(build("a", PAGE_OFFSETS_MAX_PAGES + 1)).toBeNull();
    expect(buildPageOffsetsJsonl({ markdown: Buffer.from("a"), pageCount: 1, documentId: ID, sourceUri: "s3://b/" + "x".repeat(PAGE_OFFSETS_MAX_LINE_BYTES) })).toBeNull();
  });

  it("round-trips the maximum page count within the byte bound", () => {
    const text = Array.from({ length: PAGE_OFFSETS_MAX_PAGES }, (_, i) => `p${i}`).join("\f");
    const { jsonl, index } = roundTrip(text, PAGE_OFFSETS_MAX_PAGES);
    expect(index.pageCount).toBe(PAGE_OFFSETS_MAX_PAGES);
    expect(Buffer.byteLength(jsonl)).toBeLessThanOrEqual(PAGE_OFFSETS_MAX_BYTES);
  });
});

describe("parsePageOffsets rejects", () => {
  const text = "ab\fcd\fef";
  const sourceBytes = Buffer.byteLength(text);
  const good = build(text, 3)!;
  const rows = lines(good);
  const parse = (candidate: string, over: Partial<{ documentId: string; sourceUri: string; sourceBytes: number }> = {}) =>
    read(candidate, { sourceBytes, ...over });

  it("accepts the good index (control)", () => {
    expect(parse(good)).not.toBeNull();
  });

  it("a missing end line, a truncated line and a missing final newline", () => {
    expect(parse(join(rows.slice(0, -1)))).toBeNull();
    expect(parse(good.slice(0, good.length - 5))).toBeNull();
    expect(parse(good.slice(0, -1))).toBeNull();
    expect(parse(join(rows.slice(0, 2)))).toBeNull();
  });

  it("a wrong schema, type, or extra or missing keys", () => {
    expect(parse(join([rows[0]!.replace("page-offsets/1", "page-offsets/2"), ...rows.slice(1)]))).toBeNull();
    expect(parse(join([rows[0]!.replace('"type":"doc"', '"type":"page"'), ...rows.slice(1)]))).toBeNull();
    expect(parse(join([rows[0]!.replace("}", ',"x":1}'), ...rows.slice(1)]))).toBeNull();
    expect(parse(join([rows[0]!, '{"type":"page","page":1,"start":0}', ...rows.slice(2)]))).toBeNull();
  });

  it("a different documentId, sourceUri or sourceBytes", () => {
    expect(parse(good, { documentId: "other" })).toBeNull();
    expect(parse(good, { sourceUri: "s3://bucket/other.md" })).toBeNull();
    expect(parse(good, { sourceBytes: sourceBytes + 1 })).toBeNull();
  });

  it("out-of-order or skipped page numbers", () => {
    expect(parse(join([rows[0]!, rows[2]!, rows[1]!, rows[3]!, rows[4]!]))).toBeNull();
    expect(parse(join([rows[0]!, rows[1]!, rows[3]!, rows[4]!]))).toBeNull();
    expect(parse(join([rows[0]!, rows[1]!, rows[1]!, rows[3]!, rows[4]!]))).toBeNull();
    expect(parse(join([rows[0]!, rows[1]!, rows[2]!, rows[3]!.replace('"page":3', '"page":4'), rows[4]!]))).toBeNull();
  });

  it("overlapping or out-of-range offsets", () => {
    expect(parse(join([rows[0]!, rows[1]!, '{"type":"page","page":2,"start":1,"bytes":2}', rows[3]!, rows[4]!]))).toBeNull();
    expect(parse(join([rows[0]!, rows[1]!, rows[2]!, `{"type":"page","page":3,"start":6,"bytes":${sourceBytes}}`, rows[4]!]))).toBeNull();
    expect(parse(join([rows[0]!, '{"type":"page","page":1,"start":0,"bytes":99}', rows[2]!, rows[3]!, rows[4]!]))).toBeNull();
  });

  it("negative, fractional, huge, string and non-finite numbers", () => {
    const withPage1 = (value: string) => join([rows[0]!, `{"type":"page","page":1,"start":${value},"bytes":2}`, ...rows.slice(2)]);
    for (const value of ["-1", "0.5", "1e400", "9007199254740993", '"0"', "null", "true"]) {
      expect(parse(withPage1(value))).toBeNull();
    }
    expect(parse(join([rows[0]!.replace('"pageCount":3', '"pageCount":3.5'), ...rows.slice(1)]))).toBeNull();
    expect(parse(join([rows[0]!.replace('"pageCount":3', `"pageCount":${PAGE_OFFSETS_MAX_PAGES + 1}`), ...rows.slice(1)]))).toBeNull();
    expect(parse(join([rows[0]!.replace('"pageCount":3', '"pageCount":0'), ...rows.slice(1)]))).toBeNull();
    expect(parse(join([...rows.slice(0, -1), '{"type":"end","pages":2}']))).toBeNull();
  });

  it("extra lines and blank lines", () => {
    expect(parse(`${good}{"type":"page","page":4,"start":8,"bytes":0}\n`)).toBeNull();
    expect(parse(`${good}\n`)).toBeNull();
    expect(parse(join([rows[0]!, "", ...rows.slice(1)]))).toBeNull();
  });

  it("oversized input and an oversized line", () => {
    expect(parsePageOffsets(Buffer.alloc(PAGE_OFFSETS_MAX_BYTES + 1, 0x0a), { documentId: ID, sourceUri: URI, sourceBytes })).toBeNull();
    const longUri = `s3://b/${"x".repeat(PAGE_OFFSETS_MAX_LINE_BYTES)}`;
    const long = `${JSON.stringify({ type: "doc", schema: PAGE_OFFSETS_SCHEMA, documentId: ID, sourceUri: longUri, sourceBytes, pageCount: 3 })}\n${rows.slice(1).join("\n")}\n`;
    expect(parse(long, { sourceUri: longUri })).toBeNull();
  });

  it("non-JSON lines, non-object lines and empty input", () => {
    expect(parse(join([rows[0]!, "not json", ...rows.slice(2)]))).toBeNull();
    expect(parse(join([rows[0]!, "[1,2]", ...rows.slice(2)]))).toBeNull();
    expect(parse(join([rows[0]!, "null", ...rows.slice(2)]))).toBeNull();
    expect(parse("")).toBeNull();
    expect(parsePageOffsets(Buffer.from([0xff, 0xfe, 0x0a]), { documentId: ID, sourceUri: URI, sourceBytes })).toBeNull();
  });
});

describe("pageByteRange", () => {
  const pages = ["alpha 😀", "bravo", "", "delta 漢", "echo"];
  const text = pages.join("\f");
  const { buffer, index } = roundTrip(text, pages.length);
  const slice = (start: number, end: number) => {
    const range = pageByteRange(index, start, end);
    return range ? buffer.subarray(range.start, range.end + 1).toString("utf8").split("\f") : null;
  };

  it("returns exactly the requested pages, form feeds between them included", () => {
    expect(slice(1, 1)).toEqual([pages[0]]);
    expect(slice(2, 4)).toEqual(pages.slice(1, 4));
    expect(slice(4, 5)).toEqual(pages.slice(3));
    expect(slice(1, 5)).toEqual(pages);
    expect(pageByteRange(index, 2, 4)).toEqual({ start: index.starts[1], end: index.starts[3]! + index.lengths[3]! - 1 });
  });

  it("clamps to the index", () => {
    expect(slice(-5, 2)).toEqual(pages.slice(0, 2));
    expect(slice(0, 99)).toEqual(pages);
    expect(slice(4, 1000)).toEqual(pages.slice(3));
    expect(slice(2.9, 3.1)).toEqual(pages.slice(1, 3));
  });

  it("returns null for an empty range", () => {
    expect(pageByteRange(index, 6, 9)).toBeNull();
    expect(pageByteRange(index, 4, 2)).toBeNull();
    expect(pageByteRange(index, Number.NaN, 2)).toBeNull();
    expect(pageByteRange(index, 1, Number.POSITIVE_INFINITY)).toBeNull();
    expect(pageByteRange(roundTrip("", 1).index, 1, 1)).toBeNull(); // one empty page has no bytes to fetch
  });
});

describe("pageOffsetsKey", () => {
  it("maps an evidence key to its index key", () => {
    expect(pageOffsetsKey("u1/run-1/summary-evidence/doc-1.json")).toBe("u1/run-1/summary-evidence/doc-1.pages.jsonl");
    expect(pageOffsetsKey("a/b/c")).toBe("a/b/c.pages.jsonl");
  });
});
