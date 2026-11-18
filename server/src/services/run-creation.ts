import { HTTPException } from "hono/http-exception";
import { boundLockWaits, withLockRetry as retryOnLockConflict } from "../lib/lock-retry.js";
import { bindIntakeReceipt } from "./intake-receipt-context.js";
import { randomUUID } from "node:crypto";

import { stampRunModelMode, chartExportModelsAllowed, clampRunLadder, readStoredPipelineSettings, strictestStoredPipelineFeatures, stripLegacyVisionModel, stripManagedPipelineFields, defaultPipelineLadder, effectiveLadder, minChartExportTier, type PipelineLadder, type QualityMode, projectChartExportTierCap, upgradeStoredChartExport, type ChartExportTier, type QualityLevel, type ResolvedChartExportConfig, type RunOrigin, switchDisabled } from "@docslurp/shared";
import { assertChartExportModelsCeiling, BILLED_FEATURES_SCOPE, stampRunChartExport } from "./chart-export-availability.js";
import { resolveRunExtraction } from "./extraction-settings.js";
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
import { isCallerReservedCanonicalId, MAX_CANONICAL_ID_LENGTH, normalizeUploadPath, opaqueCanonicalIdForUrl, RESERVED_CANONICAL_ID_MESSAGE, ReservedCanonicalIdError, tryCanonicalIdForUrl, tryIdentityUrl, tryNormalizedUrl } from "../lib/canonical-id.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { currentRequestApiKeyId, currentRequestId } from "../lib/request-context.js";
import { getAvailableCredits } from "./billing/credits.js";
import {
  admitRunSpend,
  loadSpendStatus,
  assertCanSpend,
  SpendBlockedError,
  type SpendBlockedCode,
} from "./billing/spend-guard.js";
import { canContributeToProject, canEditProject, getProjectAccess, getProjectAccessWithPipeline } from "./organizations.js";
import { EditorRequiredError } from "../lib/editor-required.js";
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
import { storedSummaryTree, withProjectSummaryTree } from "./run-summary-tree.js";
import { withUniqueRedactedFilenames } from "../lib/url-document-identity.js";

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

/** The run's principal no longer permits it, found inside the admission transaction: nothing was reserved or created. */
export class RunAdmissionRefusedError extends Error {
  readonly statusCode = 403;
  constructor() { super("The credential that started this upload no longer permits it"); this.name = "RunAdmissionRefusedError"; }
}

export interface CreateRunInput {
  /**
   * Re-validate the principal at billable admission: inside the admission transaction, after the organization's spend
   * lock is held, the requesting user's access and the API key (live, this organization, `scope`, project allowlist,
   * owner still a member) are read again from rows locked FOR SHARE. A revocation, scope or allowlist change, or a
   * membership removal either commits first and refuses the run (RunAdmissionRefusedError, nothing reserved), or waits
   * for this admission to commit.
   */
  principalAtAdmission?: { scope: string; keyTypes?: readonly string[] };
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
  /**
   * Where the run comes from, derived server-side from the authenticated principal (`runOriginOf`), never from a
   * request field. It decides the chart export tier when neither the request nor the project sets one. Unset: machine.
   */
  origin?: RunOrigin;
  /**
   * The pipeline comes from a run that already resolved its chart export tier (reprocess): a present tier is kept as
   * is instead of being resolved again (`stampRunChartExport` with `stamped`).
   */
  chartExportStamped?: boolean;
  /**
   * The run replays a source run's pipeline (reprocess, bulk reprocess): its stamped chart tier is capped at what the
   * project resolves to now (`projectChartExportTierCap`). `requested` is the request's explicit override, which may
   * raise it and then passes the editor/scope ceiling and spend admission like any override.
   */
  chartExportReplay?: { requested?: ChartExportTier | null; quality?: QualityLevel | null };
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
  // DOCSLURP_DISABLE=router (or `ai`) lowers the platform mode to off (switches only lower).
  return withPlatformPageRouterMode(pipeline, parsed.success && !switchDisabled(process.env, "router") ? parsed.data : "off");
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

// Lock waits, NOWAIT row locks and whole-transaction retry: lib/lock-retry.ts.

/**
 * Run creation could not take its locks in time (a concurrent writer held them):
 * retryable, 503 with Retry-After (an HTTPException, so any route answers it so).
 */
export class RunCreationBusyError extends HTTPException {
  readonly code = "unavailable";
  constructor(message = "These documents are being updated by another request; retry shortly.") {
    super(503, { message, res: new Response(null, { status: 503, headers: { "Retry-After": "2" } }) });
    this.name = "RunCreationBusyError";
  }
}

/** A reprocess source deleted (or moved out of the project) after it was selected: fail closed, 404. */
export class RunSourceGoneError extends HTTPException {
  readonly code = "not_found";
  constructor(documentId: string) {
    super(404, { message: `Document ${documentId} no longer exists in this project` });
    this.name = "RunSourceGoneError";
  }
}

/** Runs one version transaction, retrying the whole of it on lock conflicts (lib/lock-retry.ts). */
function withLockRetry<T>(transaction: () => Promise<T>): Promise<T> {
  return retryOnLockConflict(transaction, () => new RunCreationBusyError());
}

/** A URL ingest item's URL as fetched (identityUrl, exact path); null for every other item. */
function urlIngestIdentity(input: { kind: string }, file: { metadata?: unknown }): string | null {
  const sourceUrl = file.metadata && typeof file.metadata === "object" ? (file.metadata as Record<string, unknown>).sourceUrl : undefined;
  return input.kind === "url-ingest" && typeof sourceUrl === "string" ? tryIdentityUrl(sourceUrl) : null;
}

/**
 * A URL-provenance document's identities: its source URL as fetched
 * (identityUrl, exact path), its opaque ID, and the legacy raw form legacy rows
 * were stored under (the old normalization, used only to find candidates).
 */
export function urlSourceIdentity(metadata: unknown): { identity: string; opaque: string; legacy: string } | null {
  const sourceUrl = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).sourceUrl : undefined;
  if (typeof sourceUrl !== "string") return null;
  const identity = tryIdentityUrl(sourceUrl);
  const normalized = tryNormalizedUrl(sourceUrl);
  if (!identity || !normalized) return null;
  return { identity, opaque: opaqueCanonicalIdForUrl(sourceUrl), legacy: normalized.slice(0, MAX_CANONICAL_ID_LENGTH) };
}

