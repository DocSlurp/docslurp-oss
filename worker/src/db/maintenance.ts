import { randomUUID } from "node:crypto";

import { defaultPipelineFeatures, normalizeStoredPipelineFeatures } from "@docslurp/shared";
import type { Sql } from "postgres";

import { lockProjectGraph } from "../graph/graph-store.js";
import type { ProjectRun } from "../models.js";
import { collectOrphanedStorageKeys, keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";

import { appendAuditLog } from "./audit-log.js";
import { escapeHtml, recordNotificationEvent } from "./run-notifications.js";
import { TableExistence } from "./sql-helpers.js";
import {
  drainDocumentCleanupQueue,
  drainStorageCleanupQueue,
  purgeSupersededDocuments,
  refreshKnowledgeGraphNodes,
  type PurgeStorage,
  type SupersededPurgeOptions,
  type SupersededPurgeResult,
} from "./superseded-purge.js";

type BudgetAlertRow = {
  scope_id: string;
  scope_name: string;
  org_id: string | null;
  project_id: string | null;
  owner_user_id: string;
  owner_email: string;
  monthly_budget_cents: number;
  budget_alert_threshold_percent: number;
  budget_alert_level: number;
  budget_paused: boolean;
  spend_cents: number;
  cost_alert: boolean | null;
};

type ArtifactRetentionRow = {
  run_id: string;
  user_id: string;
  org_id: string | null;
  project_id: string;
  project_name: string;
  source_keys: string[] | null;
  run_artifact_uris: string[] | null;
  stage_artifact_uris: string[] | null;
};

type RunRetentionRow = {
  run_id: string;
  user_id: string;
  org_id: string | null;
  project_id: string;
  project_name: string;
};

type StorageReferenceRow = {
  reference_kind: string;
  reference_key: string | null;
  run_id: string | null;
  document_id: string | null;
  project_id: string | null;
  org_id: string | null;
  user_id: string | null;
  reference_source: string | null;
};

type StorageIntegrityRunRow = {
  run_id: string;
  user_id: string;
  org_id: string | null;
  project_id: string;
  status: string;
  pipeline: Partial<ProjectRun["pipeline"]> | null;
};

type CountByRunRow = {
  run_id: string;
  count: number;
};

type StorageReference = {
  kind: string;
  key: string;
  runId: string | null;
  documentId: string | null;
  projectId: string | null;
  orgId: string | null;
  userId: string | null;
  source: string | null;
};

type StorageIntegrityRunCheck = {
  runId: string;
  userId: string;
  orgId: string | null;
  projectId: string;
  status: string;
  pipeline: Partial<ProjectRun["pipeline"]> | null;
  documentCount: number;
  chunkCount: number;
  vectorIndexCount: number;
  summaryCount: number;
  propositionCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  chunkEntityCount: number;
  communityCount: number;
};

export type StorageIntegrityFinding = {
  kind:
    | "missing-storage-object"
    | "orphaned-storage-object"
    | "missing-index-rows"
    | "missing-vector-index-metadata"
    | "missing-summary-rows"
    | "missing-proposition-rows"
    | "missing-graph-rows";
  severity: "warning" | "error";
  key?: string;
  runId?: string | null;
  documentId?: string | null;
  projectId?: string | null;
  orgId?: string | null;
  userId?: string | null;
  referenceKind?: string | null;
  referenceSource?: string | null;
  message: string;
  metadata: Record<string, unknown>;
};

export type StorageIntegrityReport = {
  generatedAt: string;
  reportKey: string | null;
  reportUri: string | null;
  sweep: {
    bucket: string;
    prefix: string | null;
    maxKeys: number;
    listedKeys: number;
    listedKeysTruncated: boolean;
    nextContinuationToken: string | null;
    expectedReferenceCount: number;
    checkedReferenceCount: number;
    checkedReferenceTruncated: boolean;
  };
  summary: {
    findingCount: number;
    missingObjectCount: number;
    orphanedObjectCount: number;
    danglingMetadataCount: number;
    affectedRuns: number;
    affectedDocuments: number;
  };
  findings: StorageIntegrityFinding[];
};

/**
 * Maintenance: the worker's periodic sweeps, run by the maintenance loop (temporal/worker.ts) and never by pipeline stages.
 * Retention (expired artifacts, runs and operational logs), the storage integrity sweep, superseded-version purges, and
 * budget and secret-expiry alerts. Each sweep owns its SQL and keeps every statement scoped by the row it acts on.
 */
export class Maintenance {
  private readonly apiKeyUsageRetentionDays: number;
  private readonly perfLogRetentionDays: number;
  private readonly tables: TableExistence;

  constructor(
    private readonly sql: Sql<Record<string, unknown>>,
    options?: {
      apiKeyUsageRetentionDays?: number;
      perfLogRetentionDays?: number;
    },
  ) {
    this.apiKeyUsageRetentionDays = Math.max(
      1,
      options?.apiKeyUsageRetentionDays ?? 30,
    );
    this.perfLogRetentionDays = Math.max(
      1,
      options?.perfLogRetentionDays ?? 90,
    );
    this.tables = new TableExistence(sql);
  }

  async purgeSupersededDocuments(
    storage: PurgeStorage,
    options: SupersededPurgeOptions,
  ): Promise<SupersededPurgeResult> {
    // Replaced versions, then deleted documents, then deleted runs' storage
    // prefixes and dropped org vector tables; all clean storage and LanceDB.
    const superseded = await purgeSupersededDocuments(this.sql, storage, options);
    const deleted = await drainDocumentCleanupQueue(this.sql, storage, options);
    const prefixes = await drainStorageCleanupQueue(this.sql, storage, options);
    return {
      purged: superseded.purged + deleted.purged + prefixes.purged,
      failed: superseded.failed + deleted.failed + prefixes.failed,
      ...(superseded.archived ? { archived: superseded.archived } : {}),
    };
  }

  async processBudgetAlerts(): Promise<void> {
    await this.processProjectBudgetAlerts();
    await this.processOrganizationBudgetAlerts();
  }

  async processSecretExpiryAlerts(daysBefore = 7): Promise<void> {
    type ExpiringSecretRow = {
      id: string;
      project_id: string;
      name: string;
      type: string;
      expires_at: string;
      project_name: string;
      owner_user_id: string;
      owner_email: string;
    };

    const rows = await this.sql<ExpiringSecretRow[]>`
      select
        ws.id,
        ws.project_id,
        ws.name,
        ws.type,
        ws.expires_at::text,
        w.name as project_name,
        w.user_id as owner_user_id,
        u.email as owner_email
      from project_secrets ws
      join projects w on w.id = ws.project_id
      join "user" u on u.id = w.user_id
      where ws.expires_at is not null
        and ws.expires_at <= now() + (${daysBefore} * interval '1 day')
        and ws.expires_at > now()
      order by ws.expires_at asc
    `;

    for (const row of rows) {
      const daysLeft = Math.ceil(
        (new Date(row.expires_at).getTime() - Date.now()) /
          (1000 * 60 * 60 * 24),
      );
      const subject = `Secret expiring soon: ${row.name} (${row.project_name})`;
      const text = [
        `Project: ${row.project_name}`,
        `Secret name: ${row.name}`,
        `Type: ${row.type}`,
        `Expires: ${row.expires_at} (in ${daysLeft} day${daysLeft === 1 ? "" : "s"})`,
        `Rotate this secret in project settings before it expires.`,
      ].join("\n");
      const html = `<p>${text.replaceAll("\n", "<br/>")}</p>`;

      await recordNotificationEvent(this.sql, {
        deliveryId: randomUUID(),
        userId: row.owner_user_id,
        orgId: null,
        projectId: row.project_id,
        event: "cost.alert",
        recipient: row.owner_email,
        subject,
        text,
        html,
        metadata: {
          secretId: row.id,
          secretName: row.name,
          expiresAt: row.expires_at,
          daysLeft,
        },
      });

      console.log(
        `[secrets] expiry-warning secretId=${row.id} name=${row.name} project=${row.project_name} daysLeft=${daysLeft}`,
      );
    }
  }

  async runRetentionSweep(
    storage: ArtifactStore,
    batchSize: number,
  ): Promise<void> {
    await this.purgeExpiredArtifacts(storage, batchSize);
    await this.deleteExpiredRuns(batchSize);
    await this.pruneOperationalLogs();
  }

  async runStorageIntegritySweep(
    storage: ArtifactStore,
    options?: {
      maxKeys?: number;
      prefix?: string | null;
    },
  ): Promise<StorageIntegrityReport> {
    const maxKeys = Math.max(100, options?.maxKeys ?? 20_000);
    const prefix = options?.prefix?.trim() || null;
    const [references, runChecks, listedKeys] = await Promise.all([
      this.loadStorageIntegrityReferences(storage.bucket),
      this.loadStorageIntegrityRunChecks(),
      storage.listKeys({ prefix: prefix ?? undefined, maxKeys }),
    ]);

    const expectedKeySet = new Set(
      references
        .filter((reference) => !prefix || reference.key.startsWith(prefix))
        .map((reference) => reference.key),
    );
    const checkedReferences = Array.from(expectedKeySet).slice(0, maxKeys);
    // Existence comes from listing each run's prefix (`<user>/<run>/`) completely:
    // one LIST per run instead of a HEAD per artifact, with no reliance on listing
    // order. Keys a complete listing lacks are confirmed with a HEAD before they
    // count as missing; prefixes too large to list, and keys without one, are HEADed.
    const existingKeySet = new Set<string>();
    const { byPrefix, ungrouped } = groupReferencesByRunPrefix(checkedReferences);
    const needsHead = [...ungrouped];
    let listCalls = 0;
    const prefixes = [...byPrefix.entries()];
    for (let index = 0; index < prefixes.length; index += 8) {
      await Promise.all(prefixes.slice(index, index + 8).map(async ([runPrefix, keys]) => {
        const listing = await storage.listKeys({ prefix: runPrefix, maxKeys: 10_000 }).catch(() => null);
        listCalls += 1;
        if (!listing || listing.truncated) { needsHead.push(...keys); return; }
        const listed = new Set(listing.keys);
        for (const key of keys) {
          if (listed.has(key)) existingKeySet.add(key);
          else needsHead.push(key);
        }
      }));
    }

    for (let index = 0; index < needsHead.length; index += 25) {
      const batch = needsHead.slice(index, index + 25);
      const results = await Promise.all(
        batch.map(async (key) => ({
          key,
          exists: await storage.objectExists(key),
        })),
      );

      for (const result of results) {
        if (result.exists) {
          existingKeySet.add(result.key);
        }
      }
    }
    console.log(`[storage-integrity] references=${checkedReferences.length} run_prefixes=${byPrefix.size} list_calls=${listCalls} head_checks=${needsHead.length}`);

    const baseReport = buildStorageIntegrityReport({
      bucket: storage.bucket,
      prefix,
      maxKeys,
      references,
      runChecks,
      listedKeys: listedKeys.keys,
      listedKeysTruncated: listedKeys.truncated,
      nextContinuationToken: listedKeys.nextContinuationToken,
      checkedKeys: checkedReferences,
      existingKeys: existingKeySet,
    });

    const reportKey = `system/integrity/${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`;
    const persistedReport: StorageIntegrityReport = {
      ...baseReport,
      reportKey,
      reportUri: storage.uri(reportKey),
    };
    await storage.putJson(reportKey, persistedReport);

    await appendAuditLog(this.sql, {
      action: "maintenance.storage_integrity_sweep",
      resourceType: "maintenance",
      resourceId: reportKey,
      metadata: {
        reportUri: persistedReport.reportUri,
        ...persistedReport.summary,
        sweep: persistedReport.sweep,
      },
    });

    console.log(
      `[integrity-sweep] bucket=${storage.bucket} prefix=${prefix ?? "all"} missing=${persistedReport.summary.missingObjectCount} orphaned=${persistedReport.summary.orphanedObjectCount} dangling=${persistedReport.summary.danglingMetadataCount} report=${persistedReport.reportUri}`,
    );

    return persistedReport;
  }

  private async pruneOperationalLogs(): Promise<void> {
    await this.sql`
      delete from api_key_usage
      where minute_bucket < now() - make_interval(days => ${this.apiKeyUsageRetentionDays})
    `;

    await this.sql`
      delete from performance_log
      where created_at < now() - make_interval(days => ${this.perfLogRetentionDays})
    `;
  }

  /**
   * Native search's cached eligible sets (server search/eligible-documents.ts,
   * channel `search_eligibility`) drop these projects now instead of after
   * their TTL: they serve LanceDB rows without re-reading Postgres.
   */
  private async notifySearchEligibilityChanged(projectIds: ReadonlyArray<string | null | undefined>): Promise<void> {
    const ids = [...new Set(projectIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return;
    await this.sql`select pg_notify('search_eligibility', ${JSON.stringify({ projectIds: ids })})`;
  }

  /**
   * Remove the graph evidence of a run's documents (chunk mentions, edge
   * evidence and extraction state) before retention drops their chunks or the
   * run itself, then re-derive the touched nodes and edges. Facts that other
   * documents still support survive with recomputed weights and counts;
   * communities that lost a member or an internal relation are deleted with
   * their summaries (see `refreshKnowledgeGraphNodes`).
   */
  private async removeRunGraphContributions(projectId: string, runId: string): Promise<void> {
    if (!(await this.tableExists("kg_nodes"))) return;
    await this.sql.begin(async (tx) => {
      const client = tx as unknown as Sql<Record<string, unknown>>;
      await lockProjectGraph(client, projectId);
      const affected = await client<{ node_id: string }[]>`
        select ce.node_id from chunk_entities ce
        where ce.project_id = ${projectId} and ce.run_id = ${runId}
        union
        select ce.node_id from chunk_entities ce
        join document_chunks c on c.id = ce.chunk_id
        join documents d on d.id = c.document_id
        where d.run_id = ${runId}
        union
        select e.source_node_id from kg_edge_evidence ev
        join kg_edges e on e.id = ev.edge_id
        join documents d on d.id = ev.document_id
        where d.run_id = ${runId}
        union
        select e.target_node_id from kg_edge_evidence ev
        join kg_edges e on e.id = ev.edge_id
        join documents d on d.id = ev.document_id
        where d.run_id = ${runId}
      `;
      await client`
        delete from chunk_entities
        where (project_id = ${projectId} and run_id = ${runId})
          or chunk_id in (
            select c.id from document_chunks c join documents d on d.id = c.document_id where d.run_id = ${runId}
          )
      `;
      await client`
        delete from kg_edge_evidence where document_id in (select id from documents where run_id = ${runId})
      `;
      await client`
        delete from kg_document_state where document_id in (select id from documents where run_id = ${runId})
      `;
      await refreshKnowledgeGraphNodes(client, affected.map((row) => row.node_id));
    });
  }

  private async loadStorageIntegrityReferences(
    bucket: string,
  ): Promise<StorageReference[]> {
    const rows = await this.sql.unsafe<StorageReferenceRow[]>(
      `
      select
        'document-source' as reference_kind,
        d.source_key as reference_key,
        d.run_id,
        d.id as document_id,
        d.project_id,
        d.org_id,
        d.user_id,
        d.filename as reference_source
      from documents d
      union all
      select
        'run-artifact' as reference_kind,
        artifact.value as reference_key,
        r.id as run_id,
        null::text as document_id,
        r.project_id,
        r.org_id,
        r.user_id,
        artifact.key as reference_source
      from project_runs r
      join lateral jsonb_each_text(coalesce(r.artifacts, '{}'::jsonb)) as artifact(key, value) on true
      union all
      select
        'stage-artifact' as reference_kind,
        states.artifact_uri as reference_key,
        states.run_id,
        states.document_id,
        runs.project_id,
        runs.org_id,
        runs.user_id,
        states.stage_name as reference_source
      from (
        select run_id, null::text as document_id, stage_name, artifact_uri
        from project_run_stage_states
        where artifact_uri is not null
        union all
        select run_id, document_id, stage_name, artifact_uri
        from document_run_stage_states
        where artifact_uri is not null
      ) states
      join project_runs runs on runs.id = states.run_id
      union all
      select
        'vector-index' as reference_kind,
        case when vi.bucket = $1 then vi.path else null end as reference_key,
        d.run_id,
        d.id as document_id,
        d.project_id,
        d.org_id,
        d.user_id,
        vi.embedding_model as reference_source
      from vector_indexes vi
      join documents d on d.id = vi.document_id
      `,
      [bucket],
    );

    return rows
      .map((row) => ({
        kind: row.reference_kind,
        key: keyFromStorageUri(row.reference_key ?? "", bucket),
        runId: row.run_id,
        documentId: row.document_id,
        projectId: row.project_id,
        orgId: row.org_id,
        userId: row.user_id,
        source: row.reference_source,
      }))
      .filter((row): row is StorageReference => Boolean(row.key));
  }

  private async loadStorageIntegrityRunChecks(): Promise<
    StorageIntegrityRunCheck[]
  > {
    const runs = await this.sql<StorageIntegrityRunRow[]>`
      select
        id as run_id,
        user_id,
        org_id,
        project_id,
        status,
        pipeline
      from project_runs
      where status in ('completed', 'failed')
    `;

    const documentCounts = new Map<string, number>(
      (
        await this.sql<CountByRunRow[]>`
        select run_id, count(*)::int as count
        from documents
        where run_id is not null
        group by run_id
      `
      ).map((row) => [row.run_id, row.count]),
    );
    const chunkCounts = new Map<string, number>(
      (
        await this.sql<CountByRunRow[]>`
        select run_id, count(*)::int as count
        from document_chunks
        group by run_id
      `
      ).map((row) => [row.run_id, row.count]),
    );
    const vectorIndexCounts = new Map<string, number>(
      (
        await this.sql<CountByRunRow[]>`
        select d.run_id, count(distinct vi.document_id)::int as count
        from vector_indexes vi
        join documents d on d.id = vi.document_id
        where d.run_id is not null
        group by d.run_id
      `
      ).map((row) => [row.run_id, row.count]),
    );
    const summaryCounts = new Map<string, number>(
      (
        await this.sql<CountByRunRow[]>`
        select run_id, count(*)::int as count
        from document_summaries
        group by run_id
      `
      ).map((row) => [row.run_id, row.count]),
    );

    const propositionCounts = (await this.tableExists("document_propositions"))
      ? new Map<string, number>(
          (
            await this.sql<CountByRunRow[]>`
            select run_id, count(*)::int as count
            from document_propositions
            group by run_id
          `
          ).map((row) => [row.run_id, row.count]),
        )
      : new Map<string, number>();
    const graphNodeCounts = (await this.tableExists("kg_nodes"))
      ? new Map<string, number>(
          (
            await this.sql<CountByRunRow[]>`
            select run_id, count(*)::int as count
            from kg_nodes
            group by run_id
          `
          ).map((row) => [row.run_id, row.count]),
        )
      : new Map<string, number>();
    const graphEdgeCounts = (await this.tableExists("kg_edges"))
      ? new Map<string, number>(
          (
            await this.sql<CountByRunRow[]>`
            select run_id, count(*)::int as count
            from kg_edges
            group by run_id
          `
          ).map((row) => [row.run_id, row.count]),
        )
      : new Map<string, number>();
    const chunkEntityCounts = (await this.tableExists("chunk_entities"))
      ? new Map<string, number>(
          (
            await this.sql<CountByRunRow[]>`
            select run_id, count(*)::int as count
            from chunk_entities
            group by run_id
          `
          ).map((row) => [row.run_id, row.count]),
        )
      : new Map<string, number>();
    const communityCounts = (await this.tableExists("kg_communities"))
      ? new Map<string, number>(
          (
            await this.sql<CountByRunRow[]>`
            select run_id, count(*)::int as count
            from kg_communities
            group by run_id
          `
          ).map((row) => [row.run_id, row.count]),
        )
      : new Map<string, number>();

    return runs.map((run) => ({
      runId: run.run_id,
      userId: run.user_id,
      orgId: run.org_id,
      projectId: run.project_id,
      status: run.status,
      pipeline: run.pipeline,
      documentCount: documentCounts.get(run.run_id) ?? 0,
      chunkCount: chunkCounts.get(run.run_id) ?? 0,
      vectorIndexCount: vectorIndexCounts.get(run.run_id) ?? 0,
      summaryCount: summaryCounts.get(run.run_id) ?? 0,
      propositionCount: propositionCounts.get(run.run_id) ?? 0,
      graphNodeCount: graphNodeCounts.get(run.run_id) ?? 0,
      graphEdgeCount: graphEdgeCounts.get(run.run_id) ?? 0,
      chunkEntityCount: chunkEntityCounts.get(run.run_id) ?? 0,
      communityCount: communityCounts.get(run.run_id) ?? 0,
    }));
  }

  private async purgeExpiredArtifacts(
    storage: ArtifactStore,
    batchSize: number,
  ): Promise<void> {
    const rows = await this.sql.unsafe<ArtifactRetentionRow[]>(
      `
      select
        r.id as run_id,
        r.user_id,
        r.org_id,
        r.project_id,
        w.name as project_name,
        -- Quarantine's scanned parse copies (migration 0134) are run artifacts and go with them.
        array_remove(array_agg(distinct d.source_key) || array_agg(distinct d.parse_source_key), null) as source_keys,
        array_remove(
          array_agg(distinct artifact_value.value) filter (where artifact_value.value is not null),
          null
        ) as run_artifact_uris,
        array_remove(
          array_agg(distinct stage_uri.value) filter (where stage_uri.value is not null),
          null
        ) as stage_artifact_uris
      from project_runs r
      join projects w on w.id = r.project_id
      left join documents d on d.run_id = r.id
      left join lateral jsonb_each_text(coalesce(r.artifacts, '{}'::jsonb)) as artifact_value(key, value) on true
      left join lateral (
        select wrss.artifact_uri as value
        from project_run_stage_states wrss
        where wrss.run_id = r.id
        union all
        select drss.artifact_uri as value
        from document_run_stage_states drss
        where drss.run_id = r.id
      ) as stage_uri on true
      where w.artifact_retention_days is not null
        and r.status in ('completed', 'failed')
        and r.artifacts_purged_at is null
        and r.created_at < now() - make_interval(days => w.artifact_retention_days)
        -- A partial reprocess still seeding from or running on this run's
        -- documents reads their artifacts; purge once it reaches a terminal state.
        and not exists (
          select 1
          from documents source
          join documents reusing on reusing.reused_from_document_id = source.id
          join project_runs reusing_run on reusing_run.id = reusing.run_id
          where source.run_id = r.id
            and reusing_run.status not in ('completed', 'failed')
        )
      group by r.id, r.user_id, r.org_id, r.project_id, w.name
      order by r.created_at asc
      limit $1
      `,
      [Math.max(1, batchSize)],
    );

    for (const row of rows) {
      // Revoke source reads before external deletion. A failed purge retries
      // cleanup, but cannot make content eligible for materialization again.
      await this.sql`update documents set materialization_generation = materialization_generation + 1,
        source_materialization_blocked = true where run_id = ${row.run_id}`;
      const keys = new Set<string>();

      for (const sourceKey of row.source_keys ?? []) {
        const normalized = keyFromStorageUri(sourceKey, storage.bucket);
        if (normalized) {
          keys.add(normalized);
        }
      }

      for (const uri of [
        ...(row.run_artifact_uris ?? []),
        ...(row.stage_artifact_uris ?? []),
      ]) {
        const normalized = keyFromStorageUri(uri, storage.bucket);
        if (normalized) {
          keys.add(normalized);
        }
      }

      // Embedding reuse pointers into this run's embedding artifacts go with them.
      const artifactUris = [...(row.run_artifact_uris ?? []), ...(row.stage_artifact_uris ?? [])];
      if (artifactUris.length > 0 && (await this.tableExists("embedding_reuse_refs"))) {
        await this.sql`delete from embedding_reuse_refs where artifact_uri = any(${this.sql.array(artifactUris)}::text[])`;
      }
      await storage.deleteKeys([...keys]);

      if (await this.tableExists("document_page_states")) {
        // A kept model read (read_text) is page content too: a later query must not republish it. The billing
        // decision (read_billed_run) stays, so the page is never charged again.
        await this.sql`
          update document_page_states s
          set read_text = null
          from documents d
          where d.id = s.document_id and d.run_id = ${row.run_id} and s.read_text is not null
        `;
      }

      if (await this.tableExists("document_propositions")) {
        await this.sql`
          delete from document_propositions
          where run_id = ${row.run_id}
        `;
      }
      await this.removeRunGraphContributions(row.project_id, row.run_id);
      if (await this.tableExists("document_summaries")) {
        await this.sql`
          delete from document_summaries
          where run_id = ${row.run_id}
        `;
      }
      if (await this.tableExists("document_summary_trees")) {
        // The summary tree is derived from this run's chunks. Its registry rows go here; its rows in the project's
        // summaries table go with the vector targets handed to the cleanup sweep below (strict delete).
        await this.sql`
          delete from document_summary_tree_nodes
          where document_id in (select id from documents where run_id = ${row.run_id})
        `;
        await this.sql`
          delete from document_summary_trees
          where document_id in (select id from documents where run_id = ${row.run_id})
        `;
      }
      if (await this.tableExists("document_chunks")) {
        await this.sql`
          delete from document_chunks
          where run_id = ${row.run_id}
        `;
      }
      if (await this.tableExists("document_pages")) {
        await this.sql`
          delete from document_pages
          where run_id = ${row.run_id}
        `;
      }
      if (await this.tableExists("vector_indexes")) {
        // The documents stay, but their LanceDB rows must go too: hand the
        // vector targets to the cleanup sweep before the index rows vanish.
        await this.sql`
          insert into document_cleanup_queue (
            document_id, org_id, user_id, project_id, run_id, source_key, delete_source, vector_targets
          )
          select d.id, coalesce(d.org_id, ${row.org_id ?? ""}), d.user_id, d.project_id, d.run_id, d.source_key, false,
            jsonb_agg(distinct jsonb_build_object(
              'backend', vi.backend, 'embeddingModel', vi.embedding_model, 'dimension', vi.dimension))
          from documents d
          join vector_indexes vi on vi.document_id = d.id
          where d.run_id = ${row.run_id}
          group by d.id
          on conflict (document_id) do nothing
        `;
        await this.sql`
          delete from vector_indexes
          where document_id in (
            select id
            from documents
            where run_id = ${row.run_id}
          )
        `;
      }
      await this.sql`
        update project_runs
        set
          artifacts_purged_at = now(),
          updated_at = now()
        where id = ${row.run_id}
      `;
      await this.notifySearchEligibilityChanged([row.project_id]);

      await appendAuditLog(this.sql, {
        orgId: row.org_id,
        userId: row.user_id,
        projectId: row.project_id,
        runId: row.run_id,
        action: "retention.artifacts_purged",
        resourceType: "project_run",
        resourceId: row.run_id,
        metadata: {
          projectName: row.project_name,
          deletedObjectCount: keys.size,
        },
      });
    }
  }

  private async deleteExpiredRuns(batchSize: number): Promise<void> {
    const rows = await this.sql.unsafe<RunRetentionRow[]>(
      `
      select
        r.id as run_id,
        r.user_id,
        r.org_id,
        r.project_id,
        w.name as project_name
      from project_runs r
      join projects w on w.id = r.project_id
      where w.run_retention_days is not null
        and r.status in ('completed', 'failed')
        and r.created_at < now() - make_interval(days => w.run_retention_days)
        -- As for artifact retention: a partial reprocess still seeding from or
        -- running on this run's documents needs them; delete once it is terminal.
        and not exists (
          select 1
          from documents source
          join documents reusing on reusing.reused_from_document_id = source.id
          join project_runs reusing_run on reusing_run.id = reusing.run_id
          where source.run_id = r.id
            and reusing_run.status not in ('completed', 'failed')
        )
      order by r.created_at asc
      limit $1
      `,
      [Math.max(1, batchSize)],
    );

    for (const row of rows) {
      await appendAuditLog(this.sql, {
        orgId: row.org_id,
        userId: row.user_id,
        projectId: row.project_id,
        runId: row.run_id,
        action: "retention.run_deleted",
        resourceType: "project_run",
        resourceId: row.run_id,
        metadata: {
          projectName: row.project_name,
        },
      });

      // A deleted run takes its documents and artifacts with it, whether or
      // not artifact retention already purged them. The documents and
      // project_runs BEFORE DELETE triggers enqueue LanceDB, raw-source and
      // run-prefix cleanup for the worker sweep (docs/data-deletion.md).
      await this.removeRunGraphContributions(row.project_id, row.run_id);
      await this.sql.begin(async (tx) => {
        const client = tx as unknown as Sql<Record<string, unknown>>;
        // Newer versions in other runs keep a valid (null) predecessor link.
        await client`
          update documents set previous_version_id = null
          where previous_version_id in (select id from documents where run_id = ${row.run_id})
            and run_id is distinct from ${row.run_id}
        `;
        await client`delete from documents where run_id = ${row.run_id}`;
        await client`delete from project_runs where id = ${row.run_id}`;
      });
      await this.notifySearchEligibilityChanged([row.project_id]);
    }
  }

  private async processProjectBudgetAlerts(): Promise<void> {
    const rows = await this.sql.unsafe<BudgetAlertRow[]>(
      `
      select
        w.id as scope_id,
        w.name as scope_name,
        w.org_id,
        w.id as project_id,
        w.user_id as owner_user_id,
        u.email as owner_email,
        w.monthly_budget_cents,
        w.budget_alert_threshold_percent,
        w.budget_alert_level,
        w.budget_paused,
        -- floor, not the cast's rounding: 99.5 cents must not trip a 100-cent cap (the live check compares exactly).
        floor(coalesce(spend.cost_cents, 0))::integer as spend_cents,
        np.cost_alert
      from projects w
      join "user" u on u.id = w.user_id
      left join notification_prefs np on np.user_id = w.user_id
      -- The shared attribution rule (usage_attribution view, migration 0042).
      left join (
        select au.project_id, sum(au.cost_cents)::double precision as cost_cents
        from usage_attribution au
        where au.created_at >= date_trunc('month', now())
          and au.project_id in (
            select id from projects where monthly_budget_cents is not null and monthly_budget_cents > 0
          )
        group by au.project_id
      ) spend on spend.project_id = w.id
      where w.monthly_budget_cents is not null
        and w.monthly_budget_cents > 0
      group by
        w.id,
        w.name,
        w.org_id,
        w.user_id,
        u.email,
        w.monthly_budget_cents,
        w.budget_alert_threshold_percent,
        w.budget_alert_level,
        w.budget_paused,
        spend.cost_cents,
        np.cost_alert
      `,
    );

    for (const row of rows) {
      const nextLevel = resolveBudgetAlertLevel(
        row.spend_cents,
        row.monthly_budget_cents,
        row.budget_alert_threshold_percent,
      );
      // A budget change resets budget_paused but not the level, so compare both.
      if (nextLevel === row.budget_alert_level && row.budget_paused === nextLevel >= 100) {
        continue;
      }

      await this.sql`
        update projects
        set
          budget_alert_level = ${nextLevel},
          budget_paused = ${nextLevel >= 100},
          budget_alert_updated_at = case when ${nextLevel} > 0 then now() else null end,
          updated_at = now()
        where id = ${row.scope_id}
      `;

      if (nextLevel > row.budget_alert_level && row.cost_alert !== false) {
        await this.sendBudgetAlertEmail({
          scope: "project",
          scopeId: row.scope_id,
          scopeName: row.scope_name,
          orgId: row.org_id,
          projectId: row.project_id,
          userId: row.owner_user_id,
          recipient: row.owner_email,
          spendCents: row.spend_cents,
          budgetCents: row.monthly_budget_cents,
          alertLevel: nextLevel,
          thresholdPercent: row.budget_alert_threshold_percent,
        });
      }
    }
  }

  private async processOrganizationBudgetAlerts(): Promise<void> {
    const rows = await this.sql.unsafe<BudgetAlertRow[]>(
      `
      select
        o.id as scope_id,
        o.name as scope_name,
        o.id as org_id,
        null::text as project_id,
        o.created_by_user_id as owner_user_id,
        u.email as owner_email,
        o.monthly_budget_cents,
        o.budget_alert_threshold_percent,
        o.budget_alert_level,
        o.budget_paused,
        floor(coalesce(spend.cost_cents, 0))::integer as spend_cents,
        np.cost_alert
      from organizations o
      join "user" u on u.id = o.created_by_user_id
      left join notification_prefs np on np.user_id = o.created_by_user_id
      -- The shared attribution rule (usage_attribution view, migration 0042):
      -- includes run-less search and chat spend whose writer stamped no org.
      left join (
        select au.org_id, sum(au.cost_cents)::double precision as cost_cents
        from usage_attribution au
        where au.created_at >= date_trunc('month', now())
        group by au.org_id
      ) spend on spend.org_id = o.id
      where o.monthly_budget_cents is not null
        and o.monthly_budget_cents > 0
      group by
        o.id,
        o.name,
        o.created_by_user_id,
        u.email,
        o.monthly_budget_cents,
        o.budget_alert_threshold_percent,
        o.budget_alert_level,
        o.budget_paused,
        spend.cost_cents,
        np.cost_alert
      `,
    );

    for (const row of rows) {
      const nextLevel = resolveBudgetAlertLevel(
        row.spend_cents,
        row.monthly_budget_cents,
        row.budget_alert_threshold_percent,
      );
      // A budget change resets budget_paused but not the level, so compare both.
      if (nextLevel === row.budget_alert_level && row.budget_paused === nextLevel >= 100) {
        continue;
      }

      await this.sql`
        update organizations
        set
          budget_alert_level = ${nextLevel},
          budget_paused = ${nextLevel >= 100},
          budget_alert_updated_at = case when ${nextLevel} > 0 then now() else null end,
          updated_at = now()
        where id = ${row.scope_id}
      `;

      if (nextLevel > row.budget_alert_level && row.cost_alert !== false) {
        await this.sendBudgetAlertEmail({
          scope: "organization",
          scopeId: row.scope_id,
          scopeName: row.scope_name,
          orgId: row.org_id,
          projectId: null,
          userId: row.owner_user_id,
          recipient: row.owner_email,
          spendCents: row.spend_cents,
          budgetCents: row.monthly_budget_cents,
          alertLevel: nextLevel,
          thresholdPercent: row.budget_alert_threshold_percent,
        });
      }
    }
  }

  private async sendBudgetAlertEmail(args: {
    scope: "project" | "organization";
    scopeId: string;
    scopeName: string;
    orgId: string | null;
    projectId: string | null;
    userId: string;
    recipient: string;
    spendCents: number;
    budgetCents: number;
    alertLevel: number;
    thresholdPercent: number;
  }): Promise<void> {
    const exceeded = args.alertLevel >= 100;
    const subject = exceeded
      ? `Budget exceeded: ${args.scopeName}`
      : `Budget alert: ${args.scopeName}`;
    const remainingCents = Math.max(args.budgetCents - args.spendCents, 0);
    const lines = [
      `${args.scope === "project" ? "Project" : "Organization"}: ${args.scopeName}`,
      `Scope ID: ${args.scopeId}`,
      `Spend this month: ${formatCurrency(args.spendCents)}`,
      `Budget this month: ${formatCurrency(args.budgetCents)}`,
      `Remaining budget: ${formatCurrency(remainingCents)}`,
      exceeded
        ? "Status: new runs are blocked until spend drops below the monthly cap."
        : `Status: monthly spend crossed ${args.thresholdPercent}% of budget.`,
    ];

    await recordNotificationEvent(this.sql, {
      deliveryId: randomUUID(),
      userId: args.userId,
      orgId: args.orgId,
      projectId: args.projectId,
      event: "cost.alert",
      recipient: args.recipient,
      subject,
      text: lines.join("\n"),
      html: `<p>${lines.map((line) => escapeHtml(line)).join("<br />")}</p>`,
      metadata: {
        scope: args.scope,
        scopeId: args.scopeId,
        spendCents: args.spendCents,
        budgetCents: args.budgetCents,
        alertLevel: args.alertLevel,
        thresholdPercent: args.thresholdPercent,
      },
    });
  }

  private tableExists(tableName: string): Promise<boolean> {
    return this.tables.exists(tableName);
  }
}

export function resolveBudgetAlertLevel(
  spendCents: number,
  budgetCents: number | null,
  thresholdPercent: number,
): number {
  if (!budgetCents || budgetCents <= 0) {
    return 0;
  }

  if (spendCents >= budgetCents) {
    return 100;
  }

  const warningThreshold = Math.ceil((budgetCents * thresholdPercent) / 100);
  return spendCents >= warningThreshold ? thresholdPercent : 0;
}

export function buildStorageIntegrityReport(args: {
  bucket: string;
  prefix: string | null;
  maxKeys: number;
  references: StorageReference[];
  runChecks: StorageIntegrityRunCheck[];
  listedKeys: string[];
  listedKeysTruncated: boolean;
  nextContinuationToken: string | null;
  checkedKeys: string[];
  existingKeys: Set<string>;
}): StorageIntegrityReport {
  const generatedAt = new Date().toISOString();
  const referencesByKey = new Map<string, StorageReference[]>();

  for (const reference of args.references) {
    if (args.prefix && !reference.key.startsWith(args.prefix)) {
      continue;
    }

    const existing = referencesByKey.get(reference.key) ?? [];
    existing.push(reference);
    referencesByKey.set(reference.key, existing);
  }

  const findings: StorageIntegrityFinding[] = [];
  for (const key of args.checkedKeys) {
    if (args.existingKeys.has(key)) {
      continue;
    }

    const references = referencesByKey.get(key) ?? [];
    const reference = references[0] ?? null;
    findings.push({
      kind: "missing-storage-object",
      severity: "error",
      key,
      runId: reference?.runId ?? null,
      documentId: reference?.documentId ?? null,
      projectId: reference?.projectId ?? null,
      orgId: reference?.orgId ?? null,
      userId: reference?.userId ?? null,
      referenceKind: reference?.kind ?? null,
      referenceSource: reference?.source ?? null,
      message: `Expected ${reference?.kind ?? "storage"} object is missing from ${args.bucket}.`,
      metadata: {
        bucket: args.bucket,
        referenceCount: references.length,
      },
    });
  }

  const expectedKeySet = new Set(referencesByKey.keys());
  for (const key of collectOrphanedStorageKeys(
    args.listedKeys,
    expectedKeySet,
  )) {
    findings.push({
      kind: "orphaned-storage-object",
      severity: "warning",
      key,
      message: `Storage object is not referenced by documents, run artifacts, stage artifacts, or vector index metadata.`,
      metadata: {
        bucket: args.bucket,
      },
    });
  }

  for (const run of args.runChecks) {
    if (run.status !== "completed" || run.documentCount === 0) {
      continue;
    }

    const pipeline = normalizeStoredPipelineFeatures(run.pipeline ?? defaultPipelineFeatures, `run ${run.runId}`);
    if ((pipeline.embed || pipeline.indexVectors) && run.chunkCount === 0) {
      findings.push({
        kind: "missing-index-rows",
        severity: "error",
        runId: run.runId,
        projectId: run.projectId,
        orgId: run.orgId,
        userId: run.userId,
        message:
          "Completed run is missing document chunk rows even though vector indexing was enabled.",
        metadata: {
          documentCount: run.documentCount,
          chunkCount: run.chunkCount,
          vectorIndexCount: run.vectorIndexCount,
        },
      });
    } else if (
      (pipeline.embed || pipeline.indexVectors) &&
      run.vectorIndexCount === 0
    ) {
      findings.push({
        kind: "missing-vector-index-metadata",
        severity: "warning",
        runId: run.runId,
        projectId: run.projectId,
        orgId: run.orgId,
        userId: run.userId,
        message:
          "Completed run has chunk rows but no vector index metadata records.",
        metadata: {
          documentCount: run.documentCount,
          chunkCount: run.chunkCount,
          vectorIndexCount: run.vectorIndexCount,
        },
      });
    }

    if (pipeline.summarize && run.summaryCount === 0) {
      findings.push({
        kind: "missing-summary-rows",
        severity: "warning",
        runId: run.runId,
        projectId: run.projectId,
        orgId: run.orgId,
        userId: run.userId,
        message:
          "Completed run enabled summaries but no document summary rows were found.",
        metadata: {
          documentCount: run.documentCount,
          summaryCount: run.summaryCount,
        },
      });
    }

    if (pipeline.propositionIndex && run.propositionCount === 0) {
      findings.push({
        kind: "missing-proposition-rows",
        severity: "warning",
        runId: run.runId,
        projectId: run.projectId,
        orgId: run.orgId,
        userId: run.userId,
        message:
          "Completed run enabled proposition indexing but no proposition rows were found.",
        metadata: {
          documentCount: run.documentCount,
          propositionCount: run.propositionCount,
        },
      });
    }

    if (
      (pipeline.graphRag ||
        pipeline.entityIndex ||
        pipeline.graphCommunitySummaries) &&
      run.graphNodeCount === 0 &&
      run.graphEdgeCount === 0 &&
      run.chunkEntityCount === 0 &&
      run.communityCount === 0
    ) {
      findings.push({
        kind: "missing-graph-rows",
        severity: "warning",
        runId: run.runId,
        projectId: run.projectId,
        orgId: run.orgId,
        userId: run.userId,
        message:
          "Completed run enabled graph features but no graph/entity rows were found.",
        metadata: {
          graphNodeCount: run.graphNodeCount,
          graphEdgeCount: run.graphEdgeCount,
          chunkEntityCount: run.chunkEntityCount,
          communityCount: run.communityCount,
        },
      });
    }
  }

  const affectedRuns = new Set(
    findings.map((finding) => finding.runId).filter(Boolean),
  );
  const affectedDocuments = new Set(
    findings.map((finding) => finding.documentId).filter(Boolean),
  );
  const missingObjectCount = findings.filter(
    (finding) => finding.kind === "missing-storage-object",
  ).length;
  const orphanedObjectCount = findings.filter(
    (finding) => finding.kind === "orphaned-storage-object",
  ).length;
  const danglingMetadataCount =
    findings.length - missingObjectCount - orphanedObjectCount;

  return {
    generatedAt,
    reportKey: null,
    reportUri: null,
    sweep: {
      bucket: args.bucket,
      prefix: args.prefix,
      maxKeys: args.maxKeys,
      listedKeys: args.listedKeys.length,
      listedKeysTruncated: args.listedKeysTruncated,
      nextContinuationToken: args.nextContinuationToken,
      expectedReferenceCount: expectedKeySet.size,
      checkedReferenceCount: args.checkedKeys.length,
      checkedReferenceTruncated: expectedKeySet.size > args.checkedKeys.length,
    },
    summary: {
      findingCount: findings.length,
      missingObjectCount,
      orphanedObjectCount,
      danglingMetadataCount,
      affectedRuns: affectedRuns.size,
      affectedDocuments: affectedDocuments.size,
    },
    findings,
  };
}

function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function groupReferencesByRunPrefix(keys: string[]): { byPrefix: Map<string, string[]>; ungrouped: string[] } {
  const byPrefix = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const key of keys) {
    const parts = key.split("/");
    if (parts.length < 3 || !parts[0] || !parts[1]) { ungrouped.push(key); continue; }
    const prefix = `${parts[0]}/${parts[1]}/`;
    const list = byPrefix.get(prefix);
    if (list) list.push(key);
    else byPrefix.set(prefix, [key]);
  }
  return { byPrefix, ungrouped };
}
