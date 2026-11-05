import { mkdtemp, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXTRACTOR_PLUGIN_API_VERSION, registerExtractorPlugin, resetExtractorPluginsForTest, type SandboxedOcrJob } from "../../extractors/plugins.js";
import type { CommandPlan } from "../../tools/runner.js";
import { fakeOcrRunner, ocrResultFor, pngHeader, type FakeFrame } from "../../test/fake-ocr.js";
import { OCR_DEFAULT_MAX_LONG_EDGE, OCR_RESULT_MAX_BYTES, ocrMaxConcurrent, ocrMaxLongEdge, readWithOcr } from "../engine.js";
import { OcrRefusedError } from "../mode.js";

let scratch: string;
let source: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "docslurp-ocr-engine-"));
  source = path.join(scratch, "scan.png");
  await writeFile(source, "stored bytes, never decoded here");
  env = { DOCSLURP_OCR_MODE: "vm", DOCSLURP_OCR_SCRATCH_DIR: scratch };
  resetExtractorPluginsForTest();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  resetExtractorPluginsForTest();
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

/** Job scratch directories the engine left behind. */
async function leftovers(): Promise<string[]> {
  return (await readdir(scratch)).filter((name) => name.startsWith("docslurp-ocr-"));
}

const frameName = (frame: number) => `frame-${String(frame).padStart(4, "0")}.png`;

/** A runner whose boundary writes `write(job)` instead of the default result. */
function runnerWriting(write: (job: SandboxedOcrJob) => Promise<void>) {
  const fake = fakeOcrRunner(() => []);
  fake.runner.run.mockImplementation(async (plan: CommandPlan) => {
    fake.jobs.push(plan.sandboxedOcr!);
    await write(plan.sandboxedOcr!);
    return { stdout: "", stderr: "" };
  });
  return fake;
}

