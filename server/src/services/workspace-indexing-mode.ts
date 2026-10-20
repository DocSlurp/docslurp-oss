import { randomUUID } from "node:crypto";

import {
  defaultIndexingModeForPlan,
  deferredProfilesEnabled,
  effectiveIndexingMode,
  estimatePageEmbedCredits,
  isBillingEnforced,
  getPrivateModelEndpointRegistry,
  compilePipelinePlan,
  type CostEstimate,
  type IndexingMode,
  type MaterializationPolicy,
  type PipelineFeatures,
  type WorkspaceRecord,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { nextVersionNumber } from "./version-number.js";
import type { RequestActor } from "../lib/request-actor.js";
import { admitRunSpend, canSpend, SpendBlockedError } from "./billing/spend-guard.js";
import { canEditWorkspace, getWorkspaceAccess } from "./organizations.js";
import { enforceLiveBudgetCaps } from "./run-creation.js";
import { assertBackfillReusableMany, isReprocessRejectedError } from "./runs.js";
import { estimateWork, type EstimateEnv } from "./config-change.js";

/** Domain failure with an HTTP status and machine-readable code. */
export class IndexingModeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 402 | 403 | 404 | 409 | 413,
    readonly code:
      | "too_many_documents"
      | "index_in_progress"
      | "visual_mode_privacy"
      | "credits_required_for_full_index"
      | "full_index_not_allowed"
      | "document_not_found"
      | "nothing_to_index"
      | "backfill_not_possible",
  ) {
    super(message);
    this.name = "IndexingModeError";
  }
}

export { effectiveIndexingMode };

