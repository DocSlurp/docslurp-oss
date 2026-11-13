import { randomUUID } from "node:crypto";

import {
  assertPipelineSpeedBoost,
  countedPagesForForecast,
  documentVersionKey,
  effectiveIndexingMode,
  intakePageCountSource,
  pageRouterModeSchema,
  sanitizeStoredPipeline,
  parseManagedPipelineOverrides,
  resolveManagedPipeline,
  stageSelectionKeys,
  withoutStageSelection,
  withPlatformPageRouterMode,
  type DocumentRecord,
  type IndexingMode,
  type PipelineFeatures,
  type ProjectRun,
} from "@docslurp/shared";

import { sql as defaultSql, type SqlClient } from "../db.js";
import { normalizeUploadPath } from "../lib/canonical-id.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { currentRequestId } from "../lib/request-context.js";
import { getAvailableCredits } from "./billing/credits.js";
import {
  admitRunSpend,
  SpendBlockedError,
  type SpendBlockedCode,
} from "./billing/spend-guard.js";
import { canContributeToProject, getProjectAccess } from "./organizations.js";
import { attributedUsage } from "./usage-attribution.js";
import { buildRunProcessingPreview } from "./run-processing-preview.js";
import { RunPipelineInvalidError, runLifecycle, type RunLifecycleRun, type RunStartOutcome } from "./run-lifecycle.js";
import { mapDocument, mapProjectRun, type DocumentRow, type ProjectRunRow } from "./run-records.js";
import {
  AllSourcesUnreadableError,
  resolveSourceMetadata,
  UnreadableSourceError,
} from "./source-metadata.js";
import { extractNotReprocessable } from "./reprocess-errors.js";
import { assertVisualModeAllowed, IndexingModeError } from "./project-indexing-mode.js";
import { EXTRACT_EXPIRED_MESSAGE, ExtractError } from "./extracts.js";

// Long source preparation renews this lease. Expiry only authorizes cleanup;
// it never authorizes processing. Every document write and publication locks
// the unpublished Run, so a creator that resumes after cleanup is fenced out.
const CREATION_LEASE_MS = 5 * 60_000;
const CREATION_HEARTBEAT_MS = 30_000;

export const RUN_START_FAILED_DEFERRED_MESSAGE =
  "Run created, but processing could not start yet. It will start automatically; no need to upload again.";

/** A stored source file that becomes a new Document. */
export interface RunSourceFile {
  filename: string;
  mimeType: string;
  sourceKey: string;
  fileSize?: number;
  metadata?: Record<string, unknown>;
  canonicalId?: string | null;
  /** Folder path inside the upload; with the filename it is the version key. Empty for single files. */
  path?: string | null;
  tags?: string[];
}

export type RunSources =
  /** Stored files. Unreadable ones are skipped and reported; all-unreadable throws. */
  | { kind: "files"; files: RunSourceFile[] }
  /**
   * Existing Documents to run again as new versions. `reuse` marks the new
   * versions as reusing the source's outputs (partial / stage-subset runs).
   */
  | { kind: "versionsOf"; documentIds: string[]; reuse?: boolean };

export interface CreateRunInput {
  /** Explicit admission opt-in; never inherit this from project or prior-run settings. */
  speedBoost?: boolean;
  /** Internal durable intake identity; never accepted from HTTP input. */
  runId?: string;
  /** The requester: access is checked against them and the Run belongs to them. */
  userId: string;
  projectId: string;
  kind: string;
  pipeline: PipelineFeatures;
  apiKeyId?: string | null;
  priority?: number;
  sources: RunSources;
  /**
   * Extract mode (services/extracts.ts): the run writes every artifact under
   * the extract's storage prefix, its documents never version or deduplicate
   * against other documents, and it is deleted when the extract expires.
   */
  extract?: { id: string; storagePrefix: string };
}

export interface UnreadableSource {
  filename: string;
  sourceKey: string;
  error: UnreadableSourceError;
}

export interface CreatedRun {
  /** Published, with the true document and page totals. */
  run: ProjectRun;
  documents: DocumentRecord[];
  unreadable: UnreadableSource[];
  /** Set when the Run exists but processing has not started yet. */
  deferredReason: string | null;
}

export interface RunCreationDeps {
  sql: SqlClient;
  /** Run lifecycle start; a thrown error is downgraded to a deferred start. */
  start: (run: RunLifecycleRun) => Promise<RunStartOutcome>;
  heartbeatMs?: number;
}

/** Version rows read for `versionsOf` sources. */
type SourceDocumentRow = DocumentRow & { file_size: number | string | null; metadata: Record<string, unknown> | null; file_facts?: unknown };

// Some drivers hand jsonb back as text; accept both so a copy never double-encodes.
function sourceMetadata(value: unknown): Record<string, never> {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, never>;
}

/**
 * `pages` for a forecast file: only a count (the worker's measured billing pages or page count, or intake's count from the bytes of a
 * whole text file or a single-frame image). An assumed count (a PDF's size estimate, the one page intake gives an Office file, a
 * sampled text count) is left out, and the forecast prices that file over its size as a labelled range (countedPagesForForecast).
 */
