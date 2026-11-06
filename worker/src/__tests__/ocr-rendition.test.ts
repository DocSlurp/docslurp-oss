import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerExtractorPlugin, resetExtractorPluginsForTest, type SandboxedOcrJob } from "../extractors/plugins.js";
import { PAGE_RENDITION, parseRawRendition, RENDITION_MAGIC } from "../lib/page-rendition.js";
import { readWithOcr } from "../ocr/engine.js";
import { ocrDocument } from "../ocr/read-document.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { fakeOcrRunner, ocrResultFor, pngHeader } from "../test/fake-ocr.js";

/** A raw rendition as the CLI writes it: magic, u32 BE width and height, then width x height x 3 RGB bytes. */
function raw(width: number, height: number, pixels = Buffer.alloc(width * height * 3, 0x80)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  return Buffer.concat([RENDITION_MAGIC, head, pixels]);
}

/** A PNG chunk with its CRC slot (the content does not matter: a PNG rendition is refused before any decoding). */
function pngWith(chunk: string): Buffer {
  const body = Buffer.from(chunk === "iCCP" ? "icc\0\0crafted-profile" : chunk === "eXIf" ? "MM\0*crafted" : "Comment\0\0crafted");
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(chunk, 4, "latin1");
  return Buffer.concat([pngHeader(64, 64), head, body, Buffer.alloc(4)]);
}

/**
 * An uploaded image's only pixels the worker uses are the OCR boundary's renditions: raw RGB behind a fixed header. The host
 * accepts one only when it is exactly that (named for its frame, exact size for its dimensions, within the caps); anything
 * else, a PNG with or without ICC, EXIF or text chunks included, is refused. Nothing is decoded.
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "ocr-rendition-"));
  vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => { resetExtractorPluginsForTest(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

function provider(renditions: boolean) {
  registerExtractorPlugin({ apiVersion: 1, name: "ocr", sandboxedOcr: {
    id: "test-vm-ocr", renditions, maxSourceBytes: 1e9, assertConfigured() {}, run: vi.fn(), timeoutMs: () => 1,
  } as never });
}

/** A boundary that writes each frame's rendition file as `files` says. */
function boundary(files: Record<number, { name?: string; file?: string; bytes: Buffer } | null>) {
  const jobs: SandboxedOcrJob[] = [];
  const frames = [1, 2, 3].map((frame) => ({ frame, text: `Page ${frame}` }));
  const fake = fakeOcrRunner(() => frames, {
    result: (job) => {
      jobs.push(job);
      const result = ocrResultFor(job, frames) as { frames: Array<Record<string, unknown>> };
      for (const record of result.frames) {
        const file = files[record.frame as number];
        record.rendition = file ? file.name ?? `rendition-${String(record.frame).padStart(4, "0")}.rgb` : null;
      }
      return result;
    },
  });
  const run = fake.runner.run;
  fake.runner.run = vi.fn(async (plan) => {
    const out = await run(plan);
    const job = plan.sandboxedOcr!;
    for (const [frame, file] of Object.entries(files)) {
      if (file) await writeFile(path.join(job.imageDir, file.file ?? `rendition-${String(frame).padStart(4, "0")}.rgb`), file.bytes);
    }
    return out;
  });
  return { runner: fake.runner, jobs };
}

