import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeImageBundle, encodeImageBundle, mergeImageBundles, type EmbeddedImages } from "./doppler-images.js";

// Authored uniform 2x3 RGB image encoded losslessly, independent of the PDF pilot.
export const webp = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQqCrUsv+BiOh/AAA=", "base64");
export function imageBundle(first = 1, last = 3, pageCount = 3): EmbeddedImages {
  const sha256 = createHash("sha256").update(webp).digest("hex");
  return { pageCount, first, last, assets: [{ sha256, width: 2, height: 3, mediaType: "image/webp", bytes: webp }],
    placements: [{ pageNumber: first, occurrence: 0, role: "image", width: 2, height: 3, sha256 }] };
}

describe("bounded image framing", () => {
  it("preserves Markdown bytes and exact image bytes with page placements", () => {
    const images = imageBundle(), markdown = Buffer.from("title\f\fend");
    const decoded = decodeImageBundle(encodeImageBundle(images, markdown));
    expect(decoded.markdown).toEqual(markdown);
    expect(decoded.images).toEqual(images);
  });
  it("deduplicates assets across shards without dropping placements or blank pages", () => {
    const merged = mergeImageBundles([imageBundle(1,32,33), imageBundle(33,33,33)],33);
    expect(merged.assets).toHaveLength(1);
    expect(merged.placements.map(p => p.pageNumber)).toEqual([1,33]);
    expect(merged.last).toBe(33);
    expect(() => mergeImageBundles([imageBundle(1,31,33), imageBundle(33,33,33)],33)).toThrow();
  });
  it("rejects truncation, extras, malformed headers, changed image hashes and dimensions", () => {
    const wire = encodeImageBundle(imageBundle());
    expect(() => decodeImageBundle(wire.subarray(0,-1))).toThrow();
    expect(() => decodeImageBundle(Buffer.concat([wire,Buffer.from([0])]))).toThrow();
    const bad = Buffer.from(wire); bad[bad.length-1] ^= 1;
    expect(() => decodeImageBundle(bad)).toThrow();
    const huge = Buffer.from(wire); huge.writeUInt32BE(0xffffffff,8);
    expect(() => decodeImageBundle(huge)).toThrow();
    const dimensions = imageBundle(); dimensions.assets[0]!.width = 3;
    expect(() => encodeImageBundle(dimensions)).toThrow();
  });
  it("retains mask identity even when bytes deduplicate with an ordinary image", () => {
    const images = imageBundle();
    images.placements.push({...images.placements[0]!,occurrence:1,role:"smask",maskOf:0});
    expect(decodeImageBundle(encodeImageBundle(images)).images.placements[1]).toMatchObject({role:"smask",maskOf:0});
    images.placements[1]!.maskOf = 2;
    expect(() => encodeImageBundle(images)).toThrow();
  });
  it("refuses out-of-range pages, orphan assets, repeated occurrences, and oversized inventories", () => {
    const images = imageBundle(); images.placements[0]!.pageNumber=4;
    expect(() => encodeImageBundle(images)).toThrow();
    const orphan = imageBundle(); orphan.placements=[];
    expect(() => encodeImageBundle(orphan)).toThrow();
    const duplicate=imageBundle(); duplicate.placements.push({...duplicate.placements[0]!});
    expect(() => encodeImageBundle(duplicate)).toThrow();
    const many=imageBundle(1,600,600); many.placements=Array.from({length:513},(_,i)=>({...many.placements[0]!,pageNumber:i+1}));
    expect(() => encodeImageBundle(many)).toThrow();
  });
});