/**
 * URL documents ingested before canonical IDs became opaque store the URL
 * itself (its legacy raw form, canonicalIdForUrl) as their canonical ID; new
 * ingests use `url:<sha256>`. Before a URL document is ingested (or
 * reprocessed) under the server-derived opaque ID, this project's legacy chain
 * of that URL is re-keyed to it, so the version lookup and the supersession
 * trigger (which match canonical_id exactly) treat it as earlier versions.
 * Lazy, per ingest; no migration.
 *
 * Provenance is decided per chain: the rows of this project and organization
 * under the legacy key (found by the old normalization) are adopted when at
 * least one of them was created by a `url-ingest` run (URL intake and crawl; a
 * server-only marker) and its stored `sourceUrl` is the URL being ingested,
 * exactly as fetched (identityUrl: same path, trailing slash included; no
 * 2,048-character cut). Then every row under that key whose stored `sourceUrl`
 * is that URL is adopted, whatever its run kind (a `bulk-reprocess` version copies
 * canonical_id and sourceUrl from its source). A row with another or no
 * `sourceUrl` (a caller's own URL-shaped ID, `/manual/` for `/manual`, a
 * different URL sharing a long prefix) is never touched; nor is a chain without URL-intake provenance.
 * Rows a pre-release build of this change keyed by a hash of the truncated (2,048-character) URL are not
 * adopted either (none were deployed): adoption only finds the raw legacy form.
 *
 * Locking. The caller holds the opaque key's advisory lock (which serializes
 * URL ingests and reprocesses of this URL), taken under a bounded lock_timeout;
 * there is no lock on the legacy key, which would cycle with a worker
 * completing a legacy row (its supersession trigger takes that key while
 * holding the row). Candidate rows are locked FOR UPDATE NOWAIT, newest first
 * (created_at desc, id desc): run creation never waits on a row while holding
 * others, so it cannot cycle with the trigger (completing row, then older rows)
 * or with deletion (children, then the row). A conflict aborts the caller's
 * transaction, which withLockRetry retries whole, releasing every lock, and on
 * exhaustion answers RunCreationBusyError (503, retryable).
 *
 * The UPDATE bumps projection_revision (migration 0109 bumps it on every
 * documents UPDATE, routine status writes included), so a publication in
 * flight for one of these rows fails its compare-and-set, which is intended for
 * a legacy version about to be superseded. If the ingest that adopted the chain
 * then fails, the re-key and its bump stay (C-L2): the rows are still the URL's
 * history, now under its opaque key, and the next ingest continues the chain.
 */
/**
 * The latest version of a chain (by creation, as the supersession trigger orders them) with the next number after
 * the chain's highest, locked FOR KEY SHARE NOWAIT until commit: the new version points at it
 * (previous_version_id, no foreign key), so a deletion of that row (which locks it FOR UPDATE before it rewires its
 * children) waits and then rewires the new version too, never leaving it pointing at a deleted row. Run creation
 * never waits on a row: a conflict aborts the transaction for withLockRetry, and a row deleted between the read and
 * the lock is read again.
 */
async function lockedLatestVersion(
  client: SqlClient,
  args: { projectId: string; orgId?: string; canonicalId: string },
): Promise<{ id: string; next_version: number } | undefined> {
  const org = () => (args.orgId ? client`and org_id = ${args.orgId}` : client``);
  for (let attempt = 0; attempt < 3; attempt++) {
    const [latest] = await client<{ id: string; next_version: number }[]>`
      select id, (select max(version_number) from documents
        where project_id = ${args.projectId} ${org()} and canonical_id = ${args.canonicalId}) + 1 as next_version
      from documents
      where project_id = ${args.projectId} ${org()} and canonical_id = ${args.canonicalId}
      order by created_at desc, id desc
      limit 1
    `;
    if (!latest) return undefined;
    const [held] = await client<{ id: string }[]>`select id from documents where id = ${latest.id} for key share nowait`;
    if (held) return latest;
  }
  throw new RunCreationBusyError();
}

