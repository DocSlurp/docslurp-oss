/**
 * The `text` capability pool as one sandboxed PDF provider: several registered providers (each a text pool member,
 * extractor plugin `poolMembers`) run in the pool's order. A job goes to the first member; when it is unavailable (the
 * VM or service failed to run the job: an infrastructure error, not a refusal of the input) the job moves to the next
 * member the pool fails over to automatically, and the failover is recorded. Every member is a VM boundary of its own:
 * failover never leaves the VM route and never parses on the worker host.
 *
 * Optional features (embedded images, figures, batches, shard profiles, figure resume) are the first member's: a job
 * that asks for figures or embedded images fails over only to a member that returns them under the same producer id, and
 * images are always read back from the member that wrote them. Nothing is cached or reused between jobs: which member
 * served a job is remembered per job object and per output path, for that job's own follow-up reads only.
 */
import type { CapabilityPoolMember, PoolFailoverReason, ServicePoolMember } from "@docslurp/shared";

import type { SandboxedPdfExtractorProvider, SandboxedPdfJob, SandboxedPdfResult } from "./plugins.js";

type Member = { member: ServicePoolMember; provider: SandboxedPdfExtractorProvider };

/** Errors that refuse the input itself: running it on another member would only refuse it again (and bill twice). */
function refusesInput(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.ocrRefused === true || record.refused === true || typeof record.pageCountOutcome === "string" || record.name === "AbortError";
}

/** Hooks for telemetry (defaults: worker lib/capability-pools.ts), replaceable in tests. */
export interface TextPoolTelemetry {
  served(memberId: string): void;
  failover(from: string, to: string | null, reason: PoolFailoverReason): void;
}

let telemetry: TextPoolTelemetry | null = null;
export function setTextPoolTelemetry(hooks: TextPoolTelemetry | null): void {
  telemetry = hooks;
}

/** Most output paths remembered for image read-back (each job reads its images once, right after its run). */
const MAX_REMEMBERED_OUTPUTS = 4_096;

export function createTextPoolProvider(
  providers: readonly SandboxedPdfExtractorProvider[],
  pool: () => readonly CapabilityPoolMember[],
): SandboxedPdfExtractorProvider {
  const ordered = (): Member[] => {
    const members = pool().filter((member): member is ServicePoolMember => member.kind === "service" && member.capability === "text");
    const out = members.flatMap((member) => {
      const provider = providers.find((candidate) => candidate.id === member.backend);
      return provider ? [{ member, provider }] : [];
    });
    if (out.length === 0) throw new Error("the text capability pool has no member with a registered sandboxed PDF provider");
    return out;
  };
  const first = () => ordered()[0]!.provider;
  const servedBy = new WeakMap<SandboxedPdfJob, Member>();
  const outputs = new Map<string, Member>();
  const remember = (job: SandboxedPdfJob, member: Member) => {
    servedBy.set(job, member);
    outputs.delete(job.output);
    outputs.set(job.output, member);
    while (outputs.size > MAX_REMEMBERED_OUTPUTS) outputs.delete(outputs.keys().next().value!);
  };
  /** The members a job may run on: the first, then automatic-failover members that can serve what it asks for. */
  const eligible = (job: SandboxedPdfJob | null): Member[] => {
    const all = ordered();
    const lead = all[0]!;
    return all.filter((entry, index) => {
      if (index === 0) return true;
      if (!entry.member.automaticFailover) return false;
      if (job?.figures && entry.provider.figures?.producerId !== lead.provider.figures?.producerId) return false;
      if (job?.embeddedImages && entry.provider.embeddedImages?.producerId !== lead.provider.embeddedImages?.producerId) return false;
      return true;
    });
  };
  async function withFailover<T>(job: SandboxedPdfJob | null, run: (entry: Member) => Promise<T>, stamp?: (value: T, entry: Member) => T): Promise<T> {
    const candidates = eligible(job);
    let lastError: unknown;
    for (const [index, entry] of candidates.entries()) {
      try {
        const value = await run(entry);
        if (job) remember(job, entry);
        telemetry?.served(entry.member.id);
        return stamp ? stamp(value, entry) : value;
      } catch (error) {
        lastError = error;
        if (refusesInput(error)) throw error;
        const next = candidates[index + 1] ?? null;
        telemetry?.failover(entry.member.id, next?.member.id ?? null, "unavailable");
        if (!next) throw error;
      }
    }
    throw lastError ?? new Error("the text capability pool has no member to run the job");
  }
  const lead = first();
  return {
    id: lead.id,
    get maxSourceBytes() { return first().maxSourceBytes; },
    assertConfigured() {
      for (const { provider } of ordered()) provider.assertConfigured();
    },
    run(job, context, signal) {
      return withFailover<SandboxedPdfResult>(job, ({ provider }) => provider.run(job, context, signal),
        (result, entry) => ({ ...result, poolMemberId: entry.member.id }));
    },
    timeoutMs(pages) {
      // The first member's budget plus one failover member's: a failover gets its own time.
      const [a, b] = eligible(null);
      return a!.provider.timeoutMs(pages) + (b ? b.provider.timeoutMs(pages) : 0);
    },
    ...(lead.embeddedImages ? {
      embeddedImages: {
        producerId: lead.embeddedImages.producerId,
        optionsDigest: lead.embeddedImages.optionsDigest,
        read(output: string, signal?: AbortSignal) {
          const entry = outputs.get(output);
          const images = (entry?.provider ?? first()).embeddedImages;
          if (!images) throw new Error("the text pool member that converted this document returns no embedded images");
          return images.read(output, signal);
        },
      },
    } : {}),
    ...(lead.figures ? { figures: lead.figures } : {}),
    ...(lead.shardProfile ? { shardProfile: lead.shardProfile } : {}),
    ...(lead.batch ? { batch: lead.batch } : {}),
    ...(providers.some((provider) => provider.pageCount) ? {
      pageCount(job: { input: string }, signal?: AbortSignal) {
        return withFailover(null, async ({ provider }) => {
          if (!provider.pageCount) throw Object.assign(new Error("this text pool member cannot count pages"), { name: "UnsupportedError" });
          return await provider.pageCount(job, signal);
        });
      },
    } : {}),
  };
}
