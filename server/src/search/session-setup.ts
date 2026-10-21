import {
  defaultWorkspaceSearchSettings,
  normalizePipelineFeatures,
  privacyModeAllowsHosted,
  type PrivacyMode,
  type PipelineFeatures,
  type WorkspaceSearchSettings,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { resolveOpenRouterApiKey, SEARCH_OPENROUTER_MODEL } from "../lib/ai.js";
import { hostedApiKeyForWorkspace, openRouterCall } from "../lib/privacy.js";
import { canSpend } from "../services/billing/spend-guard.js";
import { getWorkspaceAccess } from "../services/organizations.js";
import { currentRequestApiKeyWorkspaceIds } from "../lib/request-context.js";
import { getWorkspaceSearchSettings, parseWorkspaceSearchSettingsRow, type SettingsRow } from "../services/search-controls.js";
import { loadCachedSearchAvailability, searchLanceDbNativeEnabled } from "./eligible-documents.js";
import type { SearchOptions } from "../services/search.js";
import { createSearchSessionJournal, searchSessionWriteBehindEnabled, type SearchSessionJournal } from "./session.js";
import { resolveWorkspaceRetrievalControls } from "./workspace-retrieval-session.js";
import { parseIndexConfigs, type IndexConfigMap } from "./index-serving.js";
import { earlyLexicalDocument, fullyIndexedDocument, servableInProgressVersion } from "./eligibility.js";

export class MissingWorkspaceScopeError extends Error {
  constructor() {
    super(
      "Retrieval requires a workspaceId filter or a narrower run/document scope.",
    );
    this.name = "MissingWorkspaceScopeError";
  }
}

export interface SearchSetup {
  session: SearchSessionJournal;
  normalizedScope: SearchWorkspaceScope;
  workspaceSettings: WorkspaceSearchSettings;
  /** Undefined when privacyMode forbids hosted LLM strategies for this workspace. */
  openRouterApiKey: string | undefined;
  rerankApiKey?: string;
  availabilityRow: SearchAvailabilityRow | undefined;
  resolvedOptions: SearchOptions;
  workspacePipeline: PipelineFeatures;
  /** Index configs live documents are built with (hash -> config); one entry or none means a single index. */
  indexConfigs: IndexConfigMap;
  privacyMode: PrivacyMode;
  /** SEARCH_LANCEDB_NATIVE for this workspace: lexical, vector and hydration come from LanceDB. */
  lanceNative?: boolean;
}

export type SearchAvailabilityRow = {
  total_documents: number;
  indexed_documents: number;
  page_indexed_documents: number;
  /** Served by keyword search ahead of the index stage; no vectors yet. */
  keyword_only_documents?: number;
  /** Served only by progressive page search (page-index done, no chunks served yet). */
  page_only_documents?: number;
  searchable_documents: number;
  in_progress_documents: number;
  failed_documents?: number;
  total_pages: number;
  searchable_pages: number;
  indexed_chunk_count: number;
  queued_runs: number;
  processing_runs: number;
  failed_runs?: number;
  stalled_runs?: number;
};

type WorkspacePipelineRow = {
  pipeline: PipelineFeatures | null;
  index_configs?: unknown;
};

export async function resolveSearchSetup(
  userId: string,
  options: SearchOptions,
): Promise<SearchSetup> {
  const requestedWorkspaceId = options.filters?.workspaceId?.trim();
  const lanceNative = searchLanceDbNativeEnabled(requestedWorkspaceId);
  let normalizedScope: SearchWorkspaceScope;
  let workspaceSettings: WorkspaceSearchSettings;
  let workspaceIndexing: { pipeline: PipelineFeatures; indexConfigs: IndexConfigMap };
  if (lanceNative && requestedWorkspaceId) {
    // Access, settings and pipeline in one round trip (never cached: they decide authorization and privacy).
    ({ scope: normalizedScope, settings: workspaceSettings, indexing: workspaceIndexing } =
      await loadSearchWorkspaceContext(requestedWorkspaceId, userId));
  } else {
    normalizedScope = await normalizeSearchScope({ userId, options });
    // Independent lookups run together: each is a database round trip.
    [workspaceSettings, workspaceIndexing] = await Promise.all([
      getWorkspaceSearchSettings(normalizedScope.workspaceId, userId).catch(() => ({
        ...defaultWorkspaceSearchSettings,
        workspaceId: normalizedScope.workspaceId,
        userId,
      })),
      loadWorkspaceIndexing(normalizedScope.workspaceId),
    ]);
  }
  const session = createSearchSessionJournal({
    rootSessionId: options.rootSessionId,
    scope: normalizedScope,
    writeBehind: searchSessionWriteBehindEnabled(lanceNative),
  });
  const workspacePipeline = workspaceIndexing.pipeline;
  const retrievalControls = resolveWorkspaceRetrievalControls({
    options,
    workspaceId: normalizedScope.workspaceId,
    settings: workspaceSettings,
    pipeline: workspacePipeline,
  });
  session.recordDiagnostic("retrievalControls", retrievalControls.diagnostics);
  const resolvedOptions = retrievalControls.options;
  const availabilityPromise = (lanceNative ? loadCachedSearchAvailability : loadSearchAvailability)({
    workspaceId: normalizedScope.workspaceId,
    runId:
      resolvedOptions.runId?.trim() ||
      resolvedOptions.filters?.runId?.trim() ||
      undefined,
  });
  // Settles with the spend check below; never left unhandled if that throws first.
  availabilityPromise.catch(() => undefined);

  const privacyMode = workspacePipeline.privacyMode;
  const wantsHostedStrategies = Boolean(
    resolvedOptions.useHyDE || resolvedOptions.queryRewrite || resolvedOptions.stepback ||
    resolvedOptions.selfQuery || resolvedOptions.useContextualCompression || resolvedOptions.iterativeMultiHop,
  );
  // HyDE, rewrite, stepback, self-query, compression and multi-hop are optional
  // and skip without a key, so a privacy block withholds the key.
  const openRouterApiKey = wantsHostedStrategies
    ? await hostedApiKeyForWorkspace({
        apiKey: resolveOpenRouterApiKey(),
        privacyMode,
        workspaceId: normalizedScope.workspaceId,
        call: openRouterCall("api.search.strategies", SEARCH_OPENROUTER_MODEL),
      })
    : privacyModeAllowsHosted(privacyMode) ? resolveOpenRouterApiKey() : undefined;
  if (!privacyModeAllowsHosted(privacyMode)) {
    session.recordDiagnostic("privacyMode", { privacyMode, hostedStrategies: "blocked" });
  }
  const rerankApiKey = resolvedOptions.useRerank && resolvedOptions.rerankProvider === "deepinfra"
    ? await hostedApiKeyForWorkspace({
        apiKey: process.env.DEEPINFRA_API_KEY,
        privacyMode, workspaceId: normalizedScope.workspaceId,
        call: { provider: "deepinfra", model: "Qwen/Qwen3-Reranker-0.6B", operation: "api.search.rerank", target: "hosted" },
      })
    : undefined;
  // When the org may not spend (credits, budget caps), withhold the key too:
  // retrieval still runs, without model calls.
  const [availabilityRow, spendAllowed] = await Promise.all([
    availabilityPromise,
    (openRouterApiKey || rerankApiKey) ? canSpend(normalizedScope.orgId, normalizedScope.workspaceId, { kind: "interactive", hold: false }) : true,
  ]);
  if (!spendAllowed) session.recordDiagnostic("aiStrategies", { disabled: "spend_blocked" });

  return {
    session,
    normalizedScope,
    workspaceSettings,
    openRouterApiKey: spendAllowed ? openRouterApiKey : undefined,
    rerankApiKey: spendAllowed ? rerankApiKey : undefined,
    availabilityRow,
    resolvedOptions,
    workspacePipeline,
    indexConfigs: workspaceIndexing.indexConfigs,
    privacyMode,
    lanceNative,
  };
}

type SearchWorkspaceContextRow = Partial<SettingsRow> & {
  workspace_id: string;
  org_id: string;
  pipeline: PipelineFeatures | null;
  index_configs: unknown;
  settings_workspace_id: string | null;
};

/**
 * getWorkspaceAccess + getWorkspaceSearchSettings + loadWorkspaceIndexing as
 * one query, with the same access rule (G-06) and API-key allowlist.
 */
export async function loadSearchWorkspaceContext(workspaceId: string, userId: string): Promise<{
  scope: SearchWorkspaceScope;
  settings: WorkspaceSearchSettings;
  indexing: { pipeline: PipelineFeatures; indexConfigs: IndexConfigMap };
}> {
  const [row] = await sql<SearchWorkspaceContextRow[]>`
    select w.id as workspace_id, w.org_id, w.pipeline, w.index_configs,
      s.workspace_id as settings_workspace_id, s.user_id, s.typo_tolerance, s.dedupe_by_filename, s.ranking_rules,
      s.boosts, s.pinned_results, s.synonyms, s.compat_settings, s.rules, s.compat_metadata
    from workspaces w
    join organizations o on o.id = w.org_id
    left join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
    left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = ${userId}
    left join workspace_search_settings s on s.workspace_id = w.id
    where w.id = ${workspaceId}
      and (
        (om.user_id is not null and (w.user_id = ${userId} or wm.user_id is not null or om.role in ('owner', 'admin') or w.is_default))
        or (wm.user_id is not null and o.is_personal)
      )
    limit 1
  `;
  const allowlist = currentRequestApiKeyWorkspaceIds();
  if (!row || (allowlist && !allowlist.includes(row.workspace_id))) throw new Error("Workspace not found");
  let settings: WorkspaceSearchSettings;
  try {
    settings = parseWorkspaceSearchSettingsRow(row.settings_workspace_id ? row as SettingsRow : undefined, row.workspace_id, userId);
  } catch {
    settings = { ...defaultWorkspaceSearchSettings, workspaceId: row.workspace_id, userId };
  }
  let indexing: { pipeline: PipelineFeatures; indexConfigs: IndexConfigMap };
  try {
    indexing = { pipeline: normalizePipelineFeatures(row.pipeline ?? null), indexConfigs: parseIndexConfigs(row.index_configs) };
  } catch {
    // Fail closed, as loadWorkspaceIndexing does.
    indexing = { pipeline: { ...normalizePipelineFeatures(null), privacyMode: "local-only" }, indexConfigs: {} };
  }
  return { scope: { workspaceId: row.workspace_id, orgId: row.org_id }, settings, indexing };
}

export interface SearchWorkspaceScope {
  workspaceId: string;
  orgId: string;
}

async function resolveSearchWorkspaceScope(args: {
  userId: string;
  runId?: string;
  filters?: SearchOptions["filters"];
}): Promise<SearchWorkspaceScope> {
  const requestedWorkspaceId = args.filters?.workspaceId?.trim();
  const allowlist = currentRequestApiKeyWorkspaceIds();
  const keyAllowlist = allowlist ? sql.array([...allowlist]) : null;
  if (requestedWorkspaceId) {
    const access = await getWorkspaceAccess(requestedWorkspaceId, args.userId);
    if (!access) {
      throw new Error("Workspace not found");
    }
    return { workspaceId: access.workspaceId, orgId: access.orgId };
  }

  const documentIds = args.filters?.documentIds?.length
    ? args.filters.documentIds
    : args.filters?.documentId
      ? [args.filters.documentId]
      : [];

  if (documentIds.length > 0) {
    const rows = await sql<{ workspace_id: string; org_id: string }[]>`
      select distinct d.workspace_id, w.org_id
      from documents d
      join workspaces w on w.id = d.workspace_id
      left join org_memberships om
        on om.org_id = w.org_id
        and om.user_id = ${args.userId}
      left join workspace_members wm
        on wm.workspace_id = w.id
        and wm.user_id = ${args.userId}
      where d.id = any(${sql.array(documentIds)})
        and (
          -- G-06: team-org access always requires org membership; only a
          -- personal org's direct shares stand alone.
          (om.user_id is not null and (w.user_id = ${args.userId} or wm.user_id is not null or om.role in ('owner', 'admin') or w.is_default))
          or (wm.user_id is not null and exists (select 1 from organizations o where o.id = w.org_id and o.is_personal))
        )
        and (${keyAllowlist}::text[] is null or w.id = any(${keyAllowlist}::text[]))
    `;

    if (rows.length === 0) {
      throw new Error("Workspace not found");
    }

    if (rows.length > 1) {
      throw new Error("Search scope must stay within a single workspace");
    }

    return { workspaceId: rows[0]!.workspace_id, orgId: rows[0]!.org_id };
  }

  if (args.runId) {
    const [row] = await sql<{ workspace_id: string; org_id: string }[]>`
      select runs.workspace_id, w.org_id
      from workspace_runs runs
      join workspaces w on w.id = runs.workspace_id
      left join org_memberships om
        on om.org_id = w.org_id
        and om.user_id = ${args.userId}
      left join workspace_members wm
        on wm.workspace_id = w.id
        and wm.user_id = ${args.userId}
      where runs.id = ${args.runId}
        and (
          -- G-06: team-org access always requires org membership; only a
          -- personal org's direct shares stand alone.
          (om.user_id is not null and (w.user_id = ${args.userId} or wm.user_id is not null or om.role in ('owner', 'admin') or w.is_default))
          or (wm.user_id is not null and exists (select 1 from organizations o where o.id = w.org_id and o.is_personal))
        )
        and (${keyAllowlist}::text[] is null or w.id = any(${keyAllowlist}::text[]))
      limit 1
    `;

    if (!row) {
      throw new Error("Workspace not found");
    }

    return { workspaceId: row.workspace_id, orgId: row.org_id };
  }

  throw new MissingWorkspaceScopeError();
}

async function normalizeSearchScope(args: {
  userId: string;
  options: SearchOptions;
}): Promise<SearchWorkspaceScope> {
  return await resolveSearchWorkspaceScope({
    userId: args.userId,
    runId:
      args.options.runId?.trim() ||
      args.options.filters?.runId?.trim() ||
      undefined,
    filters: args.options.filters,
  });
}

export async function loadSearchAvailability(args: {
  workspaceId: string;
  runId?: string;
}): Promise<SearchAvailabilityRow | undefined> {
  // Coverage counts what search actually serves (search/eligibility.ts), not
  // stage checkpoints: a document is indexed when it is `completed` and
  // current, keyword-only when its chunks are served ahead of completion, and
  // page-only when progressive page search covers it.
  //
  // Chunk and page totals come from the trigger-maintained documents.chunk_count
  // and documents.stored_page_count (migration 0063), never from counting
  // document_chunks/document_pages rows: that seq-scanned every tenant's chunks
  // on each search. A document's chunks and pages always carry its run_id.
  const [row] = await sql<SearchAvailabilityRow[]>`
    with scoped_runs as (
      select id, status, lease_expires_at
      from workspace_runs
      where workspace_id = ${args.workspaceId}
        and (${args.runId ?? null}::text is null or id = ${args.runId ?? null})
    ),
    scoped_docs as (
      select d.id, d.run_id, d.page_count, d.status, d.workspace_id, d.canonical_id, d.created_at, d.superseded_at,
        d.stored_page_count, d.chunk_count,
        ${fullyIndexedDocument("d")} as fully_indexed,
        ${earlyLexicalDocument("d")} as keyword_only
      from documents d
      join scoped_runs runs on runs.id = d.run_id
      -- Superseded versions no longer serve search; never count them. PII-blocked
      -- documents are deliberately unsearchable, so they do not make coverage partial.
      where d.superseded_at is null
        and d.status <> 'pii_blocked'
    ),
    page_stage as (
      select distinct states.document_id
      from document_run_stage_states states
      join scoped_runs runs on runs.id = states.run_id
      where states.stage_name = 'page-index'
        and states.status = 'completed'
    ),
    classified as (
      select docs.*,
        runs.status as run_status,
        runs.lease_expires_at,
        page_stage.document_id is not null as page_indexed,
        -- Same eligibility as progressivePageSearch (services/search.ts).
        page_stage.document_id is not null and not docs.fully_indexed and not docs.keyword_only
          and coalesce(docs.stored_page_count, 0) > 0
          and ${servableInProgressVersion("docs")} as page_only,
        coalesce(docs.stored_page_count, 0) as stored_pages
      from scoped_runs runs
      left join scoped_docs docs on docs.run_id = runs.id
      left join page_stage on page_stage.document_id = docs.id
    )
    select
      count(distinct docs.id)::int as total_documents,
      count(distinct docs.id) filter (where docs.fully_indexed)::int as indexed_documents,
      count(distinct docs.id) filter (where docs.page_indexed)::int as page_indexed_documents,
      count(distinct docs.id) filter (where docs.page_only)::int as page_only_documents,
      count(distinct docs.id) filter (where docs.keyword_only)::int as keyword_only_documents,
      count(distinct docs.id) filter (
        where docs.fully_indexed or docs.keyword_only or docs.page_only
      )::int as searchable_documents,
      count(distinct docs.id) filter (
        where coalesce(docs.status, '') not in ('completed', 'failed', 'cancelled')
          and (
            docs.run_status = 'queued'
            or (
              docs.run_status = 'processing'
              and coalesce(docs.lease_expires_at, to_timestamp(0)) >= now()
            )
          )
      )::int as in_progress_documents,
      count(distinct docs.id) filter (
        where coalesce(docs.status, '') = 'failed'
          or docs.run_status = 'failed'
          or (
            docs.run_status = 'processing'
            and coalesce(docs.lease_expires_at, to_timestamp(0)) < now()
          )
      )::int as failed_documents,
      coalesce(sum(docs.page_count), 0)::int as total_pages,
      -- Chunk-searchable documents cover every page; page-only ones the pages stored so far.
      coalesce(sum(
        case
          when docs.fully_indexed or docs.keyword_only then greatest(coalesce(docs.page_count, 0), docs.stored_pages)
          when docs.page_only then docs.stored_pages
          else 0
        end
      ), 0)::int as searchable_pages,
      coalesce(sum(docs.chunk_count) filter (where docs.fully_indexed or docs.keyword_only), 0)::int as indexed_chunk_count,
      (select count(*) from scoped_runs where status = 'queued')::int as queued_runs,
      (
        select count(*) from scoped_runs
        where status = 'processing'
          and coalesce(lease_expires_at, to_timestamp(0)) >= now()
      )::int as processing_runs,
      (select count(*) from scoped_runs where status = 'failed')::int as failed_runs,
      (
        select count(*) from scoped_runs
        where status = 'processing'
          and coalesce(lease_expires_at, to_timestamp(0)) < now()
      )::int as stalled_runs
    from classified docs
  `;

  return row;
}

/** The workspace pipeline and its recorded index configs in one round trip. */
export async function loadWorkspaceIndexing(
  workspaceId: string,
): Promise<{ pipeline: PipelineFeatures; indexConfigs: IndexConfigMap }> {
  try {
    const [row] = await sql<WorkspacePipelineRow[]>`
      select pipeline, index_configs
      from workspaces
      where id = ${workspaceId}
      limit 1
    `;
    return { pipeline: normalizePipelineFeatures(row?.pipeline ?? null), indexConfigs: parseIndexConfigs(row?.index_configs) };
  } catch {
    // Fail closed: an unreadable or invalid pipeline must not fall back to the
    // standard (hosted-allowed) default and leak a private workspace's queries.
    return { pipeline: { ...normalizePipelineFeatures(null), privacyMode: "local-only" }, indexConfigs: {} };
  }
}

export async function loadWorkspacePipeline(
  workspaceId: string,
): Promise<PipelineFeatures> {
  return (await loadWorkspaceIndexing(workspaceId)).pipeline;
}
