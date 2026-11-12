import { resolveGeoDocumentScope } from "./geo-scope.js";
import {
  defaultProjectSearchSettings,
  normalizePipelineFeatures,
  normalizeStoredPipelineFeatures,
  privacyModeAllowsHosted,
  type PrivacyMode,
  type PipelineFeatures,
  type ProjectSearchSettings,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { resolveOpenRouterApiKey, SEARCH_OPENROUTER_MODEL } from "../lib/ai.js";
import { hostedApiKeyForProject, openRouterCall } from "../lib/privacy.js";
import { canSpend } from "../services/billing/spend-guard.js";
import { getProjectAccess } from "../services/organizations.js";
import { currentRequestApiKeyProjectIds } from "../lib/request-context.js";
import { getProjectSearchSettings, parseProjectSearchSettingsRow, type SettingsRow } from "../services/search-controls.js";
import { loadCachedSearchAvailability, searchLanceDbNativeEnabled } from "./eligible-documents.js";
import type { SearchOptions } from "../services/search.js";
import { createSearchSessionJournal, searchSessionWriteBehindEnabled, type SearchSessionJournal } from "./session.js";
import { resolveProjectRetrievalControls } from "./project-retrieval-session.js";
import { parseIndexConfigs, type IndexConfigMap } from "./index-serving.js";
import { earlyLexicalDocument, fullyIndexedDocument, servableInProgressVersion } from "./eligibility.js";
import { clampKeywordOnly, searchIsKeywordOnly } from "./keyword-only.js";

/**
 * The project does not exist or the caller may not see it (the two are indistinguishable by design).
 * The message stays "Project not found" for routes that still match it; new code tests `instanceof`.
 */
export class ProjectNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(message = "Project not found") {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

/** A retrieval scope spanning more than one project (HTTP 400). */
export class CrossProjectScopeError extends Error {
  constructor() {
    super("Search scope must stay within a single project");
    this.name = "CrossProjectScopeError";
  }
}

export class MissingProjectScopeError extends Error {
  constructor() {
    super(
      "Retrieval requires a projectId filter or a narrower run/document scope.",
    );
    this.name = "MissingProjectScopeError";
  }
}

export interface SearchSetup {
  session: SearchSessionJournal;
  normalizedScope: SearchProjectScope;
  projectSettings: ProjectSearchSettings;
  /** Undefined when privacyMode forbids hosted LLM strategies for this project. */
  openRouterApiKey: string | undefined;
  rerankApiKey?: string;
  availabilityRow: SearchAvailabilityRow | undefined;
  resolvedOptions: SearchOptions;
  projectPipeline: PipelineFeatures;
  /** Index configs live documents are built with (hash -> config); one entry or none means a single index. */
  indexConfigs: IndexConfigMap;
  privacyMode: PrivacyMode;
  /** SEARCH_LANCEDB_NATIVE for this project: lexical, vector and hydration come from LanceDB. */
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

type ProjectPipelineRow = {
  pipeline: PipelineFeatures | null;
  index_configs?: unknown;
};

export async function resolveSearchSetup(
  userId: string,
  options: SearchOptions,
): Promise<SearchSetup> {
  const requestedProjectId = options.filters?.projectId?.trim();
  const lanceNative = searchLanceDbNativeEnabled(requestedProjectId);
  let normalizedScope: SearchProjectScope;
  let projectSettings: ProjectSearchSettings;
  let projectIndexing: { pipeline: PipelineFeatures; indexConfigs: IndexConfigMap };
  if (lanceNative && requestedProjectId) {
    // Access, settings and pipeline in one round trip (never cached: they decide authorization and privacy).
    ({ scope: normalizedScope, settings: projectSettings, indexing: projectIndexing } =
      await loadSearchProjectContext(requestedProjectId, userId));
  } else {
    normalizedScope = await normalizeSearchScope({ userId, options });
    // Independent lookups run together: each is a database round trip.
    [projectSettings, projectIndexing] = await Promise.all([
      getProjectSearchSettings(normalizedScope.projectId, userId).catch(() => ({
        ...defaultProjectSearchSettings,
        projectId: normalizedScope.projectId,
        userId,
      })),
      loadProjectIndexing(normalizedScope.projectId),
    ]);
  }
  if (options.filters?.geo) {
    options = {...options, filters: await resolveGeoDocumentScope(normalizedScope, options.filters, projectIndexing.pipeline.outputSchema, options.runId),
      summarySeed:false, enableCommunityExpansion:false};
  }
  const session = createSearchSessionJournal({
    rootSessionId: options.rootSessionId,
    scope: normalizedScope,
    writeBehind: searchSessionWriteBehindEnabled(lanceNative),
  });
  const projectPipeline = projectIndexing.pipeline;
  const retrievalControls = resolveProjectRetrievalControls({
    options,
    projectId: normalizedScope.projectId,
    settings: projectSettings,
    pipeline: projectPipeline,
  });
  session.recordDiagnostic("retrievalControls", retrievalControls.diagnostics);
  // A keyword-only key (or caller) is clamped after project defaults, so no project setting re-enables model calls.
  const resolvedOptions = searchIsKeywordOnly(options) ? clampKeywordOnly(retrievalControls.options) : retrievalControls.options;
  if (resolvedOptions.keywordOnly) session.recordDiagnostic("retrievalMode", "keyword");
  const availabilityPromise = (lanceNative ? loadCachedSearchAvailability : loadSearchAvailability)({
    projectId: normalizedScope.projectId,
    runId:
      resolvedOptions.runId?.trim() ||
      resolvedOptions.filters?.runId?.trim() ||
      undefined,
  });
  // Settles with the spend check below; never left unhandled if that throws first.
  availabilityPromise.catch(() => undefined);

  const privacyMode = projectPipeline.privacyMode;
  const wantsHostedStrategies = Boolean(
    resolvedOptions.useHyDE || resolvedOptions.queryRewrite || resolvedOptions.stepback ||
    resolvedOptions.selfQuery || resolvedOptions.useContextualCompression || resolvedOptions.iterativeMultiHop,
  );
  // HyDE, rewrite, stepback, self-query, compression and multi-hop are optional
  // and skip without a key, so a privacy block withholds the key.
  // Keyword-only never holds a model key, so no later step can make a model call.
  const openRouterApiKey = resolvedOptions.keywordOnly
    ? undefined
    : wantsHostedStrategies
    ? await hostedApiKeyForProject({
        apiKey: resolveOpenRouterApiKey(),
        privacyMode,
        projectId: normalizedScope.projectId,
        call: openRouterCall("api.search.strategies", SEARCH_OPENROUTER_MODEL),
      })
    : privacyModeAllowsHosted(privacyMode) ? resolveOpenRouterApiKey() : undefined;
  if (!privacyModeAllowsHosted(privacyMode)) {
    session.recordDiagnostic("privacyMode", { privacyMode, hostedStrategies: "blocked" });
  }
  const rerankApiKey = resolvedOptions.useRerank && resolvedOptions.rerankProvider === "deepinfra"
    ? await hostedApiKeyForProject({
        apiKey: process.env.DEEPINFRA_API_KEY,
        privacyMode, projectId: normalizedScope.projectId,
        call: { provider: "deepinfra", model: "Qwen/Qwen3-Reranker-0.6B", operation: "api.search.rerank", target: "hosted" },
      })
    : undefined;
  // When the org may not spend (credits, budget caps), withhold the key too:
  // retrieval still runs, without model calls.
  const [availabilityRow, spendAllowed] = await Promise.all([
    availabilityPromise,
    (openRouterApiKey || rerankApiKey) ? canSpend(normalizedScope.orgId, normalizedScope.projectId, { kind: "interactive", hold: false }) : true,
  ]);
  if (!spendAllowed) session.recordDiagnostic("aiStrategies", { disabled: "spend_blocked" });

  return {
    session,
    normalizedScope,
    projectSettings,
    openRouterApiKey: spendAllowed ? openRouterApiKey : undefined,
    rerankApiKey: spendAllowed ? rerankApiKey : undefined,
    availabilityRow,
    resolvedOptions,
    projectPipeline,
    indexConfigs: projectIndexing.indexConfigs,
    privacyMode,
    lanceNative,
  };
}

type SearchProjectContextRow = Partial<SettingsRow> & {
  project_id: string;
  org_id: string;
  pipeline: PipelineFeatures | null;
  index_configs: unknown;
  settings_project_id: string | null;
};

/**
 * getProjectAccess + getProjectSearchSettings + loadProjectIndexing as
 * one query, with the same access rule (G-06) and API-key allowlist.
 */
export async function loadSearchProjectContext(projectId: string, userId: string): Promise<{
  scope: SearchProjectScope;
  settings: ProjectSearchSettings;
  indexing: { pipeline: PipelineFeatures; indexConfigs: IndexConfigMap };
}> {
  const [row] = await sql<SearchProjectContextRow[]>`
    select w.id as project_id, w.org_id, w.pipeline, w.index_configs,
      s.project_id as settings_project_id, s.user_id, s.typo_tolerance, s.dedupe_by_filename, s.ranking_rules,
      s.boosts, s.pinned_results, s.synonyms, s.compat_settings, s.rules, s.compat_metadata
    from projects w
    left join project_search_settings s on s.project_id = w.id
    where w.id = ${projectId}
      and docslurp_project_access(w.id, ${userId})
    limit 1
  `;
  const allowlist = currentRequestApiKeyProjectIds();
  if (!row || (allowlist && !allowlist.includes(row.project_id))) throw new ProjectNotFoundError();
  let settings: ProjectSearchSettings;
  try {
    settings = parseProjectSearchSettingsRow(row.settings_project_id ? row as SettingsRow : undefined, row.project_id, userId);
  } catch {
    settings = { ...defaultProjectSearchSettings, projectId: row.project_id, userId };
  }
  let indexing: { pipeline: PipelineFeatures; indexConfigs: IndexConfigMap };
  try {
    indexing = { pipeline: normalizeStoredPipelineFeatures(row.pipeline ?? null, `project ${row.project_id}`), indexConfigs: parseIndexConfigs(row.index_configs) };
  } catch {
    // Fail closed, as loadProjectIndexing does.
    indexing = { pipeline: { ...normalizePipelineFeatures(null), privacyMode: "local-only" }, indexConfigs: {} };
  }
  return { scope: { projectId: row.project_id, orgId: row.org_id }, settings, indexing };
}

export interface SearchProjectScope {
  projectId: string;
  orgId: string;
}

async function resolveSearchProjectScope(args: {
  userId: string;
  runId?: string;
  filters?: SearchOptions["filters"];
}): Promise<SearchProjectScope> {
  const requestedProjectId = args.filters?.projectId?.trim();
  const allowlist = currentRequestApiKeyProjectIds();
  const keyAllowlist = allowlist ? sql.array([...allowlist]) : null;
  if (requestedProjectId) {
    const access = await getProjectAccess(requestedProjectId, args.userId);
    if (!access) {
      throw new ProjectNotFoundError();
    }
    return { projectId: access.projectId, orgId: access.orgId };
  }

  const documentIds = args.filters?.documentIds?.length
    ? args.filters.documentIds
    : args.filters?.documentId
      ? [args.filters.documentId]
      : [];

  if (documentIds.length > 0) {
    const rows = await sql<{ project_id: string; org_id: string }[]>`
      select distinct d.project_id, w.org_id
      from documents d
      join projects w on w.id = d.project_id
      where d.id = any(${sql.array(documentIds)})
        and docslurp_project_access(w.id, ${args.userId})
        and (${keyAllowlist}::text[] is null or w.id = any(${keyAllowlist}::text[]))
    `;

    if (rows.length === 0) {
      throw new ProjectNotFoundError();
    }

    if (rows.length > 1) {
      throw new CrossProjectScopeError();
    }

    return { projectId: rows[0]!.project_id, orgId: rows[0]!.org_id };
  }

  if (args.runId) {
    const [row] = await sql<{ project_id: string; org_id: string }[]>`
      select runs.project_id, w.org_id
      from project_runs runs
      join projects w on w.id = runs.project_id
      where runs.id = ${args.runId}
        and docslurp_project_access(w.id, ${args.userId})
        and (${keyAllowlist}::text[] is null or w.id = any(${keyAllowlist}::text[]))
      limit 1
    `;

    if (!row) {
      throw new ProjectNotFoundError();
    }

    return { projectId: row.project_id, orgId: row.org_id };
  }

  throw new MissingProjectScopeError();
}

async function normalizeSearchScope(args: {
  userId: string;
  options: SearchOptions;
}): Promise<SearchProjectScope> {
  return await resolveSearchProjectScope({
    userId: args.userId,
    runId:
      args.options.runId?.trim() ||
      args.options.filters?.runId?.trim() ||
      undefined,
    filters: args.options.filters,
  });
}

export async function loadSearchAvailability(args: {
  projectId: string;
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
      from project_runs
      where project_id = ${args.projectId}
        and (${args.runId ?? null}::text is null or id = ${args.runId ?? null})
    ),
    scoped_docs as (
      select d.id, d.run_id, d.page_count, d.status, d.project_id, d.canonical_id, d.created_at, d.superseded_at,
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

/** The project pipeline and its recorded index configs in one round trip. */
export async function loadProjectIndexing(
  projectId: string,
): Promise<{ pipeline: PipelineFeatures; indexConfigs: IndexConfigMap }> {
  try {
    const [row] = await sql<ProjectPipelineRow[]>`
      select pipeline, index_configs
      from projects
      where id = ${projectId}
      limit 1
    `;
    return { pipeline: normalizeStoredPipelineFeatures(row?.pipeline ?? null, `project ${projectId}`), indexConfigs: parseIndexConfigs(row?.index_configs) };
  } catch {
    // Fail closed: an unreadable or invalid pipeline must not fall back to the
    // standard (hosted-allowed) default and leak a private project's queries.
    return { pipeline: { ...normalizePipelineFeatures(null), privacyMode: "local-only" }, indexConfigs: {} };
  }
}

export async function loadProjectPipeline(
  projectId: string,
): Promise<PipelineFeatures> {
  return (await loadProjectIndexing(projectId)).pipeline;
}
