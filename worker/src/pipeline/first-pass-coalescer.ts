/*
 * The same-organization batch coalescer: several runs' first-pass batches (each built, staged and checked by its own
 * runFirstPassBatch) converted in one provider job, each result handed back only to its own run.
 *
 * Each participant run sees an ordinary SandboxedPdfBatchProvider (participant(runId)). The coalescer waits until every
 * expected run has either called run() or left without one (leave()), then launches: runs whose options match are merged
 * into one SandboxedPdfOrgBatchJob of at most the provider's limits, checked against the database (assertSingleOrgBatch),
 * and run once through the provider's `runOrgBatch`. A provider without `runOrgBatch`, or a run with no partner, runs its
 * own job through `run` exactly as before.
 *
 * Rules:
 * - One organization: participants must name the coalescer's organization and their own run; the merged job is refused
 *   before any VM work unless the database agrees for every document.
 * - The provider never sees a run's own paths: every merged file gets a folder of the coalescer's (inputs hard-linked or
 *   copied), and a result is moved into the run's folder only after assertDemuxTarget checked its route.
 * - Failure isolation: a run whose handler refuses an event, or that is cancelled, is detached alone: its later events are
 *   dropped, its run() rejects, and the other runs carry on. Only a batch-level failure (no VM, a malformed or unroutable
 *   event, a scope refusal) reaches every run, each of which then hands its documents back as for any failed batch.
 * - Usage: the provider cost of a merged job is split between its runs by pages (apportionBatchUsage), every share billed
 *   exactly once: to a run still attached through its own ledger (run() resolves or rejects with it), to a detached run
 *   through recordDetachedUsage.
 */
import { copyFile, cp, link, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { UsageEvent } from "../models.js";
import {
  BATCH_FINAL_PROPERTY, BATCH_USAGE_PROPERTY, batchUsageOf, isFinalBatchFailure, MAX_BATCH_DOCUMENT_PAGES,
  type SandboxedPdfBatchEvent, type SandboxedPdfBatchJob, type SandboxedPdfBatchProvider,
} from "../extractors/sandboxed-pdf-batch.js";
import {
  apportionBatchUsage, assertDemuxTarget, assertSingleOrgBatch, OrgBatchScopeError,
  type DocumentOwners, type OrgBatchRoute, type SandboxedPdfOrgBatchFile, type SandboxedPdfOrgBatchJob,
} from "../extractors/sandboxed-pdf-org-batch.js";

export interface OrgBatchCoalescerOptions {
  orgId: string;
  /** Every run expected to join, each at most once. */
  runIds: readonly string[];
  provider: SandboxedPdfBatchProvider;
  /** What the database says owns each document (Store.documentScopes). A lookup failure refuses the batch. */
  owners(documentIds: string[]): Promise<DocumentOwners>;
  /** The provider-cost share of a run that was detached before its batch ended (cancelled, its handler refused). */
  recordDetachedUsage(runId: string, usage: UsageEvent[]): Promise<void>;
  /** Folder for the coalescer's own copies of inputs and outputs (default: the OS temp folder). */
  workDir?: string;
}

export interface OrgBatchCoalescerStats {
  /** Provider jobs launched: merged (several runs) and single (one run's own job). */
  merged: number;
  single: number;
  /** Files per merged job. */
  mergedFiles: number[];
  /** Runs detached while their batch ran. */
  detached: string[];
}

export interface OrgBatchCoalescer {
  participant(runId: string): SandboxedPdfBatchProvider;
  /** The run's first pass is over (called whether or not it joined): no run() will follow. */
  leave(runId: string): void;
  /** Resolves when every launched provider job has ended and its usage is recorded. */
  settled(): Promise<OrgBatchCoalescerStats>;
}

type Participant = {
  runId: string;
  state: "expected" | "joined" | "left" | "detached" | "done";
  job?: SandboxedPdfBatchJob;
  onEvent?: (event: SandboxedPdfBatchEvent) => Promise<void>;
  signal?: AbortSignal;
  resolve?: (value: { usage: UsageEvent[] }) => void;
  reject?: (error: unknown) => void;
  /** Pages this run's files put through the VM: measured when its text arrived, else the estimate. */
  measured: Map<number, number>;
  onAbort?: () => void;
};

const optionsKey = (options: SandboxedPdfBatchJob["options"]) =>
  JSON.stringify({ math: !!options.math, figures: !!options.figures, pageFacts: options.pageFacts?.include ? [...options.pageFacts.include].sort() : null });

const abortError = (signal: AbortSignal | undefined): Error =>
  signal?.reason instanceof Error ? signal.reason : Object.assign(new Error("first-pass batch aborted"), { name: "AbortError" });

/** A participant's own copy of a batch-level failure: its share of the usage, the final flag kept, the cause chained. */
function participantFailure(error: unknown, usage: UsageEvent[]): Error {
  const message = error instanceof Error ? error.message : String(error);
  const failure = new Error(message, { cause: error }) as Error & Record<string, unknown>;
  if (error instanceof Error) failure.name = error.name;
  failure[BATCH_USAGE_PROPERTY] = usage;
  if (isFinalBatchFailure(error)) failure[BATCH_FINAL_PROPERTY] = true;
  return failure;
}

async function linkOrCopy(from: string, to: string): Promise<void> {
  try { await link(from, to); } catch { await copyFile(from, to); }
}

async function moveInto(from: string, to: string): Promise<void> {
  try { await rename(from, to); } catch { await copyFile(from, to); }
}

async function moveFolderContents(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from)) {
    const source = path.join(from, entry);
    const target = path.join(to, entry);
    try { await rename(source, target); } catch { await cp(source, target, { recursive: true, errorOnExist: true, force: false }); }
  }
}

