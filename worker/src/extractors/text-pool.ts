/**
 * The `text` capability pool as one sandboxed PDF provider: several registered providers (each a text pool member,
 * extractor plugin `poolMembers`) run in the pool's order. A job goes to the first member; it moves to the next member
 * the pool fails over to automatically only when the member says it could not start the job: an error carrying
 * `poolUnavailable: true` (TEXT_POOL_UNAVAILABLE), set by a provider only for capacity or availability failures before
 * any guest started. A VM crash, an out-of-memory kill or a guest error could have been caused by the file itself, so
 * it is the job's answer and the file is never sent to another member. The failover is recorded. Every member is a VM boundary of its own:
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

/** The property a provider sets on an error when it could not start the job (capacity or availability, no guest ran). */
export const TEXT_POOL_UNAVAILABLE = "poolUnavailable";

/** Failover reason for an error, or null when the error is the job's answer (no failover). */
function failoverReason(error: unknown, signal?: AbortSignal): PoolFailoverReason | null {
  if (signal?.aborted || !error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (record.name === "AbortError") return null;
  if (record.name === "UnsupportedError") return "unsupported";
  return record[TEXT_POOL_UNAVAILABLE] === true ? "unavailable" : null;
}

/** Hooks for telemetry (defaults: worker lib/capability-pools.ts), replaceable in tests. */
export interface TextPoolTelemetry {
  /** `pages`: the pages the member converted (the job's page count; 1 when unknown). */
  served(memberId: string, pages: number): void;
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
  /** The text pool, or null before worker startup resolved the pools. */
  pool: () => readonly CapabilityPoolMember[] | null,
): SandboxedPdfExtractorProvider {
  const ordered = (): Member[] => {
    const resolved = pool();
    if (!resolved) throw new Error("the text capability pool is used before worker startup resolved the capability pools");
    const members = resolved.filter((member): member is ServicePoolMember => member.kind === "service" && member.capability === "text");
    const out = members.flatMap((member) => {
      const provider = providers.find((candidate) => candidate.id === member.backend);
      return provider ? [{ member, provider }] : [];
    });
    if (out.length === 0) throw new Error("the text capability pool has no member with a registered sandboxed PDF provider");
    return out;
  };
  // Resolved at call time, never at construction: the pools are set at worker startup, after the plugins load.
  const first = () => (pool() ? ordered()[0]!.provider : providers[0]!);
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
  async function withFailover<T>(job: SandboxedPdfJob | null, pages: number, signal: AbortSignal | undefined, run: (entry: Member) => Promise<T>, stamp?: (value: T, entry: Member) => T): Promise<T> {
    const candidates = eligible(job);
    let lastError: unknown;
    for (const [index, entry] of candidates.entries()) {
      try {
        const value = await run(entry);
        if (job) remember(job, entry);
        telemetry?.served(entry.member.id, Math.max(1, pages));
        return stamp ? stamp(value, entry) : value;
      } catch (error) {
        lastError = error;
        const reason = failoverReason(error, signal);
        if (!reason) throw error;
        const next = candidates[index + 1] ?? null;
        telemetry?.failover(entry.member.id, next?.member.id ?? null, reason);
        if (!next) throw error;
      }
    }
    throw lastError ?? new Error("the text capability pool has no member to run the job");
  }
  const lead = first;
  return {
    get id() { return lead().id; },
    get maxSourceBytes() { return lead().maxSourceBytes; },
    assertConfigured() {
      for (const { provider } of ordered()) provider.assertConfigured();
    },
    run(job, context, signal) {
      return withFailover<SandboxedPdfResult>(job, context.pages, signal, ({ provider }) => provider.run(job, context, signal),
        (result, entry) => ({ ...result, poolMemberId: entry.member.id }));
    },
    timeoutMs(pages) {
      // The first member's budget plus one failover member's: a failover gets its own time.
      const [a, b] = eligible(null);
      return a!.provider.timeoutMs(pages) + (b ? b.provider.timeoutMs(pages) : 0);
    },
    get embeddedImages() {
      const images = lead().embeddedImages;
      return images ? {
        producerId: images.producerId,
        optionsDigest: images.optionsDigest,
        read(output: string, signal?: AbortSignal) {
          const entry = outputs.get(output);
          const own = (entry?.provider ?? lead()).embeddedImages;
          if (!own) throw new Error("the text pool member that converted this document returns no embedded images");
          return own.read(output, signal);
        },
      } : undefined;
    },
    get figures() { return lead().figures; },
    get shardProfile() { return lead().shardProfile; },
    get batch() { return lead().batch; },
    get pageCount() {
      if (!providers.some((provider) => provider.pageCount)) return undefined;
      return (job: { input: string }, signal?: AbortSignal) => withFailover(null, 0, signal, async ({ provider }) => {
        if (!provider.pageCount) throw Object.assign(new Error("this text pool member cannot count pages"), { name: "UnsupportedError" });
        return await provider.pageCount(job, signal);
      });
    },
  };
}