describe("readWithOcr", () => {
  it("returns the boundary's pages, sorted, with the job's settings", async () => {
    const { runner, jobs } = fakeOcrRunner((job) => job.pages!.slice().reverse().map((frame) => ({ frame, text: `Page ${frame} words` })));
    const outcome = await readWithOcr(runner, { source, kind: "pdf", pages: [2, 5], escalation: false, env });
    try {
      expect(outcome).toMatchObject({ mode: "vm", engine: "local-sandbox", truncatedFrames: false, cpuMs: 1_200, peakRssKb: 660_000 });
      expect(outcome.pages.map((page) => [page.pageNumber, page.text, page.recogniser, page.escalation])).toEqual([
        [2, "Page 2 words", "multi", null],
        [5, "Page 5 words", "multi", null],
      ]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        input: source, kind: "pdf", pages: [2, 5], recognisers: ["multi", "eslav", "korean"], maxAttempts: 3,
        maxLongEdge: OCR_DEFAULT_MAX_LONG_EDGE, maxFrames: 2, escalation: null,
      });
      expect(path.isAbsolute(jobs[0]!.output) && path.isAbsolute(jobs[0]!.imageDir)).toBe(true);
      expect(runner.localOcrRead).not.toHaveBeenCalled();
      expect(await leftovers()).toHaveLength(1);
    } finally {
      await outcome.dispose();
    }
    expect(await leftovers()).toEqual([]);
  });

  it("reads every frame up to the frame cap when no pages are named", async () => {
    const { runner, jobs } = fakeOcrRunner(() => [{ frame: 1, text: "a" }, { frame: 2, text: "b" }, { frame: 3, text: "c" }]);
    const outcome = await readWithOcr(runner, { source, kind: "image", escalation: false, env });
    await outcome.dispose();
    expect(jobs[0]!.pages).toBeUndefined();
    expect(jobs[0]!.maxFrames).toBe(64);
    expect(outcome.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
  });

  it("honours DOCSLURP_OCR_MAX_LONG_EDGE within 640..4000", async () => {
    expect(ocrMaxLongEdge({})).toBe(2000);
    expect(ocrMaxLongEdge({ DOCSLURP_OCR_MAX_LONG_EDGE: "640" })).toBe(640);
    expect(ocrMaxLongEdge({ DOCSLURP_OCR_MAX_LONG_EDGE: "4000" })).toBe(4000);
    for (const bad of ["639", "4001", "1500.5", "big", "-2000"]) expect(ocrMaxLongEdge({ DOCSLURP_OCR_MAX_LONG_EDGE: bad }), bad).toBe(2000);
    const { runner, jobs } = fakeOcrRunner(() => [{ frame: 1, text: "a" }]);
    await (await readWithOcr(runner, { source, kind: "image", escalation: false, env: { ...env, DOCSLURP_OCR_MAX_LONG_EDGE: "1024" } })).dispose();
    expect(jobs[0]!.maxLongEdge).toBe(1024);
  });

  it("bounds DOCSLURP_OCR_MAX_CONCURRENT to 1..32, default 1", () => {
    expect(ocrMaxConcurrent({})).toBe(1);
    expect(ocrMaxConcurrent({ DOCSLURP_OCR_MAX_CONCURRENT: "4" })).toBe(4);
    expect(ocrMaxConcurrent({ DOCSLURP_OCR_MAX_CONCURRENT: "500" })).toBe(32);
    expect(ocrMaxConcurrent({ DOCSLURP_OCR_MAX_CONCURRENT: "0" })).toBe(1);
  });

  for (const [limit, expected] of [["1", 1], ["2", 2]] as const) {
    it(`never runs more than DOCSLURP_OCR_MAX_CONCURRENT=${limit} jobs at once`, async () => {
      let active = 0;
      let peak = 0;
      const fake = fakeOcrRunner(() => [{ frame: 1, text: "words" }]);
      const write = fake.runner.run.getMockImplementation()!;
      fake.runner.run.mockImplementation(async (plan: CommandPlan) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        try {
          return await write(plan);
        } finally {
          active -= 1;
        }
      });
      const limited = { ...env, DOCSLURP_OCR_MAX_CONCURRENT: limit };
      const outcomes = await Promise.all([1, 2, 3].map(() => readWithOcr(fake.runner, { source, kind: "image", escalation: false, env: limited })));
      await Promise.all(outcomes.map((outcome) => outcome.dispose()));
      expect(peak).toBe(expected);
      expect(fake.runner.run).toHaveBeenCalledTimes(3);
    });
  }

  it("refuses a source over the provider's maxSourceBytes before any run", async () => {
    const run = vi.fn();
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-ocr-plugin", sandboxedOcr: { id: "test-vm-ocr", maxSourceBytes: 8, assertConfigured: () => undefined, run, timeoutMs: () => 1_000 } });
    const { runner } = fakeOcrRunner(() => [{ frame: 1, text: "x" }]);
    const read = readWithOcr(runner, { source, kind: "image", escalation: false, env });
    await expect(read).rejects.toBeInstanceOf(OcrRefusedError);
    await expect(read).rejects.toMatchObject({ reason: "too-large" });
    expect(runner.sandboxedOcrRead).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(await leftovers()).toEqual([]);
  });

  it("names the provider as the engine when one is registered", async () => {
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-ocr-plugin", sandboxedOcr: { id: "test-vm-ocr", maxSourceBytes: 1 << 20, assertConfigured: () => undefined, run: vi.fn(), timeoutMs: () => 1_000 } });
    const { runner } = fakeOcrRunner(() => [{ frame: 1, text: "x" }]);
    const outcome = await readWithOcr(runner, { source, kind: "image", escalation: false, env });
    await outcome.dispose();
    expect(outcome.engine).toBe("test-vm-ocr");
  });

  it("refuses an unavailable plan without running it", async () => {
    const { runner } = fakeOcrRunner(() => []);
    runner.sandboxedOcrRead.mockImplementation(async (job: SandboxedOcrJob) => ({ binary: "x", args: [], available: false, sandboxedOcr: job }));
    await expect(readWithOcr(runner, { source, kind: "image", escalation: false, env })).rejects.toMatchObject({ reason: "unavailable" });
    expect(runner.run).not.toHaveBeenCalled();
    expect(await leftovers()).toEqual([]);
  });
});