function forecastPages(doc: { page_count: number; billing_pages?: number | null; page_count_source?: string | null }): { pages?: number } {
  const pages = countedPagesForForecast({ pageCount: doc.page_count, billingPages: doc.billing_pages, pageCountSource: doc.page_count_source });
  return pages === undefined ? {} : { pages };
}

function platformRunPipeline<T extends PipelineFeatures>(pipeline: T): T {
  const parsed = pageRouterModeSchema.safeParse(process.env.PAGE_ROUTER_MODE?.trim().toLowerCase());
  return withPlatformPageRouterMode(pipeline, parsed.success ? parsed.data : "off");
}

const SKIP_RUN_BUDGET_GUARDS_IN_DEV =
  process.env.SKIP_RUN_BUDGET_GUARDS_IN_DEV !== "false";

/** A run blocked by spend admission (402); see billing/spend-guard.ts. */
export class RunCreationBlockedError extends SpendBlockedError {
  constructor(
    message: string,
    _statusCode: 402 = 402,
    code: SpendBlockedCode = "credit_exhausted",
  ) {
    super(message, code);
    this.name = "RunCreationBlockedError";
  }
}

export function isRunCreationBlockedError(
  error: unknown,
): error is SpendBlockedError {
  return error instanceof SpendBlockedError;
}

export async function enforceLiveBudgetCaps(
  projectId: string,
  orgId: string,
): Promise<void> {
  const sql = defaultSql;
  if (
    process.env.NODE_ENV === "development" &&
    SKIP_RUN_BUDGET_GUARDS_IN_DEV
  ) {
    return;
  }

  // Credits are checked atomically when the run row is inserted
  // (admitRunSpend). An admitted run is paused, not failed, once the org
  // balance goes negative mid-run (docs/billing/credits.md, run admission).

  // Budgets first: summing a month of attributed usage is the most expensive
  // statement on the ingest path (67% of app-database time at 576 slots in the
  // 2026-10-09 load-test re-run), so only sum spend for a cap that exists.
  const [limits] = await sql<
    { project_budget_cents: number | null; org_budget_cents: number | null }[]
  >`
    select
      w.monthly_budget_cents as project_budget_cents,
      o.monthly_budget_cents as org_budget_cents
    from projects w
    join organizations o on o.id = w.org_id
    where w.id = ${projectId}
    limit 1
  `;

  if (!limits) {
    throw new Error("Project not found");
  }

  const monthSpendCents = async (scope: "project" | "org"): Promise<number> => {
    const [row] = await sql<{ spend_cents: number }[]>`
      select coalesce(sum(au.cost_cents), 0)::double precision as spend_cents
      from ${attributedUsage("month")} au
      where ${scope === "project" ? sql`au.project_id = ${projectId}` : sql`au.org_id = ${orgId}`}
    `;
    return Number(row?.spend_cents ?? 0);
  };
  const budget = {
    project_budget_cents: limits.project_budget_cents,
    project_spend_cents: limits.project_budget_cents == null ? 0 : await monthSpendCents("project"),
    org_budget_cents: limits.org_budget_cents,
    org_spend_cents: limits.org_budget_cents == null ? 0 : await monthSpendCents("org"),
  };

  const projectPaused =
    budget.project_budget_cents != null &&
    budget.project_spend_cents >= budget.project_budget_cents;
  const orgPaused =
    budget.org_budget_cents != null &&
    budget.org_spend_cents >= budget.org_budget_cents;

  // Write only on a change: every ingest runs this, and the org row is the
  // one every credit debit in the org locks.
  await sql`
    update projects
    set budget_paused = ${projectPaused}, updated_at = now()
    where id = ${projectId} and budget_paused is distinct from ${projectPaused}
  `;
  await sql`
    update organizations
    set budget_paused = ${orgPaused}, updated_at = now()
    where id = ${orgId} and budget_paused is distinct from ${orgPaused}
  `;

  if (projectPaused) {
    throw new RunCreationBlockedError(
      "This project has reached its monthly budget cap and new runs are paused. " +
        "Increase the budget in project settings to resume processing.",
      402,
      "project_budget_paused",
    );
  }

  if (orgPaused) {
    throw new RunCreationBlockedError(
      "This organization has reached its monthly budget cap and new runs are paused. " +
        "Increase the org budget to resume processing.",
      402,
      "org_budget_paused",
    );
  }
}

// Optional floor on available credits (MIN_CREDIT_BALANCE_CENTS, 1 credit = 1
// cent), on top of the always-on "must be positive" gate. Read per call.
async function assertCreditFloor(orgId: string): Promise<void> {
  const floor = Number(process.env.MIN_CREDIT_BALANCE_CENTS ?? "0");
  if (!(floor > 0)) return;
  const { available } = await getAvailableCredits(orgId);
  if (available < floor) {
    throw new RunCreationBlockedError(
      `Insufficient credits. Available: ${available.toFixed(2)} credits ($${(available / 100).toFixed(2)}). ` +
        "Buy credits at /app/billing to continue processing.",
      402,
      "minimum_credit_required",
    );
  }
}

