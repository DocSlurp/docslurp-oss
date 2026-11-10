import { describe, expect, it } from "vitest";

import {
  DOPPLER_FIGURE_FILE_NAME, DOPPLER_FIGURE_LIMITS, DOPPLER_FIGURES_VERSION, dopplerFigureFileName, dopplerFigureManifestSchema,
  dopplerFigureUrls, dopplerImageMarkerIds, parseDopplerFigureId, parseDopplerImageMarkerLine, resolveDopplerImageMarkers,
  stripDopplerImageMarkers, type DopplerFigureEntry,
} from "../doppler-figures.js";

const sha = "a".repeat(64);
const raster = (over: Partial<DopplerFigureEntry> = {}): DopplerFigureEntry => ({
  id: "p3.1", page: 3, bbox: [72, 100, 300, 260], kind: "picture", fate: "block", file: "p3.1.webp", format: "webp",
  bytes: 120, sha256: sha, width: 456, height: 320, ...over,
});
const vector = (over: Partial<DopplerFigureEntry> = {}): DopplerFigureEntry => ({
  id: "p3.g2", page: 3, bbox: [72, 300, 500, 600], kind: "vector", fate: "block", file: "p3.g2.svg", format: "svg",
  bytes: 900, sha256: "b".repeat(64), width: 428.5, height: 300, ...over,
});
const manifest = (images: unknown[]) => ({ version: DOPPLER_FIGURES_VERSION, images });

describe("doppler figure ids and names", () => {
  it("parses raster and vector ids", () => {
    expect(parseDopplerFigureId("p12.0")).toEqual({ id: "p12.0", pageNumber: 12, vector: false, index: 0 });
    expect(parseDopplerFigureId("p1.g7")).toEqual({ id: "p1.g7", pageNumber: 1, vector: true, index: 7 });
  });

  it.each(["p0.1", "p1", "p1.", "p01.1", "p1.01", "p1.x1", "../p1.1", "p1.1/..", "p1.1 ", "P1.1", "p1234567890.1", "p1.1234567"])("refuses %j", (id) => {
    expect(parseDopplerFigureId(id)).toBeNull();
  });

  it("derives file names only from id and format", () => {
    expect(dopplerFigureFileName("p3.g2", "svg")).toBe("p3.g2.svg");
    expect(() => dopplerFigureFileName("../etc/passwd", "svg")).toThrow();
    expect(() => dopplerFigureFileName("p3.1", "html" as never)).toThrow();
    expect(DOPPLER_FIGURE_FILE_NAME.test("p3.1.webp")).toBe(true);
    for (const name of ["manifest.json", "p3.1.webp.exe", ".p3.1.webp", "p3.1.WEBP", "p3.1.html", "x/p3.1.webp"]) {
      expect(DOPPLER_FIGURE_FILE_NAME.test(name)).toBe(false);
    }
  });
});