export async function adoptLegacyUrlVersions(
  client: SqlClient,
  args: { projectId: string; orgId: string; canonicalId: string; metadata?: Record<string, unknown> | null },
): Promise<number> {
  const identity = urlSourceIdentity(args.metadata);
  if (!identity || args.canonicalId !== identity.opaque || identity.legacy === args.canonicalId) return 0;
  type Candidate = { id: string; source_url: string | null; run_kind: string | null };
  // The legacy key only finds candidates; provenance is the stored sourceUrl, exactly (no slash folding).
  const provenance = (rows: Candidate[]) => {
    const sameUrl = rows.filter((row) => row.source_url !== null && tryIdentityUrl(row.source_url) === identity.identity);
    return sameUrl.some((row) => row.run_kind === "url-ingest") ? sameUrl : [];
  };
  const candidates = (lock: boolean) => client<Candidate[]>`
    select d.id, d.metadata ->> 'sourceUrl' as source_url, r.kind as run_kind
    from documents d
    left join project_runs r on r.id = d.run_id and r.project_id = d.project_id and r.org_id = d.org_id
    where d.project_id = ${args.projectId} and d.org_id = ${args.orgId} and d.canonical_id = ${identity.legacy}
    order by d.created_at desc, d.id desc
    ${lock ? client`for update of d nowait` : client``}
  `;
  // Most URL ingests have no legacy chain: one unlocked read, and no lock sequence at all.
  if (!provenance(await candidates(false)).length) return 0;
  // NOWAIT: never wait on a row while holding others; a conflict aborts the caller's transaction, which
  // withLockRetry retries whole (releasing every lock first). Provenance is re-checked on the locked rows.
  const sameUrl = provenance(await candidates(true));
  if (!sameUrl.length) return 0;
  const updated = await client<{ id: string }[]>`
    update documents set canonical_id = ${args.canonicalId}, updated_at = now()
    where id = any(${client.array(sameUrl.map((row) => row.id))}) and project_id = ${args.projectId}
      and org_id = ${args.orgId} and canonical_id = ${identity.legacy}
    returning id
  `;
  return updated.length;
}

/**
 * A caller's canonicalId must not be the raw-URL key of a legacy URL-intake chain in the project: written as an
 * upload's key it would join that URL's history (and be adopted with it) before the URL's next ingest re-keys the
 * chain. Refused like the reserved shapes (ReservedCanonicalIdError, 400 canonical_id_reserved). A chain counts when
 * one of its rows came from a `url-ingest` run and its stored sourceUrl maps to exactly that legacy key.
 *
 * The one exemption is a URL ingest of that same URL continuing its chain (a repeat ingest under the caller's own
 * key): `sourceIdentity`, the item's URL as fetched (identityUrl), must equal the stored sourceUrl of every URL-intake
 * row of the chain, exactly. The legacy key is lossy (`/manual` and `/manual/` share one), so a near match, or a
 * chain holding more than one URL, is refused too.
 *
 * Called twice: once before anything is created (unlocked, for an early answer), and inside each file's transaction
 * under the chain's advisory lock (`documents_project_canonical_idx`, one indexed read), which is authoritative. No
 * new legacy chain is ever written (URL ingests write opaque keys) and adoption only re-keys one away.
 */
export async function assertCallerKeysAvoidLegacyUrlChains(
  client: SqlClient,
  args: { projectId: string; orgId: string; items: Array<{ canonicalId?: string | null; sourceIdentity?: string | null }> },
): Promise<void> {
  const items = args.items.filter((item): item is { canonicalId: string; sourceIdentity?: string | null } =>
    typeof item.canonicalId === "string" && item.canonicalId !== "" && !isCallerReservedCanonicalId(item.canonicalId));
  if (!items.length) return;
  const rows = await client<{ canonical_id: string; source_url: string | null }[]>`
    select d.canonical_id, d.metadata ->> 'sourceUrl' as source_url
    from documents d
    join project_runs r on r.id = d.run_id and r.project_id = d.project_id and r.org_id = d.org_id
    where d.project_id = ${args.projectId} and d.org_id = ${args.orgId}
      and d.canonical_id = any(${client.array([...new Set(items.map((item) => item.canonicalId))])}) and r.kind = 'url-ingest'
  `;
  // The stored URLs (as fetched) of each key's legacy URL-intake chain.
  const chains = new Map<string, Set<string | null>>();
  for (const row of rows) {
    if (row.source_url === null || tryCanonicalIdForUrl(row.source_url) !== row.canonical_id) continue;
    chains.set(row.canonical_id, (chains.get(row.canonical_id) ?? new Set()).add(tryIdentityUrl(row.source_url)));
  }
  for (const item of items) {
    const stored = chains.get(item.canonicalId);
    if (!stored) continue;
    const sameUrl = !!item.sourceIdentity && stored.size === 1 && stored.has(item.sourceIdentity);
    if (!sameUrl) throw new ReservedCanonicalIdError(RESERVED_CANONICAL_ID_MESSAGE);
  }
}

