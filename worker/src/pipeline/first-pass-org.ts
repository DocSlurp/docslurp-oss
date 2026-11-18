/*
 * The same-organization first-pass batch (activity body): small first passes of several runs of ONE organization share one
 * sandboxed PDF batch job, each run otherwise exactly its own first pass (runFirstPassBatch: its staging, admission, page
 * counts, credit authorization, drains, publish gate and usage ledger). Default off (DOCSLURP_FIRST_PASS_CROSS_RUN); see
 * docs/design/cross-run-first-pass-batching.md.
 *
 * Rules:
 * - One organization. Before any staging or VM work, the database must say every run and every document belongs to the
 *   input organization and every document to the run it is listed under; otherwise the whole batch is refused and every
 *   run takes its own first pass back (OrgBatchScopeError). The merged job is checked again before the VM, and every
 *   result is routed by the host's own table (first-pass-coalescer.ts).
 * - Each run's outcome is its own: a run's credit stop, failed write, refused event or cancellation ends that run's part
 *   only. A run's result reports a fixed status slug; raw errors go to the worker log, never into the result.
 * - Per-run cancellation: a run asked to cancel is detached within one poll (cancelPollMs) and its documents are dropped.
 * - Provider cost is split by pages between the runs that shared the VM, each share billed once to its own run.
 */
import type { UsageEvent } from "../models.js";
import { isFinalBatchFailure, sandboxedPdfBatchProvider, type SandboxedPdfBatchProvider } from "../extractors/sandboxed-pdf-batch.js";
import { OrgBatchScopeError } from "../extractors/sandboxed-pdf-org-batch.js";
import { RunPolicyError } from "../lib/document-failure.js";
import { createOrgBatchCoalescer, type OrgBatchCoalescerStats } from "./first-pass-coalescer.js";
import { loadRunState } from "./stage-execution.js";
import { runFirstPassBatch, type FirstPassBatchDeps, type FirstPassBatchResult, type FirstPassStore } from "./first-pass.js";

/** Most runs one shared batch takes (the collector packs far fewer; this bounds a malformed input). */
export const ORG_BATCH_MAX_RUNS = 512;

export interface OrgFirstPassEntry {
  runId: string;
  documentIds: string[];
}

export interface OrgFirstPassInput {
  orgId: string;
  entries: OrgFirstPassEntry[];
}

export type OrgFirstPassRunResult =
  | { runId: string; status: "done"; output: Pick<FirstPassBatchResult, "usage" | "indexed" | "extracted" | "handedBack" | "timings"> }
  /** A run-policy stop (credits, cost cap): the run stops exactly as for its own batch. */
  | { runId: string; status: "policy-stop" }
  /** The run was cancelled while the batch ran: its documents were dropped. */
  | { runId: string; status: "cancelled" }
  /** The run's part failed: its documents take its own first-pass fallback (counted, then the stage loop). */
  | { runId: string; status: "failed"; reason: "batch-failed" | "batch-final" | "scope-refused" };

export interface OrgFirstPassOutput {
  results: OrgFirstPassRunResult[];
  stats: OrgBatchCoalescerStats | null;
}

export interface OrgFirstPassDeps extends Omit<FirstPassBatchDeps, "runStage" | "provider"> {
  store: FirstPassStore & { runCancelRequested?(runId: string): Promise<boolean> };
  /** The ordinary stage runner for one run (runFirstPassBatch's runStage, bound to that run). */
  runStageFor(runId: string): FirstPassBatchDeps["runStage"];
  provider?: SandboxedPdfBatchProvider;
  /** How often each run's cancellation is checked while the batch runs (default 5 s). */
  cancelPollMs?: number;
  workDir?: string;
}

/** Shape and tenant checks, before anything is staged: the database must agree on every run and document. */
export async function assertOrgFirstPassScope(store: OrgFirstPassDeps["store"], input: OrgFirstPassInput): Promise<void> {
  const refuse = (why: string): never => { throw new OrgBatchScopeError(`Organization first pass refused: ${why}`); };
  if (!input || typeof input.orgId !== "string" || !input.orgId) refuse("needs an organization");
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > ORG_BATCH_MAX_RUNS) refuse("run count out of bounds");
  const runs = new Set<string>();
  const listed = new Map<string, string>();
  for (const entry of input.entries) {
    if (!entry || typeof entry.runId !== "string" || !entry.runId || runs.has(entry.runId)) refuse("runs must be distinct");
    runs.add(entry.runId);
    if (!Array.isArray(entry.documentIds) || entry.documentIds.length < 1) refuse("a run lists no documents");
    for (const id of entry.documentIds) {
      if (typeof id !== "string" || !id || listed.has(id)) refuse("documents must be distinct");
      listed.set(id, entry.runId);
    }
  }
  for (const runId of runs) {
    const run = await store.loadRun(runId).catch(() => null);
    // A run of another organization, or one whose organization is unknown, refuses the whole batch.
    if (!run || !run.orgId || run.orgId !== input.orgId) refuse("mixes organizations");
  }
  const scopes = await store.documentScopes([...listed.keys()]);
  for (const [documentId, runId] of listed) {
    const scope = scopes.get(documentId);
    if (!scope || scope.orgId !== input.orgId) refuse("mixes organizations");
    if (scope!.runId !== runId) refuse("a document is listed under a run that does not own it");
  }
}