type DedupScope = "project" | "org";

type DedupCandidateRow = {
  id: string;
  /** The document that was embedded (itself unless it is a copy); a new copy points here. */
  vector_owner_id: string;
  /**
   * The owner's LanceDB rows live in the owner's project database. A copy
   * elsewhere cannot share them: its index stage runs and writes its own.
   */
  shares_owner_vectors: boolean;
  dedup_scope: DedupScope;
};

async function findDedupCandidate(
  client: SqlClient,
  args: {
    orgId: string;
    projectId: string;
    sourceSha256: string;
    runId: string;
  },
): Promise<DedupCandidateRow | null> {
  const [row] = await client<DedupCandidateRow[]>`
    select
      d.id,
      coalesce(d.deduped_from_document_id, d.id) as vector_owner_id,
      coalesce(owner.project_id, d.project_id) = ${args.projectId} as shares_owner_vectors,
      case
        when d.project_id = ${args.projectId} then 'project'
        else 'org'
      end as dedup_scope
    from documents d
    left join documents owner on owner.id = d.deduped_from_document_id
    join project_runs runs on runs.id = d.run_id
    join project_runs target_run on target_run.id = ${args.runId}
    where d.org_id = ${args.orgId}
      and d.source_sha256 = ${args.sourceSha256}
      and d.status = 'completed'
      and d.superseded_at is null
      and d.purged_at is null
      and runs.status = 'completed'
      -- Extract documents are deleted when their retention ends; nothing may borrow their artifacts.
      and runs.extract_id is null
      -- Partial-run documents carry full output; compare features, not stage selection.
      and (runs.pipeline - ${client.array([...stageSelectionKeys])}::text[])
        = (target_run.pipeline - ${client.array([...stageSelectionKeys])}::text[])
      and (
        d.project_id = ${args.projectId}
        or d.org_id = ${args.orgId}
      )
      -- A copy in another project than the vector owner is indexed from the
      -- owner's embedding artifact. Pages materialized on demand (deferred
      -- indexing) have vectors outside that artifact, so such a source is
      -- only reused inside its own project.
      and (
        coalesce(owner.project_id, d.project_id) = ${args.projectId}
        or not exists (
          select 1 from document_chunks deferred
          where deferred.document_id = d.id and deferred.id like '%:p%:c%'
        )
      )
    order by
      case when d.project_id = ${args.projectId} then 0 else 1 end,
      d.updated_at desc,
      d.created_at desc
    limit 1
  `;

  return row ?? null;
}

async function seedDeduplicatedDocument(
  client: SqlClient,
  args: {
    sourceDocumentId: string;
    dedupScope: DedupScope;
    /** False: the copy is indexed into its own project's LanceDB database by the worker. */
    sharesOwnerVectors: boolean;
    targetDocumentId: string;
    targetRunId: string;
    targetUserId: string;
  },
): Promise<void> {
  await client`
    insert into document_run_stage_states (
      run_id,
      document_id,
      stage_name,
      status,
      attempts,
      artifact_uri,
      stats,
      error,
      started_at,
      completed_at,
      updated_at
    )
    select
      ${args.targetRunId},
      ${args.targetDocumentId},
      drss.stage_name,
      'completed',
      greatest(drss.attempts, 1),
      drss.artifact_uri,
      coalesce(drss.stats, '{}'::jsonb) || jsonb_build_object(
        'deduplicated', true,
        'dedupScope', ${args.dedupScope}::text,
        'dedupedFromDocumentId', ${args.sourceDocumentId}::text
      ),
      null,
      now(),
      now(),
      now()
    from document_run_stage_states drss
    where drss.document_id = ${args.sourceDocumentId}
      and drss.status = 'completed'
      and drss.stage_name <> 'quarantine'
      and (${args.sharesOwnerVectors}::boolean or drss.stage_name <> 'index')
  `;

  await client`
    insert into document_pages (
      id,
      document_id,
      run_id,
      user_id,
      page_number,
      text,
      token_estimate
    )
    select
      gen_random_uuid()::text,
      ${args.targetDocumentId},
      ${args.targetRunId},
      ${args.targetUserId},
      page_number,
      text,
      token_estimate
    from document_pages
    where document_id = ${args.sourceDocumentId}
  `;

  await client`
    insert into document_chunks (
      id,
      document_id,
      run_id,
      user_id,
      chunk_index,
      text,
      heading_path,
      page_number,
      token_estimate,
      metadata,
      content_hash,
      pipeline_version,
      parent_page_id
    )
    select
      -- The source's id with this document as prefix (<document>-<index>). The
      -- worker rebinds the source's embedding artifact to these chunks by index.
      case when starts_with(chunks.id, ${args.sourceDocumentId}::text)
        then ${args.targetDocumentId}::text || substr(chunks.id, length(${args.sourceDocumentId}::text) + 1)
        else gen_random_uuid()::text
      end,
      ${args.targetDocumentId},
      ${args.targetRunId},
      ${args.targetUserId},
      chunks.chunk_index,
      chunks.text,
      chunks.heading_path,
      chunks.page_number,
      chunks.token_estimate,
      chunks.metadata,
      chunks.content_hash,
      chunks.pipeline_version,
      target_pages.id
    from document_chunks chunks
    left join document_pages source_pages on source_pages.id = chunks.parent_page_id
    left join document_pages target_pages
      on target_pages.document_id = ${args.targetDocumentId}
     and target_pages.page_number = source_pages.page_number
    where chunks.document_id = ${args.sourceDocumentId}
  `;

  await client`
    insert into document_summaries (
      id,
      document_id,
      run_id,
      user_id,
      summary
    )
    select
      gen_random_uuid()::text,
      ${args.targetDocumentId},
      ${args.targetRunId},
      ${args.targetUserId},
      summary
    from document_summaries
    where document_id = ${args.sourceDocumentId}
  `;

  await client`
    insert into document_propositions (
      id,
      document_id,
      run_id,
      user_id,
      chunk_index,
      text,
      source_paragraph,
      token_estimate
    )
    select
      gen_random_uuid()::text,
      ${args.targetDocumentId},
      ${args.targetRunId},
      ${args.targetUserId},
      chunk_index,
      text,
      source_paragraph,
      token_estimate
    from document_propositions
    where document_id = ${args.sourceDocumentId}
  `;

  await client`
    insert into vector_indexes (
      id,
      document_id,
      backend,
      bucket,
      path,
      embedding_model,
      dimension
    )
    select
      gen_random_uuid()::text,
      ${args.targetDocumentId},
      backend,
      bucket,
      path,
      embedding_model,
      dimension
    from vector_indexes
    where document_id = ${args.sourceDocumentId}
      and ${args.sharesOwnerVectors}::boolean
  `;
}