/** Credits per page of full indexing, for estimates only; billing uses actual usage. */
export function fullIndexCreditsPerPage(): number {
  const parsed = Number.parseFloat(process.env.DOCSLURP_FULL_INDEX_CREDITS_PER_PAGE ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.1;
}

/**
 * Org default for new workspaces: free plan without purchased credits defers
 * (`map`); a paid plan or any purchased (top-up / auto-recharge / subscription)
 * credit grant indexes fully. Starter and promo grants do not count.
 */
export async function defaultIndexingModeForOrg(orgId: string): Promise<IndexingMode> {
  if (!deferredProfilesEnabled()) return "full";
  const [row] = await sql<{ plan_id: string | null; purchased: boolean }[]>`
    select o.plan_id,
      exists (
        select 1 from credit_grants g
        where g.org_id = o.id
          and g.source in ('subscription', 'topup', 'auto_recharge')
          and g.credits - g.reversed_credits > 0
      ) as purchased
    from organizations o where o.id = ${orgId}
  `;
  return defaultIndexingModeForPlan({ planId: row?.plan_id, hasPurchasedCredits: row?.purchased ?? false });
}

export function hasPrivatePageEmbedder(): boolean {
  try {
    return getPrivateModelEndpointRegistry().endpoints.some((endpoint) =>
      endpoint.models.some((model) => model.capability === "embedding" && /omni/i.test(model.id)),
    );
  } catch {
    return false;
  }
}

/** Visual mode sends page images to an embedder: refuse when privacy or PII policy forbids it. */
export function assertVisualModeAllowed(pipeline: Pick<PipelineFeatures, "privacyMode" | "piiPolicy">): void {
  const hostedForbidden = pipeline.privacyMode !== "standard" && !hasPrivatePageEmbedder();
  const piiBlocks = Boolean(pipeline.piiPolicy?.enabled && pipeline.piiPolicy.action === "block_indexing");
  if (hostedForbidden || piiBlocks) {
    throw new IndexingModeError(
      piiBlocks
        ? "Visual mode embeds raw page images, which the workspace PII policy blocks."
        : "Visual mode needs a private page embedder under this workspace's privacy mode.",
      400,
      "visual_mode_privacy",
    );
  }
}

type PageCountRow = { pages: number; documents: number };

/** Pages of live deferred documents that are not yet searchable (state indexed). */
async function unindexedPages(workspaceId: string, documentIds?: string[]): Promise<Array<{ id: string; unindexed: number }>> {
  return await sql<{ id: string; unindexed: number }[]>`
    select d.id,
      greatest(d.page_count - coalesce(ps.indexed, 0), 0)::int as unindexed
    from documents d
    left join lateral (
      select count(*) filter (where state in ('indexed', 'blocked-pii'))::int as indexed
      from document_page_states where document_id = d.id
    ) ps on true
    where d.workspace_id = ${workspaceId}
      and d.status = 'completed' and d.superseded_at is null
      and d.indexing_mode <> 'full'
      ${documentIds ? sql`and d.id = any(${documentIds})` : sql``}
    order by d.created_at, d.id
  `;
}

/** `estimatedCredits` is null (and `billing` is "disabled") on deployments that do not bill. */
export type ModeEstimate = {
  pages: number;
  estimatedCredits: number | null;
  billing: "enforced" | "disabled";
  job: "none" | "full-index" | "build-maps" | "embed-pages";
};

/** Credits as a price only where billing is enforced. */
export function priceOrNull(credits: number, env: Record<string, string | undefined> = process.env): number | null {
  return isBillingEnforced(env) ? credits : null;
}

function billingMode(): ModeEstimate["billing"] {
  return isBillingEnforced() ? "enforced" : "disabled";
}

export async function estimateModeSwitch(
  workspaceId: string,
  to: IndexingMode,
): Promise<ModeEstimate> {
  const [ws] = await sql<{ pipeline: PipelineFeatures | null }[]>`select pipeline from workspaces where id = ${workspaceId}`;
  const route = ws?.pipeline?.visualPages?.route ?? "auto";
  const from = effectiveIndexingMode(ws?.pipeline?.indexingMode);
  if (from === to || !deferredProfilesEnabled()) return { pages: 0, estimatedCredits: priceOrNull(0), billing: billingMode(), job: "none" };
  if (to === "full") {
    const pages = (await unindexedPages(workspaceId)).reduce((sum, row) => sum + row.unindexed, 0);
    return { pages, estimatedCredits: priceOrNull(round(pages * fullIndexCreditsPerPage())), billing: billingMode(), job: pages > 0 ? "full-index" : "none" };
  }
  if (from === "full") return { pages: 0, estimatedCredits: priceOrNull(0), billing: billingMode(), job: "none" };
  const [row] = await sql<PageCountRow[]>`
    select coalesce(sum(d.page_count), 0)::int as pages, count(*)::int as documents
    from documents d
    where d.workspace_id = ${workspaceId} and d.status = 'completed' and d.superseded_at is null
      and d.indexing_mode <> 'full'
      ${to === "visual"
        ? sql`and d.page_count > (select count(*) from document_page_states s where s.document_id = d.id and s.embedded_at is not null)`
        : sql`and not exists (select 1 from document_maps m where m.document_id = d.id)`}
  `;
  const pages = row?.pages ?? 0;
  // Page-image embedding is the expensive pass: estimate it with the embedder the workspace's route resolves to (private Jina at its token price, else Gemini list price plus markup) so
  // the confirmation shows a real number. Mapping is priced by usage events (fees default to 0).
  const estimatedCredits = priceOrNull(to === "visual" ? round(estimatePageEmbedCredits(pages, route)) : 0);
  return { pages, estimatedCredits, billing: billingMode(), job: pages > 0 ? (to === "visual" ? "embed-pages" : "build-maps") : "none" };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

type SourceDoc = {
  id: string; org_id: string; user_id: string; workspace_id: string; filename: string; mime_type: string;
  source_key: string; extraction_mode: string; page_count: number; canonical_id: string | null;
  version_number: number | null; source_sha256: string | null; run_id: string;
};

/** Documents one switch or full-index request may fan out to; larger corpora go in batches. */
export const MAX_DOCUMENTS_PER_INDEX_REQUEST = 500;

/** One queued run: a new version of each document, in `mode`. */
type RunBatch = { docs: SourceDoc[]; pipeline: PipelineFeatures; mode: IndexingMode; partial: boolean };

/** Prepared (validated, not yet admitted) jobs; commit creates all runs in one transaction. */
export type PreparedIndexJobs = { orgId: string; workspaceId: string; batches: RunBatch[]; pages: number };

type Client = Pick<typeof sql, never> & ((strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<any[]>);

/** Source documents that already have a queued or processing backfill of the same shape. */
async function inFlightSourceIds(client: Client, workspaceId: string, ids: string[], stageSubset: string[] | null): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await client`
    select d.previous_version_id as id
    from documents d
    join workspace_runs r on r.id = d.run_id
    where r.workspace_id = ${workspaceId} and r.kind = 'full-index' and r.status in ('queued', 'processing')
      and d.previous_version_id = any(${ids})
      and coalesce(r.pipeline -> 'stageSubset', 'null'::jsonb)::text = ${JSON.stringify(stageSubset)}
  `) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

async function liveDocs(workspaceId: string, ids: string[]): Promise<SourceDoc[]> {
  if (ids.length === 0) return [];
  return await sql<SourceDoc[]>`
    select d.id, d.org_id, d.user_id, d.workspace_id, d.filename, d.mime_type, d.source_key, d.extraction_mode,
      d.page_count, d.canonical_id, d.version_number, d.source_sha256, d.run_id
    from documents d where d.workspace_id = ${workspaceId} and d.id = any(${ids})
    order by d.created_at, d.id
  `;
}

function assertDocumentCap(count: number): void {
  if (count > MAX_DOCUMENTS_PER_INDEX_REQUEST) {
    throw new IndexingModeError(
      `This affects ${count} documents; at most ${MAX_DOCUMENTS_PER_INDEX_REQUEST} per request. ` +
        "Use the workspace full-index endpoint with documentIds in batches.",
      413,
      "too_many_documents",
    );
  }
}

/**
 * Reprocess validation for partial backfills (4xx instead of a worker failure). Batches that run the same
 * stages are validated together, so a switch over N documents costs two queries, not two per document.
 */
async function validateBatches(batches: RunBatch[]): Promise<void> {
  const byPipeline = new Map<string, { pipeline: PipelineFeatures; byRun: Map<string, string[]> }>();
  for (const batch of batches) {
    if (!batch.partial) continue;
    const key = JSON.stringify(batch.pipeline);
    const entry = byPipeline.get(key) ?? { pipeline: batch.pipeline, byRun: new Map<string, string[]>() };
    for (const doc of batch.docs) entry.byRun.set(doc.run_id, [...(entry.byRun.get(doc.run_id) ?? []), doc.id]);
    byPipeline.set(key, entry);
  }
  for (const { pipeline, byRun } of byPipeline.values()) {
    try {
      await assertBackfillReusableMany([...byRun].map(([runId, documentIds]) => ({ runId, documentIds })), pipeline);
    } catch (error) {
      if (isReprocessRejectedError(error)) {
        throw new IndexingModeError(error.message, error.statusCode === 400 ? 400 : 409, "backfill_not_possible");
      }
      throw error;
    }
  }
}

/**
 * Creates every batch as a queued reprocess run in one transaction under a
 * per-workspace lock, re-checking in-flight work inside it so concurrent or
 * repeated requests cannot double-spend. All-or-nothing.
 */
export async function commitIndexJobs(prepared: PreparedIndexJobs, userId: string): Promise<{ runIds: string[]; pipelines: Map<string, PipelineFeatures> }> {
  const result = { runIds: [] as string[], pipelines: new Map<string, PipelineFeatures>() };
  if (prepared.batches.length === 0) return result;
  await enforceLiveBudgetCaps(prepared.workspaceId, prepared.orgId);
  await admitRunSpend(prepared.orgId, prepared.workspaceId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`full-index:${prepared.workspaceId}`}, 0))`;
    for (const batch of prepared.batches) {
      const stageSubset = batch.pipeline.stageSubset ?? null;
      const busy = await inFlightSourceIds(tx as unknown as Client, prepared.workspaceId, batch.docs.map((doc) => doc.id), stageSubset);
      const docs = batch.docs.filter((doc) => !busy.has(doc.id));
      if (docs.length === 0) continue;
      const runId = randomUUID();
      const pages = docs.reduce((sum, doc) => sum + Math.max(0, doc.page_count ?? 0), 0);
      await tx`
        insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, priority, stage,
          total_documents, processed_documents, pages_total, pages_processed, pipeline,
          creation_ready_at, creation_expires_at)
        -- The documents are inserted in this transaction, so the manifest is complete when it commits.
        values (${runId}, ${prepared.orgId}, ${userId}, ${prepared.workspaceId}, 'full-index', 'queued', 0, 'queued',
          ${docs.length}, 0, ${pages}, 0, ${tx.json(JSON.parse(JSON.stringify(batch.pipeline)))}, now(), null)
      `;
      for (const doc of docs) {
        const canonicalId = doc.canonical_id ?? doc.id;
        const versionNumber = await nextVersionNumber(tx as unknown as typeof sql, prepared.workspaceId, canonicalId);
        await tx`
          insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status,
            extraction_mode, page_count, canonical_id, version_number, previous_version_id, reused_from_document_id,
            source_sha256, indexing_mode, reindex_of)
          values (${randomUUID()}, ${doc.org_id}, ${doc.user_id}, ${doc.workspace_id}, ${runId}, ${doc.filename},
            ${doc.mime_type}, ${doc.source_key}, 'queued', ${doc.extraction_mode}, ${doc.page_count},
            ${canonicalId}, ${versionNumber}, ${doc.id},
            ${batch.partial ? doc.id : null}, ${doc.source_sha256 ?? null}, ${batch.mode}, ${doc.id})
        `;
      }
      result.runIds.push(runId);
      result.pipelines.set(runId, batch.pipeline);
    }
  });
  return result;
}

type FullIndexArgs = {
  orgId: string;
  workspaceId: string;
  documentIds?: string[];
  actor: RequestActor;
  policy: MaterializationPolicy;
};

/** Validates a full-index request and returns the jobs to admit. Throws 4xx. */
export async function prepareFullIndex(args: FullIndexArgs): Promise<PreparedIndexJobs & { unindexedPages: number; estimatedCredits: number | null; billing: ModeEstimate["billing"] }> {
  if (!args.policy.allowFullIndexRequest) {
    throw new IndexingModeError("This key or capability may not request a full index.", 403, "full_index_not_allowed");
  }
  const access = await getWorkspaceAccess(args.workspaceId, args.actor.userId);
  if (!access || !canEditWorkspace(access, args.actor.userId)) {
    throw new IndexingModeError("Workspace not found", 404, "document_not_found");
  }
  const [ws] = await sql<{ pipeline: PipelineFeatures | null }[]>`
    select pipeline from workspaces where id = ${args.workspaceId} and org_id = ${args.orgId}
  `;
  if (!ws) throw new IndexingModeError("Workspace not found", 404, "document_not_found");
  const pending = (await unindexedPages(args.workspaceId, args.documentIds)).filter((row) => row.unindexed > 0);
  if (args.documentIds?.length && pending.length === 0) {
    const known = await liveDocs(args.workspaceId, args.documentIds);
    if (known.length === 0) throw new IndexingModeError("Document not found", 404, "document_not_found");
  }
  if (pending.length === 0) throw new IndexingModeError("Everything is already indexed.", 400, "nothing_to_index");
  const busy = await inFlightSourceIds(sql as unknown as Client, args.workspaceId, pending.map((row) => row.id), null);
  const todo = pending.filter((row) => !busy.has(row.id));
  if (todo.length === 0) throw new IndexingModeError("A full index is already running for these documents.", 409, "index_in_progress");
  assertDocumentCap(todo.length);
  const docs = await liveDocs(args.workspaceId, todo.map((row) => row.id));
  const pipeline = { ...(ws.pipeline as PipelineFeatures), indexingMode: "full" as const };
  const batches: RunBatch[] = [{ docs, pipeline, mode: "full", partial: false }];
  await validateBatches(batches);
  const unindexed = todo.reduce((sum, row) => sum + row.unindexed, 0);
  return {
    orgId: args.orgId, workspaceId: args.workspaceId, batches, pages: unindexed,
    unindexedPages: unindexed, estimatedCredits: priceOrNull(round(unindexed * fullIndexCreditsPerPage())), billing: billingMode(),
  };
}

/**
 * Full index: a reprocess run in `full` mode for documents that still have
 * unindexed pages and no full index already running. Admission is checked
 * first (402 when out of credits).
 */
export async function requestFullIndex(args: FullIndexArgs): Promise<{ runId: string; pages: number; estimatedCredits: number | null; billing: ModeEstimate["billing"]; pipeline: PipelineFeatures }> {
  const prepared = await prepareFullIndex(args);
  const { runIds, pipelines } = await commitIndexJobs(prepared, args.actor.userId);
  const runId = runIds[0];
  if (!runId) throw new IndexingModeError("A full index is already running for these documents.", 409, "index_in_progress");
  return { runId, pages: prepared.pages, estimatedCredits: prepared.estimatedCredits, billing: prepared.billing, pipeline: pipelines.get(runId)! };
}

/** Runs started by a mode switch; the route starts each one in the run lifecycle. */
export type ModeSwitchResult = { runIds: string[]; pipelines: Map<string, PipelineFeatures> };

/**
 * Validates a requested mode before it is saved: visual needs privacy/PII
 * clearance; `full` on a plan that defaults to deferred needs spendable credits.
 * `current` is null when creating a workspace.
 */
export async function validateModeChoice(args: {
  orgId: string;
  workspaceId: string | null;
  currentMode: IndexingMode | null;
  nextPipeline: Pick<PipelineFeatures, "indexingMode" | "privacyMode" | "piiPolicy">;
}): Promise<void> {
  const next = args.nextPipeline.indexingMode;
  if (next === "visual") assertVisualModeAllowed(args.nextPipeline);
  if (next === "full" && args.currentMode !== "full" && deferredProfilesEnabled()) {
    const mode = await defaultIndexingModeForOrg(args.orgId);
    if (mode === "map" && !(await canSpend(args.orgId, args.workspaceId))) {
      throw new IndexingModeError(
        "Full indexing needs credits. Add credits or upgrade your plan.",
        402,
        "credits_required_for_full_index",
      );
    }
  }
}

export async function validateModeSwitch(args: { current: WorkspaceRecord; nextPipeline: PipelineFeatures }): Promise<void> {
  await validateModeChoice({
    orgId: args.current.orgId,
    workspaceId: args.current.id,
    currentMode: args.current.pipeline.indexingMode,
    nextPipeline: args.nextPipeline,
  });
}

/**
 * Computes and validates the jobs a mode change triggers (spec 1.1) without
 * persisting anything, so the route can reject the change before saving it.
 * Throws 4xx when the jobs are impossible or too large.
 */
export async function prepareModeSwitchJobs(args: {
  workspace: WorkspaceRecord;
  to: IndexingMode;
  indexAll: boolean;
  actor: RequestActor;
  policy: MaterializationPolicy;
}): Promise<PreparedIndexJobs> {
  const from = effectiveIndexingMode(args.workspace.pipeline.indexingMode);
  const to = effectiveIndexingMode(args.to);
  const none: PreparedIndexJobs = { orgId: args.workspace.orgId, workspaceId: args.workspace.id, batches: [], pages: 0 };
  if (from === to || from === "full") return none;
  if (to === "full") {
    if (!args.indexAll) return none;
    try {
      const prepared = await prepareFullIndex({
        orgId: args.workspace.orgId, workspaceId: args.workspace.id, actor: args.actor, policy: args.policy,
      });
      return prepared;
    } catch (error) {
      if (error instanceof IndexingModeError && (error.code === "nothing_to_index" || error.code === "index_in_progress")) return none;
      throw error;
    }
  }
  const stage = to === "visual" ? "page-embed" : "document-map";
  const sources = await sql<{ id: string }[]>`
    select id from documents
    where workspace_id = ${args.workspace.id} and status = 'completed' and superseded_at is null and indexing_mode <> 'full'
    order by created_at, id
  `;
  assertDocumentCap(sources.length);
  const busy = await inFlightSourceIds(sql as unknown as Client, args.workspace.id, sources.map((row) => row.id), [stage]);
  const docs = await liveDocs(args.workspace.id, sources.map((row) => row.id).filter((id) => !busy.has(id)));
  const pipeline = { ...args.workspace.pipeline, indexingMode: to, stageSubset: [stage] } as PipelineFeatures;
  const batches = docs.map((doc) => ({ docs: [doc], pipeline, mode: to, partial: true }));
  await validateBatches(batches);
  return { ...none, batches, pages: docs.reduce((sum, doc) => sum + doc.page_count, 0) };
}

/** Prepare and commit in one step (tests and simple callers). */
export async function startModeSwitchJobs(args: {
  before: WorkspaceRecord;
  after: WorkspaceRecord;
  indexAll: boolean;
  actor: RequestActor;
  policy: MaterializationPolicy;
}): Promise<ModeSwitchResult> {
  const prepared = await prepareModeSwitchJobs({
    workspace: args.before, to: args.after.pipeline.indexingMode, indexAll: args.indexAll, actor: args.actor, policy: args.policy,
  });
  return await commitIndexJobs(prepared, args.actor.userId);
}

/** Restores the stored mode when jobs fail after the mode was saved. */
export async function restoreStoredIndexingMode(workspaceId: string, mode: IndexingMode): Promise<void> {
  await sql`
    update workspaces set pipeline = jsonb_set(pipeline, '{indexingMode}', to_jsonb(${mode}::text)), updated_at = now()
    where id = ${workspaceId}
  `;
}

export { SpendBlockedError };


/**
 * Work estimate of a full index over `documentIds` (or every deferred document): the unindexed pages that
 * are not already being indexed, priced with the workspace's full pipeline. The full-index mutation returns
 * this same value as `job.estimate`.
 */
export async function estimateFullIndex(args: {
  workspaceId: string;
  orgId: string;
  documentIds?: string[];
  env?: EstimateEnv;
}): Promise<CostEstimate | null> {
  const [ws] = await sql<{ pipeline: PipelineFeatures | null }[]>`
    select pipeline from workspaces where id = ${args.workspaceId} and org_id = ${args.orgId}
  `;
  if (!ws?.pipeline) return null;
  const pending = (await unindexedPages(args.workspaceId, args.documentIds)).filter((row) => row.unindexed > 0);
  const busy = await inFlightSourceIds(sql as unknown as Client, args.workspaceId, pending.map((row) => row.id), null);
  const todo = pending.filter((row) => !busy.has(row.id));
  const features = { ...ws.pipeline, indexingMode: "full" as const } as PipelineFeatures;
  return await estimateWork({
    features,
    stages: compilePipelinePlan(features).stageOrder,
    documents: todo.length,
    pages: todo.reduce((sum, row) => sum + row.unindexed, 0),
    orgId: args.orgId,
    env: args.env,
  });
}
