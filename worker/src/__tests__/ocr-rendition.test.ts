import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerExtractorPlugin, resetExtractorPluginsForTest, type SandboxedOcrJob } from "../extractors/plugins.js";
import { PAGE_RENDITION } from "../lib/page-rendition.js";
import { readWithOcr } from "../ocr/engine.js";
import { ocrDocument } from "../ocr/read-document.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { fakeOcrRunner, ocrResultFor, pngHeader } from "../test/fake-ocr.js";

/**
 * An uploaded image's only decodable pixels are the OCR boundary's renditions. The host accepts one only when it is the PNG
 * asked for (named for its frame, PNG by header, within the byte and edge caps); anything else is refused, never decoded.
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
function boundary(files: Record<number, { name?: string; bytes: Buffer } | null>) {
  const jobs: SandboxedOcrJob[] = [];
  const frames = [1, 2, 3].map((frame) => ({ frame, text: `Page ${frame}` }));
  const fake = fakeOcrRunner(() => frames, {
    result: (job) => {
      jobs.push(job);
      const result = ocrResultFor(job, frames) as { frames: Array<Record<string, unknown>> };
      for (const record of result.frames) {
        const file = files[record.frame as number];
        record.rendition = file ? file.name ?? `rendition-${String(record.frame).padStart(4, "0")}.png` : null;
      }
      return result;
    },
  });
  const run = fake.runner.run;
  fake.runner.run = vi.fn(async (plan) => {
    const out = await run(plan);
    const job = plan.sandboxedOcr!;
    for (const [frame, file] of Object.entries(files)) {
      if (file) await writeFile(path.join(job.imageDir, `rendition-${String(frame).padStart(4, "0")}.png`), file.bytes);
    }
    return out;
  });
  return { runner: fake.runner, jobs };
}

describe("OCR boundary renditions", () => {
  it("asks a provider that declares renditions for them, and accepts only well-formed ones within the caps", async () => {
    provider(true);
    const big = Buffer.concat([pngHeader(800, 600), Buffer.alloc(PAGE_RENDITION.maxBytes)]);
    const { runner, jobs } = boundary({
      1: { bytes: pngHeader(1024, 768) },                // ok
      2: { bytes: pngHeader(2048, 1024) },               // long edge over the 1024 cap
      3: { bytes: big },                                  // over the byte cap
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

  it("refuses a malformed rendition: not a PNG, or named for another frame", async () => {
    provider(true);
    const { runner } = boundary({ 1: { bytes: Buffer.from("GIF89a not a png at all, padded out past the header length") }, 2: { name: "rendition-0001.png", bytes: pngHeader(10, 10) } });
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
    const png = pngHeader(640, 480);
    const { runner } = boundary({ 1: { bytes: png }, 2: null, 3: null });
    const source = path.join(dir, "scan.png");
    await writeFile(source, "bytes");
    const state = WorkflowState.create({ id: "run-1", pipeline: {}, stats: {}, artifacts: {} } as never, []);
    const result = await ocrDocument({ runner: runner as never, state, documentId: "doc-1", source, kind: "image", stage: "extract-markdown", rendition: PAGE_RENDITION });
    expect(result.pages.find((page) => page.pageNumber === 1)?.rendition).toEqual({ bytes: png, width: 640, height: 480 });
    expect(result.pages.find((page) => page.pageNumber === 2)?.rendition).toBeUndefined();
  });
});