describe("malformed results are refused", () => {
  // A deep copy: cases edit it, and the helper shares its model list between results.
  const valid = (job: SandboxedOcrJob, frames: FakeFrame[] = [{ frame: 1, text: "ok" }]) => structuredClone(ocrResultFor(job, frames));
  const cases: Array<[string, (job: SandboxedOcrJob) => Promise<void>, RegExp, number[]?]> = [
    ["bad JSON", async (job) => writeFile(job.output, "{\"protocol\": "), /not valid JSON/],
    ["a wrong protocol", async (job) => writeFile(job.output, JSON.stringify({ ...valid(job), protocol: "docslurp-ocr@2" })), /failed validation: protocol/],
    ["a schema violation in a frame", async (job) => {
      const result = valid(job) as { frames: Array<Record<string, unknown>> };
      result.frames[0]!.meanConfidence = 1.5;
      await writeFile(job.output, JSON.stringify(result));
    }, /failed validation: frames.0.meanConfidence/],
    ["an image name outside the pattern", async (job) => {
      const result = valid(job) as { frames: Array<Record<string, unknown>> };
      result.frames[0]!.image = "../../etc/passwd";
      await writeFile(job.output, JSON.stringify(result));
    }, /failed validation: frames.0.image/],
    ["an extra top-level key", async (job) => writeFile(job.output, JSON.stringify({ ...valid(job), extra: true })), /failed validation/],
    ["an extra frame key", async (job) => {
      const result = valid(job) as { frames: Array<Record<string, unknown>> };
      result.frames[0]!.html = "<script>";
      await writeFile(job.output, JSON.stringify(result));
    }, /failed validation/],
    ["a repeated frame", async (job) => writeFile(job.output, JSON.stringify(valid(job, [{ frame: 1, text: "a" }, { frame: 1, text: "b" }]))), /repeats frame 1/, [1]],
    ["an unrequested page", async (job) => writeFile(job.output, JSON.stringify(valid(job, [{ frame: 3, text: "a" }]))), /unrequested frame 3/, [1, 2]],
    ["a frame past the frame cap", async (job) => writeFile(job.output, JSON.stringify(valid(job, [{ frame: 65, text: "a" }]))), /unrequested frame 65/],
    ["an unrequested recogniser", async (job) => writeFile(job.output, JSON.stringify(valid(job, [{ frame: 1, text: "a", recogniser: "thai" }]))), /unrequested recogniser thai/],
    ["a frame larger than the long-edge cap", async (job) => {
      const result = valid(job) as { frames: Array<Record<string, unknown>> };
      result.frames[0]!.width = 2001;
      await writeFile(job.output, JSON.stringify(result));
    }, /exceeds the long-edge cap/],
    ["an unpinned model id", async (job) => {
      const result = valid(job) as { models: Array<{ id: string; sha256: string }> };
      result.models[1] = { id: "evil-rec", sha256: "a".repeat(64) };
      await writeFile(job.output, JSON.stringify(result));
    }, /unpinned model evil-rec/],
    ["a pinned id with the wrong sha256", async (job) => {
      const result = valid(job) as { models: Array<{ id: string; sha256: string }> };
      result.models[0] = { id: result.models[0]!.id, sha256: "b".repeat(64) };
      await writeFile(job.output, JSON.stringify(result));
    }, /unpinned model pp-ocrv6-det-small/],
    ["a result over 64 MiB", async (job) => {
      await writeFile(job.output, JSON.stringify(valid(job)));
      await truncate(job.output, OCR_RESULT_MAX_BYTES + 1);
    }, /exceeds 67108864 bytes/],
    ["no result", async () => undefined, /no result file/],
    ["a result that is a symlink", async (job) => {
      const real = path.join(path.dirname(job.output), "elsewhere.json");
      await writeFile(real, JSON.stringify(valid(job)));
      await symlink(real, job.output);
    }, /no result file/],
    ["a result that is a directory", async (job) => { await (await import("node:fs/promises")).mkdir(job.output); }, /no result file/],
  ];

  it.each(cases)("refuses %s and removes the job's scratch", async (_name, write, message, pages) => {
    const { runner } = runnerWriting(write);
    await expect(readWithOcr(runner, { source, kind: pages ? "pdf" : "image", ...(pages ? { pages } : {}), escalation: false, env })).rejects.toThrow(message);
    expect(await leftovers()).toEqual([]);
  });
});

