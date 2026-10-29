import { mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxRunError, type SandboxResult } from "../../types.js";
import { SHARD_PROFILES } from "../../../temporal/page-shard-profiles.js";
import { executeDopplerShards, mergeVmUsage, planDopplerShards, type DopplerShardSettings } from "./doppler-shards.js";
import { MAX_PDF_BYTES, validEnvelope, validShardRange, type DopplerVmJob } from "./doppler-vm.js";

const on: DopplerShardSettings = { enabled: true, vmParallel: 8, maxCostOverhead: 3, maxTransferBytes: 512 * 1024 * 1024, maxShards: 32 };
const usage = (seconds: number) => ({
  provider: "modal", model: "doppler-document-vm", metric: "sandbox_compute", amount: seconds, unit: "cent", costCents: seconds,
  metadata: { wallSeconds: seconds, costFloorCents: seconds / 2 },
});
/** Page p's Markdown is "p<p>"; slots are separated by form feeds, as the guest writes them. */
const pagesText = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => `p${first + i}`).join("\f");

let dir: string;
let job: DopplerVmJob;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "doppler-shards-"));
  job = { operation: "doppler-markdown", input: join(dir, "in.pdf"), output: join(dir, "out.md") };
  await writeFile(job.input, Buffer.alloc(1024));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fakeVm(behaviour: (job: DopplerVmJob, signal?: AbortSignal) => Promise<string | Error> = async (j) => pagesText(j.range?.first ?? 1, j.range?.last ?? 477)) {
  let active = 0;
  const calls: DopplerVmJob[] = [];
  const stats = { maxActive: 0 };
  const execute = vi.fn(async (vmJob: DopplerVmJob, signal?: AbortSignal): Promise<SandboxResult> => {
    calls.push(vmJob);
    active++; stats.maxActive = Math.max(stats.maxActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const outcome = await behaviour(vmJob, signal);
      if (outcome instanceof Error) throw outcome;
      await writeFile(vmJob.output, outcome);
      return { stdout: "", stderr: "", exitCode: 0, usage: usage(2) };
    } finally { active--; }
  });
  return { execute, calls, stats };
}

describe("executeDopplerShards", () => {
  it("passes whole documents through when sharding is off or the plan has one shard", async () => {
    const vm = fakeVm(async () => pagesText(1, 20));
    await executeDopplerShards(job, 477, undefined, { ...on, enabled: false }, { execute: vm.execute });
    await executeDopplerShards(job, 20, undefined, on, { execute: vm.execute });
    expect(vm.calls.map((c) => c.range)).toEqual([undefined, undefined]);
  });

  it("runs aligned ranges in parallel and merges them byte-identically in page order", async () => {
    const vm = fakeVm();
    const timings: number[] = [];
    const result = await executeDopplerShards(job, 477, undefined, on, { execute: vm.execute, recordTiming: (t) => timings.push(t.pages) });
    expect(await readFile(job.output, "utf8")).toBe(pagesText(1, 477));
    const ranges = vm.calls.map((c) => c.range!);
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges.every((r) => (r.first - 1) % 32 === 0)).toBe(true);
    expect(ranges.filter((r) => r.final)).toEqual([{ first: ranges.at(-1)!.first, last: 477, final: true }]);
    expect(vm.stats.maxActive).toBeLessThanOrEqual(on.vmParallel);
    expect(timings.reduce((a, b) => a + b, 0)).toBe(477);
    expect(result.usage?.costCents).toBe(2 * ranges.length);
    expect(result.usage?.metadata?.vms).toBe(ranges.length);
    expect(await readdir(dir)).toEqual(["in.pdf", "out.md"]);
  });

  it("falls back to one whole-document VM when a shard fails, and bills both", async () => {
    const vm = fakeVm(async (j) => j.range && j.range.first > 1 && !j.range.final ? new SandboxRunError("Document VM parser failed (1)", usage(5)) : pagesText(j.range?.first ?? 1, j.range?.last ?? 477));
    const result = await executeDopplerShards(job, 477, undefined, on, { execute: vm.execute });
    expect(vm.calls.at(-1)!.range).toBeUndefined();
    expect(await readFile(job.output, "utf8")).toBe(pagesText(1, 477));
    expect(result.usage!.costCents).toBeGreaterThanOrEqual(5 + 2);
    expect(await readdir(dir)).toEqual(["in.pdf", "out.md"]);
  });

  it("publishes nothing when the fallback fails too, keeping every VM's cost", async () => {
    const vm = fakeVm(async () => new SandboxRunError("Document VM parser failed (1)", usage(3)));
    const error = await executeDopplerShards(job, 477, undefined, on, { execute: vm.execute }).catch((e) => e);
    expect(error).toBeInstanceOf(SandboxRunError);
    expect(error.usage.costCents).toBeGreaterThanOrEqual(6);
    expect(await readdir(dir)).toEqual(["in.pdf"]);
  });

  it("stops scheduling and publishes nothing when aborted", async () => {
    const controller = new AbortController();
    const vm = fakeVm(async (j, signal) => {
      controller.abort();
      return signal?.aborted ? new SandboxRunError("Document VM aborted", usage(1)) : pagesText(j.range!.first, j.range!.last);
    });
    await expect(executeDopplerShards(job, 477, controller.signal, on, { execute: vm.execute })).rejects.toThrow(/aborted/);
    expect(vm.calls.length).toBeLessThanOrEqual(on.vmParallel);
    expect(await readdir(dir)).toEqual(["in.pdf"]);
  });

  it("refuses a shard whose page slots do not match its range", async () => {
    const vm = fakeVm(async (j) => j.range ? pagesText(j.range.first, j.range.last - (j.range.first === 1 ? 1 : 0)) : new Error("no fallback"));
    await expect(executeDopplerShards(job, 477, undefined, on, { execute: vm.execute })).rejects.toThrow(/page slots/);
    expect(await readdir(dir)).toEqual(["in.pdf"]);
  });

  it("refuses symlinked and oversized inputs before any VM starts", async () => {
    const vm = fakeVm();
    const link = join(dir, "link.pdf");
    await symlink(job.input, link);
    await expect(executeDopplerShards({ ...job, input: link }, 477, undefined, on, { execute: vm.execute })).rejects.toThrow(/invalid or oversized/);
    await truncate(job.input, MAX_PDF_BYTES + 1);
    await expect(executeDopplerShards(job, 477, undefined, on, { execute: vm.execute })).rejects.toThrow(/invalid or oversized/);
    expect(vm.calls).toHaveLength(0);
  });

  it("caps shards by the bytes every VM must receive", () => {
    const profile = SHARD_PROFILES["extract-markdown:doppler-vm"];
    const small = planDopplerShards(998, 1024 * 1024, on, profile);
    const large = planDopplerShards(998, 200 * 1024 * 1024, on, profile);
    expect(small.shards.length).toBeGreaterThan(2);
    expect(large.shards.length).toBeLessThanOrEqual(2);
  });
});

