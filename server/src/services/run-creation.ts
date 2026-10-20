import { randomUUID } from "node:crypto";

import {
  pageRouterModeSchema,
  stageSelectionKeys,
  withoutStageSelection,
  withPlatformPageRouterMode,
  type DocumentRecord,
  type PipelineFeatures,
  type WorkspaceRun,
} from "@docslurp/shared";

import { sql as defaultSql, type SqlClient } from "../db.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { currentRequestId } from "../lib/request-context.js";
import { getAvailableCredits } from "./billing/credits.js";
import {
  admitRunSpend,
  SpendBlockedError,
  type SpendBlockedCode,
} from "./billing/spend-guard.js";
import { canEditWorkspace, getWorkspaceAccess } from "./organizations.js";
import { attributedUsage } from "./usage-attribution.js";
import { buildRunProcessingPreview } from "./run-processing-preview.js";
import { runLifecycle, type RunLifecycleRun, type RunStartOutcome } from "./run-lifecycle.js";
import { mapDocument, mapWorkspaceRun, type DocumentRow, type WorkspaceRunRow } from "./run-records.js";
import {
  AllSourcesUnreadableError,
  resolveSourceMetadata,
  UnreadableSourceError,
} from "./source-metadata.js";

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
  /** The requester: access is checked against them and the Run belongs to them. */
  userId: string;
  workspaceId: string;
  kind: string;
  pipeline: PipelineFeatures;
  apiKeyId?: string | null;
  priority?: number;
  sources: RunSources;
}

export interface UnreadableSource {
  filename: string;
  sourceKey: string;
  error: UnreadableSourceError;
}

