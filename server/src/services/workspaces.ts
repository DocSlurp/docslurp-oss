import { deferredProfilesEnabled, isBillingEnforced, PUBLIC_ERROR_MESSAGES, publicDiagnostics, publicDocumentError } from "@docslurp/shared";
import { markWorkspaceAutoNamed, refineWorkspaceNames } from "./workspace-naming.js";
import { forgetWorkspaceProviderPolicy } from "../lib/provider-policy.js";
import { jsonRecord } from "../lib/json-record.js";
import { randomBytes, randomUUID } from "node:crypto";

import {
  applyWorkspaceTemplateLocks,
  createWorkspaceSchema,
  defaultPipelineFeatures,
  getWorkspaceTemplate,
  isUntitledWorkspaceName,
  isWorkspaceUuid,
  normalizePipelineFeatures,
  normalizeStoredPipelineFeatures,
  slugifyWorkspaceName,
  WORKSPACE_SLUG_MAX_LENGTH,
  type WorkspaceInputRef,
  withoutStageSelection,
  updateWorkspaceSchema,
  workspaceSlugProblem,
  workspaceBoardRecordSchema,
  workspaceRunSchema,
  workspaceSchema,
  type CreateWorkspaceInput,
  type PipelineFeatures,
  type UpdateWorkspaceInput,
  type WorkspaceBoardRecord,
  type WorkspaceRun,
  type WorkspaceTemplateKey,
  type WorkspaceRecord,
  UNTITLED_WORKSPACE_NAME,
  DEFAULT_INDEXING_MODE
} from "@docslurp/shared";

import { sql } from "../db.js";
import {
  effectiveIndexingMode,
  validateModeChoice,
  validateModeSwitch,
} from "./workspace-indexing-mode.js";
import { buildRunProgressSnapshot, withRunCosts } from "./runs.js";
import {
  canEditWorkspace,
  canManageWorkspace,
  ensurePersonalOrganization,
  getWorkspaceAccess,
  listAccessibleWorkspaceIds,
} from "./organizations.js";
import {
  buildClonedWorkspaceName,
  readWorkspaceVersionSnapshot,
  type WorkspaceVersionSnapshot,
} from "./workspace-utils.js";
import {
  emptyWorkspaceBoardSummary,
  listWorkspaceBoardSummaries,
} from "./workspace-board-telemetry.js";
import { attributedUsage, sessionTokenUsage } from "./usage-attribution.js";
import { cancelWorkspaceRuns, deleteWorkspaceData } from "./data-deletion.js";
import { insertDefaultWorkspace, WorkspaceAccessError } from "./default-workspace.js";
import { isProtectedStoredQuery } from "../search/session.js";

type WorkspaceRow = {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  template_key: WorkspaceTemplateKey | null;
  system_prompt: string | null;
  pipeline: WorkspaceRecord["pipeline"] | null;
  monthly_budget_cents: number | null;
  artifact_retention_days?: number | null;
  run_retention_days?: number | null;
  retain_document_versions?: number | null;
  allow_china_providers?: boolean | null;
  auto_confirm_reindex?: boolean | null;
  document_count: number;
  total_page_count: number;
  indexed_page_count?: number | null;
  source_bytes?: number | string | null;
  pending_document_count?: number | null;
  pending_page_count?: number | null;
  run_count: number;
  search_session_count: number;
  chat_thread_count: number;
  chat_message_count: number;
  latest_run_id: string | null;
  latest_run_status: WorkspaceRecord["latestRunStatus"];
  archived_at: string | null;
  is_default: boolean | null;
  slug: string;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
};