describe("doppler-vm@3 envelope", () => {
  const env = (conversion: Record<string, unknown>, output: string, protocol = "doppler-vm@3") =>
    validEnvelope({ protocol, engine: "doppler", outputBytes: Buffer.byteLength(output), conversion }, Buffer.from(output), undefined);
  const shard = (conversion: Record<string, unknown>, output: string, range: DopplerVmJob["range"], protocol = "doppler-vm@3") =>
    validEnvelope({ protocol, engine: "doppler", outputBytes: Buffer.byteLength(output), conversion }, Buffer.from(output), range);

  it("accepts the old guest for whole documents only", () => {
    expect(env({ pages: 3 }, "a\fb\fc", "doppler-vm@2")).toBe(true);
    expect(shard({ pages: 32 }, pagesText(1, 32), { first: 1, last: 32, final: false }, "doppler-vm@2")).toBe(false);
  });

  it("requires the guest to echo the requested range and page slots", () => {
    const range = { first: 33, last: 64, final: false };
    const good = { pages: 32, first: 33, last: 64, documentPages: 67 };
    expect(shard(good, pagesText(33, 64), range)).toBe(true);
    expect(shard({ ...good, first: 1 }, pagesText(33, 64), range)).toBe(false);
    expect(shard(good, pagesText(33, 63), range)).toBe(false);
    expect(shard({ ...good, documentPages: 64 }, pagesText(33, 64), range)).toBe(false);
    expect(shard({ pages: 3, first: 65, last: 67, documentPages: 67 }, pagesText(65, 67), { first: 65, last: 67, final: true })).toBe(true);
    expect(shard({ pages: 3, first: 65, last: 67, documentPages: 70 }, pagesText(65, 67), { first: 65, last: 67, final: true })).toBe(false);
    expect(env({ pages: 3, first: 1, last: 3, documentPages: 3 }, "a\fb\fc")).toBe(true);
  });

  it("rejects ranges off the guest chunk grid", () => {
    expect(validShardRange({ first: 2, last: 32, final: false })).toBe(false);
    expect(validShardRange({ first: 1, last: 40, final: false })).toBe(false);
    expect(validShardRange({ first: 33, last: 40, final: true })).toBe(true);
    expect(mergeVmUsage([undefined], 1)).toBeUndefined();
  });
});