export interface CreatedRun {
  /** Published, with the true document and page totals. */
  run: WorkspaceRun;
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
type SourceDocumentRow = DocumentRow & { file_size: number | string | null; metadata: Record<string, unknown> | null };

// Some drivers hand jsonb back as text; accept both so a copy never double-encodes.
function sourceMetadata(value: unknown): Record<string, never> {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, never>;
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
  workspaceId: string,
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
  // balance goes negative mid-run (docs/pricing-and-credits.md, gotcha 7).

  // Budgets first: summing a month of attributed usage is the most expensive
  // statement on the ingest path (67% of app-database time at 576 slots in the
  // 2026-10-09 load-test re-run), so only sum spend for a cap that exists.
  const [limits] = await sql<
    { workspace_budget_cents: number | null; org_budget_cents: number | null }[]
  >`
    select
      w.monthly_budget_cents as workspace_budget_cents,
      o.monthly_budget_cents as org_budget_cents
    from workspaces w
    join organizations o on o.id = w.org_id
    where w.id = ${workspaceId}
    limit 1
  `;

  if (!limits) {
    throw new Error("Workspace not found");
  }

  const monthSpendCents = async (scope: "workspace" | "org"): Promise<number> => {
    const [row] = await sql<{ spend_cents: number }[]>`
      select coalesce(sum(au.cost_cents), 0)::double precision as spend_cents
      from ${attributedUsage("month")} au
      where ${scope === "workspace" ? sql`au.workspace_id = ${workspaceId}` : sql`au.org_id = ${orgId}`}
    `;
    return Number(row?.spend_cents ?? 0);
  };
  const budget = {
    workspace_budget_cents: limits.workspace_budget_cents,
    workspace_spend_cents: limits.workspace_budget_cents == null ? 0 : await monthSpendCents("workspace"),
    org_budget_cents: limits.org_budget_cents,
    org_spend_cents: limits.org_budget_cents == null ? 0 : await monthSpendCents("org"),
  };

  const workspacePaused =
    budget.workspace_budget_cents != null &&
    budget.workspace_spend_cents >= budget.workspace_budget_cents;
  const orgPaused =
    budget.org_budget_cents != null &&
    budget.org_spend_cents >= budget.org_budget_cents;

  // Write only on a change: every ingest runs this, and the org row is the
  // one every credit debit in the org locks.
  await sql`
    update workspaces
    set budget_paused = ${workspacePaused}, updated_at = now()
    where id = ${workspaceId} and budget_paused is distinct from ${workspacePaused}
  `;
  await sql`
    update organizations
    set budget_paused = ${orgPaused}, updated_at = now()
    where id = ${orgId} and budget_paused is distinct from ${orgPaused}
  `;

  if (workspacePaused) {
    throw new RunCreationBlockedError(
      "This workspace has reached its monthly budget cap and new runs are paused. " +
        "Increase the budget in workspace settings to resume processing.",
      402,
      "workspace_budget_paused",
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

type DedupScope = "workspace" | "org";

type DedupCandidateRow = {
  id: string;
  /** The document whose LanceDB rows the candidate's vectors are (itself unless it is a copy). */
  vector_owner_id: string;
  dedup_scope: DedupScope;
};

async function findDedupCandidate(
  client: SqlClient,
  args: {
    orgId: string;
    workspaceId: string;
    sourceSha256: string;
    runId: string;
  },
): Promise<DedupCandidateRow | null> {
  const [row] = await client<DedupCandidateRow[]>`
    select
      d.id,
      coalesce(d.deduped_from_document_id, d.id) as vector_owner_id,
      case
        when d.workspace_id = ${args.workspaceId} then 'workspace'
        else 'org'
      end as dedup_scope
    from documents d
    join workspace_runs runs on runs.id = d.run_id
    join workspace_runs target_run on target_run.id = ${args.runId}
    where d.org_id = ${args.orgId}
      and d.source_sha256 = ${args.sourceSha256}
      and d.status = 'completed'
      and d.superseded_at is null
      and d.purged_at is null
      and runs.status = 'completed'
      -- Partial-run documents carry full output; compare features, not stage selection.
      and (runs.pipeline - ${client.array([...stageSelectionKeys])}::text[])
        = (target_run.pipeline - ${client.array([...stageSelectionKeys])}::text[])
      and (
        d.workspace_id = ${args.workspaceId}
        or d.org_id = ${args.orgId}
      )
    order by
      case when d.workspace_id = ${args.workspaceId} then 0 else 1 end,
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
      gen_random_uuid()::text,
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
  `;
}


async function lockRunCreation(runId: string, sql: SqlClient): Promise<void> {
  const [run] = await sql<{ id: string }[]>`
    select id from workspace_runs
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
      jsonb_build_object('workspaceId', r.workspace_id), sources.keys, 'run_creation'
    from workspace_runs r
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
  await sql`delete from workspace_runs where id = ${runId}`;
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
      update workspace_runs
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
      select id from workspace_runs where id = ${runId}
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
      select id from workspace_runs
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
  }): Promise<WorkspaceRunRow> {
    const { input } = args;
    const requestId = currentRequestId();
    const [row] = await admitRunSpend(args.orgId, input.workspaceId, (tx) => tx<WorkspaceRunRow[]>`
      with inserted as (
        insert into workspace_runs (
          id, org_id, user_id, workspace_id, kind, status, priority, control_state,
          control_requested_at, stage, total_documents, processed_documents,
          pages_total, pages_processed, stats, creation_source_keys, pipeline
        )
        values (
          ${args.id},
          ${args.orgId},
          ${input.userId},
          ${input.workspaceId},
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
          })},
          ${sql.array(args.sourceKeys)}::text[],
          ${sql.json(JSON.parse(JSON.stringify(args.pipeline)))}
        )
        returning *
      )
      select inserted.*, workspaces.name as workspace_name
      from inserted
      join workspaces on workspaces.id = inserted.workspace_id
    `, { leaseRunId: args.id });
    return row!;
  }

  async function materialiseFiles(
    runId: string,
    orgId: string,
    input: CreateRunInput,
    files: RunSourceFile[],
  ) {
    const documents: DocumentRow[] = [];
    const unreadable: UnreadableSource[] = [];

    for (const file of files) {
      const filename = sanitizeUploadFilename(file.filename);
      const documentId = randomUUID();
      let metadata: Awaited<ReturnType<typeof resolveSourceMetadata>>;
      try {
        metadata = await resolveSourceMetadata({ ...file, filename });
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
        const canonicalId = file.canonicalId ?? null;
        if (canonicalId) {
          await client`select pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${canonicalId}`}, 0))`;
        }
        // Canonical documents version per workspace by logical source; others by filename.
        const [existing] = canonicalId
          ? await client<{ id: string; version_number: number }[]>`
              select id, version_number from documents
              where workspace_id = ${input.workspaceId} and canonical_id = ${canonicalId}
              order by version_number desc, created_at desc
              limit 1
            `
          : await client<{ id: string; version_number: number }[]>`
              select id, version_number from documents
              where org_id = ${orgId} and filename = ${filename}
              order by version_number desc
              limit 1
            `;

        const dedupCandidate = await findDedupCandidate(client, {
          orgId,
          workspaceId: input.workspaceId,
          sourceSha256: metadata.sourceSha256,
          runId,
        });

