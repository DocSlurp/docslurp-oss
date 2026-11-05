/*
 * Regressions for council findings on the OCR change: blank frames never escalate, a cancelled job leaves the slot
 * queue without running, a result's character count must match its text, and a self-hosted install with no mode starts.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetExtractorPluginsForTest } from "../../extractors/plugins.js";
import type { CommandPlan } from "../../tools/runner.js";
import { fakeOcrRunner, ocrResultFor } from "../../test/fake-ocr.js";
import { escalationReason, readWithOcr } from "../engine.js";
import { planOcrLanguages } from "../languages.js";
import { OCR_FAILED_PAGES_KEY, assertOcrConfiguration, ocrFailedPages } from "../mode.js";
import { ocrEscalationEnabled } from "../hosted-reader.js";

let scratch: string;
let source: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "docslurp-ocr-council-"));
  source = path.join(scratch, "scan.png");
  await writeFile(source, "stored bytes");
  env = { DOCSLURP_OCR_MODE: "vm", DOCSLURP_OCR_SCRATCH_DIR: scratch, DOCSLURP_OCR_MAX_CONCURRENT: "1" };
  resetExtractorPluginsForTest();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  resetExtractorPluginsForTest();
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe("council fixes", () => {
  it("never escalates a frame where nothing was detected (blank or picture-only)", () => {
    const plan = planOcrLanguages("eng", {});
    expect(escalationReason({ recogniser: null, meanConfidence: null, chars: 0 }, plan)).toBeNull();
    expect(escalationReason({ recogniser: "none", meanConfidence: null, chars: 0 }, plan)).toBeNull();
    // Detected text regions the recogniser could not read still escalate.
    expect(escalationReason({ recogniser: "multi", meanConfidence: 0.2, chars: 0 }, plan)).toBe("empty");
  });

  it("starts a stock self-hosted install (NODE_ENV=production, no mode, no plugin) with OCR off", () => {
    expect(assertOcrConfiguration({ NODE_ENV: "production" })).toBe("off");
    expect(() => assertOcrConfiguration({ NODE_ENV: "production", DOCSLURP_SERVICE_PROFILE: "service" })).toThrow(/OCR provider plugin/);
  });

  it("refuses a result whose character count does not match its text", async () => {
    const { runner } = fakeOcrRunner(() => [], { result: (job) => {
      const result = ocrResultFor(job, [{ frame: 1, text: "short" }]);
      (result.frames as Array<{ chars: number }>)[0]!.chars = 999;
      return result;
    } });
    await expect(readWithOcr(runner, { source, kind: "image", escalation: false, env })).rejects.toThrow(/chars/);
  });

  it("drops a cancelled job from the slot queue without starting it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeOcrRunner(() => [{ frame: 1, text: "words" }]);
    const serve = fake.runner.run.getMockImplementation()!;
    let started = 0;
    fake.runner.run.mockImplementation(async (plan: CommandPlan) => {
      started += 1;
      if (started === 1) await held;
      return await serve(plan);
    });
    const first = readWithOcr(fake.runner, { source, kind: "image", escalation: false, env });
    await vi.waitFor(() => expect(started).toBe(1));
    const abort = new AbortController();
    const second = readWithOcr(fake.runner, { source, kind: "image", escalation: false, env, signal: abort.signal });
    abort.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow(/cancelled/);
    release();
    const outcome = await first;
    await outcome.dispose();
    expect(started).toBe(1);
  });

  it("reads back the pages whose OCR failed, ignoring anything malformed", () => {
    const values = new Map<string, string>([[OCR_FAILED_PAGES_KEY, JSON.stringify([3, 1, "x", -2, 1.5])]]);
    const ledger = { readDocument: (_doc: string, key: string) => values.get(key) ?? null };
    expect([...ocrFailedPages(ledger, "doc")].sort()).toEqual([1, 3]);
    expect(ocrFailedPages({ readDocument: () => "{not json" }, "doc").size).toBe(0);
  });

  it("escalates only on an explicit opt-in, whatever keys are configured", () => {
    expect(ocrEscalationEnabled({ DEEPINFRA_API_KEY: "k" })).toBe(false);
    expect(ocrEscalationEnabled({ DOCSLURP_OCR_ESCALATION: "on" })).toBe(true);
  });
});
