import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { planPageShards, type PageShardPlan, type ShardCostProfile } from "../../../temporal/page-shards.js";
import { SHARD_PROFILES, shardCapacity } from "../../../temporal/page-shard-profiles.js";
import { SandboxRunError, type SandboxResult } from "../../types.js";
import type { UsageEvent } from "../../../models.js";
import { currentPerfContext } from "../../../lib/perf-context.js";
import { executeDopplerVm, GUEST_CHUNK_PAGES, MAX_OUTPUT_BYTES, MAX_PDF_BYTES, SHARDS_UNSUPPORTED_MESSAGE, type DopplerVmJob } from "./doppler-vm.js";

/** Most pages one guest VM converts; a longer document must be split into shards no larger than this. */
export const GUEST_MAX_VM_PAGES = 10_000;
/** Most pages in a document the guest accepts at all (only as shards of at most GUEST_MAX_VM_PAGES). */
export const GUEST_MAX_DOCUMENT_PAGES = 100_000;

/** One searchable line per sharding decision: `[document-vm] shards=...`. */
function logPlan(fields: Record<string, string | number | boolean | undefined>): void {
  const documentId = currentPerfContext()?.documentId;
  const parts = Object.entries({ document: documentId, ...fields }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`);
  console.info(`[document-vm] ${parts.join(" ")}`);
}

/**
 * Parallel Doppler shards: one fresh offline VM per page range, merged in page order.
 *
 * The host never parses the PDF. It plans from the page count the pipeline already holds
 * and the file size; each guest re-counts pages and refuses a range that does not fit, and
 * a final shard must end on the document's last page. Shard boundaries sit on the guest's
 * 32-page chunk grid, so the merged Markdown is byte-identical to one whole-document VM.
 */

export interface DopplerShardSettings {
  enabled: boolean;
  /** Most VMs one document may hold at once (provider concurrency and fairness). */
  vmParallel: number;
  /** Most extra fixed VM cost over one whole-document VM, as a fraction. */
  maxCostOverhead: number;
  /** Every shard VM receives the full PDF: cap shards x file bytes. */
  maxTransferBytes: number;
  maxShards: number;
  /** Most shard VMs this worker process holds across all documents. */
  globalParallel: number;
  /** The image's guest accepts page ranges (protocol 3): required to split documents over GUEST_MAX_VM_PAGES. */
  rangesSupported: boolean;
}

export function dopplerShardSettings(env: NodeJS.ProcessEnv = process.env): DopplerShardSettings {
  const int = (name: string, fallback: number, min: number, max: number) => {
    const value = Number.parseInt(env[name] ?? "", 10);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const overhead = Number.parseFloat(env.DOCSLURP_DOPPLER_SHARD_COST_OVERHEAD ?? "");
  return {
    // Sharding needs a range-aware guest; the image's protocol is declared with its digest, never assumed.
    enabled: /^(1|true|on)$/i.test(env.DOCSLURP_DOPPLER_SHARDS?.trim() ?? "") && env.DOCSLURP_DOPPLER_VM_PROTOCOL?.trim() === "3",
    rangesSupported: env.DOCSLURP_DOPPLER_VM_PROTOCOL?.trim() === "3",
    globalParallel: int("DOCSLURP_DOPPLER_VM_GLOBAL_PARALLEL", 16, 1, 256),
    vmParallel: int("DOCSLURP_DOPPLER_VM_MAX_PARALLEL", 8, 1, 64),
    maxCostOverhead: Number.isFinite(overhead) && overhead >= 0 ? Math.min(overhead, 10) : 0.5,
    maxTransferBytes: int("DOCSLURP_DOPPLER_SHARD_TRANSFER_MB", 512, 1, 8192) * 1024 * 1024,
    maxShards: int("DOCSLURP_DOPPLER_MAX_SHARDS", 32, 1, 128),
  };
}

export interface ShardTiming {
  stage: "extract-markdown";
  executor: "doppler-vm";
  pages: number;
  ms: number;
  shardIndex: number;
  shardCount: number;
}

export interface DopplerShardDeps {
  execute?: (job: DopplerVmJob, signal?: AbortSignal) => Promise<SandboxResult>;
  profile?: () => Promise<ShardCostProfile>;
  recordTiming?: (timing: ShardTiming) => void;
}

/** Plan shards for one document; a single shard means "run the whole document in one VM". */
export function planDopplerShards(pageCount: number, fileBytes: number, settings: DopplerShardSettings, profile: ShardCostProfile): PageShardPlan {
  // Every shard VM receives the full file, and so does the whole-document fallback (which a forced split never runs).
  const fallbackUploads = pageCount > GUEST_MAX_VM_PAGES ? 0 : 1;
  const byTransfer = Math.max(1, Math.floor(settings.maxTransferBytes / Math.max(1, fileBytes)) - fallbackUploads);
  return planPageShards(pageCount, { ...profile, pageAlign: GUEST_CHUNK_PAGES },
    shardCapacity("doppler-vm", { idleSlots: 0, orgSlots: 0, vmParallel: settings.vmParallel }),
    { maxCostOverhead: settings.maxCostOverhead, maxShards: Math.min(settings.maxShards, byTransfer) });
}

/**
 * Process-wide VM accounting. Shard VMs of every document on this worker share one budget, so a batch of
 * long PDFs cannot exhaust the provider's sandbox quota for other tenants; a saturated budget runs whole.
 */
let shardVmsInUse = 0;
/** Set when an image refuses shards; sharding stays off until it expires (a fresh image needs a redeploy anyway). */
let shardsUnsupportedUntil = 0;
const UNSUPPORTED_BACKOFF_MS = 30 * 60_000;
export function resetDopplerShardStateForTest(): void { shardVmsInUse = 0; shardsUnsupportedUntil = 0; }

/** A plan is dispatched only if it is feasible, within the cap, contiguous and on the guest's chunk grid. */
export function dispatchablePlan(plan: PageShardPlan, pageCount: number, maxShards: number): boolean {
  if (!plan.feasible || plan.shards.length < 2 || plan.shards.length > maxShards) return false;
  let expected = 1;
  for (const shard of plan.shards) {
    if (shard.first !== expected || shard.last < shard.first || (shard.first - 1) % GUEST_CHUNK_PAGES !== 0) return false;
    if (shard.last !== pageCount && shard.last % GUEST_CHUNK_PAGES !== 0) return false;
    expected = shard.last + 1;
  }
  return expected === pageCount + 1;
}

/** Sum per-VM usage into one conservative event: any unconfirmed allocation keeps its full reservation. */
export function mergeVmUsage(events: Array<UsageEvent | undefined>, shards: number): UsageEvent | undefined {
  const present = events.filter((event): event is UsageEvent => Boolean(event));
  if (present.length === 0) return undefined;
  const sum = (pick: (event: UsageEvent) => unknown) => present.reduce((total, event) => {
    const value = pick(event);
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
  const base = present[0]!;
  const unconfirmed = present.some((event) => event.metadata?.allocationUnconfirmed === true);
  const costCents = sum((event) => event.costCents);
  return {
    ...base,
    amount: costCents,
    costCents,
    metadata: {
      ...base.metadata,
      vms: present.length,
      shards,
      wallSeconds: sum((event) => event.metadata?.wallSeconds),
      costFloorCents: sum((event) => event.metadata?.costFloorCents),
      ...(unconfirmed ? { allocationUnconfirmed: true, estimateReason: "One or more shard VMs reserved their full configured lifetime" } : {}),
    },
  };
}

/** Each shard owns `pages` slots separated by form feeds; the merge adds one form feed between shards. */
function countSlots(bytes: Buffer): number {
  let separators = 0;
  for (const byte of bytes) if (byte === 0x0c) separators++;
  return separators + 1;
}

export async function executeDopplerShards(
  job: DopplerVmJob,
  pageCount: number,
  signal: AbortSignal | undefined,
  settings: DopplerShardSettings = dopplerShardSettings(),
  deps: DopplerShardDeps = {},
): Promise<SandboxResult> {
  const execute = deps.execute ?? executeDopplerVm;
  if (job.range || !Number.isSafeInteger(pageCount) || pageCount < 1) return execute(job, signal);
  // A document longer than one VM may convert must be split; that is not optional sharding.
  const mustSplit = pageCount > GUEST_MAX_VM_PAGES;
  const whole = (reason: string) => {
    if (settings.enabled || mustSplit) logPlan({ shards: 1, pages: pageCount, reason });
    return execute(job, signal);
  };
  if (mustSplit ? !settings.rangesSupported : !settings.enabled) return whole(mustSplit ? "ranges-unsupported" : "disabled");
  if (pageCount > GUEST_MAX_DOCUMENT_PAGES) return whole("over-document-limit");
  if (signal?.aborted) throw new SandboxRunError("Document VM aborted");
  // Size only: the host does not open or parse the document.
  const info = await lstat(job.input);
  if (!info.isFile() || info.size > MAX_PDF_BYTES) throw new SandboxRunError("Document VM invalid or oversized input");
  const profile = await (deps.profile?.() ?? Promise.resolve(SHARD_PROFILES["extract-markdown:doppler-vm"] as ShardCostProfile));
  if (signal?.aborted) throw new SandboxRunError("Document VM aborted");
  const free = settings.globalParallel - shardVmsInUse;
  if (Date.now() < shardsUnsupportedUntil) return whole("image-refused-ranges");
  // Optional sharding needs two free VMs; a forced split proceeds on at least one, running its shards in waves.
  if (!mustSplit && free < 2) return whole("vm-budget-full");
  const vmParallel = Math.max(1, Math.min(settings.vmParallel, free));
  const plan = planDopplerShards(pageCount, info.size, { ...settings, vmParallel }, profile);
  // An infeasible, oversized or malformed plan runs as one whole-document VM (which refuses a document over the per-VM limit).
  if (!dispatchablePlan(plan, pageCount, settings.maxShards)) return whole(plan.shards.length <= 1 ? "plan-unsharded" : `plan-rejected:${plan.reason}`);
  const reserved = Math.min(plan.parallel, plan.shards.length);
  shardVmsInUse += reserved;
  const dispatched = Date.now();

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort(); // delivered between the check above and the listener
  const token = randomUUID();
  const outputs = plan.shards.map((_, index) => `${job.output}.shard-${index}.${token}`);
  const usages: Array<UsageEvent | undefined> = new Array(plan.shards.length);
  const staged = `${job.output}.${token}.partial`;
  let failure: unknown;
  let next = 0;
  // Every exit below carries the cost of the VMs that already ran.
  const fail = (message: string, extra: Array<UsageEvent | undefined> = []): never => {
    throw new SandboxRunError(message, mergeVmUsage([...usages, ...extra], plan.shards.length));
  };
  try {
    await Promise.all(Array.from({ length: Math.min(plan.parallel, plan.shards.length) }, async () => {
      while (next < plan.shards.length && !failure && !controller.signal.aborted) {
        const index = next++;
        const shard = plan.shards[index]!;
        const started = Date.now();
        try {
          // Shards share the host's memory: each gets a share of the output cap proportional to its pages (x2 for skew).
          const outputLimit = Math.min(MAX_OUTPUT_BYTES, Math.ceil(MAX_OUTPUT_BYTES * 2 * (shard.last - shard.first + 1) / pageCount));
          const result = await execute({ ...job, output: outputs[index]!, outputLimit, range: { ...shard, final: shard.last === pageCount } }, controller.signal);
          usages[index] = result.usage;
          deps.recordTiming?.({ stage: "extract-markdown", executor: "doppler-vm", pages: shard.last - shard.first + 1,
            ms: Date.now() - started, shardIndex: index, shardCount: plan.shards.length });
        } catch (error) {
          if (error instanceof SandboxRunError) usages[index] = error.usage;
          if (error instanceof Error && error.message === SHARDS_UNSUPPORTED_MESSAGE && Date.now() >= shardsUnsupportedUntil) {
            shardsUnsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS;
            console.warn("[document-vm] image does not support page-range shards; sharding off for 30 min. Check DOCSLURP_DOPPLER_VM_PROTOCOL against the image");
          }
          failure ??= error;
          controller.abort(); // stop scheduling and cancel in-flight shards
        }
      }
    }));
    if (signal?.aborted || (controller.signal.aborted && !failure)) fail("Document VM aborted");
    if (failure) {
      const vms = usages.filter(Boolean).length;
      // One VM cannot convert a document over the per-VM limit, so there is nothing to fall back to.
      if (mustSplit) {
        logPlan({ shards: plan.shards.length, pages: pageCount, shardPages: plan.shardPages, vms, outcome: "failed", fallback: false });
        return fail(failure instanceof SandboxRunError ? failure.message : "Document VM shard failed");
      }
      // A guest that refuses a range (for example, it counts different pages than the host's index) would refuse
      // every retry too. Fall back once to one whole-document VM: the same boundary, at the cost of a second run.
      logPlan({ shards: plan.shards.length, pages: pageCount, shardPages: plan.shardPages, vms, outcome: "failed", fallback: true });
      console.warn(`[document-vm] shard failed; retrying as one whole-document VM shards=${plan.shards.length}`);
      let whole: SandboxResult;
      try {
        whole = await execute(job, signal);
      } catch (error) {
        return fail(error instanceof SandboxRunError ? error.message : "Document VM execution failed",
          [error instanceof SandboxRunError ? error.usage : undefined]);
      }
      const combined = mergeVmUsage([...usages, whole.usage], plan.shards.length);
      return { ...whole, ...(combined ? { usage: combined } : {}) };
    }
    // Merge in page order with the same bounds a single VM enforces.
    let total = 0;
    try {
      const handle = await open(staged, "wx", 0o600);
      try {
        for (const [index, shard] of plan.shards.entries()) {
          const bytes = await readFile(outputs[index]!);
          if (countSlots(bytes) !== shard.last - shard.first + 1) fail("Document VM shard page slots do not match range");
          total += bytes.length + (index > 0 ? 1 : 0);
          if (total > MAX_OUTPUT_BYTES) fail("Document VM merged output exceeds limit");
          if (index > 0) await handle.write(Buffer.from([0x0c]));
          await handle.write(bytes);
        }
      } finally {
        await handle.close();
      }
      if (signal?.aborted) fail("Document VM cancelled before output commit");
      await rename(staged, job.output);
    } catch (error) {
      if (error instanceof SandboxRunError) throw error;
      fail("Document VM shard merge failed"); // filesystem errors stay out of the message; the cost stays in
    }
    const usage = mergeVmUsage(usages, plan.shards.length);
    logPlan({ shards: plan.shards.length, pages: pageCount, shardPages: plan.shardPages, parallel: plan.parallel,
      vms: usages.filter(Boolean).length, wallMs: Date.now() - dispatched, predictedWallMs: plan.predictedWallMs,
      unshardedWallMs: plan.unshardedWallMs, outputBytes: total, forced: mustSplit, outcome: "merged" });
    return {
      stdout: JSON.stringify({ protocol: "doppler-vm@3", engine: "doppler", outputBytes: total,
        conversion: { pages: pageCount, first: 1, last: pageCount, documentPages: pageCount, shards: plan.shards.length,
          shardPages: plan.shardPages, parallel: plan.parallel, predictedWallMs: plan.predictedWallMs } }),
      stderr: "",
      exitCode: 0,
      ...(usage ? { usage } : {}),
    };
  } finally {
    shardVmsInUse -= reserved;
    signal?.removeEventListener("abort", onAbort);
    // Cleanup never replaces the result or the usage-bearing error.
    await Promise.allSettled([...outputs, staged].map((file) => rm(file, { force: true })));
  }
}