async function lockRunCreation(runId: string, sql: SqlClient): Promise<void> {
  const [run] = await sql<{ id: string }[]>`
    select id from project_runs
    where id = ${runId} and creation_ready_at is null and status = 'queued'
      and workflow_started_at is null
    for update
  `;
  if (!run) throw new Error(`Run ${runId} is no longer being created`);
}

// Sources are registered with the initial Run insert, including files whose
// preparation never made a Document. New versions borrow sources and register
// none. Queue only keys with no remaining Document reference.
async function enqueueUnmaterializedSources(runId: string, sql: SqlClient): Promise<void> {
  await sql`
    insert into storage_cleanup_queue (kind, org_id, target, payload, artifact_uris, reason)
    select 'storage_prefix', r.org_id, r.user_id || '/' || r.id || '/',
      jsonb_build_object('projectId', r.project_id), sources.keys, 'run_creation'
    from project_runs r
    cross join lateral (
      select array_agg(distinct key) as keys
      from unnest(r.creation_source_keys) as source(key)
      where not exists (select 1 from documents d where d.source_key = source.key)
    ) sources
    where r.id = ${runId} and cardinality(sources.keys) > 0
    on conflict (kind, target) do update
    set artifact_uris = array(select distinct unnest(storage_cleanup_queue.artifact_uris || excluded.artifact_uris))
  `;
}

async function deleteRunCreation(runId: string, sql: SqlClient): Promise<void> {
  await sql`delete from documents where run_id = ${runId}`;
  await enqueueUnmaterializedSources(runId, sql);
  await sql`delete from project_runs where id = ${runId}`;
}

/** Publish only a fully materialized manifest, with its final document/page totals. */
async function publishRunCreation(
  runId: string,
  totalDocuments: number,
  sql: SqlClient,
): Promise<{ pagesTotal: number }> {
  return await sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    await lockRunCreation(runId, client);
    const [manifest] = await client<{ count: number; pages: number }[]>`
      select count(*)::int as count, coalesce(sum(page_count), 0)::int as pages
      from documents where run_id = ${runId}
    `;
    if (manifest?.count !== totalDocuments) {
      throw new Error(`Run ${runId} has an incomplete manifest: expected ${totalDocuments}, found ${manifest?.count ?? 0}`);
    }
    await client`
      update project_runs
      set total_documents = ${totalDocuments}, pages_total = ${manifest.pages},
          creation_ready_at = now(), creation_expires_at = null, creation_source_keys = '{}', updated_at = now()
      where id = ${runId}
    `;
    return { pagesTotal: manifest.pages };
  });
}

/** Published Runs belong to processing and must never be discarded by creation cleanup. */
export async function discardUnstartedRun(runId: string, sql: SqlClient = defaultSql): Promise<boolean> {
  return await sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    const [locked] = await client<{ id: string }[]>`
      select id from project_runs where id = ${runId}
        and creation_ready_at is null and workflow_started_at is null for update
    `;
    if (!locked) return false;
    await deleteRunCreation(runId, client);
    return true;
  });
}

