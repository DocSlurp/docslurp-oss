import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { planPageShards, type PageShardPlan, type ShardCostProfile } from "../../../temporal/page-shards.js";
import { SHARD_PROFILES, shardCapacity } from "../../../temporal/page-shard-profiles.js";
import { SandboxRunError, type SandboxResult } from "../../types.js";
import type { UsageEvent } from "../../../models.js";
import { executeDopplerVm, GUEST_CHUNK_PAGES, MAX_OUTPUT_BYTES, MAX_PDF_BYTES, type DopplerVmJob } from "./doppler-vm.js";

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
}

export function dopplerShardSettings(env: NodeJS.ProcessEnv = process.env): DopplerShardSettings {
  const int = (name: string, fallback: number, min: number, max: number) => {
    const value = Number.parseInt(env[name] ?? "", 10);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const overhead = Number.parseFloat(env.DOCSLURP_DOPPLER_SHARD_COST_OVERHEAD ?? "");
  return {
    enabled: /^(1|true|on)$/i.test(env.DOCSLURP_DOPPLER_SHARDS?.trim() ?? ""),
    vmParallel: int("DOCSLURP_DOPPLER_VM_MAX_PARALLEL", 8, 1, 64),
    maxCostOverhead: Number.isFinite(overhead) && overhead >= 0 ? Math.min(overhead, 10) : 1,
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
  const byTransfer = Math.max(1, Math.floor(settings.maxTransferBytes / Math.max(1, fileBytes)));
  return planPageShards(pageCount, { ...profile, pageAlign: GUEST_CHUNK_PAGES },
    shardCapacity("doppler-vm", { idleSlots: 0, orgSlots: 0, vmParallel: settings.vmParallel }),
    { maxCostOverhead: settings.maxCostOverhead, maxShards: Math.min(settings.maxShards, byTransfer) });
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
  if (!settings.enabled || job.range || !Number.isSafeInteger(pageCount) || pageCount < 1) return execute(job, signal);
  // Size only: the host does not open or parse the document.
  const info = await lstat(job.input);
  if (!info.isFile() || info.size > MAX_PDF_BYTES) throw new SandboxRunError("Document VM invalid or oversized input");
  const profile = await (deps.profile?.() ?? Promise.resolve(SHARD_PROFILES["extract-markdown:doppler-vm"] as ShardCostProfile));
  const plan = planDopplerShards(pageCount, info.size, settings, profile);
  if (plan.shards.length <= 1) return execute(job, signal);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const token = randomUUID();
  const outputs = plan.shards.map((_, index) => `${job.output}.shard-${index}.${token}`);
  const usages: Array<UsageEvent | undefined> = new Array(plan.shards.length);
  const staged = `${job.output}.${token}.partial`;
  let failure: unknown;
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(plan.parallel, plan.shards.length) }, async () => {
      while (next < plan.shards.length && !failure && !controller.signal.aborted) {
        const index = next++;
        const shard = plan.shards[index]!;
        const started = Date.now();
        try {
          const result = await execute({ ...job, output: outputs[index]!, range: { ...shard, final: shard.last === pageCount } }, controller.signal);
          usages[index] = result.usage;
          deps.recordTiming?.({ stage: "extract-markdown", executor: "doppler-vm", pages: shard.last - shard.first + 1,
            ms: Date.now() - started, shardIndex: index, shardCount: plan.shards.length });
        } catch (error) {
          if (error instanceof SandboxRunError) usages[index] = error.usage;
          failure ??= error;
          controller.abort(); // stop scheduling and cancel in-flight shards
        }
      }
    }));
    const usage = mergeVmUsage(usages, plan.shards.length);
    if (signal?.aborted) throw new SandboxRunError("Document VM aborted", usage);
    if (failure) {
      // A guest that refuses a range (for example, it counts different pages than the host's index) would refuse
      // every retry too. Fall back once to one whole-document VM: the same boundary, at the cost of a second run.
      console.warn(`[document-vm] shard failed; retrying as one whole-document VM shards=${plan.shards.length}`);
      try {
        const whole = await execute(job, signal);
        const combined = mergeVmUsage([usage, whole.usage], plan.shards.length);
        return { ...whole, ...(combined ? { usage: combined } : {}) };
      } catch (error) {
        throw new SandboxRunError(error instanceof SandboxRunError ? error.message : "Document VM execution failed",
          mergeVmUsage([usage, error instanceof SandboxRunError ? error.usage : undefined], plan.shards.length));
      }
    }
    // Merge in page order with the same bounds a single VM enforces.
    const handle = await open(staged, "wx", 0o600);
    let total = 0;
    try {
      for (const [index, shard] of plan.shards.entries()) {
        const bytes = await readFile(outputs[index]!);
        if (countSlots(bytes) !== shard.last - shard.first + 1) throw new SandboxRunError("Document VM shard page slots do not match range", usage);
        total += bytes.length + (index > 0 ? 1 : 0);
        if (total > MAX_OUTPUT_BYTES) throw new SandboxRunError("Document VM merged output exceeds limit", usage);
        if (index > 0) await handle.write(Buffer.from([0x0c]));
        await handle.write(bytes);
      }
    } finally {
      await handle.close();
    }
    if (signal?.aborted) throw new SandboxRunError("Document VM cancelled before output commit", usage);
    await rename(staged, job.output);
    return {
      stdout: JSON.stringify({ protocol: "doppler-vm@3", engine: "doppler", outputBytes: total,
        conversion: { pages: pageCount, first: 1, last: pageCount, documentPages: pageCount, shards: plan.shards.length,
          shardPages: plan.shardPages, parallel: plan.parallel, predictedWallMs: plan.predictedWallMs } }),
      stderr: "",
      exitCode: 0,
      ...(usage ? { usage } : {}),
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await Promise.all([...outputs, staged].map((file) => rm(file, { force: true })));
  }
}