const hasPolicyStop = (error: unknown): boolean => {
  for (let link: unknown = error, depth = 0; link && depth < 8; depth++, link = (link as { cause?: unknown }).cause) {
    if (link instanceof RunPolicyError) return true;
  }
  return false;
};

export async function runOrgFirstPassBatch(deps: OrgFirstPassDeps, input: OrgFirstPassInput): Promise<OrgFirstPassOutput> {
  await assertOrgFirstPassScope(deps.store, input);
  const provider = deps.provider ?? sandboxedPdfBatchProvider();
  if (!provider) throw new Error("First pass needs a sandboxed PDF batch provider");
  const coalescer = createOrgBatchCoalescer({
    orgId: input.orgId,
    runIds: input.entries.map((entry) => entry.runId),
    provider,
    owners: (ids) => deps.store.documentScopes(ids),
    workDir: deps.workDir,
    // A detached run's share of the VM, through its own ledger (the same write as the run's own batch flush).
    recordDetachedUsage: async (runId, usage: UsageEvent[]) => {
      const state = await loadRunState(deps.store, runId, { hydrate: true });
      for (const event of usage) state.usageLedger.enqueue(event);
      await deps.store.updateProgress(state);
    },
  });
  const pollMs = Math.max(50, deps.cancelPollMs ?? 5_000);
  const results = await Promise.all(input.entries.map(async (entry): Promise<OrgFirstPassRunResult> => {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(deps.signal?.reason);
    if (deps.signal?.aborted) controller.abort(deps.signal.reason);
    deps.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let cancelled = false;
    const poll = deps.store.runCancelRequested ? setInterval(() => {
      void deps.store.runCancelRequested!(entry.runId).then((yes) => {
        if (yes && !controller.signal.aborted) { cancelled = true; controller.abort(new Error("run cancelled")); }
      }, () => undefined);
    }, pollMs) : null;
    poll?.unref?.();
    try {
      const output = await runFirstPassBatch({
        store: deps.store, storage: deps.storage, quarantineEnabled: deps.quarantineEnabled, heartbeat: deps.heartbeat, now: deps.now,
        signal: controller.signal, runStage: deps.runStageFor(entry.runId), provider: coalescer.participant(entry.runId),
      }, entry);
      return { runId: entry.runId, status: "done", output: { usage: output.usage, indexed: output.indexed, extracted: output.extracted, handedBack: output.handedBack, timings: output.timings } };
    } catch (error) {
      if (cancelled) return { runId: entry.runId, status: "cancelled" };
      if (hasPolicyStop(error)) return { runId: entry.runId, status: "policy-stop" };
      console.warn(`[first-pass] org=${input.orgId} run=${entry.runId} shared batch part failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "error"}`);
      const reason = error instanceof OrgBatchScopeError || (error as { cause?: unknown })?.cause instanceof OrgBatchScopeError ? "scope-refused"
        : isFinalBatchFailure(error) ? "batch-final" : "batch-failed";
      return { runId: entry.runId, status: "failed", reason };
    } finally {
      if (poll) clearInterval(poll);
      deps.signal?.removeEventListener("abort", onOuterAbort);
      coalescer.leave(entry.runId);
    }
  }));
  const stats = await coalescer.settled();
  // The activity itself was cancelled (the collector stopped): Temporal decides, not a per-run result.
  if (deps.signal?.aborted) throw deps.signal.reason instanceof Error ? deps.signal.reason : new Error("first-pass org batch cancelled");
  console.log(`[first-pass] org=${input.orgId} shared batch runs=${input.entries.length} merged=${stats.merged} single=${stats.single} ` +
    `files=${stats.mergedFiles.join("+") || 0} detached=${stats.detached.length} ` +
    `statuses=${results.map((r) => r.status).join(",")}`);
  return { results, stats };
}