export function createOrgBatchCoalescer(options: OrgBatchCoalescerOptions): OrgBatchCoalescer {
  if (!options.orgId) throw new OrgBatchScopeError("Organization batch needs an organization");
  if (new Set(options.runIds).size !== options.runIds.length || options.runIds.length < 1) throw new OrgBatchScopeError("Organization batch needs distinct runs");
  const participants = new Map<string, Participant>(options.runIds.map((runId) => [runId, { runId, state: "expected", measured: new Map() }]));
  const stats: OrgBatchCoalescerStats = { merged: 0, single: 0, mergedFiles: [], detached: [] };
  const jobs: Promise<void>[] = [];
  let launched = false;
  let launchedSignal!: () => void;
  const launchedPromise = new Promise<void>((resolve) => (launchedSignal = resolve));
  /** Merged groups each participant belongs to, so a detach can stop a group nobody waits for. */
  const groupOf = new Map<string, { controller: AbortController; members: Participant[] }>();

  const detach = (participant: Participant, reason: unknown) => {
    if (participant.state !== "joined") return;
    participant.state = "detached";
    if (participant.onAbort) participant.signal?.removeEventListener("abort", participant.onAbort);
    stats.detached.push(participant.runId);
    participant.reject!(reason);
    const group = groupOf.get(participant.runId);
    if (group && group.members.every((member) => member.state !== "joined")) group.controller.abort(new Error("every run of the batch left"));
  };

  const maybeLaunch = () => {
    if (launched) return;
    if ([...participants.values()].some((p) => p.state === "expected")) return;
    launched = true;
    launchedSignal();
    const active = [...participants.values()].filter((p) => p.state === "joined");
    const merge = typeof options.provider.runOrgBatch === "function";
    // Same options only (math, figures, page facts), packed whole runs at a time within the provider's limits.
    const byOptions = new Map<string, Participant[]>();
    for (const p of active) {
      const k = optionsKey(p.job!.options);
      byOptions.set(k, [...(byOptions.get(k) ?? []), p]);
    }
    for (const members of byOptions.values()) {
      const groups: Array<{ members: Participant[]; files: number; bytes: number; pages: number }> = [];
      for (const p of members) {
        const files = p.job!.files.length;
        const bytes = p.job!.files.reduce((sum, f) => sum + Math.max(0, f.bytes || 0), 0);
        const pages = p.job!.files.reduce((sum, f) => sum + Math.max(1, Math.ceil(f.estimatedPages || 1)), 0);
        const target = merge ? groups.find((g) => g.files + files <= options.provider.maxFiles && g.bytes + bytes <= options.provider.maxBatchBytes && g.pages + pages <= options.provider.maxBatchPages) : undefined;
        if (target) { target.members.push(p); target.files += files; target.bytes += bytes; target.pages += pages; } else groups.push({ members: [p], files, bytes, pages });
      }
      for (const group of groups) jobs.push(group.members.length > 1 ? runMerged(group.members) : runSingle(group.members[0]!));
    }
  };

  /** One run's own job, exactly as without the coalescer. */
  const runSingle = async (p: Participant): Promise<void> => {
    stats.single++;
    try {
      const result = await options.provider.run(p.job!, p.onEvent!, p.signal);
      if (p.state === "joined") { p.state = "done"; p.resolve!(result); } else await options.recordDetachedUsage(p.runId, result.usage);
    } catch (error) {
      if (p.state === "joined") { p.state = "done"; p.reject!(error); } else await options.recordDetachedUsage(p.runId, batchUsageOf(error)).catch(() => undefined);
    }
  };

  const runMerged = async (members: Participant[]): Promise<void> => {
    const controller = new AbortController();
    const group = { controller, members };
    for (const p of members) groupOf.set(p.runId, group);
    const work = await mkdtemp(path.join(options.workDir ?? tmpdir(), "docslurp-org-batch-"));
    let usage: UsageEvent[] = [];
    let failure: unknown;
    let ok = false;
    try {
      // The provider's folders: the coalescer's own, never a run's.
      const files: SandboxedPdfOrgBatchFile[] = [];
      const routes: OrgBatchRoute[] = [];
      const owner: Participant[] = [];
      for (const p of members) {
        for (const file of p.job!.files) {
          const index = files.length;
          const dir = path.join(work, String(index));
          await mkdir(dir);
          const input = path.join(dir, "source.pdf");
          await linkOrCopy(file.input, input);
          const figuresDir = file.figures ? path.join(dir, "figures") : undefined;
          if (figuresDir) await mkdir(figuresDir);
          files.push({
            index, runId: p.runId, documentId: file.documentId, input, output: path.join(dir, "output.md"), bytes: file.bytes,
            estimatedPages: file.estimatedPages, ...(file.figures ? { figures: { ...file.figures, dir: figuresDir! } } : {}),
          });
          routes.push({ runId: p.runId, localIndex: file.index, documentId: file.documentId, root: path.dirname(file.output), output: file.output,
            ...(file.figures ? { figuresDir: file.figures.dir } : {}) });
          owner.push(p);
        }
      }
      const job: SandboxedPdfOrgBatchJob = { scope: { orgId: options.orgId, runIds: members.map((p) => p.runId) }, files, options: members[0]!.job!.options };
      let owners: DocumentOwners;
      try {
        owners = await options.owners(files.map((f) => f.documentId));
      } catch {
        throw new OrgBatchScopeError("Organization batch refused: document ownership could not be verified");
      }
      // Right before the VM: the database agrees on every document's organization and run.
      assertSingleOrgBatch(job, owners);
      stats.merged++;
      stats.mergedFiles.push(files.length);

      const onEvent = async (raw: SandboxedPdfBatchEvent) => {
        const event = raw as unknown as Record<string, unknown> | null;
        if (!event || typeof event !== "object") throw new OrgBatchScopeError("Organization batch result refused: not an object");
        // An index the host cannot route ends the whole batch: no run can be trusted with it.
        const route = assertDemuxTarget(job, routes, owners, event.index);
        const p = owner[event.index as number]!;
        if (p.runId !== route.runId) throw new OrgBatchScopeError("Organization batch result refused: route names another run");
        if (p.state !== "joined") return;
        const source = files[event.index as number]!;
        try {
          if (event.phase === "text") await moveInto(source.output, route.output);
          if (event.phase === "figures" && source.figures && route.figuresDir) await moveFolderContents(source.figures.dir, route.figuresDir);
          await p.onEvent!({ ...(event as object), index: route.localIndex } as SandboxedPdfBatchEvent);
          const pages = event.pages;
          if (event.phase === "text" && typeof pages === "number" && Number.isSafeInteger(pages) && pages >= 1 && pages <= MAX_BATCH_DOCUMENT_PAGES) p.measured.set(route.localIndex, pages);
        } catch (error) {
          // This run refused its own result (a credit stop, a failed write, an event it would not accept): it alone ends.
          detach(p, error);
        }
      };

      if (members.every((p) => p.state !== "joined")) controller.abort(new Error("every run of the batch left"));
      try {
        usage = (await options.provider.runOrgBatch!(job, onEvent, controller.signal)).usage;
        ok = true;
      } catch (error) {
        failure = error;
        usage = batchUsageOf(error);
      }
    } catch (error) {
      // Refused before any VM ran (scope, staging): nothing to bill.
      failure = error;
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }

    const weights = new Map(members.map((p) => [p.runId, p.job!.files.reduce((sum, f) => sum + (p.measured.get(f.index) ?? Math.max(1, Math.ceil(f.estimatedPages || 1))), 0)]));
    const shares = apportionBatchUsage(usage, weights);
    for (const p of members) {
      const share = shares.get(p.runId) ?? [];
      if (p.state === "joined") {
        p.state = "done";
        if (p.onAbort) p.signal?.removeEventListener("abort", p.onAbort);
        if (ok) p.resolve!({ usage: share }); else p.reject!(participantFailure(failure, share));
      } else if (share.length) {
        await options.recordDetachedUsage(p.runId, share).catch((error: unknown) =>
          console.error(`[first-pass] org batch usage for a detached run could not be recorded run=${p.runId}: ${error instanceof Error ? error.name : "error"}`));
      }
    }
  };

  return {
    participant(runId: string): SandboxedPdfBatchProvider {
      const p = participants.get(runId);
      if (!p) throw new OrgBatchScopeError("Organization batch: run is not a participant");
      const base = options.provider;
      return {
        maxFiles: base.maxFiles, maxBatchBytes: base.maxBatchBytes, maxBatchPages: base.maxBatchPages,
        run: (job, onEvent, signal) => new Promise((resolve, reject) => {
          if (p.state !== "expected") return reject(new OrgBatchScopeError("Organization batch: a run joined twice or after it left"));
          // Each run's job was already checked against its own run and organization (assertSingleScopeBatch); it must also
          // name this coalescer's organization and its own run.
          if (job?.scope?.orgId !== options.orgId || job.scope.runId !== runId) return reject(new OrgBatchScopeError("Organization batch refused: a run's job names another organization or run"));
          Object.assign(p, { state: "joined", job, onEvent, signal, resolve, reject });
          if (signal?.aborted) detach(p, abortError(signal));
          else if (signal) { p.onAbort = () => detach(p, abortError(signal)); signal.addEventListener("abort", p.onAbort, { once: true }); }
          maybeLaunch();
        }),
      };
    },
    leave(runId: string) {
      const p = participants.get(runId);
      if (p?.state === "expected") { p.state = "left"; maybeLaunch(); }
    },
    async settled() {
      await launchedPromise;
      await Promise.allSettled(jobs);
      return stats;
    },
  };
}
