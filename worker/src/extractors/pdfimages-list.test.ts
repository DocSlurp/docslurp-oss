import { describe, expect, it } from "vitest";
import { parsePdfImagesList, pdfImagesFacts, pngDimensions } from "./pdfimages-list.js";

const LIST = `page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
--------------------------------------------------------------------------------------------
   3     0 image     820  1060  rgb     3   8  jpeg   no         7  0   118   118 15.8K 0.6%
   3     1 smask     820  1060  gray    1   8  image  yes        9  0   118   118 7898B 0.3%
   3     2 stencil    20    20  -       1   1  ccitt  no  [inline]       72    72  400B  100%
   3     3 image      10    10  gray    1   8  image  no  [none]         96    96  100B  1.0%
`;

describe("pdfimages -list", () => {
  it("reads stored facts, including inline images and masks, without inventing anything", () => {
    const rows = parsePdfImagesList(LIST);
    expect(rows.map((r) => [r.page, r.num, r.role, r.width, r.height])).toEqual([[3, 0, "image", 820, 1060], [3, 1, "smask", 820, 1060], [3, 2, "stencil", 20, 20], [3, 3, "image", 10, 10]]);
    expect(rows[0]!.source).toEqual({ objectId: { num: 7, gen: 0 }, inline: false, encoding: "jpeg", colorSpace: "rgb", components: 3, bitsPerComponent: 8, interpolate: false, ppi: [118, 118], streamBytes: 16179 });
    expect(rows[1]!.source).toMatchObject({ interpolate: true, streamBytes: 7898 });
    expect(rows[2]!.source).toMatchObject({ objectId: null, inline: true, encoding: "ccitt", colorSpace: "-", ppi: [72, 72], streamBytes: 400 });
    expect(rows[3]!.source).toMatchObject({ objectId: null, inline: false, ppi: [96, 96], streamBytes: 100 });
    const facts = pdfImagesFacts(rows, rows.map((r, i) => ({ sha256: String(i).repeat(64), width: r.width, height: r.height })), 3);
    expect(facts.every((f) => f.placement.status === "unknown" && f.signals === null && f.anchor === null && f.maskOf === undefined)).toBe(true);
    expect(facts.map((f) => f.occurrence)).toEqual([0, 1, 2, 3]);
  });

  it("refuses output it cannot join reliably", () => {
    expect(() => parsePdfImagesList("nothing here")).toThrow("Unrecognized");
    expect(() => parsePdfImagesList(LIST.replace("image     820", "photo     820"))).toThrow("Unreadable");
    const rows = parsePdfImagesList(LIST);
    expect(() => pdfImagesFacts(rows, [], 3)).toThrow("disagree");
    expect(() => pdfImagesFacts(rows, rows.map((r) => ({ sha256: "a".repeat(64), width: r.width, height: r.height })), 4)).toThrow("another page");
  });

  it("reads PNG dimensions from the header only", () => {
    const header = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 3])]);
    expect(pngDimensions(header)).toEqual({ width: 2, height: 3 });
    expect(pngDimensions(Buffer.from("not a png at all, really"))).toBeNull();
  });
});