describe("escalation images", () => {
  async function readEscalating(frames: FakeFrame[], afterRun?: (job: SandboxedOcrJob) => Promise<void>, settings: { languageSetting?: string; escalation?: boolean } = {}) {
    const fake = fakeOcrRunner(() => frames);
    if (afterRun) {
      const write = fake.runner.run.getMockImplementation()!;
      fake.runner.run.mockImplementation(async (plan: CommandPlan) => {
        const result = await write(plan);
        await afterRun(plan.sandboxedOcr!);
        return result;
      });
    }
    const outcome = await readWithOcr(fake.runner, { source, kind: "image", escalation: settings.escalation ?? true, ...(settings.languageSetting ? { languageSetting: settings.languageSetting } : {}), env });
    return { outcome, jobs: fake.jobs };
  }

  it("keeps the boundary's PNG for a low-confidence frame when its IHDR matches the frame", async () => {
    const { outcome, jobs } = await readEscalating([{ frame: 1, text: "blurry", meanConfidence: 0.5, image: true }, { frame: 2, text: "crisp", meanConfidence: 0.99, image: true }]);
    try {
      expect(jobs[0]!.escalation).toEqual({ belowConfidence: 0.8, recognisers: ["arabic", "devanagari"] });
      expect(outcome.pages[0]!.escalation).toMatchObject({ reason: "low-confidence", width: 100, height: 50 });
      expect(outcome.pages[0]!.escalation!.imagePath).toBe(path.join(jobs[0]!.imageDir, frameName(1)));
      expect(existsSync(outcome.pages[0]!.escalation!.imagePath)).toBe(true);
      expect(outcome.pages[1]!.escalation).toBeNull();
    } finally { await outcome.dispose(); }
    expect(await leftovers()).toEqual([]);
  });

  it("escalates an empty read of a non-blank frame only when the boundary wrote its PNG", async () => {
    const { outcome } = await readEscalating([{ frame: 1, text: "", image: true }, { frame: 2, text: "", image: false }]);
    await outcome.dispose();
    expect(outcome.pages[0]!.escalation?.reason).toBe("empty");
    expect(outcome.pages[1]!.escalation).toBeNull();
  });

  it("keeps no escalation when the caller did not ask for it", async () => {
    const { outcome, jobs } = await readEscalating([{ frame: 1, text: "blurry", meanConfidence: 0.5, image: true }], undefined, { escalation: false });
    await outcome.dispose();
    expect(jobs[0]!.escalation).toBeNull();
    expect(outcome.pages[0]!.escalation).toBeNull();
  });

  const tampered: Array<[string, (file: string) => Promise<void>]> = [
    ["an IHDR size that is not the frame's", async (file) => writeFile(file, pngHeader(99, 50))],
    ["a file that is not a PNG", async (file) => writeFile(file, Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40)]))],
    ["a truncated PNG", async (file) => writeFile(file, pngHeader(100, 50).subarray(0, 20))],
    ["a symlink to a matching PNG", async (file) => {
      const real = `${file}.real`;
      await writeFile(real, pngHeader(100, 50));
      await rm(file);
      await symlink(real, file);
    }],
    ["an oversized PNG", async (file) => {
      await writeFile(file, pngHeader(100, 50));
      await truncate(file, 16 * 1024 * 1024 + 1);
    }],
    ["a missing PNG", async (file) => rm(file)],
  ];

  it.each(tampered)("drops the escalation for %s and keeps the recogniser's read", async (_name, tamper) => {
    const { outcome } = await readEscalating([{ frame: 1, text: "blurry", meanConfidence: 0.5, image: true }], async (job) => tamper(path.join(job.imageDir, frameName(1))));
    await outcome.dispose();
    expect(outcome.pages[0]!.escalation).toBeNull();
    expect(outcome.pages[0]!.text).toBe("blurry");
  });
});

