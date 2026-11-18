/*
 * Same-organization batch: first-pass files from several runs of ONE organization converted in one sandboxed PDF batch job
 * (docs/design/cross-run-first-pass-batching.md). Default off (DOCSLURP_FIRST_PASS_CROSS_RUN).
 *
 * The organization is the only tenant scope, and a batch never mixes organizations. Enforced fail closed at three points,
 * each against what the host's database says owns a document (never the provider, never the request):
 * - the collector admits an entry only for its own organization (temporal/first-pass-collector.ts admitCollectorEntry);
 * - the activity refuses the whole batch before any VM work when a run or document belongs elsewhere
 *   (pipeline/first-pass-org.ts), and the merged job is checked again here (assertSingleOrgBatch) right before the
 *   provider runs;
 * - every provider event is routed back by the host's own route table, re-checked against the database owners
 *   (assertDemuxTarget), so a file's result reaches only the run that owns its document, and only that run's own folder.
 *
 * Usage: one VM's provider cost is split between the runs that shared it (apportionBatchUsage). Page charges are not split:
 * each run still records and authorizes its own documents' measured pages.
 */
import type { UsageEvent } from "../models.js";
import type { SandboxedPdfBatchFile, SandboxedPdfBatchOptions } from "./sandboxed-pdf-batch.js";

/** One file of a same-organization batch: a run's batch file, tagged with the run that owns its document. */
export interface SandboxedPdfOrgBatchFile extends SandboxedPdfBatchFile {
  runId: string;
}

/** A batch job spanning several runs of one organization. Providers opt in with `runOrgBatch`. */
export interface SandboxedPdfOrgBatchJob {
  scope: { orgId: string; runIds: string[] };
  files: SandboxedPdfOrgBatchFile[];
  options: SandboxedPdfBatchOptions;
}

export type DocumentOwners = ReadonlyMap<string, { orgId: string | null; runId: string }>;

export class OrgBatchScopeError extends Error {
  override name = "OrgBatchScopeError";
}

/**
 * Refuse a same-organization batch unless every file's document belongs, per the database, to the job's organization and to
 * the run the file is tagged with, every run is listed in the scope, and paths are absolute and distinct.
 */
export function assertSingleOrgBatch(job: SandboxedPdfOrgBatchJob, owners: DocumentOwners): void {
  const refuse = (why: string): never => { throw new OrgBatchScopeError(`Organization batch refused: ${why}`); };
  if (!job?.scope?.orgId || typeof job.scope.orgId !== "string") refuse("needs an organization scope");
  if (!Array.isArray(job.scope.runIds) || job.scope.runIds.length < 1 || job.scope.runIds.some((id) => typeof id !== "string" || !id)) refuse("needs its runs");
  const runs = new Set(job.scope.runIds);
  if (runs.size !== job.scope.runIds.length) refuse("lists a run twice");
  if (!Array.isArray(job.files) || job.files.length < 1) refuse("has no files");
  const ids = new Set<string>();
  const paths = new Set<string>();
  const used = new Set<string>();
  job.files.forEach((file, position) => {
    if (file.index !== position) refuse("file indexes must be 0..n-1 in order");
    if (ids.has(file.documentId)) refuse("lists a document twice");
    ids.add(file.documentId);
    for (const p of [file.input, file.output, file.figures?.dir]) {
      if (p === undefined) continue;
      if (typeof p !== "string" || !p.startsWith("/") || paths.has(p)) refuse("paths must be absolute and distinct");
      paths.add(p);
    }
    if (!!file.figures !== job.options.figures) refuse("figure folders must match the figures option");
    if (!runs.has(file.runId)) refuse("a file names a run outside the scope");
    const owner = owners.get(file.documentId);
    // The database decides: a document of another organization, of another run, or unknown refuses the whole batch.
    if (!owner || owner.orgId === null || owner.orgId !== job.scope.orgId) refuse("mixes organizations");
    if (owner!.runId !== file.runId) refuse("a file is tagged with a run that does not own its document");
    used.add(file.runId);
  });
  if (used.size !== runs.size) refuse("lists a run with no file");
}

