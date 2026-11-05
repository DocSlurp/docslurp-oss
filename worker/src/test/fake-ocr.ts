/*
 * A fake OCR boundary for tests: a runner whose `sandboxedOcrRead`/`localOcrRead` plans are "run" by writing a
 * docslurp-ocr@1 result (and escalation PNGs) for the job, as the VM guest or the local CLI would.
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";

import type { SandboxedOcrJob } from "../extractors/plugins.js";
import type { CommandPlan } from "../tools/runner.js";

export interface FakeFrame {
  frame: number;
  text: string;
  meanConfidence?: number | null;
  recogniser?: string | null;
  /** Write an escalation PNG of this size (defaults to 100x50 when the frame qualifies). */
  image?: boolean;
}

const MANIFEST = JSON.parse(readFileSync(new URL("../../ocr-models.json", import.meta.url), "utf8")) as {
  models: Array<{ id: string; sha256: string; role: string; family: string | null }>;
};
const DETECTOR = MANIFEST.models.find((model) => model.role === "det")!;

/** The models a real CLI names for these frames: the detector, plus a recogniser model per family that read a frame. */
export function ocrModelsFor(frames: Array<{ recogniser: string | null }>): Array<{ id: string; sha256: string }> {
  const families = [...new Set(frames.map((frame) => frame.recogniser).filter((family): family is string => family !== null))];
  const recs = families.map((family) => MANIFEST.models.find((model) => model.role === "rec" && model.family === family))
    .filter((model) => model !== undefined);
  return [DETECTOR, ...recs].map((model) => ({ id: model.id, sha256: model.sha256 }));
}

/** A minimal PNG header (signature + IHDR) with the given size; enough for the host's no-decode check. */
export function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

export function ocrResultFor(job: SandboxedOcrJob, frames: FakeFrame[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const records = frames.map((frame) => ({
    frame: frame.frame,
    width: 100,
    height: 50,
    sourceWidth: 200,
    sourceHeight: 100,
    recogniser: frame.recogniser === undefined ? job.recognisers[0] : frame.recogniser,
    attempts: [],
    text: frame.text,
    lines: [],
    meanConfidence: frame.meanConfidence === undefined ? 0.95 : frame.meanConfidence,
    chars: frame.text.length,
    elapsedMs: 10,
    image: frame.image ? `frame-${String(frame.frame).padStart(4, "0")}.png` : null,
  }));
  return {
    protocol: "docslurp-ocr@1",
    engine: { name: "rapidocr", version: "3.10.0", onnxruntime: "1.31.1" },
    models: ocrModelsFor(records),
    truncatedFrames: false,
    frames: records,
    peakRssKb: 660_000,
    cpuMs: 1_200,
    ...overrides,
  };
}

/**
 * A runner that serves OCR jobs with `frames(job)`. `local` and `spawned` record which path ran; `run` never spawns
 * anything for a VM plan.
 */
export function fakeOcrRunner(frames: (job: SandboxedOcrJob) => FakeFrame[], options: { result?: (job: SandboxedOcrJob) => unknown } = {}) {
  const jobs: SandboxedOcrJob[] = [];
  const runner = {
    sandboxedOcrRead: vi.fn(async (job: SandboxedOcrJob): Promise<CommandPlan> => ({ binary: "fake-vm-ocr", args: [], available: true, sandboxedOcr: job })),
    localOcrRead: vi.fn(async (): Promise<CommandPlan> => { throw new Error("local OCR must not run in this test"); }),
    run: vi.fn(async (plan: CommandPlan) => {
      const job = plan.sandboxedOcr;
      if (!job) throw new Error(`unexpected host command ${plan.binary}`);
      jobs.push(job);
      const served = frames(job);
      const result = options.result ? options.result(job) : ocrResultFor(job, served);
      await writeFile(job.output, typeof result === "string" ? result : JSON.stringify(result));
      for (const frame of served) {
        if (frame.image) await writeFile(path.join(job.imageDir, `frame-${String(frame.frame).padStart(4, "0")}.png`), pngHeader(100, 50));
      }
      return { stdout: "", stderr: "" };
    }),
  };
  return { runner, jobs };
}
