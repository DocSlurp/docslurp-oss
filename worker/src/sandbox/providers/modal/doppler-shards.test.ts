import { mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxRunError, type SandboxResult } from "../../types.js";
import { SHARD_PROFILES } from "../../../temporal/page-shard-profiles.js";
import { dopplerShardSettings, executeDopplerShards, mergeVmUsage, planDopplerShards, resetDopplerShardStateForTest, shardVmsInUseForTest, type DopplerShardSettings } from "./doppler-shards.js";
import { declaredGuestProtocol, MAX_PDF_BYTES, SHARDS_UNSUPPORTED_MESSAGE, validEnvelope, validShardRange, type DopplerVmJob } from "./doppler-vm.js";
import { planPageShards } from "../../../temporal/page-shards.js";

const on: DopplerShardSettings = { enabled: true, vmParallel: 8, maxCostOverhead: 3, maxTransferBytes: 512 * 1024 * 1024, maxShards: 32, globalParallel: 64, rangesSupported: true };
const usage = (seconds: number) => ({
  provider: "modal", model: "doppler-document-vm", metric: "sandbox_compute", amount: seconds, unit: "cent", costCents: seconds,
  metadata: { wallSeconds: seconds, costFloorCents: seconds / 2 },
});
/** Page p's Markdown is "p<p>"; slots are separated by form feeds, as the guest writes them. */
const pagesText = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => `p${first + i}`).join("\f");