/** Where one file of a merged job goes back to: the participant run and that run's own file index and folder. */
export interface OrgBatchRoute {
  runId: string;
  localIndex: number;
  documentId: string;
  /** The participant's own work folder; its outputs are moved only below it. */
  root: string;
  /** The participant's output and figure folder for this file (from the run's own job, never from the provider). */
  output: string;
  figuresDir?: string;
}

const within = (root: string, p: string) => p.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * The route for a provider event's file index, checked before anything is moved or handed on: the index is known, the route
 * names the run the merged file was tagged with, the database says that run owns the document, the organization is the
 * job's, and the destination lies inside that run's own folder. Anything else refuses (OrgBatchScopeError).
 */
export function assertDemuxTarget(job: SandboxedPdfOrgBatchJob, routes: readonly OrgBatchRoute[], owners: DocumentOwners, index: unknown): OrgBatchRoute {
  const refuse = (why: string): never => { throw new OrgBatchScopeError(`Organization batch result refused: ${why}`); };
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= job.files.length || index >= routes.length) refuse("unknown file index");
  const file = job.files[index as number]!;
  const route = routes[index as number]!;
  if (route.documentId !== file.documentId) refuse("route names another document");
  if (route.runId !== file.runId) refuse("route names another run");
  const owner = owners.get(file.documentId);
  if (!owner || owner.orgId !== job.scope.orgId || owner.runId !== route.runId) refuse("document is not the route's run's");
  if (!within(route.root, route.output) || (route.figuresDir !== undefined && !within(route.root, route.figuresDir))) refuse("destination outside the run's folder");
  return route;
}

// ── Usage ──

/**
 * Split `total` by `weights` in integer units of 1/scale, so the shares sum exactly to the whole at the column's precision
 * (usage_events.cost_cents keeps 12 decimals; amount keeps 4).
 */
function splitExact(total: number, weights: readonly number[], scale: number): number[] {
  const units = Math.round(total * scale);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (units * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let rest = units - floors.reduce((a, b) => a + b, 0);
  // Largest remainder first; ties to the earlier share, so the split is deterministic.
  const order = raw.map((r, i) => ({ i, frac: r - floors[i]! })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) { if (rest <= 0) break; floors[i]! += 1; rest--; }
  return floors.map((u) => u / scale);
}

/**
 * Split the provider cost of a shared batch between its runs, in proportion to `weights` (pages each run's files put
 * through the VM). Every event is split into one event per run with a positive weight; the shares of each event sum to the
 * event (to the column's precision), so nothing is billed twice and nothing is dropped. With no positive weight, everything goes to
 * the first run listed.
 */
export function apportionBatchUsage(events: readonly UsageEvent[], weights: ReadonlyMap<string, number>): Map<string, UsageEvent[]> {
  const runs = [...weights.keys()];
  const w = runs.map((run) => { const v = weights.get(run)!; return Number.isFinite(v) && v > 0 ? v : 0; });
  const out = new Map<string, UsageEvent[]>(runs.map((run) => [run, []]));
  if (runs.length === 0) return out;
  const totalWeight = w.reduce((a, b) => a + b, 0);
  for (const event of events) {
    const cost = splitExact(Number(event.costCents) || 0, w, 1_000_000);
    const amount = splitExact(Number(event.amount) || 0, w, 10_000);
    runs.forEach((run, i) => {
      if (totalWeight > 0 && w[i] === 0) return;
      if (totalWeight === 0 && i > 0) return;
      out.get(run)!.push({
        ...event,
        costCents: cost[i]!,
        amount: amount[i]!,
        metadata: { ...(event.metadata ?? {}), sharedBatch: { runs: runs.length, weight: w[i]!, totalWeight } },
      } as UsageEvent);
    });
  }
  return out;
}