/** Crash/restart backstop. Existing deletion triggers enqueue source/artifact cleanup. */
export async function sweepInterruptedRunCreations(sql: SqlClient = defaultSql, limit = 25): Promise<number> {
  return await sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    const rows = await client<{ id: string }[]>`
      select id from project_runs
      where creation_ready_at is null and workflow_started_at is null
        and creation_expires_at <= now()
      order by creation_expires_at asc limit ${limit} for update skip locked
    `;
    for (const row of rows) {
      await deleteRunCreation(row.id, client);
    }
    return rows.length;
  });
}

/**
 * A new version of a Document supersedes the old one on completion, so every
 * source needs a canonical ID. Documents uploaded without one get one derived
 * from their own ID.
 */
async function ensureCanonicalId(
  sql: SqlClient,
  doc: { id: string; canonical_id?: string | null },
): Promise<string> {
  if (doc.canonical_id) return doc.canonical_id;
  const canonicalId = `docslurp:document:${doc.id}`;
  const [row] = await sql<{ canonical_id: string }[]>`
    update documents set canonical_id = coalesce(canonical_id, ${canonicalId})
    where id = ${doc.id}
    returning canonical_id
  `;
  return row?.canonical_id ?? canonicalId;
}

/**
 * Run creation: admit, materialise, publish and start a Run as one step. A Run
 * is either fully created (published, then started or deferred) or it does not
 * exist. Callers describe sources; they never write Documents themselves.
 */