export async function enforceLiveBudgetCaps(
  projectId: string,
  orgId: string,
): Promise<void> {
  if (process.env.NODE_ENV === "development" && SKIP_RUN_BUDGET_GUARDS_IN_DEV) return;
  await defaultSql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${orgId}))`;
    const status = await loadSpendStatus(orgId, projectId, { client: tx });
    if (!status?.projectInOrg) throw new RunCreationBlockedError("Project not found", 402, "plan_not_entitled");
    if (status.projectBudgetPaused) throw new RunCreationBlockedError("This project has reached its monthly budget cap", 402, "project_budget_paused");
    if (status.orgBudgetPaused) throw new RunCreationBlockedError("This organization has reached its monthly budget cap", 402, "org_budget_paused");
  });
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
      dimension,
      embedding_model_uri,
      embedding_model_class
    )
    select
      gen_random_uuid()::text,
      ${args.targetDocumentId},
      backend,
      bucket,
      path,
      embedding_model,
      dimension,
      embedding_model_uri,
      embedding_model_class
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
/**
 * A replayed run's chart export config: the explicit override when the request gave one, else the source run's stamped
 * tier (resolved for `origin` when it has none) capped at the project's current cap. Never raises above the project.
 */
export function replayChartExport<T extends PipelineFeatures>(
  pipeline: T,
  requested: ChartExportTier | null,
  project: { tier?: ChartExportTier } | null,
  origin: RunOrigin,
  env: Readonly<Record<string, string | undefined>> = process.env,
): T {
  const stamped = stampRunChartExport(pipeline, origin, env, { stamped: true });
  const replayed = (stamped.chartExport as ResolvedChartExportConfig).tier;
  const tier = requested ?? minChartExportTier(replayed, projectChartExportTierCap(project, env));
  if (!requested && tier !== replayed) console.log(`[chart-export] replayed tier capped from=${replayed} to=${tier} (project now resolves lower)`);
  return { ...stamped, chartExport: { ...stamped.chartExport, tier } };
}

/**
 * The principal check for `principalAtAdmission`, run with the admission transaction's client.
 *
 * Lock order is global and matches membership removal (which deletes the membership, revokes the member's keys and
 * OAuth grants, then removes their project shares): org membership, then the API key, then its OAuth grant, then the
 * project membership, so the two never deadlock. FOR SHARE serializes this check with those changes (and makes a
 * key's usage flush wait for this short transaction). Time-based validity (key expiry) is read with clock_timestamp()
 * after the locks are held: now() is the transaction's start, which can be long before the admission lock was granted.
 */
export async function assertPrincipalAtAdmission(
  tx: Parameters<Parameters<typeof admitRunSpend>[2]>[0],
  args: { orgId: string; projectId: string; userId: string; apiKeyId: string | null; scope: string; keyTypes?: readonly string[] },
): Promise<void> {
  const keyTypes = args.keyTypes ?? ["server"];
  const [membership] = await tx<Array<{ one: number }>>`select 1 as one from org_memberships
    where org_id = ${args.orgId} and user_id = ${args.userId} for share`;
  if (args.apiKeyId) {
    // A key acts only for a current member of its organization.
    if (!membership) throw new RunAdmissionRefusedError();
    const [key] = await tx<Array<{ user_id: string; org_id: string; key_type: string; scopes: string[] | null; project_ids: string[] | null }>>`
      select user_id, org_id, key_type, scopes, project_ids from api_keys
      where id = ${args.apiKeyId} and revoked_at is null
      for share`;
    const projectIds = key?.project_ids ?? [];
    if (!key || key.org_id !== args.orgId || key.user_id !== args.userId || !keyTypes.includes(key.key_type)
      || !(key.scopes ?? []).includes(args.scope) || (projectIds.length > 0 && !projectIds.includes(args.projectId))) {
      throw new RunAdmissionRefusedError();
    }
    // A key that backs an OAuth grant (device login, MCP) stops with its grant, which can be revoked on its own.
    const grants = await tx<Array<{ revoked: boolean }>>`select revoked_at is not null as revoked from mcp_oauth_grants
      where api_key_id = ${args.apiKeyId} for share`;
    if (grants.some(grant => grant.revoked)) throw new RunAdmissionRefusedError();
  }
  await tx`select 1 from project_members where project_id = ${args.projectId} and user_id = ${args.userId} for share`;
  if (args.apiKeyId) {
    // Statement time, after every principal row lock (the last may have waited on a concurrent role change): a key
    // that expired while this admission waited is refused.
    const [live] = await tx<Array<{ live: boolean }>>`select (expires_at is null or expires_at > clock_timestamp()) as live
      from api_keys where id = ${args.apiKeyId}`;
    if (!live?.live) throw new RunAdmissionRefusedError();
  }
  const access = await getProjectAccess(args.projectId, args.userId, tx);
  if (!access || access.orgId !== args.orgId || !canContributeToProject(access, args.userId)) throw new RunAdmissionRefusedError();
}

export function createRunCreation(deps: RunCreationDeps) {
  const { sql, start } = deps;

  /** An unrevoked API key's scopes, or null (unknown, revoked, or an OAuth token id): the chart ceiling then refuses. */
  async function activeApiKeyScopes(apiKeyId: string): Promise<readonly string[] | null> {
    const [row] = await sql<{ scopes: string[] }[]>`select scopes from api_keys where id = ${apiKeyId} and revoked_at is null limit 1`;
    return row?.scopes ?? null;
  }

  async function insertRun(args: {
    id: string;
    orgId: string;
    input: CreateRunInput;
    totalDocuments: number;
    sourceKeys: string[];
    pipeline: PipelineFeatures;
    budgetCents: number;
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
          extract_id, storage_prefix, origin, monthly_reservation_cents
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
          ${input.extract?.storagePrefix ?? null},
          ${input.origin ?? "machine"}, ${args.budgetCents}
        )
        returning *
      )
      select inserted.*, projects.name as project_name
      from inserted
      join projects on projects.id = inserted.project_id
    `;
      await bindIntakeReceipt(tx, args.id);
      // The extract learns its run in the same transaction, so a failure after commit never orphans the run.
      if (input.extract) await tx`update extracts set run_id = ${args.id}, updated_at = now() where id = ${input.extract.id} and (run_id is null or run_id = ${args.id})`;
      return rows;
    }, {
      leaseRunId: args.id, speedBoost: args.pipeline.speedBoost,
      ...(input.principalAtAdmission ? { authorize: (tx) => assertPrincipalAtAdmission(tx, {
        orgId: args.orgId, projectId: input.projectId, userId: input.userId, apiKeyId: input.apiKeyId ?? null, scope: input.principalAtAdmission!.scope,
        keyTypes: input.principalAtAdmission!.keyTypes,
      }) } : {}),
    });
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

      // Lock waits are bounded and the whole transaction is retried on a conflict (withLockRetry).
      const row = await withLockRetry(() => sql.begin(async (tx) => {
        const client = tx as unknown as SqlClient;

        await boundLockWaits(client);
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
        if (!input.extract) {
          // Under the chain lock: a caller key joins a legacy URL-intake chain only as a URL ingest of exactly its URL.
          await assertCallerKeysAvoidLegacyUrlChains(client, {
            projectId: input.projectId, orgId, items: [{ canonicalId: file.canonicalId, sourceIdentity: urlIngestIdentity(input, file) }],
          });
          // A URL re-ingest also takes over the version chain of this URL's legacy rows (raw-URL canonical ID).
          await adoptLegacyUrlVersions(client, { projectId: input.projectId, orgId, canonicalId, metadata: file.metadata });
        }
        // The latest version by creation (as the supersession trigger orders them), and the next number after the
        // chain's highest: adopted legacy rows can repeat numbers already used by opaque-keyed ones, so in an
        // adopted chain version_number and created_at can disagree (C-L3); creation order decides the lineage.
        const existing = input.extract ? undefined : await lockedLatestVersion(client, { projectId: input.projectId, canonicalId });

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
            ${existing ? Number(existing.next_version) : 1},
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
      }));
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
      // A URL-provenance source (stored sourceUrl, and its chain under that URL's legacy or opaque key) is
      // reprocessed under the opaque key's lock, as URL ingest is: adoption first, then lineage and insert.
      const identity = urlSourceIdentity(source.metadata);
      const urlChain = identity && (source.canonical_id === identity.opaque || source.canonical_id === identity.legacy) ? identity : null;
      // The key this source is expected under. It changes only between attempts (below), never inside a
      // transaction body that withLockRetry may run again: each attempt derives its own key from it.
      let expected = urlChain ? urlChain.opaque : await ensureCanonicalId(sql, source);
      // The source's canonical ID is re-read under the lock (a concurrent re-ingest can re-key its chain); a
      // changed key is retried with the current one.
      let row: (DocumentRow & { tags: string[] }) | null = null;
      for (let attempt = 0; attempt < 3 && row === null; attempt++) {
        const outcome = await withLockRetry(() => sql.begin(async (tx) => {
        const client = tx as unknown as SqlClient;
        // Per attempt: a URL chain always locks (and adopts under) the opaque key first, however an earlier attempt ended.
        let canonicalId = urlChain ? urlChain.opaque : expected;
        await boundLockWaits(client);
        await lockRunCreation(runId, client);
        await client`select pg_advisory_xact_lock(hashtextextended(${`${input.projectId}:${canonicalId}`}, 0))`;
        if (urlChain) {
          await adoptLegacyUrlVersions(client, { projectId: input.projectId, orgId: source.org_id, canonicalId: urlChain.opaque, metadata: source.metadata });
        }
        // The source row stays locked FOR KEY SHARE through the insert, so a concurrent deletion (which locks the
        // source FOR UPDATE before it enumerates and rewires its children) either waits for this version, which it
        // then rewires, or has already removed the source. KEY SHARE blocks only deletion: ordinary updates of the
        // source (its status, a summary build's FOR NO KEY UPDATE) go on. NOWAIT: a conflict retries the whole
        // transaction; a source gone by then fails closed.
        const [current] = await client<{ canonical_id: string | null }[]>`
          select canonical_id from documents where id = ${source.id} and project_id = ${input.projectId} and org_id = ${source.org_id}
          for key share nowait`;
        if (!current) throw new RunSourceGoneError(source.id);
        if (current.canonical_id && current.canonical_id !== canonicalId) {
          // Under URL provenance without URL-intake history the chain keeps its own key: take that key's lock too.
          if (urlChain && canonicalId === urlChain.opaque) {
            canonicalId = current.canonical_id;
            await client`select pg_advisory_xact_lock(hashtextextended(${`${input.projectId}:${canonicalId}`}, 0))`;
          } else {
            return { retryWith: current.canonical_id };
          }
        }
        // The new version follows the latest in the lineage (by creation, as the supersession trigger orders them),
        // numbered after the chain's highest, whichever version was selected. Version numbers can disagree with
        // creation order in an adopted chain (C-L3: a legacy row and an opaque row both numbered 1); creation wins.
        const latest = await lockedLatestVersion(client, { projectId: input.projectId, orgId: source.org_id, canonicalId });
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
            ${latest ? Number(latest.next_version) : (source.version_number ?? 1) + 1},
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
        return { row: { ...inserted!, tags: tags.map((row) => row.tag) } };
        }));
        // A committed attempt that found the source under another key: the next attempt starts from that key.
        if (outcome.retryWith !== undefined) expected = outcome.retryWith;
        else row = outcome.row ?? null;
      }
      if (!row) throw new Error(`[run-creation] source ${source.id} kept changing its canonical ID; retry the reprocess`);
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

  function projectPipelineForCeilings(stored: unknown, projectId: string): unknown {
    const source = `project ${projectId}`;
    // Model fields are not ceilings (and are never configuration): stripped first, as on a project read.
    const record = stored !== null && typeof stored === "object" && !Array.isArray(stored)
      ? stripLegacyVisionModel(stripManagedPipelineFields(stored as Record<string, unknown>), source)
      : stored;
    let read: ReturnType<typeof readStoredPipelineSettings>;
    try {
      read = readStoredPipelineSettings(record ?? null, source);
    } catch {
      // Written by a newer build: the ceilings are the strictest values, as the project read shows them.
      return strictestStoredPipelineFeatures();
    }
    return read.repairs.some((repair) => repair.reason !== "retired") ? read.features : stored;
  }

  async function create(request: CreateRunInput): Promise<CreatedRun> {
    // Callers often pass a stored project or run pipeline (reprocess, bulk reprocess, full index, connectors).
    // Extractor settings the strict schemas now reject are dropped here, before anything is written, so the
    // Run row never carries them (a Dolphin repoPath, an unknown extractor id). Request schemas stay strict.
    const requestedPipeline = { ...request.pipeline, speedBoost: request.speedBoost === true };
    assertPipelineSpeedBoost(requestedPipeline);
    const source = `run creation in project ${request.projectId}`;
    // Most run-creation paths land here (upload, extract, MCP, reprocess, bulk reprocess, retry-as-new, materialize),
    // and callers often pass an old run snapshot. The paths that insert runs directly apply the same resolution
    // themselves: re-index and config change (config-change.ts createReindexRuns), full index and indexing-mode switches
    // (project-indexing-mode.ts), retry in place (runs.ts retryRun). Model values in a snapshot are history,
    // never configuration: they are dropped and the project's explicit admin overrides and current defaults apply
    // (managed-pipeline-models.ts). Run-specific fields (speedBoost, indexingMode, stage selection) are kept.
    const [managedRow] = await sql<{ managed: unknown }[]>`select managed_models -> 'pipeline' as managed from projects where id = ${request.projectId}`;
    const managed = resolveManagedPipeline(
      sanitizeStoredPipeline(requestedPipeline, source),
      parseManagedPipelineOverrides(managedRow?.managed, `project ${request.projectId}`),
      source,
    );
    const sanitized = { ...managed.pipeline, speedBoost: request.speedBoost === true };
    // With the stored pipeline: the project's chart tier is the ceiling checked below, and the cap on a replayed tier.
    const access = await getProjectAccessWithPipeline(request.projectId, request.userId);
    if (!access) throw new Error("Project not found");
    // New files: any contributor (the default project admits every org member). New versions of existing documents spend
    // credits on content the caller did not upload: editors only (canEditProject, council L3).
    const reprocessing = request.sources.kind === "versionsOf";
    if (reprocessing ? !canEditProject(access, request.userId) : !canContributeToProject(access, request.userId)) {
      if (reprocessing && canContributeToProject(access, request.userId)) throw new EditorRequiredError();
      throw new Error("Forbidden");
    }
    // The project's stored settings are ceilings below (chart tier, ladder, quality and visuals). A row whose stored
    // settings no longer validate is read with its reset values (readStoredPipelineSettings: the strictest value for
    // spend and privacy settings), never with the unreadable ones; a valid row is used exactly as stored.
    const projectStored = projectPipelineForCeilings(access.pipeline, request.projectId);
    const projectChartExport = upgradeStoredChartExport((projectStored as { chartExport?: unknown } | null | undefined)?.chartExport) as { tier?: ChartExportTier } | null;
    // The chart export tier is resolved here, once per run, and stored on the run: a retry or resume reads it back, and
    // the worker never re-resolves it. A new run: request override, project tier, origin default. A replay (reprocess,
    // bulk reprocess): the request's explicit override, else the source run's stamp capped at what the project resolves
    // to now, so a project moved to off (or unset) never replays billed reads and never refuses a plain reprocess.
    // The summary tree is the project's stored setting as it is now, whatever the caller's pipeline carries (a source
    // run's snapshot on reprocess, a request body, a template): run-summary-tree.ts.
    const input: CreateRunInput = {
      ...request,
      // Falls back to the request's key: background callers (the upload reconciler) run outside any request context
      // (AsyncLocalStorage.snapshot at module load), so they never borrow another caller's key.
      apiKeyId: request.apiKeyId ?? currentRequestApiKeyId(),
      pipeline: withProjectSummaryTree(request.chartExportReplay
        ? replayChartExport(sanitized, request.chartExportReplay.requested ?? null, projectChartExport, request.origin ?? "machine")
        : stampRunChartExport(sanitized, request.origin ?? "machine", process.env, { stamped: request.chartExportStamped === true }),
      storedSummaryTree(projectStored)),
    };
    assertPipelineSpeedBoost(input.pipeline);
    // The project's Auto ladder limits (pipeline.ladder) are a ceiling for callers who cannot change the project's spend
    // settings (non-editors, and API keys without the billed-features or projects:manage scope, as for chart export):
    // their run override may tighten the limits (a lower rung, a smaller share), never loosen them, and while the project
    // has a limit it may not raise quality above the project's (auto -> good would read every page). Clamped, not refused.
    {
      const projectPipeline = (projectStored ?? null) as { quality?: QualityMode | null; ladder?: Partial<PipelineLadder> | null } | null;
      const apiKeyId = input.apiKeyId ?? currentRequestApiKeyId();
      let mayLoosen = canEditProject(access, input.userId);
      if (mayLoosen && apiKeyId) {
        const scopes = await activeApiKeyScopes(apiKeyId).catch(() => null);
        mayLoosen = !!scopes && (scopes.includes(BILLED_FEATURES_SCOPE) || scopes.includes("projects:manage"));
      }
      let clamped = clampRunLadder(input.pipeline, projectPipeline, mayLoosen);
      // A replay (reprocess, bulk reprocess, retry as new) carries an older run's snapshot: the project's limits as they are
      // now tighten it whoever asks, as the chart tier caps a replay at what the project resolves to now.
      // Quality is capped too while the project has a limit, so a snapshot at Good cannot read past it.
      if (reprocessing || request.chartExportReplay) clamped = clampRunLadder(clamped, projectPipeline, false);
      if (clamped !== input.pipeline && (JSON.stringify(clamped.ladder) !== JSON.stringify(input.pipeline.ladder) || clamped.quality !== input.pipeline.quality)) {
        console.log(`[run-creation] ladder override clamped to the project's limits project=${input.projectId} quality=${input.pipeline.quality}->${clamped.quality}`);
      }
      input.pipeline = clamped;
    }
    // The project's explicit chart tier is a ceiling: `models` above a stored `off`/`free` needs editor rights (and, for
    // an API key, the billed-features scope). Every run (upload, URL, extract, MCP, reprocess) lands here.
    await assertChartExportModelsCeiling({
      runTier: (input.pipeline.chartExport as ResolvedChartExportConfig | undefined)?.tier,
      projectTier: projectChartExport?.tier,
      canEdit: canEditProject(access, input.userId),
      // Some intake paths do not thread the key id through; the request context always has it for a key request.
      apiKeyId: input.apiKeyId ?? currentRequestApiKeyId(),
      apiKeyScopes: activeApiKeyScopes,
      context: `run creation project=${input.projectId}`,
    });
    // Quality and visuals (extraction-config.ts): a `smart` raise above the project needs the same authority as
    // `charts-ai`; a replay inherits its source run's quality capped at the project's now; privacy, the vision profile's
    // locality and the deployment switches cap stored values (recorded in `capsApplied`) and refuse explicit ones (400).
    // The resolved values are stamped on the run as `pipeline.effective` (additive: older releases ignore it).
    const { effective, ...resolvedPipeline } = await resolveRunExtraction({
      pipeline: input.pipeline,
      project: projectStored as never,
      origin: input.origin ?? "machine",
      replay: request.chartExportReplay ? { requestedQuality: request.chartExportReplay.quality ?? null } : null,
      canEdit: canEditProject(access, input.userId),
      apiKeyId: input.apiKeyId ?? currentRequestApiKeyId(),
      apiKeyScopes: activeApiKeyScopes,
      context: `run creation project=${input.projectId}`,
    });
    input.pipeline = resolvedPipeline as PipelineFeatures;
    // Every caller (upload, extract, MCP, reprocess) lands here: a run pipeline that combines visual indexing
    // with Fast (or a refused privacy/PII policy) is refused whatever the project or request says
    // (IndexingModeError visual_mode_quality / visual_mode_privacy, 400).
    // Visual mode embeds every page, which no ladder limit allows: a limit the project does not have (a run override)
    // is dropped for a visual run rather than refusing the upload; a project limit is refused below as before.
    if (effectiveIndexingMode(input.pipeline.indexingMode) === "visual" && effectiveLadder(input.pipeline).active) {
      const projectLadder = (projectStored as { ladder?: PipelineFeatures["ladder"] } | null | undefined)?.ladder;
      if (!effectiveLadder({ quality: input.pipeline.quality, ladder: projectLadder ?? null }).active) {
        console.warn(`[run-creation] ladder override ignored on a visual-mode run project=${input.projectId}`);
        input.pipeline = { ...input.pipeline, ladder: projectLadder ?? defaultPipelineLadder };
      }
    }
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

    // A caller key that is a legacy URL-intake chain's raw-URL key is refused before anything is created.
    // A caller key that is a legacy URL-intake chain's raw-URL key is refused before anything is created, unless the
    // item is a URL ingest of exactly that chain's URL (checked again, authoritatively, under the chain lock).
    if (sources.kind === "files" && !input.extract) {
      await assertCallerKeysAvoidLegacyUrlChains(sql, {
        projectId: input.projectId, orgId: access.orgId,
        items: sources.files.map((file) => ({ canonicalId: file.canonicalId, sourceIdentity: urlIngestIdentity(input, file) })),
      });
    }

    // One admission path for every caller: credit floor, live budget caps, then
    // the reserved insert.
    await assertCreditFloor(access.orgId);
    // Reading charts with AI bills model reads: the same spend admission as other model-calling work.
    if (chartExportModelsAllowed(input.pipeline.chartExport as ResolvedChartExportConfig, process.env)) {
      await assertCanSpend(access.orgId, input.projectId, { kind: "job" });
    }

    // Validated before the insert: a pipeline the preview schema rejects must fail the request with nothing
    // committed, not after the Run and its document versions exist (an orphan run recovery would retry forever).
    // The forecast prices the files and pages the run actually has (counted pages where known, sizes otherwise), not placeholders.
    type ForecastFile = { filename: string; mimeType: string; sizeBytes: number; pages?: number };
    const executionPipeline = platformRunPipeline(sources.kind === "files" ? withoutStageSelection(input.pipeline) : input.pipeline);
    const costForecastFor = (files: ForecastFile[]) => buildRunProcessingPreview({
      request: { project: input.projectId, pipeline: executionPipeline, speedBoost: executionPipeline.speedBoost === true, files, urls: [] },
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
    if (sources.kind === "files" && sources.files.some(file => !Number.isFinite(file.fileSize) || (file.fileSize ?? 0) <= 0)) {
      throw new Error("Monthly admission requires trusted positive source size evidence");
    }
    const validationFiles = forecastFilesOfSources();
    if (validationFiles.some(file => !(Number.isFinite(file.sizeBytes) && file.sizeBytes > 0) &&
        !(Number.isSafeInteger(file.pages) && (file.pages ?? 0) > 0))) {
      throw new Error("Monthly admission requires trusted positive workload evidence");
    }
    const admissionForecast = costForecastFor(validationFiles.length > 0 ? validationFiles : [{ filename: "validation.pdf", mimeType: "application/pdf", sizeBytes: 1, pages: 1 }]);

    const runId = input.runId ?? randomUUID();
    const reuse = sources.kind === "versionsOf" && sources.reuse === true;
    const row = await insertRun({
      id: runId,
      budgetCents: Math.max(1, admissionForecast.maxCents),
      orgId: access.orgId,
      input,
      totalDocuments: sources.kind === "files" ? sources.files.length : sourceDocuments.length,
      sourceKeys: sources.kind === "files" ? sources.files.map((file) => file.sourceKey) : [],
      // New files always run every enabled stage; a caller re-running existing
      // Documents chooses its own stage selection.
      // Stamped `modelMode: "private"` in private model mode, so the worker treats the run as private whatever its env.
      pipeline: stampRunModelMode({ ...executionPipeline, effective }) as PipelineFeatures,
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
      documents: withUniqueRedactedFilenames(published.documents.map(mapDocument)),
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