describe("multilingual routing reaches the boundary", () => {
  it.each([
    ["kor", ["korean"]],
    ["auto", ["multi", "eslav", "korean"]],
    ["eng+kor", ["korean", "multi"]],
    ["ara", ["arabic"]],
  ])("passes %s as recognisers %j", async (languageSetting, recognisers) => {
    const { runner, jobs } = fakeOcrRunner((job) => [{ frame: 1, text: "words", recogniser: job.recognisers[0]! }]);
    const outcome = await readWithOcr(runner, { source, kind: "image", languageSetting, escalation: false, env });
    await outcome.dispose();
    expect(jobs[0]!.recognisers).toEqual(recognisers);
    expect(jobs[0]!.maxAttempts).toBe(recognisers.length);
    expect(outcome.language.recognisers).toEqual(recognisers);
  });

  it("marks Arabic frames for a script escalation even at high confidence", async () => {
    const { runner } = fakeOcrRunner(() => [{ frame: 1, text: "نص عربي", meanConfidence: 0.97, recogniser: "arabic", image: true }]);
    const outcome = await readWithOcr(runner, { source, kind: "image", languageSetting: "ara", escalation: true, env });
    await outcome.dispose();
    expect(outcome.pages[0]!.escalation?.reason).toBe("script");
  });

  it("marks every frame of an unsupported script for escalation", async () => {
    const { runner } = fakeOcrRunner(() => [{ frame: 1, text: "words", meanConfidence: 0.99, image: true }]);
    const outcome = await readWithOcr(runner, { source, kind: "image", languageSetting: "heb", escalation: true, env });
    await outcome.dispose();
    expect(outcome.pages[0]!.escalation?.reason).toBe("unsupported-script");
  });
});