export function createRunCreation(deps: RunCreationDeps) {
  const { sql, start } = deps;

  async function insertRun(args: {
    id: string;
    orgId: string;
    input: CreateRunInput;
    totalDocuments: number;
    sourceKeys: string[];
    pipeline: PipelineFeatures;
  }): Promise<ProjectRunRow> {
    const { input } = args;
    const requestId = currentRequestId();
    const [row] = await admitRunSpend(args.orgId, input.projectId, async (tx) => {
      if (input.extract) {
        // Never a run for an extract that expired or was deleted meanwhile (a confirm racing the sweep).
        const [live] = await tx`select id from extracts where id = ${input.extract.id} and state = 'active' and expires_at > now() for update`;
        if (!live) throw new ExtractError(410, "extract_expired", EXTRACT_EXPIRED_MESSAGE);
      }
      const rows = await tx<ProjectRunRow[]>`
      with inserted as (
        insert into project_runs (
          id, org_id, user_id, project_id, kind, status, priority, control_state,
          control_requested_at, stage, total_documents, processed_documents,
          pages_total, pages_processed, stats, creation_source_keys, pipeline,
          extract_id, storage_prefix
        )
        values (
          ${args.id},
          ${args.orgId},
          ${input.userId},
          ${input.projectId},
          ${input.kind},
          'queued',
          ${input.priority ?? 0},
          null,
          null,
          'queued',
          ${args.totalDocuments},
          0,
          0,
          0,
          ${sql.json({
            ...(requestId ? { requestId } : {}),
            ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
            ...(input.extract ? { product: "extract", extractId: input.extract.id } : {}),
          })},
          ${sql.array(args.sourceKeys)}::text[],
          ${sql.json(JSON.parse(JSON.stringify(args.pipeline)))},
          ${input.extract?.id ?? null},
          ${input.extract?.storagePrefix ?? null}
        )
        returning *
      )
      select inserted.*, projects.name as project_name
      from inserted
      join projects on projects.id = inserted.project_id
    `;
      // The extract learns its run in the same transaction, so a failure after commit never orphans the run.
      if (input.extract) await tx`update extracts set run_id = ${args.id}, updated_at = now() where id = ${input.extract.id} and (run_id is null or run_id = ${args.id})`;
      return rows;
    }, { leaseRunId: args.id, speedBoost: args.pipeline.speedBoost });
    return row!;
  }

  async function materialiseFiles(
    runId: string,
    orgId: string,
    input: CreateRunInput,
    files: RunSourceFile[],
    indexingMode: IndexingMode,
  ) {
    const documents: DocumentRow[] = [];
    const unreadable: UnreadableSource[] = [];

    for (const file of files) {
      const filename = sanitizeUploadFilename(file.filename);
      const sourcePath = normalizeUploadPath(file.path);
      const documentId = randomUUID();
      let metadata: Awaited<ReturnType<typeof resolveSourceMetadata>>;
      try {
        metadata = await resolveSourceMetadata({ ...file, filename }, { userId: input.userId, orgId, projectId: input.projectId, runId, apiKeyId: input.apiKeyId });
      } catch (error) {
        if (error instanceof UnreadableSourceError) {
          unreadable.push({ sourceKey: file.sourceKey, filename, error });
          continue;
        }
        throw error;
      }

      const row = await sql.begin(async (tx) => {
        const client = tx as unknown as SqlClient;

        await lockRunCreation(runId, client);
        // Every upload has a version key: the caller's canonicalId, else project + folder path + filename.
        // Versions chain per (project_id, canonical_id) (documents_project_canonical_idx).
        // An extract document has its own key: it must never supersede (or be
        // superseded by) a kept document, which its expiry would then delete.
        const canonicalId = input.extract
          ? `docslurp:extract:${input.extract.id}:${documentId}`
          : documentVersionKey({
            projectId: input.projectId,
            path: sourcePath,
            filename,
            canonicalId: file.canonicalId,
          });
        await client`select pg_advisory_xact_lock(hashtextextended(${`${input.projectId}:${canonicalId}`}, 0))`;
        const [existing] = input.extract ? [] : await client<{ id: string; version_number: number }[]>`
          select id, version_number from documents
          where project_id = ${input.projectId} and canonical_id = ${canonicalId}
          order by version_number desc, created_at desc
          limit 1
        `;

        // Extract documents keep their own artifacts under the extract prefix, so they never reuse another document's.
        const dedupCandidate = input.extract ? null : await findDedupCandidate(client, {
          orgId,
          projectId: input.projectId,
          sourceSha256: metadata.sourceSha256,
          runId,
        });

        const [inserted] = await client<DocumentRow[]>`
          insert into documents (
            id, org_id, user_id, project_id, run_id, filename, mime_type, source_key,
            status, extraction_mode, page_count, page_count_source, source_sha256, file_facts,
            deduped_from_document_id, dedup_scope, version_number, previous_version_id,
            canonical_id, source_path, file_size, metadata, indexing_mode
          )
          values (
            ${documentId},
            ${orgId},
            ${input.userId},
            ${input.projectId},
            ${runId},
            ${filename},
            -- The type the bytes were sniffed as (intake's one decision); the declared type is kept in file_facts.
            ${metadata.fileFacts.mimeType},
            ${file.sourceKey},
            'queued',
            'hybrid',
            ${metadata.pageCount},
            -- Counted only on evidence from the bytes (the text rule over the whole text, a sniffed single-frame image); a PDF's
            -- size estimate, a sampled text count and a format only the worker counts are assumed.
            ${intakePageCountSource(metadata.pageEvidence)},
            ${metadata.sourceSha256},
            ${sql.json(JSON.parse(JSON.stringify(metadata.fileFacts)))},
            -- Point at the vector owner, not an intermediate copy, so purge keeps
            -- the owner's vectors while any copy still uses them.
            ${dedupCandidate?.vector_owner_id ?? null},
            ${dedupCandidate?.dedup_scope ?? null},
            ${existing ? existing.version_number + 1 : 1},
            ${existing?.id ?? null},
            ${canonicalId},
            ${sourcePath},
            ${file.fileSize ?? 0},
            ${JSON.stringify({ ...file.metadata, sourceSizeMeasured: file.fileSize !== undefined })}::text::jsonb,
            ${indexingMode}
          )
          returning *
        `;

        for (const tag of file.tags ?? []) {
          await client`insert into document_tags (document_id, user_id, tag)
            values (${documentId}, ${input.userId}, ${tag}) on conflict do nothing`;
        }

        if (dedupCandidate) {
          await seedDeduplicatedDocument(client, {
            sourceDocumentId: dedupCandidate.id,
            dedupScope: dedupCandidate.dedup_scope,
            sharesOwnerVectors: dedupCandidate.shares_owner_vectors,
            targetDocumentId: documentId,
            targetRunId: runId,
            targetUserId: input.userId,
          });
        }

        return { ...inserted!, tags: file.tags ?? [] };
      });
      documents.push(row);
    }

    if (unreadable.length > 0 && documents.length === 0) {
      throw new AllSourcesUnreadableError(unreadable.map((file) => file.error));
    }
    return { documents, unreadable };
  }

  async function materialiseVersions(
    runId: string,
    input: CreateRunInput,
    sources: SourceDocumentRow[],
    reuse: boolean,
    indexingMode: IndexingMode,
  ) {
    const documents: DocumentRow[] = [];
    for (const source of sources) {
      const canonicalId = await ensureCanonicalId(sql, source);
      const row = await sql.begin(async (tx) => {
        const client = tx as unknown as SqlClient;
        await lockRunCreation(runId, client);
        await client`select pg_advisory_xact_lock(hashtextextended(${`${input.projectId}:${canonicalId}`}, 0))`;
        // The new version follows the latest in the lineage, whichever version was selected.
        const [latest] = await client<{ id: string; version_number: number }[]>`
          select id, version_number from documents
          where project_id = ${input.projectId} and canonical_id = ${canonicalId}
          order by version_number desc, created_at desc
          limit 1
        `;
        const [inserted] = await client<DocumentRow[]>`
          insert into documents (
            id, org_id, user_id, project_id, run_id, filename, mime_type, source_key,
            status, extraction_mode, page_count, page_count_source, billing_pages, billing_pages_method, file_size, source_sha256, file_facts,
            canonical_id, version_number, previous_version_id, reused_from_document_id, metadata, indexing_mode
          )
          values (
            ${randomUUID()},
            ${source.org_id},
            ${input.userId},
            ${source.project_id},
            ${runId},
            ${source.filename},
            ${source.mime_type},
            ${source.source_key},
            'queued',
            ${source.extraction_mode},
            -- A new version starts from the source's page_count; the worker re-counts Office and EPUB pages after conversion.
            ${source.page_count ?? 0},
            ${source.page_count_source ?? "assumed"},
            -- The source's measured count bills the new version until the worker measures it again; a run that reuses the
            -- conversion stage never does, and without it a 300-page DOCX would bill as one page.
            ${source.billing_pages ?? null},
            ${source.billing_pages_method ?? null},
            ${Number(source.file_size ?? 0) || 0},
            ${source.source_sha256 ?? null},
            ${source.file_facts ? sql.json(source.file_facts as never) : null},
            ${canonicalId},
            ${(latest?.version_number ?? source.version_number ?? 1) + 1},
            ${latest?.id ?? source.id},
            ${reuse ? source.id : null},
            ${sql.json(sourceMetadata(source.metadata))},
            -- The Run's pipeline decides how the new version indexes.
            ${indexingMode}
          )
          returning *
        `;
        await client`insert into document_tags (document_id, user_id, tag)
          select ${inserted!.id}, ${input.userId}, tag from document_tags where document_id = ${source.id}
          on conflict do nothing`;
        const tags = await client<{ tag: string }[]>`select tag from document_tags where document_id = ${inserted!.id} order by tag`;
        return { ...inserted!, tags: tags.map((row) => row.tag) };
      });
      documents.push(row);
    }
    return { documents, unreadable: [] as UnreadableSource[] };
  }

  /** Keep slow preparation alive, publish on success, and discard partial work on failure. */
  async function prepareAndPublish<T extends { documents: unknown[] }>(
    runId: string,
    prepare: () => Promise<T>,
  ): Promise<T & { pagesTotal: number }> {
    let heartbeat: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = sql`
        update project_runs
        set creation_expires_at = now() + (${CREATION_LEASE_MS} * interval '1 millisecond')
        where id = ${runId} and creation_ready_at is null
      `.catch((error: unknown) => {
        console.warn(`[run-creation] lease renewal failed run=${runId}:`, error);
      }).finally(() => { heartbeat = undefined; });
    }, deps.heartbeatMs ?? CREATION_HEARTBEAT_MS);
    timer.unref();
    try {
      const prepared = await prepare();
      const { pagesTotal } = await publishRunCreation(runId, prepared.documents.length, sql);
      return { ...prepared, pagesTotal };
    } catch (error) {
      await discardUnstartedRun(runId, sql).catch((cleanupError: unknown) => {
        console.error(`[run-creation] could not discard run=${runId}:`, cleanupError);
      });
      throw error;
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
  }

  async function create(request: CreateRunInput): Promise<CreatedRun> {
    // Callers often pass a stored project or run pipeline (reprocess, bulk reprocess, full index, connectors).
    // Extractor settings the strict schemas now reject are dropped here, before anything is written, so the
    // Run row never carries them (a Dolphin repoPath, an unknown extractor id). Request schemas stay strict.
    const requestedPipeline = { ...request.pipeline, speedBoost: request.speedBoost === true };
    assertPipelineSpeedBoost(requestedPipeline);
    const source = `run creation in project ${request.projectId}`;
    // Every run-creation path lands here (upload, extract, MCP, reprocess, bulk reprocess, retry-as-new, materialize,
    // re-index, full index, config change), and callers often pass an old run snapshot. Model values in it are history,
    // never configuration: they are dropped and the project's explicit admin overrides and current defaults apply
    // (managed-pipeline-models.ts). Run-specific fields (speedBoost, indexingMode, stage selection) are kept.
    const [managedRow] = await sql<{ managed: unknown }[]>`select managed_models -> 'pipeline' as managed from projects where id = ${request.projectId}`;
    const managed = resolveManagedPipeline(
      sanitizeStoredPipeline(requestedPipeline, source),
      parseManagedPipelineOverrides(managedRow?.managed, `project ${request.projectId}`),
      source,
    );
    const input: CreateRunInput = { ...request, pipeline: { ...managed.pipeline, speedBoost: request.speedBoost === true } };
    assertPipelineSpeedBoost(input.pipeline);
    const access = await getProjectAccess(input.projectId, input.userId);
    if (!access) throw new Error("Project not found");
    if (!canContributeToProject(access, input.userId)) throw new Error("Forbidden");
    // Every caller (upload, extract, MCP, reprocess) lands here: a run pipeline that combines visual indexing
    // with Fast (or a refused privacy/PII policy) is refused whatever the project or request says
    // (IndexingModeError visual_mode_quality / visual_mode_privacy, 400).
    if (effectiveIndexingMode(input.pipeline.indexingMode) === "visual") assertVisualModeAllowed(input.pipeline);

    const { sources } = input;
    let sourceDocuments: SourceDocumentRow[] = [];
    if (sources.kind === "versionsOf") {
      sourceDocuments = await sql<SourceDocumentRow[]>`
        select d.* from documents d
        where d.project_id = ${input.projectId} and d.id = any(${sql.array(sources.documentIds)})
        order by d.created_at, d.id
      `;
      // Extract documents are never run again: a new version would outlive the
      // extract while pointing at sources and artifacts its expiry deletes.
      const [extractSource] = await sql<{ id: string }[]>`
        select d.id from documents d join project_runs r on r.id = d.run_id
        where d.id = any(${sql.array(sourceDocuments.map((doc) => doc.id))}) and r.extract_id is not null
        limit 1
      `;
      if (extractSource) throw extractNotReprocessable();
      if (sourceDocuments.length === 0) throw new Error("No documents to create new versions of");
    }

    // One admission path for every caller: credit floor, live budget caps, then
    // the reserved insert.
    await assertCreditFloor(access.orgId);
    await enforceLiveBudgetCaps(input.projectId, access.orgId);

    // Validated before the insert: a pipeline the preview schema rejects must fail the request with nothing
    // committed, not after the Run and its document versions exist (an orphan run recovery would retry forever).
    // The forecast prices the files and pages the run actually has (counted pages where known, sizes otherwise), not placeholders.
    type ForecastFile = { filename: string; mimeType: string; sizeBytes: number; pages?: number };
    const costForecastFor = (files: ForecastFile[]) => buildRunProcessingPreview({
      request: { project: input.projectId, pipeline: input.pipeline, files, urls: [] },
    }).current.estimatedCost;
    const forecastFilesOfSources = (): ForecastFile[] => sources.kind === "files"
      ? sources.files.map((file) => ({ filename: file.filename, mimeType: file.mimeType, sizeBytes: Math.max(0, Math.round(file.fileSize ?? 0)) }))
      : sourceDocuments.map((doc) => ({
        filename: doc.filename,
        mimeType: doc.mime_type,
        sizeBytes: Math.max(0, Math.round(Number(doc.file_size) || 0)),
        ...forecastPages(doc),
      }));
    // The preview schema needs at least one file; with none (an empty run) the call only validates the pipeline.
    const validationFiles = forecastFilesOfSources();
    costForecastFor(validationFiles.length > 0 ? validationFiles : [{ filename: "validation.pdf", mimeType: "application/pdf", sizeBytes: 1, pages: 1 }]);

    const runId = input.runId ?? randomUUID();
    const reuse = sources.kind === "versionsOf" && sources.reuse === true;
    const row = await insertRun({
      id: runId,
      orgId: access.orgId,
      input,
      totalDocuments: sources.kind === "files" ? sources.files.length : sourceDocuments.length,
      sourceKeys: sources.kind === "files" ? sources.files.map((file) => file.sourceKey) : [],
      // New files always run every enabled stage; a caller re-running existing
      // Documents chooses its own stage selection.
      pipeline: platformRunPipeline(sources.kind === "files" ? withoutStageSelection(input.pipeline) : input.pipeline),
    });

    // Stamped on every Document so a later project mode switch never rewrites how it was indexed.
    const indexingMode = effectiveIndexingMode(input.pipeline.indexingMode);
    const published = await prepareAndPublish(runId, async () => {
      const materialised = sources.kind === "files"
        ? await materialiseFiles(runId, access.orgId, input, sources.files, indexingMode)
        : await materialiseVersions(runId, input, sourceDocuments, reuse, indexingMode);
      return materialised;
    });

    const run = mapProjectRun(row);
    run.totalDocuments = published.documents.length;
    run.pagesTotal = published.pagesTotal;
    run.costForecast = costForecastFor(published.documents.map((doc) => ({
      filename: doc.filename,
      mimeType: doc.mime_type,
      sizeBytes: Math.max(0, Math.round(Number((doc as { file_size?: unknown }).file_size) || 0)),
      ...forecastPages(doc),
    })));

    // The Run is committed from here on: failing the request now would leave a
    // Run the caller never learns about, so a start failure defers instead.
    // Run-start recovery (or the stale-queued sweep) starts it later.
    let deferredReason: string | null = null;
    try {
      const outcome = await start({ id: run.id, pipeline: run.pipeline });
      if (outcome.status === "deferred") deferredReason = outcome.reason;
    } catch (error) {
      // A pipeline that does not compile never starts: start() already failed the Run (category invalid_pipeline),
      // so the request fails as invalid input instead of promising a deferred start that will never come.
      if (error instanceof RunPipelineInvalidError) {
        throw new IndexingModeError(
          "The run's pipeline settings are invalid, so it cannot start. Check the pipeline and try again.",
          400,
          "invalid_pipeline",
        );
      }
      console.error(`[run-creation] workflow start failed for run=${run.id}; deferring:`, error instanceof Error ? error.message : String(error));
      deferredReason = RUN_START_FAILED_DEFERRED_MESSAGE;
    }

    return {
      run,
      documents: published.documents.map(mapDocument),
      unreadable: published.unreadable,
      deferredReason,
    };
  }

  return { create };
}

export type RunCreation = ReturnType<typeof createRunCreation>;

export const runCreation: RunCreation = createRunCreation({
  sql: defaultSql,
  start: (run) => runLifecycle.start(run),
});