describe("dopplerFigureManifestSchema", () => {
  it("accepts raster, vector, repeat and fileless entries", () => {
    const parsed = dopplerFigureManifestSchema.parse(manifest([
      raster(), vector(),
      raster({ id: "p4.1", page: 4, file: null, format: null, bytes: null, sha256: null, width: null, height: null, fate: "duplicate", repeat_of: "p3.1" }),
      raster({ id: "p5.2", page: 5, file: null, format: null, bytes: null, sha256: null, width: null, height: null, fate: "block", error: "pixels" }),
    ]));
    expect(parsed.images).toHaveLength(4);
  });

  it.each([
    ["traversal file name", raster({ file: "../../p3.1.webp" })],
    ["file name not derived from id", raster({ file: "p3.2.webp" })],
    ["format mismatch", raster({ file: "p3.1.svg" })],
    ["page mismatch", raster({ page: 4 })],
    ["vector id as picture", vector({ kind: "picture" })],
    ["picture id as vector", raster({ kind: "vector" })],
    ["oversized file", raster({ bytes: DOPPLER_FIGURE_LIMITS.maxFileBytes + 1 })],
    ["empty file", raster({ bytes: 0 })],
    ["bad hash", raster({ sha256: "A".repeat(64) })],
    ["fractional raster", raster({ width: 10.5 })],
    ["unordered bbox", raster({ bbox: [300, 100, 72, 260] })],
    ["non-finite bbox", raster({ bbox: [0, 0, Infinity, 1] })],
    ["unknown field", { ...raster(), path: "/etc/passwd" }],
    ["unknown format", raster({ format: "html" as never, file: "p3.1.html" })],
    ["fileless with hash", raster({ file: null, format: null, bytes: null })],
    ["repeat with own file", raster({ repeat_of: "p3.g2" })],
  ])("refuses %s", (_name, entry) => {
    expect(dopplerFigureManifestSchema.safeParse(manifest([entry, vector()])).success).toBe(false);
  });

  it("refuses duplicate ids, dangling repeats, totals and unknown versions", () => {
    expect(dopplerFigureManifestSchema.safeParse(manifest([raster(), raster()])).success).toBe(false);
    expect(dopplerFigureManifestSchema.safeParse(manifest([raster({ id: "p4.1", page: 4, file: null, format: null, bytes: null, sha256: null, width: null, height: null, repeat_of: "p9.9" })])).success).toBe(false);
    const big = Array.from({ length: 9 }, (_, i) => raster({ id: `p${i + 1}.1`, page: i + 1, file: `p${i + 1}.1.webp`, bytes: DOPPLER_FIGURE_LIMITS.maxFileBytes }));
    expect(dopplerFigureManifestSchema.safeParse(manifest(big)).success).toBe(false);
    expect(dopplerFigureManifestSchema.safeParse({ version: "doppler-figures@2", images: [] }).success).toBe(false);
    expect(dopplerFigureManifestSchema.safeParse({ version: DOPPLER_FIGURES_VERSION, images: [], extra: 1 }).success).toBe(false);
  });
});

describe("doppler-image markers", () => {
  const md = "Intro\n\n![image](doppler-image:p3.1)\n\nAn icon ![image](doppler-image:p3.g2) inline.\f![image](doppler-image:p9.9)\n";

  it("finds marker ids and whole-line markers", () => {
    expect(dopplerImageMarkerIds(md)).toEqual(["p3.1", "p3.g2", "p9.9"]);
    expect(parseDopplerImageMarkerLine("![image](doppler-image:p3.1)")).toEqual({ alt: "image", id: "p3.1" });
    expect(parseDopplerImageMarkerLine("text ![image](doppler-image:p3.1)")).toBeNull();
    expect(parseDopplerImageMarkerLine("![image](doppler-image:../x)")).toBeNull();
  });

  it("resolves only ids the resolver knows and drops the rest", () => {
    const out = resolveDopplerImageMarkers(md, (id) => (id === "p3.1" ? "/v1/files/tok/p3.1.webp" : id === "p3.g2" ? "/v1/files/a b(c)/p3.g2.svg" : null));
    expect(out).toContain("![image](/v1/files/tok/p3.1.webp)");
    expect(out).toContain("![image](/v1/files/a%20b%28c%29/p3.g2.svg)");
    expect(out).not.toContain("doppler-image:");
    expect(out.split("\f")[1]).toBe("\n");
  });

  it("strips markers for embedding text and leaves other text alone", () => {
    expect(stripDopplerImageMarkers(md)).toBe("Intro\n\n\n\nAn icon  inline.\f\n");
    expect(stripDopplerImageMarkers("no markers")).toBe("no markers");
    // Doppler escapes look-alikes in page text with a zero-width space; they are not markers.
    expect(stripDopplerImageMarkers("![image](doppler​-image:p1.1)")).toBe("![image](doppler​-image:p1.1)");
  });

  it("maps artifact slots to URLs, through repeats when the index is given", () => {
    const artifacts = [
      { slot: "doc-1:doppler-figure:p3.1", url: "/f/1" },
      { slot: "doc-2:doppler-figure:p3.1", url: "/other-doc" },
      { slot: "doc-1:doppler-figure:../x", url: "/bad" },
      { slot: "doc-1:heatmap", url: "/h" },
    ];
    expect([...dopplerFigureUrls("doc-1", artifacts)]).toEqual([["p3.1", "/f/1"]]);
    expect([...dopplerFigureUrls("doc-1", artifacts, [{ id: "p3.1", fileOf: "p3.1" }, { id: "p4.1", fileOf: "p3.1" }, { id: "p5.1", fileOf: null }])])
      .toEqual([["p3.1", "/f/1"], ["p4.1", "/f/1"]]);
  });
});