type WorkspaceRunRow = {
  id: string;
  org_id: string;
  user_id: string;
  workspace_id: string;
  workspace_name: string | null;
  kind: string;
  status: string;
  stage: string;
  total_documents: number;
  processed_documents: number;
  pages_total: number;
  pages_processed: number;
  pipeline: PipelineFeatures | null;
  stats: Record<string, unknown> | null;
  artifacts: Record<string, string> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type WorkspaceVersionRow = {
  id: string;
  user_id: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type StageHotspotRow = {
  stage_name: string;
  total_states: number;
  failed_states: number;
  avg_duration_ms: number | null;
  last_seen_at: string | null;
};

type SearchTraceRow = {
  id: string;
  query: string;
  variant: string | null;
  result_count: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  input_tokens: number;
  output_tokens: number;
  top_citations: Array<{
    filename: string;
    pageNumber: number | null;
    score: number;
    regionBox?: { pageNumber: number; x: number; y: number; width: number; height: number } | null;
  }> | null;
};

type ChatTraceRow = {
  id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export interface WorkspaceCockpitSummary {
  totalCostCents?: number;
  recordedCostCents?: number;
  computeCostCents?: number;
  baseFeeCostCents?: number;
  totalDocuments: number;
  completedDocuments: number;
  failedDocuments: number;
  activeDocuments: number;
  totalRuns: number;
  queuedRuns: number;
  processingRuns: number;
  completedRuns: number;
  failedRuns: number;
  totalPages: number;
  processedPages: number;
  chunkCount: number;
  tagCount: number;
  indexedBytes: number;
  avgCompletedRunMs: number;
  pagesPerDollar: number;
  costPerThousandPagesCents: number;
  searchSessions: number;
  chatSessions: number;
}

export interface WorkspaceStageHotspot {
  stage: string;
  totalStates: number;
  failedStates: number;
  avgDurationMs: number;
  lastSeenAt: string | null;
}

export interface WorkspaceBudgetSummary {
  monthlyBudgetCents: number | null;
  monthlySpendCents: number;
  remainingCents: number | null;
  alertLevel: number;
  budgetPaused: boolean;
}

export interface WorkspaceCockpitRecord {
  workspaceId: string;
  summary: WorkspaceCockpitSummary;
  budget: WorkspaceBudgetSummary;
  activeRun: WorkspaceRun | null;
  recentRuns: WorkspaceRun[];
  stageHotspots: WorkspaceStageHotspot[];
}

export interface WorkspaceSearchTrace {
  id: string;
  kind: "search";
  query: string;
  variant: string | null;
  resultCount: number;
  filters: Record<string, unknown>;
  effectiveQuery: string | null;
  inputTokens: number;
  outputTokens: number;
  topCitations: Array<{
    filename: string;
    pageNumber: number | null;
    score: number;
    regionBox?: { pageNumber: number; x: number; y: number; width: number; height: number } | null;
  }>;
  createdAt: string;
}

export interface WorkspaceChatTrace {
  id: string;
  kind: "chat";
  query: string;
  searchSessionId: string | null;
  citations: number;
  model: string | null;
  fallback: boolean;
  topCitations: Array<{
    filename: string;
    pageNumber: number | null;
    score: number;
    regionBox?: { pageNumber: number; x: number; y: number; width: number; height: number } | null;
  }>;
  createdAt: string;
}

export interface WorkspaceTraceFeed {
  searches: WorkspaceSearchTrace[];
  chats: WorkspaceChatTrace[];
}

export interface WorkspaceVersionRecord {
  id: string;
  userId: string | null;
  action: string;
  note: string | null;
  sourceVersionId: string | null;
  snapshot: WorkspaceVersionSnapshot;
  createdAt: string;
}

export interface DeletedWorkspaceRecord {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  archivedAt: string | null;
}

type WorkspaceMutationAction = "archive" | "restore";

function normalizeConfirmationText(value: string): string {
  return value.trim();
}

function assertWorkspaceConfirmation(name: string, confirmationText: string) {
  if (normalizeConfirmationText(confirmationText) !== name) {
    throw new Error("Confirmation text must match the workspace name exactly");
  }
}

function parseWorkspaceTemplateKey(value: string | null): WorkspaceRecord["templateKey"] {
  const parsed = workspaceSchema.shape.templateKey.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  const pipeline = normalizeStoredPipelineFeatures(row.pipeline ?? defaultPipelineFeatures, `workspace ${row.id}`);
  return workspaceSchema.parse({
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    name: row.name,
    templateKey: parseWorkspaceTemplateKey(row.template_key),
    systemPrompt: row.system_prompt ?? null,
    summaries: pipeline.summarize,
    pipeline: {
      ...pipeline,
      indexingMode: effectiveIndexingMode(row.pipeline?.indexingMode),
    },
    monthlyBudgetCents: row.monthly_budget_cents ?? null,
    artifactRetentionDays: row.artifact_retention_days ?? null,
    runRetentionDays: row.run_retention_days ?? null,
    retainDocumentVersions: row.retain_document_versions ?? null,
    allowChinaProviders: row.allow_china_providers !== false,
    autoConfirmReindex: row.auto_confirm_reindex ?? false,
    documentCount: row.document_count ?? 0,
    totalPageCount: row.total_page_count ?? 0,
    indexingMode: effectiveIndexingMode(row.pipeline?.indexingMode),
    indexedPageCount: row.indexed_page_count ?? row.total_page_count ?? 0,
    deferredIndexingAvailable: deferredProfilesEnabled(),
    billingEnforced: isBillingEnforced(),
    sourceBytes: Number(row.source_bytes ?? 0),
    pendingDocumentCount: row.pending_document_count ?? 0,
    pendingPageCount: row.pending_page_count ?? 0,
    runCount: row.run_count ?? 0,
    searchSessionCount: row.search_session_count ?? 0,
    chatThreadCount: row.chat_thread_count ?? 0,
    chatMessageCount: row.chat_message_count ?? 0,
    latestRunId: row.latest_run_id,
    latestRunStatus: row.latest_run_status,
    archivedAt: row.archived_at ?? null,
    isDefault: row.is_default ?? false,
    slug: row.slug,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapWorkspaceRun(row: WorkspaceRunRow): WorkspaceRun {
  return workspaceRunSchema.parse({
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name ?? "",
    kind: row.kind,
    status: row.status,
    stage: row.stage,
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    pagesTotal: row.pages_total,
    pagesProcessed: row.pages_processed,
    pipeline: normalizeStoredPipelineFeatures(row.pipeline ?? defaultPipelineFeatures, `run ${row.id}`),
    stats: publicDiagnostics(jsonRecord(row.stats)),
    artifacts: jsonRecord(row.artifacts),
    error: publicDocumentError(row.error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

async function assertWorkspaceAccess(workspaceId: string, userId: string) {
  const access = await getWorkspaceAccess(workspaceId, userId);
  if (!access) {
    throw new Error("Workspace not found");
  }
  return access;
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
  const parsed = createWorkspaceSchema.parse(input);
  // No chosen name: start as the placeholder and let automatic naming take over.
  const untitled = isUntitledWorkspaceName(parsed.name);
  const name = untitled ? UNTITLED_WORKSPACE_NAME : parsed.name!;
  const id = randomUUID();
  const template = getWorkspaceTemplate(parsed.templateKey ?? null);
  const pipeline = applyWorkspaceTemplateLocks(
    normalizePipelineFeatures({
      ...(parsed.pipeline ?? template?.pipeline ?? defaultPipelineFeatures),
      summarize: parsed.summaries,
    }),
    template,
  );
  const organization = parsed.orgId
    ? await sql<{ id: string }[]>`
        select om.org_id as id
        from org_memberships om
        where om.org_id = ${parsed.orgId} and om.user_id = ${parsed.userId}
        limit 1
      `.then((rows) => rows[0] ?? null)
    : await ensurePersonalOrganization(parsed.userId);

  if (!organization) {
    throw new Error("Organization not found");
  }

  // The same default for every organization unless the caller chose a mode; coerced to full while the flag is off.
  const requestedMode = (input.pipeline as { indexingMode?: PipelineFeatures["indexingMode"] } | undefined)?.indexingMode;
  pipeline.indexingMode = effectiveIndexingMode(requestedMode ?? DEFAULT_INDEXING_MODE);
  // An explicit choice goes through the same gate as a switch (visual privacy).
  if (requestedMode !== undefined && deferredProfilesEnabled()) {
    await validateModeChoice({ orgId: organization.id, workspaceId: null, currentMode: null, nextPipeline: pipeline });
  }

  const insert = (slug: string | null) => sql<WorkspaceRow[]>`
    insert into workspaces (id, org_id, user_id, name, template_key, system_prompt, pipeline, slug)
    values (
      ${id},
      ${organization.id},
      ${parsed.userId},
      ${name},
      ${parsed.templateKey ?? null},
      ${parsed.systemPrompt ?? null},
      ${sql.json(JSON.parse(JSON.stringify(withoutStageSelection(pipeline))))},
      coalesce(${slug}::text, generate_workspace_slug())
    )
    returning
      id,
      org_id,
      user_id,
      name,
      template_key,
      system_prompt,
      pipeline,
      0::int as document_count,
      0::int as total_page_count,
      0::int as indexed_page_count,
      0::double precision as source_bytes,
      0::int as pending_document_count,
      0::int as pending_page_count,
      0::int as run_count,
      0::int as search_session_count,
      0::int as chat_thread_count,
      0::int as chat_message_count,
      null::text as latest_run_id,
      null::text as latest_run_status,
      null::text as archived_at,
      is_default,
      slug,
      created_at::text as last_activity_at,
      created_at::text,
      updated_at::text
  `;

  let row: WorkspaceRow | undefined;
  for (const slug of preferredSlugCandidates(parsed.slug)) {
    try {
      [row] = await insert(slug);
      break;
    } catch (error) {
      // Slugs are globally unique and never reused, so a taken one gets a suffix.
      if (slug === null || (error as { code?: string }).code !== "23505") throw error;
    }
  }

  // The lowest automatic-naming phase: the first upload, content or chat question names it.
  if (untitled) await markWorkspaceAutoNamed(row!.id, parsed.userId, name, "empty");
  return mapWorkspace(row!);
}

/**
 * Slugs to try, in order, for a new workspace that prefers `slug`: the slug
 * itself, then suffixed variants, then a generated three-word slug. Invalid
 * or reserved slugs (too short, "default", ...) go straight to a generated one.
 */
function preferredSlugCandidates(preferred: string | undefined): Array<string | null> {
  const slug = preferred ? slugifyWorkspaceName(preferred) : "";
  if (!slug || workspaceSlugProblem(slug)) return [null];
  const base = slug.slice(0, WORKSPACE_SLUG_MAX_LENGTH - 7).replace(/-+$/g, "");
  const suffixed = Array.from({ length: 3 }, () => `${base}-${randomBytes(3).toString("hex")}`);
  return [slug, ...suffixed, null];
}

export { DEFAULT_WORKSPACE_NAME, WorkspaceAccessError } from "./default-workspace.js";

export class WorkspaceSlugError extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

export type WorkspaceRef = { id: string; slug: string; renamedFrom: string | null };

/**
 * Resolves a workspace UUID, current slug, or former slug (renamed workspaces
 * keep their old slugs, like GitHub repository redirects). Access is checked by
 * the caller; this only maps the reference to an ID.
 */
export async function resolveWorkspaceRef(ref: string): Promise<WorkspaceRef | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (isWorkspaceUuid(trimmed)) {
    const [row] = await sql<{ id: string; slug: string }[]>`select id, slug from workspaces where id = ${trimmed}`;
    return row ? { id: row.id, slug: row.slug, renamedFrom: null } : null;
  }
  const slug = slugifyWorkspaceName(trimmed);
  if (!slug) return null;
  const [row] = await sql<{ id: string; slug: string }[]>`
    select w.id, w.slug
    from workspace_slugs s
    join workspaces w on w.id = s.workspace_id
    where s.slug = ${slug}
  `;
  if (!row) return null;
  return { id: row.id, slug: row.slug, renamedFrom: row.slug === slug ? null : slug };
}

/** Who is resolving a public `workspace` value, and where it may land. */
export interface WorkspaceInputScope {
  userId: string;
  /** Only workspaces in this organization: an API key's org or an explicit `orgId`. */
  orgId?: string | null;
  /** An API key's workspace allowlist; empty or null means unrestricted. */
  allowedWorkspaceIds?: readonly string[] | null;
}

/**
 * Finds the workspace a public `workspace` value (see parseWorkspaceInput)
 * names among those the caller can use: a UUID by ID; anything else by its
 * slug, current or former (renamed workspaces keep their old slugs). Slugs are
 * globally unique, so a slug that is taken elsewhere, reserved or too short
 * cannot name the caller's workspace; those fall back to the caller's
 * workspace whose name slugifies to the same slug (oldest first), which keeps
 * `workspace: "Legal Contracts"` pointing at the workspace an upload created
 * for it. Workspaces outside the caller's access, the scope's organization or
 * the key allowlist are never returned, so the answer never reveals them.
 */
export async function findWorkspaceForInput(
  ref: Extract<WorkspaceInputRef, { kind: "id" } | { kind: "slug" }>,
  scope: WorkspaceInputScope,
): Promise<{ id: string; orgId: string } | null> {
  const usable = async (workspaceId: string) => {
    const access = await getWorkspaceAccess(workspaceId, scope.userId);
    if (!access) return null;
    if (scope.orgId && access.orgId !== scope.orgId) return null;
    const allowlist = scope.allowedWorkspaceIds ?? [];
    if (allowlist.length > 0 && !allowlist.includes(workspaceId)) return null;
    return { id: workspaceId, orgId: access.orgId };
  };
  if (ref.kind === "id") return await usable(ref.id);

  const [bySlug] = await sql<{ workspace_id: string }[]>`
    select workspace_id from workspace_slugs where slug = ${ref.slug}
  `;
  if (bySlug) {
    const workspace = await usable(bySlug.workspace_id);
    if (workspace) return workspace;
  }

  const named = await sql<{ id: string; name: string }[]>`
    select w.id, w.name
    from workspaces w
    join org_memberships om on om.org_id = w.org_id and om.user_id = ${scope.userId}
    where (${scope.orgId ?? null}::text is null or w.org_id = ${scope.orgId ?? null})
      and w.id <> ${bySlug?.workspace_id ?? ""}
    order by (w.archived_at is not null), w.created_at, w.id
  `;
  for (const row of named) {
    if (slugifyWorkspaceName(row.name) !== ref.slug) continue;
    const workspace = await usable(row.id);
    if (workspace) return workspace;
  }
  return null;
}

/**
 * Returns the organization's default workspace, creating it on first use.
 * `orgId` defaults to the user's personal organization. Callers that omit a
 * workspaceId (uploads, search, chat, MCP) land here, so most users never need
 * to think about workspaces at all.
 */
export async function ensureDefaultWorkspace(args: {
  userId: string;
  orgId?: string | null;
}): Promise<WorkspaceRecord> {
  const orgId = args.orgId
    ? await sql<{ id: string }[]>`
        select om.org_id as id
        from org_memberships om
        where om.org_id = ${args.orgId} and om.user_id = ${args.userId}
        limit 1
      `.then((rows) => rows[0]?.id ?? null)
    : (await ensurePersonalOrganization(args.userId)).id;
  if (!orgId) {
    // Unknown org and non-member org look the same, so membership is not leaked.
    throw new WorkspaceAccessError(404, "organization_not_found", "Organization not found");
  }

  await insertDefaultWorkspace(sql, { orgId, userId: args.userId });
  const [row] = await sql<{ id: string }[]>`
    select id from workspaces where org_id = ${orgId} and is_default limit 1
  `;
  const workspace = row ? await getWorkspace(row.id, args.userId) : null;
  if (!workspace) {
    throw new WorkspaceAccessError(403, "workspace_forbidden", "Default workspace is not accessible");
  }
  return workspace;
}

/**
 * Read-only lookup of the organization's default workspace (personal org when `orgId` is omitted). Unlike
 * `ensureDefaultWorkspace` it creates nothing: null when the org, membership or default workspace is missing.
 */
export async function findDefaultWorkspace(args: { userId: string; orgId?: string | null }): Promise<WorkspaceRecord | null> {
  const [row] = await sql<{ id: string }[]>`
    select w.id
    from workspaces w
    join org_memberships om on om.org_id = w.org_id and om.user_id = ${args.userId}
    join organizations o on o.id = w.org_id
    where w.is_default
      ${args.orgId ? sql`and w.org_id = ${args.orgId}` : sql`and o.personal_owner_user_id = ${args.userId}`}
    limit 1
  `;
  return row ? await getWorkspace(row.id, args.userId) : null;
}

/**
 * Makes sure a dashboard user's personal organization and its default
 * workspace exist, without loading the workspace. Organizations created after
 * this get their default workspace at creation; this covers users who have
 * not touched an org-scoped endpoint yet.
 */
export async function ensurePersonalDefaultWorkspace(userId: string): Promise<void> {
  const organization = await ensurePersonalOrganization(userId);
  await insertDefaultWorkspace(sql, { orgId: organization.id, userId });
}

export async function getWorkspace(workspaceId: string, userId: string): Promise<WorkspaceRecord | null> {
  const access = await getWorkspaceAccess(workspaceId, userId);
  if (!access) {
    return null;
  }

  await refineWorkspaceNames([workspaceId]);
  const [row] = await sql<WorkspaceRow[]>`
    select
      w.id,
      w.org_id,
      w.user_id,
      w.name,
      w.template_key,
      w.system_prompt,
      w.pipeline,
      w.monthly_budget_cents,
      w.artifact_retention_days,
      w.run_retention_days,
      w.retain_document_versions,
      w.allow_china_providers,
      w.auto_confirm_reindex,
      coalesce(cs.document_count, 0)::int as document_count,
      coalesce(cs.page_count, 0)::int as total_page_count,
      greatest(coalesce(cs.page_count, 0)::int - coalesce(idx.unindexed_pages, 0), 0)::int as indexed_page_count,
      coalesce(cs.source_bytes, 0)::double precision as source_bytes,
      coalesce(inflight.document_count, 0)::int as pending_document_count,
      coalesce(inflight.page_count, 0)::int as pending_page_count,
      coalesce(j.run_count, 0)::int as run_count,
      coalesce((
        select count(*)::int
        from search_sessions s
        where s.metadata ->> 'workspaceId' = w.id
      ), 0) as search_session_count,
      coalesce((
        select count(*)::int
        from chat_sessions cs
        where cs.workspace_id = w.id
      ), 0) as chat_thread_count,
      coalesce((
        select count(*)::int
        from chat_turns ct
        join chat_sessions cs on cs.id = ct.session_id
        where cs.workspace_id = w.id
      ), 0) as chat_message_count,
      recent.id as latest_run_id,
      recent.status as latest_run_status,
      w.archived_at::text as archived_at,
      w.is_default,
      w.slug,
      greatest(
        w.updated_at,
        coalesce(recent.updated_at, w.updated_at),
        coalesce(cs.updated_at, w.updated_at),
        coalesce((
          select max(s.created_at)
          from search_sessions s
          where s.metadata ->> 'workspaceId' = w.id
        ), w.updated_at),
        coalesce((
          select max(cs.created_at)
          from chat_sessions cs
          where cs.workspace_id = w.id
        ), w.updated_at)
      )::text as last_activity_at,
      w.created_at::text,
      w.updated_at::text
    from workspaces w
    -- Current corpus totals are trigger-maintained; never aggregate documents here.
    left join workspace_corpus_stats cs on cs.workspace_id = w.id
    -- Searchable pages: only deferred documents can be partly indexed (skipped while the flag is off).
    left join lateral (
      select coalesce(sum(greatest(d.page_count - coalesce(ps.indexed, 0), 0)), 0)::int as unindexed_pages
      from documents d
      left join lateral (
        select count(*)::int as indexed from document_page_states s
        where s.document_id = d.id and s.state in ('indexed', 'blocked-pii')
      ) ps on true
      where ${deferredProfilesEnabled()}::boolean
        and d.workspace_id = w.id and d.indexing_mode <> 'full'
        and d.status = 'completed' and d.superseded_at is null
    ) idx on true
    -- In-flight ingest reads only the documents_workspace_in_flight_idx partial index.
    left join lateral (
      select count(*)::int as document_count,
        coalesce(sum(greatest(page_count, 0)), 0)::int as page_count
      from documents
      where workspace_id = w.id
        and status not in ('completed', 'failed', 'cancelled', 'pii_blocked')
    ) inflight on true
    left join lateral (
      select count(*)::int as run_count
      from workspace_runs
      where workspace_id = w.id
    ) j on true
    left join lateral (
      select id, status, updated_at
      from workspace_runs
      where workspace_id = w.id
      order by created_at desc
      limit 1
    ) recent on true
    where w.id = ${workspaceId}
  `;

  return row ? mapWorkspace(row) : null;
}

/** Dashboard bootstrap disables lazy title refinement to keep its read side-effect free. */
export async function listWorkspaces(userId: string, options: { refineNames?: boolean } = {}): Promise<WorkspaceRecord[]> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) {
    return [];
  }

  if (options.refineNames !== false) await refineWorkspaceNames(workspaceIds);
  const rows = await sql<WorkspaceRow[]>`
    select
      w.id,
      w.org_id,
      w.user_id,
      w.name,
      w.template_key,
      w.system_prompt,
      w.pipeline,
      w.monthly_budget_cents,
      w.artifact_retention_days,
      w.run_retention_days,
      w.retain_document_versions,
      w.allow_china_providers,
      w.auto_confirm_reindex,
      coalesce(cs.document_count, 0)::int as document_count,
      coalesce(cs.page_count, 0)::int as total_page_count,
      greatest(coalesce(cs.page_count, 0)::int - coalesce(idx.unindexed_pages, 0), 0)::int as indexed_page_count,
      coalesce(cs.source_bytes, 0)::double precision as source_bytes,
      coalesce(inflight.document_count, 0)::int as pending_document_count,
      coalesce(inflight.page_count, 0)::int as pending_page_count,
      coalesce(j.run_count, 0)::int as run_count,
      coalesce((
        select count(*)::int
        from search_sessions s
        where s.metadata ->> 'workspaceId' = w.id
      ), 0) as search_session_count,
      coalesce((
        select count(*)::int
        from chat_sessions cs
        where cs.workspace_id = w.id
      ), 0) as chat_thread_count,
      coalesce((
        select count(*)::int
        from chat_turns ct
        join chat_sessions cs on cs.id = ct.session_id
        where cs.workspace_id = w.id
      ), 0) as chat_message_count,
      recent.id as latest_run_id,
      recent.status as latest_run_status,
      w.archived_at::text as archived_at,
      w.is_default,
      w.slug,
      greatest(
        w.updated_at,
        coalesce(recent.updated_at, w.updated_at),
        coalesce(cs.updated_at, w.updated_at),
        coalesce((
          select max(s.created_at)
          from search_sessions s
          where s.metadata ->> 'workspaceId' = w.id
        ), w.updated_at),
        coalesce((
          select max(cs.created_at)
          from chat_sessions cs
          where cs.workspace_id = w.id
        ), w.updated_at)
      )::text as last_activity_at,
      w.created_at::text,
      w.updated_at::text
    from workspaces w
    -- Current corpus totals are trigger-maintained; never aggregate documents here.
    left join workspace_corpus_stats cs on cs.workspace_id = w.id
    -- Searchable pages: only deferred documents can be partly indexed (skipped while the flag is off).
    left join lateral (
      select coalesce(sum(greatest(d.page_count - coalesce(ps.indexed, 0), 0)), 0)::int as unindexed_pages
      from documents d
      left join lateral (
        select count(*)::int as indexed from document_page_states s
        where s.document_id = d.id and s.state in ('indexed', 'blocked-pii')
      ) ps on true
      where ${deferredProfilesEnabled()}::boolean
        and d.workspace_id = w.id and d.indexing_mode <> 'full'
        and d.status = 'completed' and d.superseded_at is null
    ) idx on true
    -- In-flight ingest reads only the documents_workspace_in_flight_idx partial index.
    left join lateral (
      select count(*)::int as document_count,
        coalesce(sum(greatest(page_count, 0)), 0)::int as page_count
      from documents
      where workspace_id = w.id
        and status not in ('completed', 'failed', 'cancelled', 'pii_blocked')
    ) inflight on true
    left join lateral (
      select count(*)::int as run_count
      from workspace_runs
      where workspace_id = w.id
    ) j on true
    left join lateral (
      select id, status, updated_at
      from workspace_runs
      where workspace_id = w.id
      order by created_at desc
      limit 1
    ) recent on true
    where w.id = any(${sql.array(workspaceIds)})
      and w.archived_at is null
    order by greatest(
      w.updated_at,
      coalesce(recent.updated_at, w.updated_at),
      coalesce(cs.updated_at, w.updated_at),
      coalesce((
        select max(s.created_at)
        from search_sessions s
        where s.metadata ->> 'workspaceId' = w.id
      ), w.updated_at),
      coalesce((
        select max(cs.created_at)
        from chat_sessions cs
        where cs.workspace_id = w.id
      ), w.updated_at)
    ) desc
  `;

  return rows.map(mapWorkspace);
}

export async function listWorkspaceBoardRecords(userId: string): Promise<WorkspaceBoardRecord[]> {
  const workspaces = await listWorkspaces(userId);
  if (workspaces.length === 0) {
    return [];
  }

  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const [summaries, runRows] = await Promise.all([
    listWorkspaceBoardSummaries(workspaceIds),
    sql<WorkspaceRunRow[]>`
      select
        ranked.id,
        ranked.org_id,
        ranked.user_id,
        ranked.workspace_id,
        ranked.workspace_name,
        ranked.kind,
        ranked.status,
        ranked.stage,
        ranked.total_documents,
        ranked.processed_documents,
        ranked.pages_total,
        ranked.pages_processed,
        ranked.pipeline,
        ranked.stats,
        ranked.artifacts,
        ranked.error,
        ranked.created_at,
        ranked.updated_at
      from (
        select
          r.id,
          r.org_id,
          r.user_id,
          r.workspace_id,
          w.name as workspace_name,
          r.kind,
          r.status,
          r.stage,
          r.total_documents,
          r.processed_documents,
          r.pages_total,
          r.pages_processed,
          r.pipeline,
          r.stats,
          r.artifacts,
          r.error,
          r.created_at::text,
          r.updated_at::text,
          row_number() over (
            partition by r.workspace_id
            order by
              case when r.status in ('queued', 'processing') then 0 else 1 end,
              r.created_at desc
          )::int as sort_rank
        from workspace_runs r
        join workspaces w on w.id = r.workspace_id
        where r.workspace_id = any(${sql.array(workspaceIds)})
      ) ranked
      where ranked.sort_rank = 1
    `,
  ]);

  const runs = await withRunCosts(runRows.map(mapWorkspaceRun));
  const runsByWorkspace = new Map(runs.map((run) => [run.workspaceId, run]));
  const liveRuns = runs.filter((run) => run.status === "queued" || run.status === "processing");
  const snapshots = await Promise.all(
    liveRuns.map(async (run) => [run.id, await buildRunProgressSnapshot(run, { recentEventLimit: 0 })] as const)
  );
  const snapshotsByRun = new Map(snapshots);

  return workspaces.map((workspace) => {
    const originalRun = runsByWorkspace.get(workspace.id) ?? null;
    const snapshot = originalRun ? (snapshotsByRun.get(originalRun.id) ?? null) : null;
    const run = snapshot?.run ?? originalRun;
    return workspaceBoardRecordSchema.parse({
      workspace,
      run,
      snapshot,
      summary: summaries.get(workspace.id) ?? emptyWorkspaceBoardSummary,
    });
  });
}

type WorkspaceSqlClient = typeof sql;

export type WorkspaceUpdateOptions = {
  indexingMode?: PipelineFeatures["indexingMode"];
  /** Run the write on this transaction client (config-change jobs save the config and create runs atomically). */
  client?: WorkspaceSqlClient;
  /**
   * Already-resolved inputs (access checked, pipeline resolved), so a write inside a transaction does not
   * issue reads on other connections (the caller also validates any indexing-mode switch). With `client` the returned record is `current`, not re-read.
   */
  precomputed?: { current: WorkspaceRecord; pipeline: PipelineFeatures };
};

/**
 * The pipeline an update would store (template locks applied, indexing mode resolved) without writing
 * anything. Estimates and the mutation share it so they classify the same change.
 */
export async function resolveUpdatedPipeline(
  workspaceId: string,
  current: WorkspaceRecord,
  parsed: UpdateWorkspaceInput,
  options: Pick<WorkspaceUpdateOptions, "indexingMode"> = {},
): Promise<PipelineFeatures> {
  const template = parsed.templateKey !== undefined
    ? getWorkspaceTemplate(parsed.templateKey)
    : getWorkspaceTemplate(current.templateKey);

  const draftPipeline = normalizePipelineFeatures(
    parsed.pipeline ??
      (parsed.templateKey !== undefined
        ? template?.pipeline ?? defaultPipelineFeatures
        : current.pipeline),
  );
  if (parsed.summaries !== undefined) draftPipeline.summarize = parsed.summaries;
  const pipeline = applyWorkspaceTemplateLocks(draftPipeline, template);
  // The schema defaults a missing indexingMode to "full", so a pipeline edit must not
  // flip the mode: only an explicit request (options) changes it. Flag off pins "full".
  // With the flag off the stored raw mode is preserved (only the effective mode is coerced).
  const [storedRow] = await sql<{ mode: PipelineFeatures["indexingMode"] | null }[]>`
    select pipeline ->> 'indexingMode' as mode from workspaces where id = ${workspaceId}
  `;
  const storedMode = storedRow?.mode ?? "full";
  pipeline.indexingMode = deferredProfilesEnabled() ? (options.indexingMode ?? storedMode) : storedMode;
  return pipeline;
}

export async function updateWorkspace(
  workspaceId: string,
  userId: string,
  input: UpdateWorkspaceInput,
  options: WorkspaceUpdateOptions = {},
): Promise<WorkspaceRecord | null> {
  const parsed = updateWorkspaceSchema.parse(input);
  let current: WorkspaceRecord;
  let pipeline: PipelineFeatures;
  if (options.precomputed) {
    ({ current, pipeline } = options.precomputed);
  } else {
    const access = await getWorkspaceAccess(workspaceId, userId);
    const loaded = await getWorkspace(workspaceId, userId);
    if (!loaded || !access || !canEditWorkspace(access, userId)) {
      return null;
    }
    current = loaded;
    pipeline = await resolveUpdatedPipeline(workspaceId, current, parsed, options);
  }
  // With precomputed inputs the caller already validated the switch (this may run inside its transaction).
  if (!options.precomputed && deferredProfilesEnabled() && (pipeline.indexingMode !== current.pipeline.indexingMode || (pipeline.indexingMode === "visual" && pipeline.quality === "fast"))) {
    await validateModeSwitch({ current, nextPipeline: pipeline });
  }

  const nextSlug = parsed.slug === undefined ? current.slug : parsed.slug.toLowerCase();
  if (nextSlug !== current.slug) {
    const problem = workspaceSlugProblem(nextSlug);
    if (problem) throw new WorkspaceSlugError(problem, 400);
  }

  const nextBudget =
    parsed.monthlyBudgetCents !== undefined
      ? (parsed.monthlyBudgetCents === null || parsed.monthlyBudgetCents === 0 ? null : parsed.monthlyBudgetCents)
      : current.monthlyBudgetCents;
  // 0 or null keeps data indefinitely (the retention sweep skips null).
  const retention = (value: number | null | undefined, fallback: number | null) =>
    value === undefined ? fallback : value === null || value === 0 ? null : value;
  const nextArtifactRetention = retention(parsed.artifactRetentionDays, current.artifactRetentionDays);
  const nextRunRetention = retention(parsed.runRetentionDays, current.runRetentionDays);
  const nextRetainVersions = parsed.retainDocumentVersions === undefined ? current.retainDocumentVersions ?? null : parsed.retainDocumentVersions;
  const nextAutoConfirm = parsed.autoConfirmReindex ?? current.autoConfirmReindex ?? false;
  const nextAllowChina = parsed.allowChinaProviders ?? current.allowChinaProviders ?? true;
  const client = options.client ?? sql;

  await client`
    with current_month_spend as (
      select coalesce(sum(au.cost_cents), 0)::double precision as spend_cents
      from ${attributedUsage("month")} au
      where au.workspace_id = ${workspaceId}
    )
    update workspaces
    set
      name = ${parsed.name ?? current.name},
      slug = ${nextSlug},
      template_key = ${parsed.templateKey ?? (parsed.templateKey === null ? null : current.templateKey)},
      system_prompt = ${parsed.systemPrompt ?? (parsed.systemPrompt === null ? null : current.systemPrompt)},
      pipeline = ${sql.json(JSON.parse(JSON.stringify(withoutStageSelection(pipeline))))},
      monthly_budget_cents = ${nextBudget},
      artifact_retention_days = ${nextArtifactRetention},
      run_retention_days = ${nextRunRetention},
      retain_document_versions = ${nextRetainVersions},
      auto_confirm_reindex = ${nextAutoConfirm},
      allow_china_providers = ${nextAllowChina},
      budget_paused = case
        when ${nextBudget}::integer is null then false
        when (select spend_cents from current_month_spend) < ${nextBudget} then false
        else true
      end,
      updated_at = now()
    where id = ${workspaceId}
  `.catch((error: unknown) => {
    // The slug guard trigger rejects current and former slugs of other workspaces.
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new WorkspaceSlugError(`Workspace slug "${nextSlug}" is already taken`, 409);
    }
    throw error;
  });

  if (parsed.allowChinaProviders !== undefined) forgetWorkspaceProviderPolicy(workspaceId);
  return options.client ? current : await getWorkspace(workspaceId, userId);
}

async function mutateWorkspaceArchiveState(args: {
  workspaceId: string;
  userId: string;
  confirmationText: string;
  action: WorkspaceMutationAction;
}): Promise<WorkspaceRecord> {
  const current = await getWorkspace(args.workspaceId, args.userId);
  const access = await getWorkspaceAccess(args.workspaceId, args.userId);
  if (!current || !access) {
    throw new Error("Workspace not found");
  }

  if (!canManageWorkspace(access, args.userId)) {
    throw new Error("Forbidden");
  }

  if (current.isDefault && args.action === "archive") {
    throw new Error("The default workspace cannot be archived");
  }

  assertWorkspaceConfirmation(current.name, args.confirmationText);

  await sql`
    update workspaces
    set
      archived_at = ${args.action === "archive" ? new Date().toISOString() : null},
      updated_at = now()
    where id = ${args.workspaceId}
  `;

  const updated = await getWorkspace(args.workspaceId, args.userId);
  if (!updated) {
    throw new Error("Workspace not found");
  }

  return updated;
}

export async function archiveWorkspace(
  workspaceId: string,
  userId: string,
  confirmationText: string
): Promise<WorkspaceRecord> {
  return await mutateWorkspaceArchiveState({
    workspaceId,
    userId,
    confirmationText,
    action: "archive"
  });
}

export async function restoreWorkspace(
  workspaceId: string,
  userId: string,
  confirmationText: string
): Promise<WorkspaceRecord> {
  return await mutateWorkspaceArchiveState({
    workspaceId,
    userId,
    confirmationText,
    action: "restore"
  });
}

export async function deleteWorkspace(
  workspaceId: string,
  userId: string,
  confirmationText: string
): Promise<DeletedWorkspaceRecord> {
  const current = await getWorkspace(workspaceId, userId);
  const access = await getWorkspaceAccess(workspaceId, userId);
  if (!current || !access) {
    throw new Error("Workspace not found");
  }

  if (!canManageWorkspace(access, userId)) {
    throw new Error("Forbidden");
  }

  if (current.isDefault) {
    throw new Error("The default workspace cannot be deleted");
  }

  assertWorkspaceConfirmation(current.name, confirmationText);

  // Stop in-flight runs, then delete documents in batches and the workspace.
  // The delete triggers enqueue LanceDB and object-storage cleanup for every
  // document and run (docs/data-deletion.md).
  await cancelWorkspaceRuns([workspaceId], "Workspace deleted");
  await deleteWorkspaceData(workspaceId);

  return {
    id: current.id,
    orgId: current.orgId,
    userId: current.userId,
    name: current.name,
    archivedAt: current.archivedAt
  };
}

export async function cloneWorkspace(
  workspaceId: string,
  userId: string,
  name?: string
): Promise<WorkspaceRecord> {
  const current = await getWorkspace(workspaceId, userId);
  if (!current) {
    throw new Error("Workspace not found");
  }

  const access = await assertWorkspaceAccess(workspaceId, userId);
  if (!canEditWorkspace(access, userId)) {
    throw new Error("Forbidden");
  }

  return await createWorkspace({
    userId,
    orgId: current.orgId,
    name: name?.trim() || buildClonedWorkspaceName(current.name),
    templateKey: current.templateKey ?? undefined,
    systemPrompt: current.systemPrompt,
    pipeline: current.pipeline,
  });
}

export async function listWorkspaceVersions(
  workspaceId: string,
  userId: string
): Promise<WorkspaceVersionRecord[]> {
  await assertWorkspaceAccess(workspaceId, userId);

  const rows = await sql<WorkspaceVersionRow[]>`
    select
      id,
      user_id,
      action,
      metadata,
      created_at::text
    from audit_log
    where workspace_id = ${workspaceId}
      and action in ('workspace.created', 'workspace.updated', 'workspace.rollback', 'workspace.cloned')
    order by created_at desc
    limit 50
  `;

  return rows
    .map((row) => {
      const snapshot = readWorkspaceVersionSnapshot(row.metadata);
      if (!snapshot) {
        return null;
      }

      return {
        id: row.id,
        userId: row.user_id,
        action: row.action,
        note: typeof row.metadata?.note === "string" ? row.metadata.note : null,
        sourceVersionId: typeof row.metadata?.sourceVersionId === "string" ? row.metadata.sourceVersionId : null,
        snapshot,
        createdAt: row.created_at,
      } satisfies WorkspaceVersionRecord;
    })
    .filter((row): row is WorkspaceVersionRecord => row !== null);
}

export async function rollbackWorkspaceVersion(
  workspaceId: string,
  userId: string,
  versionId: string
): Promise<WorkspaceRecord> {
  const access = await assertWorkspaceAccess(workspaceId, userId);
  if (!canEditWorkspace(access, userId)) {
    throw new Error("Forbidden");
  }

  const [row] = await sql<WorkspaceVersionRow[]>`
    select
      id,
      user_id,
      action,
      metadata,
      created_at::text
    from audit_log
    where id = ${versionId}
      and workspace_id = ${workspaceId}
    limit 1
  `;

  if (!row) {
    throw new Error("Workspace version not found");
  }

  const snapshot = readWorkspaceVersionSnapshot(row.metadata);
  if (!snapshot) {
    throw new Error("Workspace version is missing a rollback snapshot");
  }

  const updated = await updateWorkspace(workspaceId, userId, {
    name: snapshot.name,
    templateKey: snapshot.templateKey,
    systemPrompt: snapshot.systemPrompt,
    pipeline: snapshot.pipeline,
  });

  if (!updated) {
    throw new Error("Workspace not found");
  }

  return updated;
}

export async function getWorkspaceCockpit(
  workspaceId: string,
  userId: string
): Promise<WorkspaceCockpitRecord> {
  await assertWorkspaceAccess(workspaceId, userId);

  // Corpus totals come from trigger-maintained counters (completed, not
  // superseded). Failed/active counts are ingest state; processed pages and
  // cost-per-page stay run-based below.
  const [summaryRow] = await sql<Array<Record<string, number>>>`
    select
      coalesce(cs.document_count, 0)::int as total_documents,
      coalesce(cs.document_count, 0)::int as completed_documents,
      coalesce(cs.page_count, 0)::int as total_pages,
      coalesce((
        select count(*)::int
        from documents d
        where d.workspace_id = w.id
          and d.status = 'failed'
          and d.superseded_at is null
      ), 0) as failed_documents,
      coalesce((
        select count(*)::int
        from documents d
        where d.workspace_id = w.id
          and d.status not in ('completed', 'failed', 'cancelled', 'pii_blocked')
      ), 0) as active_documents,
      -- documents.chunk_count is trigger-maintained (migration 0063).
      coalesce((
        select sum(docs.chunk_count)::int
        from documents docs
        where docs.workspace_id = w.id
          and docs.status = 'completed'
          and docs.superseded_at is null
      ), 0) as chunk_count,
      coalesce((
        select count(distinct dt.tag)::int
        from document_tags dt
        join documents docs on docs.id = dt.document_id
        where docs.workspace_id = w.id
          and docs.superseded_at is null
      ), 0) as tag_count,
      (
        coalesce((
          select sum(octet_length(c.text))
          from document_chunks c
          join documents docs on docs.id = c.document_id
          where docs.workspace_id = w.id
            and docs.status = 'completed'
            and docs.superseded_at is null
        ), 0)
        + coalesce((
          select sum(octet_length(p.text))
          from document_pages p
          join documents pd on pd.id = p.document_id
          where pd.workspace_id = w.id
            and pd.status = 'completed'
            and pd.superseded_at is null
        ), 0)
      )::double precision as indexed_bytes
    from workspaces w
    left join workspace_corpus_stats cs on cs.workspace_id = w.id
    where w.id = ${workspaceId}
  `;

  const [runSummaryRow] = await sql<Array<Record<string, number>>>`
    select
      coalesce(count(*)::int, 0) as total_runs,
      coalesce(count(*) filter (where status = 'queued' and kind <> 'materialize')::int, 0) as queued_runs,
      coalesce(count(*) filter (where status = 'processing')::int, 0) as processing_runs,
      coalesce(count(*) filter (where status = 'completed')::int, 0) as completed_runs,
      coalesce(count(*) filter (where status = 'failed')::int, 0) as failed_runs,
      coalesce(sum(pages_processed)::int, 0) as processed_pages,
      coalesce(
        avg(extract(epoch from (updated_at - created_at)) * 1000)
        filter (where status = 'completed'),
        0
      )::int as avg_completed_run_ms
    from workspace_runs
    where workspace_id = ${workspaceId}
  `;

  const [telemetryRow] = await sql<Array<Record<string, number>>>`
    select
      coalesce((
        select count(*)::int
        from search_sessions s
        where s.metadata ->> 'workspaceId' = ${workspaceId}
      ), 0) as search_sessions,
      coalesce((
        select count(*)::int
        from audit_log a
        where a.workspace_id = ${workspaceId}
          and a.action = 'workspace.chat.requested'
      ), 0) as chat_sessions
  `;

  const recentRunsRows = await sql<WorkspaceRunRow[]>`
    select
      r.id,
      r.org_id,
      r.user_id,
      r.workspace_id,
      w.name as workspace_name,
      r.kind,
      r.status,
      r.stage,
      r.total_documents,
      r.processed_documents,
      r.pages_total,
      r.pages_processed,
      r.pipeline,
      r.stats,
      r.artifacts,
      r.error,
      r.created_at::text,
      r.updated_at::text
    from workspace_runs r
    join workspaces w on w.id = r.workspace_id
    where r.workspace_id = ${workspaceId}
    order by r.created_at desc
    limit 8
  `;

  const [activeRunRow] = await sql<WorkspaceRunRow[]>`
    select
      r.id,
      r.org_id,
      r.user_id,
      r.workspace_id,
      w.name as workspace_name,
      r.kind,
      r.status,
      r.stage,
      r.total_documents,
      r.processed_documents,
      r.pages_total,
      r.pages_processed,
      r.pipeline,
      r.stats,
      r.artifacts,
      r.error,
      r.created_at::text,
      r.updated_at::text
    from workspace_runs r
    join workspaces w on w.id = r.workspace_id
    where r.workspace_id = ${workspaceId}
      and r.status in ('queued', 'processing')
    order by r.created_at desc
    limit 1
  `;

  const stageRows = await sql<StageHotspotRow[]>`
    select
      s.stage_name,
      count(*)::int as total_states,
      count(*) filter (where s.status = 'failed')::int as failed_states,
      coalesce(
        avg(
          extract(epoch from (coalesce(s.completed_at, s.updated_at) - coalesce(s.started_at, s.updated_at))) * 1000
        ),
        0
      )::int as avg_duration_ms,
      max(s.updated_at)::text as last_seen_at
    from workspace_run_stage_states s
    join workspace_runs r on r.id = s.run_id
    where r.workspace_id = ${workspaceId}
    group by s.stage_name
    order by failed_states desc, total_states desc, max(s.updated_at) desc
    limit 8
  `;

  const [budgetRow] = await sql<
    Array<{
      monthly_budget_cents: number | null;
      budget_alert_level: number;
      budget_paused: boolean;
      month_spend_cents: number;
    }>
  >`
    select
      w.monthly_budget_cents,
      w.budget_alert_level,
      coalesce(w.budget_paused, false) as budget_paused,
      coalesce((
        select sum(au.cost_cents)::double precision
        from ${attributedUsage("month")} au
        where au.workspace_id = w.id
      ), 0)::double precision as month_spend_cents
    from workspaces w
    where w.id = ${workspaceId}
    group by w.id
  `;

  const costSummary = (await listWorkspaceBoardSummaries([workspaceId])).get(workspaceId);

  const monthlyBudget = budgetRow?.monthly_budget_cents ?? null;
  const monthlySpend = budgetRow?.month_spend_cents ?? 0;

  return {
    workspaceId,
    budget: {
      monthlyBudgetCents: monthlyBudget,
      monthlySpendCents: monthlySpend,
      remainingCents: monthlyBudget !== null ? Math.max(monthlyBudget - monthlySpend, 0) : null,
      alertLevel: budgetRow?.budget_alert_level ?? 0,
      budgetPaused: budgetRow?.budget_paused ?? false,
    },
    summary: {
      totalCostCents: costSummary?.totalCostCents,
      recordedCostCents: costSummary?.recordedCostCents,
      computeCostCents: costSummary?.computeCostCents,
      baseFeeCostCents: costSummary?.baseFeeCostCents,
      totalDocuments: summaryRow?.total_documents ?? 0,
      completedDocuments: summaryRow?.completed_documents ?? 0,
      failedDocuments: summaryRow?.failed_documents ?? 0,
      activeDocuments: summaryRow?.active_documents ?? 0,
      totalRuns: runSummaryRow?.total_runs ?? 0,
      queuedRuns: runSummaryRow?.queued_runs ?? 0,
      processingRuns: runSummaryRow?.processing_runs ?? 0,
      completedRuns: runSummaryRow?.completed_runs ?? 0,
      failedRuns: runSummaryRow?.failed_runs ?? 0,
      totalPages: summaryRow?.total_pages ?? 0,
      processedPages: runSummaryRow?.processed_pages ?? 0,
      chunkCount: summaryRow?.chunk_count ?? 0,
      tagCount: summaryRow?.tag_count ?? 0,
      indexedBytes: summaryRow?.indexed_bytes ?? 0,
      avgCompletedRunMs: runSummaryRow?.avg_completed_run_ms ?? 0,
      pagesPerDollar: (costSummary?.totalCostCents ?? 0) > 0
        ? Number(runSummaryRow?.processed_pages ?? 0) * 100 / costSummary!.totalCostCents!
        : 0,
      costPerThousandPagesCents: Number(runSummaryRow?.processed_pages ?? 0) > 0
        ? (costSummary?.totalCostCents ?? 0) * 1000 / Number(runSummaryRow!.processed_pages)
        : 0,
      searchSessions: Number(telemetryRow?.search_sessions ?? 0),
      chatSessions: Number(telemetryRow?.chat_sessions ?? 0),
    },
    activeRun: activeRunRow ? (await withRunCosts([mapWorkspaceRun(activeRunRow)]))[0]! : null,
    recentRuns: await withRunCosts(recentRunsRows.map(mapWorkspaceRun)),
    stageHotspots: stageRows.map((row) => ({
      stage: row.stage_name,
      totalStates: row.total_states,
      failedStates: row.failed_states,
      avgDurationMs: row.avg_duration_ms ?? 0,
      lastSeenAt: row.last_seen_at,
    })),
  };
}

export async function getWorkspaceTraceFeed(
  workspaceId: string,
  userId: string,
  limit = 12
): Promise<WorkspaceTraceFeed> {
  await assertWorkspaceAccess(workspaceId, userId);

  const searches = await sql<SearchTraceRow[]>`
      select
        s.id,
        s.query,
        s.variant,
        s.result_count,
        s.metadata,
        s.created_at::text,
        coalesce(tokens.input_tokens, 0)::int as input_tokens,
        coalesce(tokens.output_tokens, 0)::int as output_tokens,
        coalesce(top_results.top_citations, '[]'::jsonb) as top_citations
      from search_sessions s
      left join lateral (
        select jsonb_agg(
          jsonb_build_object(
            'filename', ranked.filename,
            'pageNumber', ranked.page_number,
            'score', ranked.score
          )
          order by ranked.rank
        ) as top_citations
        from (
          select d.filename, c.page_number, ssr.score, ssr.rank
          from search_session_results ssr
          join document_chunks c on c.id = ssr.chunk_id
          join documents d on d.id = c.document_id
          where ssr.session_id = s.id and d.workspace_id = ${workspaceId}
          order by ssr.rank asc
          limit 4
        ) ranked
      ) top_results on true
      left join lateral ${sessionTokenUsage(userId, sql`s.id`)} tokens on true
      where s.user_id = ${userId}
        and (
          s.metadata ->> 'workspaceId' = ${workspaceId}
          or exists (
            select 1
            from search_session_results sx
            join document_chunks cx on cx.id = sx.chunk_id
            join documents dx on dx.id = cx.document_id
            where sx.session_id = s.id and dx.workspace_id = ${workspaceId}
          )
        )
      order by s.created_at desc
      limit ${limit}
  `;

  const chats = await sql<ChatTraceRow[]>`
    select
      id,
      metadata,
      created_at::text
    from audit_log
    where user_id = ${userId}
      and workspace_id = ${workspaceId}
      and action = 'workspace.chat.requested'
    order by created_at desc
    limit ${limit}
  `;

  return {
    searches: searches.map((row) => {
      const filters =
        row.metadata?.filters && typeof row.metadata.filters === "object"
          ? (row.metadata.filters as Record<string, unknown>)
          : {};

      return {
        id: row.id,
        kind: "search",
        query: isProtectedStoredQuery(row.query) ? "Private query" : row.query,
        variant: row.variant,
        resultCount: row.result_count,
        filters,
        effectiveQuery: typeof row.metadata?.effectiveQuery === "string" ? row.metadata.effectiveQuery : null,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        topCitations: row.top_citations ?? [],
        createdAt: row.created_at,
      } satisfies WorkspaceSearchTrace;
    }),
    chats: chats.map((row) => {
      const metadata = jsonRecord(row.metadata);
      const topCitations = Array.isArray(metadata.topCitations)
        ? metadata.topCitations.filter((item): item is {
            documentId?: string;
            chunkIndex?: number;
            filename: string;
            pageNumber: number | null;
            score: number;
            regionBox?: { pageNumber: number; x: number; y: number; width: number; height: number } | null;
            regionCoordinateSpace?: string | null;
            sourceTrace?: Record<string, unknown> | null;
          } => {
            if (!item || typeof item !== "object") {
              return false;
            }

            const filename = (item as { filename?: unknown }).filename;
            const pageNumber = (item as { pageNumber?: unknown }).pageNumber;
            const score = (item as { score?: unknown }).score;
            const region = (item as { regionBox?: unknown }).regionBox;
            const chunkIndex = (item as { chunkIndex?: unknown }).chunkIndex;
            const regionCoordinateSpace = (item as { regionCoordinateSpace?: unknown }).regionCoordinateSpace;
            const sourceTrace = (item as { sourceTrace?: unknown }).sourceTrace;
            const validRegion =
              region === undefined ||
              region === null ||
              (typeof region === "object" &&
                typeof (region as { pageNumber?: unknown }).pageNumber === "number" &&
                typeof (region as { x?: unknown }).x === "number" &&
                typeof (region as { y?: unknown }).y === "number" &&
                typeof (region as { width?: unknown }).width === "number" &&
                typeof (region as { height?: unknown }).height === "number");

            return (
              typeof filename === "string"
              && (typeof pageNumber === "number" || pageNumber === null)
              && (chunkIndex === undefined || typeof chunkIndex === "number")
              && typeof score === "number"
              && (regionCoordinateSpace === undefined || regionCoordinateSpace === null || typeof regionCoordinateSpace === "string")
              && (sourceTrace === undefined || sourceTrace === null || typeof sourceTrace === "object")
              && validRegion
            );
          })
        : [];

      return {
        id: row.id,
        kind: "chat",
        query: typeof metadata.query === "string" ? metadata.query : "",
        searchSessionId: typeof metadata.searchSessionId === "string" ? metadata.searchSessionId : null,
        citations: typeof metadata.citations === "number" ? metadata.citations : 0,
        model: typeof metadata.model === "string" ? metadata.model : null,
        fallback: metadata.fallback === true,
        topCitations,
        createdAt: row.created_at,
      } satisfies WorkspaceChatTrace;
    }),
  };
}