        const [inserted] = await client<DocumentRow[]>`
          insert into documents (
            id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key,
            status, extraction_mode, page_count, source_sha256,
            deduped_from_document_id, dedup_scope, version_number, previous_version_id,
            canonical_id, file_size, metadata
          )
          values (
            ${documentId},
            ${orgId},
            ${input.userId},
            ${input.workspaceId},
            ${runId},
            ${filename},
            ${file.mimeType},
            ${file.sourceKey},
            'queued',
            'hybrid',
            ${metadata.pageCount},
            ${metadata.sourceSha256},
            -- Point at the vector owner, not an intermediate copy, so purge keeps
            -- the owner's vectors while any copy still uses them.
            ${dedupCandidate?.vector_owner_id ?? null},
            ${dedupCandidate?.dedup_scope ?? null},
            ${existing ? existing.version_number + 1 : 1},
            ${existing?.id ?? null},
            ${canonicalId},
            ${file.fileSize ?? 0},
            ${JSON.stringify({ ...file.metadata, sourceSizeMeasured: file.fileSize !== undefined })}::text::jsonb
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
  ) {
    const documents: DocumentRow[] = [];
    for (const source of sources) {
      const canonicalId = await ensureCanonicalId(sql, source);
      const row = await sql.begin(async (tx) => {
        const client = tx as unknown as SqlClient;
        await lockRunCreation(runId, client);
        await client`select pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${canonicalId}`}, 0))`;
        // The new version follows the latest in the lineage, whichever version was selected.
        const [latest] = await client<{ id: string; version_number: number }[]>`
          select id, version_number from documents
          where workspace_id = ${input.workspaceId} and canonical_id = ${canonicalId}
          order by version_number desc, created_at desc
          limit 1
        `;
        const [inserted] = await client<DocumentRow[]>`
          insert into documents (
            id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key,
            status, extraction_mode, page_count, file_size, source_sha256,
            canonical_id, version_number, previous_version_id, reused_from_document_id, metadata
          )
          values (
            ${randomUUID()},
            ${source.org_id},
            ${input.userId},
            ${source.workspace_id},
            ${runId},
            ${source.filename},
            ${source.mime_type},
            ${source.source_key},
            'queued',
            ${source.extraction_mode},
            -- Stages size their work from page_count (the worker never rewrites it), so keep the source's.
            ${source.page_count ?? 0},
            ${Number(source.file_size ?? 0) || 0},
            ${source.source_sha256 ?? null},
            ${canonicalId},
            ${(latest?.version_number ?? source.version_number ?? 1) + 1},
            ${latest?.id ?? source.id},
            ${reuse ? source.id : null},
            ${sql.json(sourceMetadata(source.metadata))}
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
        update workspace_runs
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

  async function create(input: CreateRunInput): Promise<CreatedRun> {
    const access = await getWorkspaceAccess(input.workspaceId, input.userId);
    if (!access) throw new Error("Workspace not found");
    if (!canEditWorkspace(access, input.userId)) throw new Error("Forbidden");

    const { sources } = input;
    let sourceDocuments: SourceDocumentRow[] = [];
    if (sources.kind === "versionsOf") {
      sourceDocuments = await sql<SourceDocumentRow[]>`
        select * from documents
        where workspace_id = ${input.workspaceId} and id = any(${sql.array(sources.documentIds)})
        order by created_at, id
      `;
      if (sourceDocuments.length === 0) throw new Error("No documents to create new versions of");
    }

    // One admission path for every caller: credit floor, live budget caps, then
    // the reserved insert.
    await assertCreditFloor(access.orgId);
    await enforceLiveBudgetCaps(input.workspaceId, access.orgId);

    const runId = randomUUID();
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

    const published = await prepareAndPublish(runId, async () => {
      const materialised = sources.kind === "files"
        ? await materialiseFiles(runId, access.orgId, input, sources.files)
        : await materialiseVersions(runId, input, sourceDocuments, reuse);
      return materialised;
    });

    const run = mapWorkspaceRun(row);
    run.totalDocuments = published.documents.length;
    run.pagesTotal = published.pagesTotal;
    run.costForecast = buildRunProcessingPreview({
      request: {
        workspaceId: input.workspaceId,
        pipeline: input.pipeline,
        files: Array.from({ length: published.documents.length }, (_, index) => ({
          filename: `document-${index + 1}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 900_000,
        })),
        urls: [],
      },
    }).current.estimatedCost;

    // The Run is committed from here on: failing the request now would leave a
    // Run the caller never learns about, so a start failure defers instead.
    // Run-start recovery (or the stale-queued sweep) starts it later.
    let deferredReason: string | null = null;
    try {
      const outcome = await start({ id: run.id, pipeline: run.pipeline });
      if (outcome.status === "deferred") deferredReason = outcome.reason;
    } catch (error) {
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