let dir: string;
let job: DopplerVmJob;
beforeEach(async () => {
  resetDopplerShardStateForTest();
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
    const ranges = vm.calls.map((c) => c.range!).sort((a, b) => a.first - b.first);
    expect(vm.calls[0]!.range!.final).toBe(true); // the final shard runs first
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

  it("launches nothing when the request is already aborted", async () => {
    const vm = fakeVm();
    const controller = new AbortController();
    controller.abort();
    await expect(executeDopplerShards(job, 477, controller.signal, on, { execute: vm.execute })).rejects.toThrow(/aborted/);
    const late = new AbortController();
    await expect(executeDopplerShards(job, 477, late.signal, on, { execute: vm.execute, profile: async () => { late.abort(); return SHARD_PROFILES["extract-markdown:doppler-vm"]; } }))
      .rejects.toThrow(/aborted/);
    expect(vm.calls).toHaveLength(0);
  });

  it("treats a shard that reports success without output as failed and keeps every VM's cost through the fallback", async () => {
    const vm = fakeVm();
    const execute = vi.fn(async (vmJob: DopplerVmJob, signal?: AbortSignal): Promise<SandboxResult> => {
      if (vmJob.range?.final) return { stdout: "", stderr: "", exitCode: 0, usage: usage(2) };
      return vm.execute(vmJob, signal);
    });
    const result = await executeDopplerShards(job, 477, undefined, on, { execute });
    expect(execute.mock.calls.at(-1)![0].range).toBeUndefined(); // whole-document fallback
    expect(result.usage!.costCents).toBe(2 * execute.mock.calls.length);
    expect(await readdir(dir)).toEqual(["in.pdf", "out.md"]);
  });

  it("stops sharding after an image refuses ranges", async () => {
    const vm = fakeVm(async (j) => j.range ? new SandboxRunError(SHARDS_UNSUPPORTED_MESSAGE, usage(8)) : pagesText(1, 477));
    await executeDopplerShards(job, 477, undefined, on, { execute: vm.execute });
    const before = vm.calls.length;
    await executeDopplerShards(job, 477, undefined, on, { execute: vm.execute });
    expect(vm.calls.slice(before).map((c) => c.range)).toEqual([undefined]);
  });

  it("runs an optional split whole when the process VM budget is saturated", async () => {
    const vm = fakeVm(async () => pagesText(1, 477));
    await executeDopplerShards(job, 477, undefined, { ...on, globalParallel: 1 }, { execute: vm.execute });
    expect(vm.calls.map((c) => c.range)).toEqual([undefined]);
  });

  it("always splits a document longer than one VM may convert, in waves when the budget is full", async () => {
    const vm = fakeVm(async (j) => pagesText(j.range!.first, j.range!.last));
    const pages = 25_000;
    await executeDopplerShards(job, pages, undefined, { ...on, enabled: false, globalParallel: 1 }, { execute: vm.execute });
    const ranges = vm.calls.map((c) => c.range!).sort((a, b) => a.first - b.first);
    expect(ranges.every((r) => r && r.last - r.first + 1 <= 10_000 && (r.first - 1) % 32 === 0)).toBe(true);
    expect(ranges.at(-1)).toMatchObject({ last: pages, final: true });
    expect(vm.stats.maxActive).toBe(1);
    expect(await readFile(job.output, "utf8")).toBe(pagesText(1, pages));
  });

  it("refuses a long document on the host, with no VM, when the image cannot take ranges, it is over the document limit or an image refused ranges", async () => {
    const vm = fakeVm();
    await expect(executeDopplerShards(job, 25_000, undefined, { ...on, rangesSupported: false }, { execute: vm.execute })).rejects.toThrow(/ranges-unsupported/);
    await expect(executeDopplerShards(job, 100_001, undefined, on, { execute: vm.execute })).rejects.toThrow(/over-document-limit/);
    const refusing = fakeVm(async (j) => j.range ? new SandboxRunError(SHARDS_UNSUPPORTED_MESSAGE, usage(1)) : pagesText(1, 477));
    await executeDopplerShards(job, 477, undefined, on, { execute: refusing.execute });
    await expect(executeDopplerShards(job, 25_000, undefined, on, { execute: vm.execute })).rejects.toThrow(/image-refused-ranges/);
    expect(vm.calls).toHaveLength(0);
  });

  it("splits 100,000 pages of a normal-sized file, or refuses it on the host with the numbers needed", async () => {
    const vm = fakeVm(async (j) => pagesText(j.range!.first, j.range!.last));
    await truncate(job.input, 30 * 1024 * 1024);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const error = await executeDopplerShards(job, 100_000, undefined, on, { execute: vm.execute }).catch((e) => e);
      expect(error).toBeInstanceOf(SandboxRunError); // 30 MiB x the 22+ shards needed exceeds the 512 MiB transfer cap
      expect(vm.calls).toHaveLength(0);
      expect(String(info.mock.calls.at(-1)![0])).toMatch(/outcome=refused shards=0 pages=100000 reason=split-infeasible wallMs=0 needShards=22 maxShards=17 configuredMaxShards=32 transferShards=17 legalShardPages=4608 fileMiB=30 transferCapMiB=512/);
      await executeDopplerShards(job, 100_000, undefined, { ...on, maxTransferBytes: 1024 * 1024 * 1024 }, { execute: vm.execute });
      expect(vm.calls.length).toBeGreaterThan(10);
      expect(vm.calls.every((c) => c.range!.last - c.range!.first + 1 <= 4_640)).toBe(true); // forced shards stay inside 60 s
    } finally { info.mockRestore(); }
  });

  it("fails at once when a shard's guest counts a different number of pages", async () => {
    const vm = fakeVm(async (j) => j.range && !j.range.final ? new SandboxRunError("Document VM page count disagrees with the host", usage(1)) : pagesText(j.range!.first, j.range!.last));
    const error = await executeDopplerShards(job, 25_000, undefined, on, { execute: vm.execute }).catch((e) => e);
    expect(error.message).toMatch(/disagrees/);
    expect(vm.calls.every((c) => c.expectedDocumentPages === 25_000)).toBe(true);
  });

  it("counts concurrent shard completions correctly and stops before the remaining waves", async () => {
    const big = "x".repeat(25 * 1024 * 1024);
    const vm = fakeVm(async (j) => big + pagesText(j.range!.first, j.range!.last));
    const error = await executeDopplerShards(job, 25_000, undefined, { ...on, vmParallel: 3 }, { execute: vm.execute }).catch((e) => e);
    expect(error.message).toBe("Document VM merged output exceeds limit");
    expect(vm.calls.length).toBeLessThanOrEqual(5); // 6 shards planned; the third 25 MiB completion trips the cap
    expect(error.usage.costCents).toBe(2 * vm.calls.length);
  });

  it("stops paying for shards once the merged output cannot fit", async () => {
    const big = "x".repeat(40 * 1024 * 1024);
    const vm = fakeVm(async (j) => j.range!.final ? pagesText(j.range!.first, j.range!.last) : big + pagesText(j.range!.first, j.range!.last));
    const error = await executeDopplerShards(job, 25_000, undefined, { ...on, vmParallel: 1 }, { execute: vm.execute }).catch((e) => e);
    expect(error.message).toBe("Document VM merged output exceeds limit");
    expect(vm.calls.length).toBeLessThan(5);
  });

  it("does not fall back to one VM when a forced split fails", async () => {
    const vm = fakeVm(async (j) => j.range?.first === 1 ? new SandboxRunError("Document VM parser failed (1)", usage(4)) : pagesText(j.range!.first, j.range!.last));
    const error = await executeDopplerShards(job, 25_000, undefined, on, { execute: vm.execute }).catch((e) => e);
    expect(error).toBeInstanceOf(SandboxRunError);
    expect(vm.calls.every((c) => c.range)).toBe(true);
    expect(error.usage.costCents).toBeGreaterThanOrEqual(4);
  });

  it("never runs more shard VMs than the process ceiling across concurrent forced splits", async () => {
    const vm = fakeVm(async (j) => pagesText(j.range!.first, j.range!.last));
    const jobs = await Promise.all([0, 1, 2, 3, 4].map(async (i) => {
      const output = join(dir, `out-${i}.md`);
      return executeDopplerShards({ ...job, output }, 25_000, undefined, { ...on, globalParallel: 1 }, { execute: vm.execute }).then(() => output);
    }));
    expect(vm.stats.maxActive).toBe(1);
    for (const output of jobs) expect(await readFile(output, "utf8")).toBe(pagesText(1, 25_000));
    expect(shardVmsInUseForTest()).toBe(0);
  });

  it("does not run a doomed fallback VM when the image cannot confine itself or misreports confinement", async () => {
    for (const message of ["Document VM image does not report the declared confinement", "Document VM guest confinement unavailable"]) {
      const vm = fakeVm(async (j) => j.range?.final ? new SandboxRunError(message, usage(1)) : pagesText(j.range?.first ?? 1, j.range?.last ?? 477));
      const error = await executeDopplerShards(job, 477, undefined, on, { execute: vm.execute }).catch((e) => e);
      expect(error.message).toBe(message);
      expect(vm.calls.every((c) => c.range)).toBe(true);
    }
  });

  it("refuses an infeasible forced split without starting any VM", async () => {
    const vm = fakeVm();
    await expect(executeDopplerShards(job, 25_000, undefined, { ...on, maxShards: 1 }, { execute: vm.execute })).rejects.toThrow(/cannot split/);
    expect(vm.calls).toHaveLength(0);
  });

  it("releases a waiting forced split's slot request on abort", async () => {
    const controller = new AbortController();
    const vm = fakeVm(async (j) => { controller.abort(); return pagesText(j.range!.first, j.range!.last); });
    await expect(executeDopplerShards(job, 25_000, controller.signal, { ...on, globalParallel: 1 }, { execute: vm.execute })).rejects.toThrow(/aborted/);
    expect(shardVmsInUseForTest()).toBe(0);
  });

  it("logs one searchable line per sharding decision", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await executeDopplerShards(job, 477, undefined, on, { execute: fakeVm().execute });
      await executeDopplerShards(job, 20, undefined, on, { execute: fakeVm(async () => pagesText(1, 20)).execute });
      const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[document-vm]"));
      expect(lines[0]).toMatch(/^\[document-vm\] outcome=merged shards=\d+ pages=477 reason=planned wallMs=\d+ shardPages=\d+ parallel=\d+ vms=\d+/);
      expect(lines[1]).toMatch(/^\[document-vm\] outcome=whole shards=1 pages=20 reason=plan-unsharded wallMs=0$/);
      for (const line of lines) expect(line.split(" ").slice(1).every((kv) => /^[A-Za-z]+=\S+$/.test(kv))).toBe(true);
    } finally { info.mockRestore(); }
  });

  it("requires the image protocol to be declared before sharding", () => {
    expect(dopplerShardSettings({ DOCSLURP_DOPPLER_SHARDS: "on" }).enabled).toBe(false);
    expect(dopplerShardSettings({ DOCSLURP_DOPPLER_SHARDS: "on", DOCSLURP_DOPPLER_VM_PROTOCOL: "2" }).enabled).toBe(false);
    expect(dopplerShardSettings({ DOCSLURP_DOPPLER_SHARDS: "on", DOCSLURP_DOPPLER_VM_PROTOCOL: "3" }).enabled).toBe(true);
  });

  it("never plans past the shard cap, and keeps shards on the chunk grid", () => {
    const profile = SHARD_PROFILES["extract-markdown:doppler-vm"];
    for (const maxShards of [1, 2, 3]) {
      const plan = planPageShards(10_000, { ...profile, pageAlign: 32 }, { readySlots: 8, maxSlots: 8, scaleUpMs: 0 }, { maxCostOverhead: 1, maxShards });
      expect(plan.shards.length).toBeLessThanOrEqual(maxShards);
      expect(plan.shards.every((s) => (s.first - 1) % 32 === 0)).toBe(true);
    }
    // A 400 MB file under a 512 MB budget cannot afford a second upload plus the fallback.
    expect(planDopplerShards(10_000, 400 * 1024 * 1024, on, profile).shards).toHaveLength(1);
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

  it("requires proof of in-VM hardening when the image is declared protocol 4", () => {
    const hardened = { policy: "doppler-guest-hardening@2", noNewPrivs: true, landlockAbi: 10, seccompDenied: 85 };
    const env4 = (diag: Record<string, unknown>, declared: number) =>
      validEnvelope({ engine: "doppler", outputBytes: 5, conversion: { pages: 3, first: 1, last: 3, documentPages: 3 }, ...diag }, Buffer.from("a\fb\fc"), undefined, declared);
    expect(env4({ protocol: "doppler-vm@4", hardening: hardened }, 4)).toBe(true);
    expect(env4({ protocol: "doppler-vm@3" }, 4)).toBe(false);                                 // older image under a hardened declaration
    expect(env4({ protocol: "doppler-vm@4" }, 4)).toBe(false);                                 // missing report
    expect(env4({ protocol: "doppler-vm@4", hardening: { ...hardened, landlockAbi: 3 } }, 4)).toBe(false);
    expect(env4({ protocol: "doppler-vm@4", hardening: { ...hardened, seccompDenied: 0 } }, 4)).toBe(false);
    expect(env4({ protocol: "doppler-vm@4", hardening: { ...hardened, noNewPrivs: "true" } }, 4)).toBe(false);
    expect(env4({ protocol: "doppler-vm@4", hardening: { ...hardened, policy: "doppler-guest-hardening@1" } }, 4)).toBe(false);
    expect(env4({ protocol: "doppler-vm@4", hardening: { ...hardened, seccompDenied: 79 } }, 4)).toBe(false);
    expect(env4({ protocol: "doppler-vm@4", hardening: { ...hardened, landlockAbi: 4.5 } }, 4)).toBe(false);
    expect(declaredGuestProtocol({ DOCSLURP_DOPPLER_VM_PROTOCOL: "04" })).toBe(0);
    expect(declaredGuestProtocol({ DOCSLURP_DOPPLER_VM_PROTOCOL: "5" })).toBe(0);
    expect(env4({ protocol: "doppler-vm@4", hardening: hardened }, 3)).toBe(true);            // rolling forward
    expect(env4({ protocol: "doppler-vm@4" }, 3)).toBe(false);                                 // a @4 guest always reports
    expect(dopplerShardSettings({ DOCSLURP_DOPPLER_SHARDS: "on", DOCSLURP_DOPPLER_VM_PROTOCOL: "4" }).enabled).toBe(true);
  });

  it("rejects ranges off the guest chunk grid", () => {
    expect(validShardRange({ first: 2, last: 32, final: false })).toBe(false);
    expect(validShardRange({ first: 1, last: 40, final: false })).toBe(false);
    expect(validShardRange({ first: 33, last: 40, final: true })).toBe(true);
    expect(mergeVmUsage([undefined], 1)).toBeUndefined();
  });
});