describe("blank pages and truncation", () => {
  const DET = { id: "pp-ocrv6-det-small", sha256: "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f" };
  const REC_MULTI = { id: "pp-ocrv6-rec-small", sha256: "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884" };
  const blank = (frame: number): FakeFrame => ({ frame, text: "", recogniser: null, meanConfidence: null });

  it("accepts a detector-only result for a blank page as a read with no text", async () => {
    const { runner } = runnerWriting(async (job) => writeFile(job.output, JSON.stringify(ocrResultFor(job, [blank(1)]))));
    const outcome = await readWithOcr(runner, { source, kind: "image", escalation: true, env });
    await outcome.dispose();
    expect(outcome.pages).toEqual([expect.objectContaining({ pageNumber: 1, text: "", recogniser: "none", chars: 0, escalation: null })]);
    expect(outcome.unreadPages).toEqual([]);
  });

  it("accepts a blank PDF page among read ones, still naming the recogniser that read the others", async () => {
    const { runner } = runnerWriting(async (job) => writeFile(job.output, JSON.stringify(ocrResultFor(job, [{ frame: 1, text: "Words" }, blank(2)]))));
    const outcome = await readWithOcr(runner, { source, kind: "pdf", pages: [1, 2], escalation: false, env });
    await outcome.dispose();
    expect(outcome.pages.map((page) => [page.pageNumber, page.text])).toEqual([[1, "Words"], [2, ""]]);
  });

  const refusals: Array<[string, (job: SandboxedOcrJob) => Record<string, unknown>, RegExp]> = [
    ["a blank result naming no model", (job) => ({ ...ocrResultFor(job, [blank(1)]), models: [] }), /failed validation: models/],
    ["a blank result naming only a recogniser", (job) => ({ ...ocrResultFor(job, [blank(1)]), models: [REC_MULTI] }), /exactly one detector/],
    ["a result naming the detector twice", (job) => ({ ...ocrResultFor(job, [{ frame: 1, text: "a" }]), models: [DET, DET, REC_MULTI] }), /names model pp-ocrv6-det-small twice|exactly one detector/],
    ["text read with no recogniser model named", (job) => ({ ...ocrResultFor(job, [{ frame: 1, text: "a" }]), models: [DET] }), /no model for recogniser multi/],
    ["a blank frame that carries text", (job) => {
      const result = ocrResultFor(job, [blank(1)]) as { frames: Array<Record<string, unknown>> };
      result.frames[0]!.text = "smuggled";
      result.frames[0]!.chars = 8;
      return result;
    }, /has text but no recogniser/],
    ["an unpinned sha256 on a detector-only result", (job) => ({ ...ocrResultFor(job, [blank(1)]), models: [{ id: DET.id, sha256: "c".repeat(64) }] }), /unpinned model/],
  ];
  it.each(refusals)("refuses %s", async (_name, result, message) => {
    const { runner } = runnerWriting(async (job) => writeFile(job.output, JSON.stringify(result(job))));
    await expect(readWithOcr(runner, { source, kind: "image", escalation: false, env })).rejects.toThrow(message);
    expect(await leftovers()).toEqual([]);
  });

  it("refuses a result that claims truncation for pages within the frame cap (missing pages would hide)", async () => {
    const { runner } = runnerWriting(async (job) => writeFile(job.output, JSON.stringify(ocrResultFor(job, [{ frame: 1, text: "a" }], { truncatedFrames: true }))));
    await expect(readWithOcr(runner, { source, kind: "pdf", pages: [1, 2, 3], escalation: false, env })).rejects.toThrow(/claims truncation for a job within its frame cap/);
  });

  it("refuses a frame-cap truncation claim that did not fill the cap", async () => {
    const { runner } = runnerWriting(async (job) => writeFile(job.output, JSON.stringify(ocrResultFor(job, [{ frame: 1, text: "a" }], { truncatedFrames: true }))));
    await expect(readWithOcr(runner, { source, kind: "image", escalation: false, env })).rejects.toThrow(/before reaching its frame cap/);
  });

  it("reports the requested pages past the frame cap as unread, never as silently missing", async () => {
    const pages = Array.from({ length: 70 }, (_, index) => index + 1);
    const { runner } = runnerWriting(async (job) => writeFile(job.output, JSON.stringify(ocrResultFor(job, job.pages!.slice(0, job.maxFrames).map((frame) => ({ frame, text: `p${frame}` })), { truncatedFrames: true }))));
    const outcome = await readWithOcr(runner, { source, kind: "pdf", pages, escalation: false, env });
    await outcome.dispose();
    expect(outcome.pages).toHaveLength(64);
    expect(outcome.truncatedFrames).toBe(true);
    expect(outcome.unreadPages).toEqual([65, 66, 67, 68, 69, 70]);
  });

  it("reports frame truncation of a multi-frame image without pages", async () => {
    const { runner } = runnerWriting(async (job) => writeFile(job.output, JSON.stringify(ocrResultFor(job, Array.from({ length: 64 }, (_, index) => ({ frame: index + 1, text: "t" })), { truncatedFrames: true }))));
    const outcome = await readWithOcr(runner, { source, kind: "image", escalation: false, env });
    await outcome.dispose();
    expect(outcome).toMatchObject({ truncatedFrames: true, unreadPages: [] });
    expect(outcome.pages).toHaveLength(64);
  });

  it("accepts PDF pages above the image frame-walk bound", async () => {
    const { runner, jobs } = fakeOcrRunner((job) => job.pages!.map((frame) => ({ frame, text: `page ${frame}` })));
    const outcome = await readWithOcr(runner, { source, kind: "pdf", pages: [2049, 5000], escalation: false, env });
    await outcome.dispose();
    expect(jobs[0]!.pages).toEqual([2049, 5000]);
    expect(outcome.pages.map((page) => page.pageNumber)).toEqual([2049, 5000]);
  });
});
