import { describe, expect, it } from "vitest";

import { documentExtractorRegistry } from "./registry.js";
import { findTessdataDir, ocrAvailable } from "./ocr-capability.js";
import type { CommandRunner } from "../tools/runner.js";

const filesystem = (...paths: string[]) => (candidate: string) => paths.includes(candidate);
const runner = {
  kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: true }),
} as unknown as CommandRunner;

describe("OCR capability (tessdata discovery)", () => {
  it("finds traineddata in TESSDATA_PREFIX before the system locations", () => {
    const exists = filesystem("/data/tess", "/data/tess/eng.traineddata", "/usr/share/tessdata", "/usr/share/tessdata/eng.traineddata");
    expect(findTessdataDir({ env: { TESSDATA_PREFIX: "/data/tess" }, exists })).toBe("/data/tess");
  });

  it("falls back to the system locations Tesseract packages install into", () => {
    const exists = filesystem("/usr/share/tesseract-ocr/5/tessdata", "/usr/share/tesseract-ocr/5/tessdata/eng.traineddata");
    expect(findTessdataDir({ env: {}, exists })).toBe("/usr/share/tesseract-ocr/5/tessdata");
  });

  it("ignores a directory that lacks the requested language", () => {
    const exists = filesystem("/usr/share/tessdata", "/usr/share/tessdata/eng.traineddata");
    expect(findTessdataDir({ env: {}, exists, language: "eng" })).toBe("/usr/share/tessdata");
    expect(findTessdataDir({ env: {}, exists, language: "deu" })).toBeNull();
    expect(findTessdataDir({ env: {}, exists, language: "eng+deu" })).toBeNull();
  });

  it("reports no OCR on a host without Tesseract data (the lean worker image)", () => {
    expect(findTessdataDir({ env: { TESSDATA_PREFIX: "/missing" }, exists: filesystem() })).toBeNull();
    expect(ocrAvailable({ env: {}, exists: filesystem() })).toBe(false);
  });

  it("lets operators switch OCR off even when data exists", () => {
    const exists = filesystem("/usr/share/tessdata", "/usr/share/tessdata/eng.traineddata");
    expect(ocrAvailable({ env: {}, exists })).toBe(true);
    expect(ocrAvailable({ env: { DOCSLURP_OCR: "off" }, exists })).toBe(false);
  });
});

describe("kreuzberg planning without OCR", () => {
  const offline = { DOCSLURP_OCR: "off" } as NodeJS.ProcessEnv;

  it("marks kreuzberg unavailable for images when OCR is unavailable", async () => {
    const prepared = await documentExtractorRegistry.prepare("kreuzberg", runner, "/scratch/scan.png", undefined, { format: "image", env: offline });
    expect(prepared.plan.available).toBe(false);
  });

  it("keeps kreuzberg available for text-layer formats, which never need OCR", async () => {
    for (const format of ["pdf", "html", "office-word"]) {
      const prepared = await documentExtractorRegistry.prepare("kreuzberg", runner, "/scratch/doc", undefined, { format, env: offline });
      expect(prepared.plan.available, format).toBe(true);
    }
  });
});