describe("OCR boundary renditions", () => {
  it("asks a provider that declares renditions for them, and accepts only well-formed ones within the caps", async () => {
    provider(true);
    const { runner, jobs } = boundary({
      1: { bytes: raw(1024, 768) },                                    // ok
      2: { bytes: raw(1025, 10) },                                     // long edge over the 1024 cap
      3: { bytes: Buffer.concat([raw(800, 600), Buffer.alloc(PAGE_RENDITION.maxBytes)]) }, // over the byte cap
    });
    const source = path.join(dir, "scan.png");
    await writeFile(source, "bytes");
    const outcome = await readWithOcr(runner as never, { source, kind: "image", escalation: false, rendition: PAGE_RENDITION });
    try {
      expect(jobs[0]!.rendition).toEqual(PAGE_RENDITION);
      const byPage = new Map(outcome.pages.map((page) => [page.pageNumber, page.rendition]));
      expect(byPage.get(1)).toMatchObject({ width: 1024, height: 768 });
      expect(byPage.get(2)).toBeUndefined();
      expect(byPage.get(3)).toBeUndefined();
    } finally {
      await outcome.dispose();
    }
  });

  it.each([
    ["a PNG with an iCCP chunk", pngWith("iCCP")],
    ["a PNG with an eXIf chunk", pngWith("eXIf")],
    ["a PNG with a zTXt chunk", pngWith("zTXt")],
    ["a plain PNG", pngHeader(64, 64)],
    ["a short pixel body", raw(10, 10).subarray(0, 100)],
    ["trailing bytes", Buffer.concat([raw(10, 10), Buffer.from("x")])],
    ["a zero width", raw(0, 10, Buffer.alloc(0))],
    ["a bad magic", Buffer.concat([Buffer.from("DSRGB2\n\0"), raw(10, 10).subarray(8)])],
  ])("refuses %s, never decoding it", async (_name, bytes) => {
    provider(true);
    const { runner } = boundary({ 1: { bytes } });
    const source = path.join(dir, "scan.png");
    await writeFile(source, "bytes");
    const outcome = await readWithOcr(runner as never, { source, kind: "image", escalation: false, rendition: PAGE_RENDITION });
    try {
      expect(outcome.pages.every((page) => page.rendition === undefined)).toBe(true);
    } finally {
      await outcome.dispose();
    }
    expect(parseRawRendition(bytes)).toBeNull();
  });

  it("refuses a result naming a rendition under its old PNG name", async () => {
    provider(true);
    const { runner } = boundary({ 1: { name: "rendition-0001.png", file: "rendition-0001.png", bytes: raw(10, 10) } });
    const source = path.join(dir, "scan.png");
    await writeFile(source, "bytes");
    // The result schema accepts only `.rgb` rendition names: a boundary naming a PNG is refused as a whole result.
    await expect(readWithOcr(runner as never, { source, kind: "image", escalation: false, rendition: PAGE_RENDITION })).rejects.toThrow();
  });

  it("refuses a rendition named for another frame", async () => {
    provider(true);
    const { runner } = boundary({ 2: { name: "rendition-0001.rgb", bytes: raw(10, 10) } });
    const source = path.join(dir, "scan.png");
    await writeFile(source, "bytes");
    const outcome = await readWithOcr(runner as never, { source, kind: "image", escalation: false, rendition: PAGE_RENDITION });
    try {
      expect(outcome.pages.every((page) => page.rendition === undefined)).toBe(true);
    } finally {
      await outcome.dispose();
    }
  });

  it("does not ask a provider whose guest cannot make renditions (the pages then get no visual index, reported)", async () => {
    provider(false);
    const { runner, jobs } = boundary({});
    const source = path.join(dir, "scan.png");
    await writeFile(source, "bytes");
    const outcome = await readWithOcr(runner as never, { source, kind: "image", escalation: false, rendition: PAGE_RENDITION });
    await outcome.dispose();
    expect(jobs[0]!.rendition).toBeUndefined();
  });

  it("ocrDocument carries each accepted rendition's bytes out before the boundary's scratch is removed", async () => {
    provider(true);
    const rgb = raw(64, 48);
    const { runner } = boundary({ 1: { bytes: rgb }, 2: null, 3: null });
    const source = path.join(dir, "scan.png");
    await writeFile(source, "bytes");
    const state = WorkflowState.create({ id: "run-1", pipeline: {}, stats: {}, artifacts: {} } as never, []);
    const result = await ocrDocument({ runner: runner as never, state, documentId: "doc-1", source, kind: "image", stage: "extract-markdown", rendition: PAGE_RENDITION });
    expect(result.pages.find((page) => page.pageNumber === 1)?.rendition).toEqual({ bytes: rgb, width: 64, height: 48 });
    expect(result.pages.find((page) => page.pageNumber === 2)?.rendition).toBeUndefined();
  });
});
