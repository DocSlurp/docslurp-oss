import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  DEFAULT_RETAINED_VERSIONS,
  MAX_RETAINED_VERSIONS,
  MIN_RETAINED_VERSIONS,
  resolveLanceDbConfig,
  resolveObjectStorageConfig,
  VectorNamespaceManager,
} from "@docslurp/shared";
import type { Sql } from "postgres";

import { lockWorkspaceGraph, refreshGraphElements } from "../graph/graph-store.js";
import { appendWorkspaceRunEvent } from "./run-event-store.js";
import { keyFromStorageUri } from "../tools/storage.js";
import { connectLanceDb } from "../stages/lancedb-connection.js";
import { deleteLanceDbRecords } from "../stages/lancedb-writer.js";
import { legacyEmbeddingLocations, legacyOrgTable } from "../stages/lancedb-legacy-layout.js";
import { lanceDbMaintenanceSettings, requestLanceDbMaintenance, requireLanceDbMaintenance } from "../stages/lancedb-maintenance.js";

/**
 * Superseded-version purge.
 *
 * When a newer canonical version completes, the supersede trigger hides the
 * old version from search and corpus counts in the same transaction. The old
 * version then sits in a shadow state for a short grace period, so searches
 * already in flight can still read its chunks, before this sweep deletes its
 * derived data: object-storage artifacts, LanceDB rows, and chunk/page/summary
 * rows. The documents row stays as a tombstone for version history, and the raw
 * source upload is kept unless STORAGE_URI sets purgeSupersededSources=true.
 */

/** Per-document derived rows. Tags, corrections, stage states and events are history and stay. */
const DERIVED_TABLES = [
  "document_chunks", // cascades chunk_entities
  "kg_edge_evidence",
  "kg_document_state",
  "document_pages",
  "document_summaries",
  "document_propositions",
  "page_stage_states",
  "page_work_tasks",
  "pii_detections",
  "search_index_staleness",
  "vector_indexes",
  // Deferred indexing: a superseded version is a tombstone, not a delete, so these do not cascade away.
  "document_page_states",
  "document_maps",
  "document_page_vectors",
] as const;

/**
 * Search-only rows removed when a superseded version is archived instead of
 * purged. Archived versions stay browsable (pages, Markdown, page images,
 * summaries, PII detections and history are kept) but are never searchable.
 * Propositions are retrieval units, so they go; grounded summaries and
 * document summaries are reader-facing, so they stay.
 */
const ARCHIVE_TABLES = [
  "document_chunks", // cascades chunk_entities
  "kg_edge_evidence",
  "kg_document_state",
  "document_propositions",
  "search_index_staleness",
  "vector_indexes",
  "document_page_states",
  "document_maps",
  "document_page_vectors",
] as const;

const SAFE_DOCUMENT_ID = /^[A-Za-z0-9_-]+$/;

export interface PurgeStorage {
  bucket: string;
  listKeys(options: { prefix: string; maxKeys?: number }): Promise<{ keys: string[] }>;
  deleteKeys(keys: string[]): Promise<void>;
}

/** Deletes the rows of the given documents from one LanceDB table (one commit). */
export type DeleteVectorRows = (args: {
  uri: string;
  table: string;
  documentIds: string[];
  /**
   * Also compact the table and prune every older version now (cleanupOlderThan: now), so the
   * deleted rows' text and vectors leave the bucket instead of lingering in old fragments for
   * the version-retention window. Set for expired extracts.
   */
  purgeHistory?: boolean;
}) => Promise<void>;

/** Drops a whole LanceDB table (org deletion). Missing tables are not an error. */
export type DropVectorTable = (args: { uri: string; table: string }) => Promise<void>;

export interface SupersededPurgeOptions {
  /** Seconds a superseded version stays readable before its data is deleted. */
  graceSeconds: number;
  batchSize: number;
  deleteSources: boolean;
  lancedbRoot: string;
  deleteVectorRows?: DeleteVectorRows;
  dropVectorTable?: DropVectorTable;
  /** Deletes LanceDB rows by id (`vector_rows` queue entries). Defaults to deleteLanceDbRecords. */
  deleteVectorIds?: (args: { uri: string; table: string; ids: string[] }) => Promise<void>;
  /** Cleanup-queue rows claimed per batch; vector and storage work is grouped per batch. */
  cleanupBatchSize?: number;
}

export interface SupersededPurgeResult {
  purged: number;
  failed: number;
  /** Superseded versions kept browsable (search data removed) within the retention window. */
  archived?: number;
}

type RetentionAction = "archive" | "purge";

/**
 * Chains worth ranking this sweep: those with a superseded version that is not archived yet (still to archive
 * or purge), plus chains in an organization or workspace whose retention setting changed since it was
 * last fully swept (archived versions may now exceed the keep count). Fully archived chains with unchanged
 * settings are never touched, so a sweep stays proportional to pending work, not to total history.
 */
export function retentionCandidateChains(sql: Sql<Record<string, unknown>>) {
  return sql`
    select distinct d.workspace_id, coalesce(d.canonical_id, 'legacy:' || d.id) as chain_key
    from documents d
    join organizations o on o.id = d.org_id
    left join workspaces w on w.id = d.workspace_id
    where d.superseded_at is not null and d.purged_at is null
      and (
        d.archived_at is null
        -- No live row left (the current version was deleted): archived predecessors still need purging.
        or not exists (
          select 1 from documents live
          where live.workspace_id = d.workspace_id
            and coalesce(live.canonical_id, 'legacy:' || live.id) = coalesce(d.canonical_id, 'legacy:' || d.id)
            and live.superseded_at is null and live.purged_at is null
        )
        or o.retention_changed_at > coalesce(o.retention_swept_at, '-infinity'::timestamptz)
        or w.retention_changed_at > coalesce(w.retention_swept_at, '-infinity'::timestamptz)
      )
  `;
}

/** Marks every retention setting change up to `sweptAt` as fully applied. */
export async function markRetentionSwept(sql: Sql<Record<string, unknown>>, sweptAt: Date): Promise<void> {
  await sql`
    update organizations set retention_swept_at = ${sweptAt}
    where retention_changed_at is not null and retention_changed_at <= ${sweptAt}
      and (retention_swept_at is null or retention_swept_at < retention_changed_at)`;
  await sql`
    update workspaces set retention_swept_at = ${sweptAt}
    where retention_changed_at is not null and retention_changed_at <= ${sweptAt}
      and (retention_swept_at is null or retention_swept_at < retention_changed_at)`;
}

/**
 * One query per sweep. Ranks unpurged completed versions per (workspace_id,
 * canonical_id) newest first (rank 1 is current), computes each chain's keep count
 * in SQL (same rule as `effectiveRetainedVersions`), and returns only
 * actionable superseded, past-grace rows, limited to `limit`. A superseded
 * rank-1 row has no live current in its chain and is purged. Only completed
 * rows take a slot: superseded failed/cancelled/pii_blocked rows are always
 * purged, and queued/processing/blocked rows (re-index children included) are
 * neither ranked nor evict anything.
 */
export async function retentionActions(
  sql: Sql<Record<string, unknown>>,
  graceSeconds: number,
  limit: number,
): Promise<{ id: string; action: RetentionAction }[]> {
  const rows = await sql<{ id: string; action: RetentionAction }[]>`
    with chains as (${retentionCandidateChains(sql)}),
    -- A version replaced by its own re-index (reindex_of) is purged and takes no retention slot:
    -- its replacement occupies the slot, so a config change never evicts an older archived version.
    reindexed as (
      select d.id, d.superseded_at
      from documents d
      join documents rep on rep.id = d.superseded_by_document_id and rep.reindex_of = d.id
      where d.purged_at is null and d.superseded_at is not null
    ),
    ranked as (
      select d.id, d.superseded_at, d.archived_at, d.org_id, d.workspace_id,
        row_number() over (
          partition by d.workspace_id, coalesce(d.canonical_id, 'legacy:' || d.id)
          order by d.created_at desc, d.id desc
        )::int as version_rank
      from documents d
      join chains c on c.workspace_id = d.workspace_id
        and c.chain_key = coalesce(d.canonical_id, 'legacy:' || d.id)
      where d.purged_at is null
        and d.status = 'completed'
        and not exists (select 1 from reindexed x where x.id = d.id)
    ),
    keep as (
      select r.id, r.version_rank, r.archived_at, r.superseded_at,
        least(${MAX_RETAINED_VERSIONS}::int, greatest(${MIN_RETAINED_VERSIONS}::int,
          coalesce(w.retain_document_versions, o.retain_document_versions, ${DEFAULT_RETAINED_VERSIONS}::int))) as keep_count
      from ranked r
      join organizations o on o.id = r.org_id
      left join workspaces w on w.id = r.workspace_id
    )
    select id, action from (
      select id, superseded_at,
        case when version_rank > 1 and version_rank <= keep_count then 'archive' else 'purge' end as action
      from keep
      where superseded_at is not null
        and superseded_at < now() - make_interval(secs => ${graceSeconds})
        and (
          version_rank = 1 or version_rank > keep_count
          or (version_rank <= keep_count and archived_at is null)
        )
      union
      select id, superseded_at, 'purge' as action
      from reindexed
      where superseded_at < now() - make_interval(secs => ${graceSeconds})
      union
      -- Superseded versions that never completed hold no slot and no value.
      select d.id, d.superseded_at, 'purge' as action
      from documents d
      join chains c on c.workspace_id = d.workspace_id
        and c.chain_key = coalesce(d.canonical_id, 'legacy:' || d.id)
      where d.purged_at is null and d.superseded_at is not null and d.status <> 'completed'
        and d.superseded_at < now() - make_interval(secs => ${graceSeconds})
    ) actionable
    order by superseded_at
    limit ${limit}
  `;
  return rows.map((row) => ({ id: row.id, action: row.action }));
}

type ClaimedDocument = {
  id: string;
  workspace_id: string;
  org_id: string;
  user_id: string;
  run_id: string | null;
  source_key: string;
  superseded_by_document_id: string | null;
  replacement_run_id: string | null;
  replacement_user_id: string | null;
  shared_with_dedup_copies: boolean;
  /**
   * A live dedup copy in the same workspace still serves this version's LanceDB
   * rows. Copies in other workspaces have their own rows in their own database.
   */
  vectors_shared: boolean;
  /** A partial reprocess still reads this version's storage artifacts. */
  artifacts_reused: boolean;
  source_shared: boolean;
};

type VectorIndexRow = { backend: string; embedding_model: string; dimension: number };

/**
 * Sweep cadence and grace are fixed: superseded versions stay readable for a
 * minute so in-flight searches can finish, then are purged within ~30s. Raw
 * source deletion is a storage policy: STORAGE_URI ?purgeSupersededSources=true.
 */
export function purgeConfig(): SupersededPurgeOptions & { intervalMs: number } {
  return {
    intervalMs: 30_000,
    graceSeconds: 60,
    batchSize: 25,
    deleteSources: resolveObjectStorageConfig().purgeSupersededSources,
    lancedbRoot: resolveLanceDbConfig().root,
  };
}

/** Deletes documents' rows from a LanceDB table, retrying commit conflicts with concurrent writers. */
export const deleteLanceDbDocumentRows: DeleteVectorRows = async ({ uri, table: tableName, documentIds, purgeHistory }) => {
  if (documentIds.length === 0) return;
  for (const documentId of documentIds) {
    if (!SAFE_DOCUMENT_ID.test(documentId)) throw new Error(`Unsafe document id for LanceDB delete: ${documentId}`);
  }
  const db = await connectLanceDb(uri);
  try {
    if (!(await db.tableNames()).includes(tableName)) return;
    for (let attempt = 0; ; attempt += 1) {
      const table = await db.openTable(tableName);
      try {
        // Deletes are visible to readers immediately (deletion vectors);
        // maintenance then compacts them out of the table and its index.
        for (let index = 0; index < documentIds.length; index += VECTOR_DELETE_CHUNK) {
          const ids = documentIds.slice(index, index + VECTOR_DELETE_CHUNK).map((id) => `'${id}'`).join(", ");
          await table.delete(`"documentId" IN (${ids})`);
        }
        const maintenance = lanceDbMaintenanceSettings(resolveLanceDbConfig().params);
        if (purgeHistory) {
          // Keep the durable cleanup row unless compaction and history pruning actually succeed.
          await requireLanceDbMaintenance(uri, tableName, { ...maintenance, versionRetentionMs: 0 });
        } else if (maintenance.enabled) {
          await requestLanceDbMaintenance(uri, tableName, maintenance);
        }
        return;
      } catch (error) {
        if (attempt >= 4 || !/incompatible transaction|commit conflict/i.test(String(error))) throw error;
        await delay(50 * 2 ** attempt);
      } finally {
        table.close();
      }
    }
  } finally {
    db.close();
  }
};

export const dropLanceDbTable: DropVectorTable = async ({ uri, table }) => {
  const db = await connectLanceDb(uri);
  try {
    if ((await db.tableNames()).includes(table)) await db.dropTable(table);
  } finally {
    db.close();
  }
};

const VECTOR_DELETE_CHUNK = 500;

function belongsToDocument(key: string, documentId: string): boolean {
  return key.includes(`/${documentId}.`) || key.includes(`/${documentId}/`);
}

/** Embedding artifact keys (`<user>/<run>/embeddings/<documentId>.json`) among deleted keys, as stored URIs. */
function embeddingArtifactUris(bucket: string, keys: readonly string[]): string[] {
  return keys.filter((key) => key.includes("/embeddings/")).map((key) => `s3://${bucket}/${key}`);
}

/**
 * Drops embedding_reuse_refs rows pointing into embedding artifacts that are
 * being deleted, so content-addressed lookups never find a stale pointer.
 * Refs are a cache: dropping them before the delete is safe if it then fails.
 */
export async function forgetEmbeddingReuseRefsForKeys(
  sql: Sql<Record<string, unknown>>,
  bucket: string,
  keys: readonly string[],
): Promise<void> {
  const uris = embeddingArtifactUris(bucket, keys);
  if (uris.length === 0 || !(await tableExists(sql, "embedding_reuse_refs"))) return;
  await sql`delete from embedding_reuse_refs where artifact_uri = any(${sql.array(uris)}::text[])`;
}

/** Purge storage whose deletes also forget embedding reuse refs into the deleted artifacts. */
function forgettingEmbeddingReuseRefs(sql: Sql<Record<string, unknown>>, storage: PurgeStorage, purgingDocumentId: string | null = null): PurgeStorage {
  return {
    bucket: storage.bucket,
    listKeys: (options) => storage.listKeys(options),
    deleteKeys: async (keys) => {
      // A recovered upload may reuse its raw key in a new document after the
      // old run's cleanup was queued. Recheck ownership at deletion time.
      const sources = keys.filter(key => key.includes("/raw/"));
      const retained = new Set(sources.length ? (await sql<{ source_key: string }[]>`
        select source_key from documents where source_key = any(${sql.array(sources)})
          and purged_at is null and id is distinct from ${purgingDocumentId}
        union
        select f.source_key from upload_session_files f join upload_sessions s on s.id = f.session_id
        where f.source_key = any(${sql.array(sources)}) and s.status in ('initializing', 'pending', 'uploading', 'ingesting')
      `).map(row => row.source_key) : []);
      const deletable = keys.filter(key => !retained.has(key));
      await forgetEmbeddingReuseRefsForKeys(sql, storage.bucket, deletable);
      await storage.deleteKeys(deletable);
    },
  };
}

async function existingTables(
  sql: Sql<Record<string, unknown>>,
  names: readonly string[] = DERIVED_TABLES,
): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select name from unnest(${sql.array([...names])}::text[]) as name
    where to_regclass('public.' || name) is not null
  `;
  return rows.map((row) => row.name);
}

/**
 * Purges up to `batchSize` superseded versions whose grace period has passed.
 * Each document is claimed with FOR UPDATE SKIP LOCKED, so concurrent workers
 * never purge the same document, and the claim commits only after external
 * deletes succeed; a failure leaves the document for the next sweep.
 */
export async function purgeSupersededDocuments(
  sql: Sql<Record<string, unknown>>,
  storage: PurgeStorage,
  options: SupersededPurgeOptions,
): Promise<SupersededPurgeResult> {
  const deleteVectorRows = options.deleteVectorRows ?? deleteLanceDbDocumentRows;
  const tables = await existingTables(sql);
  const result: SupersededPurgeResult = { purged: 0, failed: 0 };
  const [started] = await sql<{ now: Date }[]>`select clock_timestamp() as now`;
  const actions = await retentionActions(sql, options.graceSeconds, options.batchSize);
  // Nothing left to do: every pending retention setting change is now applied.
  if (actions.length === 0) await markRetentionSwept(sql, started!.now);
  const archiveTables = await existingTables(sql, ARCHIVE_TABLES);

  for (const { id: candidateId, action } of actions) {
    try {
      await sql.begin(async (tx) => {
        const client = tx as unknown as Sql<Record<string, unknown>>;
        // Deletes in this transaction also drop embedding reuse refs into deleted artifacts.
        const txStorage = forgettingEmbeddingReuseRefs(client, storage, candidateId);
        const [doc] = await client<ClaimedDocument[]>`
          select d.id, d.workspace_id, d.org_id, d.user_id, d.run_id, d.source_key, d.superseded_by_document_id,
            replacement.run_id as replacement_run_id,
            replacement.user_id as replacement_user_id,
            exists (
              select 1 from documents copy
              where copy.deduped_from_document_id = d.id and copy.purged_at is null
            ) as shared_with_dedup_copies,
            exists (
              select 1 from documents copy
              where copy.deduped_from_document_id = d.id and copy.purged_at is null
                and copy.workspace_id = d.workspace_id
            ) as vectors_shared,
            exists (
              select 1 from documents copy
              where copy.reused_from_document_id = d.id and copy.purged_at is null
            ) as artifacts_reused,
            exists (
              select 1 from documents other
              where other.source_key = d.source_key and other.id <> d.id and other.purged_at is null
            ) as source_shared
          from documents d
          left join documents replacement on replacement.id = d.superseded_by_document_id
          where d.id = ${candidateId}
            and d.superseded_at is not null
            and d.purged_at is null
            and (${action === "purge"} or d.archived_at is null)
          for update of d skip locked
        `;
        if (!doc) return;
        // Extraction holds the graph lock before its FK checks on documents.
        // We already hold this document row, so waiting for that lock would
        // invert the order. Defer this sweep before any external side effects.
        const [graphLock] = await client<{ acquired: boolean }[]>`
          select pg_try_advisory_xact_lock(hashtextextended(${`kg:${doc.workspace_id}`}, 0)) as acquired
        `;
        if (!graphLock?.acquired) return;

        if (action === "archive") {
          await archiveDocument(client, doc, options, deleteVectorRows, archiveTables);
          result.archived = (result.archived ?? 0) + 1;
          return;
        }

        // Dedup copies reuse this version's artifacts (any workspace) and, in
        // its own workspace, its vectors; keep those until the last such copy
        // is gone. Its own derived rows are still removed.
        if (!doc.vectors_shared) await deleteDocumentVectors(client, doc, options, deleteVectorRows);
        // Partial reprocesses copy stage outputs but point at this version's
        // storage artifacts; their vectors are their own, so only the
        // artifacts stay.
        if (!doc.shared_with_dedup_copies && !doc.artifacts_reused) {
          await txStorage.deleteKeys(await artifactKeys(client, txStorage, doc, options.deleteSources));
        }

        const kgNodeIds = await knowledgeGraphNodesForDocument(client, doc.id);
        for (const table of tables) {
          await client`delete from ${client(table)} where document_id = ${doc.id}`;
        }
        await refreshKnowledgeGraphNodes(client, kgNodeIds);
        await client`update documents set purged_at = now() where id = ${doc.id}`;
        // This version may have held the last live reference to artifacts it
        // reused from an older (possibly already purged) version.
        const inheritedUris = (await client<{ artifact_uri: string }[]>`
          select distinct artifact_uri from document_run_stage_states
          where document_id = ${doc.id} and artifact_uri is not null
        `).map((row) => row.artifact_uri).filter((uri) => {
          const key = keyFromStorageUri(uri, txStorage.bucket);
          return key !== null && !belongsToDocument(key, doc.id);
        });
        await reclaimReusedArtifacts(client, txStorage, inheritedUris);

        if (doc.replacement_run_id && doc.replacement_user_id) {
          await appendWorkspaceRunEvent({
            sql: client,
            event: {
              userId: doc.replacement_user_id,
              runId: doc.replacement_run_id,
              documentId: doc.superseded_by_document_id ?? undefined,
              eventType: "document.purged",
              status: "completed",
              message: "Removed derived data for a replaced version",
              progress: { purgedDocumentId: doc.id },
              payload: { purgedDocumentId: doc.id, artifactsKept: doc.shared_with_dedup_copies || doc.artifacts_reused },
            },
          });
        }
        result.purged += 1;
      });
    } catch (error) {
      result.failed += 1;
      console.warn(
        `[superseded-purge] failed error=${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
    }
  }

  if (result.purged > 0 || result.failed > 0 || (result.archived ?? 0) > 0) {
    console.log(`[superseded-purge] purged=${result.purged} archived=${result.archived ?? 0} failed=${result.failed}`);
  }
  return result;
}

/** Deletes a document's rows from its workspace's LanceDB database(s). */
async function deleteDocumentVectors(
  client: Sql<Record<string, unknown>>,
  doc: ClaimedDocument,
  options: SupersededPurgeOptions,
  deleteVectorRows: DeleteVectorRows,
): Promise<void> {
  const vectors = await client<VectorIndexRow[]>`
    select distinct backend, embedding_model, dimension from vector_indexes where document_id = ${doc.id}
  `;
  for (const vector of vectors) {
    if (vector.backend !== "lancedb") continue;
    const location = VectorNamespaceManager.getEmbeddingLocation(
      options.lancedbRoot, doc.org_id, doc.workspace_id, vector.embedding_model, vector.dimension,
    );
    await deleteVectorRows({ uri: location.uri, table: location.table, documentIds: [doc.id] });
  }
}

/**
 * Archives a retained superseded version: removes everything search reads
 * (chunks, vectors, graph evidence, staleness, deferred page vectors/maps)
 * and keeps pages, artifacts and page images for browsing. Vector rows shared
 * with live dedup copies in the same workspace stay until the last copy is gone.
 */
async function archiveDocument(
  client: Sql<Record<string, unknown>>,
  doc: ClaimedDocument,
  options: SupersededPurgeOptions,
  deleteVectorRows: DeleteVectorRows,
  archiveTables: readonly string[],
): Promise<void> {
  if (!doc.vectors_shared) await deleteDocumentVectors(client, doc, options, deleteVectorRows);
  const kgNodeIds = await knowledgeGraphNodesForDocument(client, doc.id);
  for (const table of archiveTables) {
    await client`delete from ${client(table)} where document_id = ${doc.id}`;
  }
  await refreshKnowledgeGraphNodes(client, kgNodeIds);
  await client`update documents set archived_at = now() where id = ${doc.id}`;
}

async function artifactKeys(
  sql: Sql<Record<string, unknown>>,
  storage: PurgeStorage,
  doc: ClaimedDocument,
  deleteSources: boolean,
): Promise<string[]> {
  const stageUris = await sql<{ artifact_uri: string }[]>`
    select artifact_uri from document_run_stage_states
    where document_id = ${doc.id} and artifact_uri is not null
  `;
  return await documentArtifactKeys(storage, {
    documentId: doc.id,
    userId: doc.user_id,
    runId: doc.run_id,
    sourceKey: doc.source_key,
    artifactUris: stageUris.map((row) => row.artifact_uri),
    deleteSource: deleteSources && !doc.source_shared,
  });
}

/** Storage keys of one document's artifacts; the raw source only when asked. */
async function documentArtifactKeys(
  storage: PurgeStorage,
  doc: {
    documentId: string;
    userId: string;
    runId: string | null;
    sourceKey: string | null;
    artifactUris: string[];
    deleteSource: boolean;
  },
): Promise<string[]> {
  const keys = new Set<string>();
  for (const uri of doc.artifactUris) {
    // Dedup copies inherit the source document's artifact URIs; never delete
    // files that belong to another document.
    const key = keyFromStorageUri(uri, storage.bucket);
    if (key && belongsToDocument(key, doc.documentId)) keys.add(key);
  }
  // Artifacts live under `${userId}/${runId}/<kind>/${documentId}...`.
  if (doc.runId) {
    const listed = await storage.listKeys({ prefix: `${doc.userId}/${doc.runId}/`, maxKeys: 100_000 });
    for (const key of listed.keys) {
      if (belongsToDocument(key, doc.documentId)) keys.add(key);
    }
  }
  const sourceKey = doc.sourceKey ? keyFromStorageUri(doc.sourceKey, storage.bucket) : null;
  if (sourceKey) {
    if (doc.deleteSource) keys.add(sourceKey);
    else keys.delete(sourceKey);
  }
  return [...keys];
}

/** Knowledge-graph nodes a document supports: chunk mentions and edge evidence endpoints. */
export async function knowledgeGraphNodesForDocument(
  sql: Sql<Record<string, unknown>>,
  documentId: string,
): Promise<string[]> {
  if (!(await tableExists(sql, "chunk_entities"))) return [];
  const rows = await sql<{ node_id: string }[]>`
    select ce.node_id
    from chunk_entities ce
    join document_chunks c on c.id = ce.chunk_id
    where c.document_id = ${documentId}
    union
    select e.source_node_id from kg_edge_evidence ev join kg_edges e on e.id = ev.edge_id
    where ev.document_id = ${documentId}
    union
    select e.target_node_id from kg_edge_evidence ev join kg_edges e on e.id = ev.edge_id
    where ev.document_id = ${documentId}
  `;
  return rows.map((row) => row.node_id);
}

/**
 * Re-derives graph elements after a document's chunks and edge evidence were
 * removed (see `refreshGraphElements`): nodes and edges no current document
 * supports are deleted, then affected community sizes are recounted.
 */
export async function refreshKnowledgeGraphNodes(
  sql: Sql<Record<string, unknown>>,
  nodeIds: string[],
): Promise<void> {
  if (nodeIds.length === 0 || !(await tableExists(sql, "kg_nodes"))) return;
  const communities = await sql<{ community_id: string }[]>`
    select distinct community_id from kg_community_members where node_id = any(${sql.array(nodeIds)})
  `;
  await refreshGraphElements(sql, { nodeIds });
  if (communities.length > 0) {
    await sql`
      update kg_communities k
      set member_count = (select count(*)::int from kg_community_members m where m.community_id = k.id),
          updated_at = now()
      where k.id = any(${sql.array(communities.map((row) => row.community_id))})
    `;
  }
}

async function tableExists(sql: Sql<Record<string, unknown>>, name: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`select to_regclass(${`public.${name}`}) is not null as exists`;
  return row?.exists ?? false;
}

type VectorTarget =
  | { backend: string; embeddingModel: string; dimension: number }
  | { backend: string; uri: string; table: string };

type CleanupRow = {
  document_id: string;
  org_id: string;
  user_id: string;
  workspace_id: string;
  run_id: string | null;
  source_key: string | null;
  delete_source: boolean;
  keep_shared_artifacts: boolean;
  shares_vectors: boolean;
  vector_targets: VectorTarget[];
  artifact_uris: string[];
  kg_node_ids: string[];
};

type VectorLocation = { uri: string; table: string };

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** A queued vector target in its workspace's LanceDB database; null when it cannot be resolved safely. */
function resolveVectorLocation(lancedbRoot: string, orgId: string, workspaceId: string, target: VectorTarget): VectorLocation | null {
  if (target.backend !== "lancedb") return null;
  if ("uri" in target && target.uri && target.table) return { uri: target.uri, table: target.table };
  if (!("embeddingModel" in target) || !SAFE_ID.test(orgId) || !SAFE_ID.test(workspaceId)) return null;
  return VectorNamespaceManager.getEmbeddingLocation(lancedbRoot, orgId, workspaceId, target.embeddingModel, target.dimension);
}

function legacyLocationsFor(lancedbRoot: string, orgId: string, payload: Record<string, unknown>): VectorLocation[] {
  if (!orgId.trim()) return [];
  const model = typeof payload.embeddingModel === "string" ? payload.embeddingModel : null;
  const dimension = typeof payload.dimension === "number" ? payload.dimension : null;
  return [
    ...(model && dimension ? legacyEmbeddingLocations(lancedbRoot, orgId, model, dimension) : []),
    legacyOrgTable(lancedbRoot, orgId),
  ];
}

/** vector_table queue payloads name the workspace whose database holds the table. */
function payloadWorkspaceId(payload: object): string {
  const workspaceId = (payload as { workspaceId?: unknown }).workspaceId;
  return typeof workspaceId === "string" ? workspaceId : "";
}

const locationKey = (location: VectorLocation) => `${location.uri}#${location.table}`;

/**
 * Finishes cleanup for deleted documents. Their rows (and derived rows) are
 * already gone; the documents BEFORE DELETE trigger recorded what lives outside
 * Postgres in document_cleanup_queue. This deletes their LanceDB rows and
 * storage artifacts and refreshes graph counts.
 *
 * Rows are claimed in batches (FOR UPDATE SKIP LOCKED), so a workspace or org
 * deletion costs one LanceDB delete per table and one storage listing per run
 * prefix per batch, not per document. Vector tables queued for a whole drop and
 * runs whose prefix is queued for a purge are skipped here. A failed batch is
 * retried row by row so one poison row cannot block the rest; each row is
 * retried on later sweeps (up to 10 attempts).
 */
export async function drainDocumentCleanupQueue(
  sql: Sql<Record<string, unknown>>,
  storage: PurgeStorage,
  options: SupersededPurgeOptions,
): Promise<SupersededPurgeResult> {
  if (!(await tableExists(sql, "document_cleanup_queue"))) return { purged: 0, failed: 0 };
  const result: SupersededPurgeResult = { purged: 0, failed: 0 };
  const claimSize = Math.max(1, options.cleanupBatchSize ?? 200);

  // Rows that fail are retried on a later sweep, not again in this one.
  const failedIds: string[] = [];
  for (let index = 0; index < options.batchSize; index += 1) {
    let claimed: string[] = [];
    try {
      await sql.begin(async (tx) => {
        const client = tx as unknown as Sql<Record<string, unknown>>;
        const rows = await client<CleanupRow[]>`
          select * from document_cleanup_queue
          where attempts < 10 and not_before <= now()
            and document_id <> all(${client.array(failedIds)}::text[])
          order by created_at
          limit ${claimSize}
          for update skip locked
        `;
        claimed = rows.map((row) => row.document_id);
        if (rows.length === 0) return;
        await cleanDeletedDocuments(client, storage, options, rows);
        result.purged += rows.length;
      });
    } catch (error) {
      if (claimed.length <= 1) {
        result.failed += Math.max(1, claimed.length);
        failedIds.push(...claimed);
        await recordDocumentCleanupFailure(sql, claimed, error);
      } else {
        // Isolate the failing row(s).
        for (const documentId of claimed) {
          const single = await cleanOneDocument(sql, storage, options, documentId);
          if (single === "cleaned") result.purged += 1;
          else if (single === "failed") {
            result.failed += 1;
            failedIds.push(documentId);
          }
        }
      }
      if (claimed.length === 0) break;
    }
    if (claimed.length < claimSize) break;
  }

  if (result.purged > 0 || result.failed > 0) {
    console.log(`[document-cleanup] cleaned=${result.purged} failed=${result.failed}`);
  }
  return result;
}

async function cleanOneDocument(
  sql: Sql<Record<string, unknown>>,
  storage: PurgeStorage,
  options: SupersededPurgeOptions,
  documentId: string,
): Promise<"cleaned" | "failed" | "skipped"> {
  try {
    let outcome: "cleaned" | "skipped" = "skipped";
    await sql.begin(async (tx) => {
      const client = tx as unknown as Sql<Record<string, unknown>>;
      const rows = await client<CleanupRow[]>`
        select * from document_cleanup_queue
        where document_id = ${documentId} and attempts < 10
        for update skip locked
      `;
      if (rows.length === 0) return;
      await cleanDeletedDocuments(client, storage, options, rows);
      outcome = "cleaned";
    });
    return outcome;
  } catch (error) {
    await recordDocumentCleanupFailure(sql, [documentId], error);
    return "failed";
  }
}

async function recordDocumentCleanupFailure(sql: Sql<Record<string, unknown>>, documentIds: string[], error: unknown) {
  const message = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
  if (documentIds.length > 0) {
    await sql`
      update document_cleanup_queue
      set attempts = attempts + 1, last_error = ${message.slice(0, 2000)}
      where document_id = any(${sql.array(documentIds)})
    `.catch(() => {});
  }
  console.warn(`[document-cleanup] failed documents=${documentIds.join(",") || "?"} error=${message}`);
}

async function cleanDeletedDocuments(
  client: Sql<Record<string, unknown>>,
  rawStorage: PurgeStorage,
  options: SupersededPurgeOptions,
  rows: CleanupRow[],
): Promise<void> {
  // Queue rows are independent of graph writers; lock all workspace graphs
  // in a stable order before refreshing their shared nodes and edges.
  for (const workspaceId of [...new Set(rows.map((row) => row.workspace_id))].sort()) {
    await lockWorkspaceGraph(client, workspaceId);
  }
  // Deletes in this transaction also drop embedding reuse refs into deleted artifacts.
  const storage = forgettingEmbeddingReuseRefs(client, rawStorage);
  const deleteVectorRows = options.deleteVectorRows ?? deleteLanceDbDocumentRows;
  // Dedup copies share artifacts, and in the same workspace vectors too; a
  // partial reprocess shares only artifacts (its vectors are its own).
  const vectorOwners = rows.filter((row) => !row.shares_vectors);
  const owned = rows.filter((row) => !row.keep_shared_artifacts);

  // Tables queued for a whole drop (org deletion) need no row deletes.
  const orgIds = [...new Set(vectorOwners.map((row) => row.org_id))];
  const droppedTables = new Set(
    (await client<{ payload: VectorTarget; org_id: string | null }[]>`
      select payload, org_id from storage_cleanup_queue
      where kind = 'vector_table' and org_id = any(${client.array(orgIds)})
    `).flatMap((row) => {
      const location = resolveVectorLocation(options.lancedbRoot, row.org_id ?? "", payloadWorkspaceId(row.payload), { ...row.payload, backend: "lancedb" });
      return location ? [locationKey(location)] : [];
    }),
  );
  const byTable = new Map<string, { location: VectorLocation; documentIds: Set<string>; purgeHistory: boolean }>();
  for (const row of vectorOwners) {
    for (const target of row.vector_targets) {
      const location = resolveVectorLocation(options.lancedbRoot, row.org_id, row.workspace_id, target);
      if (!location || droppedTables.has(locationKey(location))) continue;
      const group = byTable.get(locationKey(location)) ?? { location, documentIds: new Set<string>(), purgeHistory: false };
      group.documentIds.add(row.document_id);
      // An expired extract's text must not survive in the table's older versions.
      if (row.source_key?.startsWith("extracts/")) group.purgeHistory = true;
      byTable.set(locationKey(location), group);
    }
  }
  for (const { location, documentIds, purgeHistory } of byTable.values()) {
    await deleteVectorRows({ uri: location.uri, table: location.table, documentIds: [...documentIds], ...(purgeHistory ? { purgeHistory } : {}) });
  }

  const keys = new Set<string>();
  const foreignUris = new Set<string>();
  for (const row of rows) {
    for (const uri of row.artifact_uris) {
      // Dedup copies and partial reprocesses inherit another document's
      // artifact URIs; those are reclaimed below only once unreferenced.
      const key = keyFromStorageUri(uri, storage.bucket);
      if (!key) continue;
      if (!belongsToDocument(key, row.document_id)) foreignUris.add(uri);
      else if (!row.keep_shared_artifacts) keys.add(key);
    }
  }
  // Artifacts live under `${userId}/${runId}/<kind>/${documentId}...`. List
  // each run prefix once per batch; a deleted run has its whole prefix queued
  // in storage_cleanup_queue instead.
  const runIds = [...new Set(owned.flatMap((row) => (row.run_id ? [row.run_id] : [])))];
  const liveRuns = new Set(
    runIds.length === 0
      ? []
      : (await client<{ id: string }[]>`select id from workspace_runs where id = any(${client.array(runIds)})`).map((row) => row.id),
  );
  const byPrefix = new Map<string, CleanupRow[]>();
  for (const row of owned) {
    if (!row.run_id || !liveRuns.has(row.run_id)) continue;
    const prefix = `${row.user_id}/${row.run_id}/`;
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), row]);
  }
  for (const [prefix, prefixRows] of byPrefix) {
    const listed = await storage.listKeys({ prefix, maxKeys: 100_000 });
    for (const key of listed.keys) {
      if (prefixRows.some((row) => belongsToDocument(key, row.document_id))) keys.add(key);
    }
  }

  // Raw sources go only when no remaining document still points at them.
  const sourceKeys = rows.flatMap((row) => (row.delete_source && row.source_key ? [row.source_key] : []));
  const shared = new Set(
    sourceKeys.length === 0
      ? []
      : (await client<{ source_key: string }[]>`
          select distinct source_key from documents where source_key = any(${client.array(sourceKeys)})
        `).map((row) => row.source_key),
  );
  for (const row of rows) {
    const sourceKey = row.source_key ? keyFromStorageUri(row.source_key, storage.bucket) : null;
    if (!sourceKey) continue;
    if (row.delete_source && !shared.has(row.source_key!)) keys.add(sourceKey);
    else keys.delete(sourceKey);
  }
  await storage.deleteKeys([...keys]);
  await reclaimReusedArtifacts(client, storage, [...foreignUris]);

  await refreshKnowledgeGraphNodes(client, [...new Set(rows.flatMap((row) => row.kg_node_ids))]);
  await client`delete from document_cleanup_queue where document_id = any(${client.array(rows.map((row) => row.document_id))})`;
}

/**
 * The document a run artifact key belongs to: `<user>/<run>/<kind>/<documentId>[./]...`,
 * or `extracts/<org>/<extract>/<kind>/<documentId>[./]...` for an extract run, whose
 * root is three segments (read as two, `extracts/<org>/` would span every extract of the org).
 */
export function artifactOwner(key: string): { prefix: string; documentId: string } | null {
  if (key.startsWith("extracts/")) {
    const [, org, extract, , file] = key.split("/");
    const documentId = file?.split(".")[0];
    if (!org || !/^[A-Za-z0-9_-]{1,128}$/.test(org) || !extract || !/^ext_[0-9a-f]{32}$/.test(extract)) return null;
    if (!documentId || !SAFE_DOCUMENT_ID.test(documentId)) return null;
    return { prefix: `extracts/${org}/${extract}/`, documentId };
  }
  const [user, run, , file] = key.split("/");
  const documentId = file?.split(".")[0];
  if (!user || !run || !documentId || !SAFE_DOCUMENT_ID.test(documentId)) return null;
  return { prefix: `${user}/${run}/`, documentId };
}

/**
 * A deleted document that reused another version's artifacts (partial
 * reprocess, dedup copy) may have held the last reference to them. Once the
 * owning document is gone and no surviving stage state points at an artifact,
 * that document's artifacts are deleted. When the owning run's whole prefix is
 * queued, its purge is brought forward instead.
 */
async function reclaimReusedArtifacts(client: Sql<Record<string, unknown>>, storage: PurgeStorage, uris: string[]) {
  if (uris.length === 0) return;
  const referenced = new Set(
    (await client<{ artifact_uri: string }[]>`
      select distinct states.artifact_uri
      from document_run_stage_states states
      join documents d on d.id = states.document_id
      -- A purged version's stage states are history, not readers.
      where states.artifact_uri = any(${client.array(uris)}) and d.purged_at is null
    `).map((row) => row.artifact_uri),
  );
  const owners = new Map<string, { prefix: string; documentId: string }>();
  for (const uri of uris) {
    if (referenced.has(uri)) continue;
    const key = keyFromStorageUri(uri, storage.bucket);
    const owner = key ? artifactOwner(key) : null;
    if (owner) owners.set(`${owner.prefix}${owner.documentId}`, owner);
  }
  if (owners.size === 0) return;
  const live = new Set(
    (await client<{ id: string }[]>`
      select id from documents
      where id = any(${client.array([...owners.values()].map((owner) => owner.documentId))})
        -- A superseded owner whose artifacts were kept for a reusing copy is a tombstone.
        and purged_at is null
    `).map((row) => row.id),
  );
  const orphaned = [...owners.values()].filter((owner) => !live.has(owner.documentId));
  if (orphaned.length === 0) return;
  const prefixes = [...new Set(orphaned.map((owner) => owner.prefix))];
  const queued = new Set(
    (await client<{ target: string }[]>`
      update storage_cleanup_queue set not_before = least(not_before, now())
      where kind = 'storage_prefix' and target = any(${client.array(prefixes)})
      returning target
    `).map((row) => row.target),
  );
  const keys: string[] = [];
  for (const prefix of prefixes) {
    if (queued.has(prefix)) continue;
    const listed = await storage.listKeys({ prefix, maxKeys: 100_000 });
    for (const key of listed.keys) {
      if (orphaned.some((owner) => owner.prefix === prefix && belongsToDocument(key, owner.documentId))) keys.push(key);
    }
  }
  await storage.deleteKeys(keys);
}

/** LIKE pattern matching artifact URIs (`s3://<bucket>/<key>`) under a storage prefix. */
function uriPrefixPattern(bucket: string, prefix: string): string {
  return `s3://${bucket}/${prefix}`.replace(/[\\%_]/g, (character) => `\\${character}`) + "%";
}

/**
 * Documents under a deleted run's prefix whose artifacts surviving versions
 * still reference: a partial reprocess seeds stage states and run artifacts
 * with the source version's URIs. Their artifacts are kept as a unit.
 */
async function referencedDocumentsUnderPrefix(
  client: Sql<Record<string, unknown>>,
  storage: PurgeStorage,
  workspaceId: string | null,
  prefix: string,
): Promise<Set<string>> {
  const pattern = uriPrefixPattern(storage.bucket, prefix);
  const rows = await client<{ uri: string }[]>`
    select stage.artifact_uri as uri
    from document_run_stage_states stage
    where stage.artifact_uri like ${pattern}
    union
    select artifact.value
    from workspace_runs r
    cross join lateral jsonb_each_text(coalesce(r.artifacts, '{}'::jsonb)) as artifact(key, value)
    where r.workspace_id = ${workspaceId ?? ""} and artifact.value like ${pattern}
  `;
  const documents = new Set<string>();
  for (const row of rows) {
    const key = keyFromStorageUri(row.uri, storage.bucket);
    const owner = key ? artifactOwner(key) : null;
    if (owner) documents.add(owner.documentId);
  }
  return documents;
}

type StorageCleanupRow = {
  id: string;
  kind: "storage_prefix" | "vector_table" | "vector_prefix" | "vector_rows" | "upload_original";
  org_id: string | null;
  target: string;
  payload: Record<string, unknown>;
  artifact_uris: string[];
};

/** A deferred-materialization vector id of one document: `${documentId}:p<page>:g<generation>:c<index>`. */
const DEFERRED_VECTOR_ID = /^([A-Za-z0-9_-]+):p[0-9]{1,9}:g[0-9a-f]{1,32}:c[0-9]{1,9}$/;

/**
 * `vector_rows` (materialize-pages.ts queueOrphanVectors): vector ids of one document whose delete failed or whose
 * publication's COMMIT outcome was unknown. Deletes, in the queuing workspace's own LanceDB table, only well-formed
 * deferred ids of that document that no document_chunks row names: a commit that landed keeps its vectors.
 */
async function deleteOrphanVectorRows(client: Sql<Record<string, unknown>>, options: SupersededPurgeOptions, row: StorageCleanupRow) {
  const payload = row.payload as { documentId?: unknown; embeddingModel?: unknown; dimension?: unknown; ids?: unknown };
  const documentId = typeof payload.documentId === "string" ? payload.documentId : "";
  const ids = Array.isArray(payload.ids) ? payload.ids : [];
  if (!SAFE_DOCUMENT_ID.test(documentId) || typeof payload.embeddingModel !== "string" || typeof payload.dimension !== "number"
    || ids.some((id) => typeof id !== "string" || DEFERRED_VECTOR_ID.exec(id)?.[1] !== documentId)) {
    throw new Error(`Refusing malformed vector_rows entry: ${row.target}`);
  }
  const location = resolveVectorLocation(options.lancedbRoot, row.org_id ?? "", payloadWorkspaceId(row.payload), {
    backend: "lancedb", embeddingModel: payload.embeddingModel, dimension: payload.dimension,
  } as VectorTarget);
  if (!location) throw new Error(`Unresolvable vector table: ${row.target}`);
  const live = new Set((await client<{ id: string }[]>`
    select id from document_chunks where document_id = ${documentId} and id = any(${ids as string[]}::text[])
  `).map((r) => r.id));
  const orphans = (ids as string[]).filter((id) => !live.has(id));
  const deleteIds = options.deleteVectorIds ?? (({ uri, table, ids: rows }) => deleteLanceDbRecords(uri, table, rows));
  if (orphans.length > 0) await deleteIds({ uri: location.uri, table: location.table, ids: orphans });
}

/** `<userId>/<runId>/`: two safe segments, never a bucket root or a whole user. */
const SAFE_RUN_PREFIX = /^[A-Za-z0-9_.@-]+\/[A-Za-z0-9_-]+\/$/;

/**
 * Drains storage_cleanup_queue: whole run prefixes (every artifact of a deleted
 * run in one listing loop, instead of one listing per document) and whole
 * LanceDB tables (a workspace's vector tables after workspace or org deletion). Entries for runs
 * that were still in flight wait out `not_before` so late writes are caught.
 */
export async function drainStorageCleanupQueue(
  sql: Sql<Record<string, unknown>>,
  storage: PurgeStorage,
  options: SupersededPurgeOptions,
): Promise<SupersededPurgeResult> {
  if (!(await tableExists(sql, "storage_cleanup_queue"))) return { purged: 0, failed: 0 };
  const dropVectorTable = options.dropVectorTable ?? dropLanceDbTable;
  const result: SupersededPurgeResult = { purged: 0, failed: 0 };

  // A row that fails is retried on a later sweep, not again in this one.
  const failedIds: string[] = [];
  for (let index = 0; index < options.batchSize; index += 1) {
    let claimed: StorageCleanupRow | null = null;
    try {
      await sql.begin(async (tx) => {
        const client = tx as unknown as Sql<Record<string, unknown>>;
        // Deletes in this transaction also drop embedding reuse refs into deleted artifacts.
        const txStorage = forgettingEmbeddingReuseRefs(client, storage);
        const [row] = await client<StorageCleanupRow[]>`
          select id::text, kind, org_id, target, payload, artifact_uris from storage_cleanup_queue
          where (attempts < 10 or kind = 'upload_original') and not_before <= now()
            and id::text <> all(${client.array(failedIds)}::text[])
          order by created_at, id
          limit 1
          for update skip locked
        `;
        if (!row) return;
        claimed = row;
        if (row.kind === "upload_original") {
          const sealed = row.payload.sealedKey;
          const directory = row.target.slice(0, row.target.lastIndexOf("/") + 1);
          if (!directory.endsWith("/raw/") || typeof sealed !== "string" ||
              !sealed.startsWith(`${directory}sealed-`) || sealed === row.target ||
              row.target.endsWith("/") || row.target.includes("..")) {
            throw new Error("Refusing invalid original-upload cleanup target");
          }
          // Independent durable ownership cannot be changed by a malformed cleanup queue row.
          const [owner] = await client`select 1 from upload_cleanup_owners
            where original_key = ${row.target} and sealed_key = ${sealed} and org_id = ${row.org_id}`;
          if (!row.org_id || !owner) throw new Error("Original upload ownership cannot be verified");
          // Never delete a source still referenced by a document or an unfinished finalization.
          const [reference] = await client`select 1 from documents where source_key = ${row.target}
            union all select 1 from upload_session_files where source_key = ${row.target} limit 1`;
          if (reference) throw new Error("Original upload is still referenced");
          await txStorage.deleteKeys([row.target]);
          // Keep a tombstone: a PUT started before authorization expired may finish later.
          await client`update storage_cleanup_queue set attempts = 0, last_error = null,
            not_before = now() + interval '1 day' where id = ${row.id}`;
          result.purged += 1;
          return;
        } else if (row.kind === "storage_prefix") {
          if (!SAFE_RUN_PREFIX.test(row.target)) throw new Error(`Refusing unsafe storage prefix: ${row.target}`);
          // Direct-upload recovery deliberately reuses the session ID as its
          // run ID. An old cleanup record must not remove the recovered run's
          // new artifacts, or sources while intake is between attempts.
          const runId = row.target.split("/")[1]!;
          const [owner] = await client`
            select 1 from workspace_runs where id = ${runId}
            union all
            select 1 from upload_sessions where id = ${runId}
              and status in ('initializing', 'pending', 'uploading', 'ingesting')
            limit 1
          `;
          if (owner) {
            await client`update storage_cleanup_queue set not_before = now() + interval '1 day' where id = ${row.id}`;
            result.purged += 1;
            return;
          }
          const workspaceId = typeof row.payload.workspaceId === "string" ? row.payload.workspaceId : null;
          const kept = await referencedDocumentsUnderPrefix(client, txStorage, workspaceId, row.target);
          const keep = (key: string) => [...kept].some((documentId) => belongsToDocument(key, documentId));
          await purgePrefix(txStorage, row.target, keep);
          await txStorage.deleteKeys(row.artifact_uris.flatMap((uri) => {
            const key = keyFromStorageUri(uri, txStorage.bucket);
            return key && !keep(key) ? [key] : [];
          }));
          if (kept.size > 0) {
            // Still referenced by a newer version: re-check daily. Deleting the
            // last reference brings this forward (reclaimReusedArtifacts).
            await client`update storage_cleanup_queue set not_before = now() + interval '1 day' where id = ${row.id}`;
            result.purged += 1;
            return;
          }
        } else if (row.kind === "vector_prefix") {
          await purgeWorkspaceVectorPrefix(client, storage, options.lancedbRoot, row.org_id ?? "", payloadWorkspaceId(row.payload));
        } else if (row.kind === "vector_rows") {
          await deleteOrphanVectorRows(client, options, row);
        } else {
          // Queued before workspaces had their own databases (migration 0082 marks them):
          // a deleted org's org-level tables, dropped with their legacy names.
          const locations = row.payload.legacyLayout === true
            ? legacyLocationsFor(options.lancedbRoot, row.org_id ?? "", row.payload)
            : [resolveVectorLocation(options.lancedbRoot, row.org_id ?? "", payloadWorkspaceId(row.payload), {
                ...(row.payload as VectorTarget),
                backend: "lancedb",
              })];
          if (locations.length === 0 || locations.some((location) => !location)) throw new Error(`Unresolvable vector table: ${row.target}`);
          for (const location of locations as VectorLocation[]) {
            await dropVectorTable(location);
            await client`delete from vector_index_outbox where table_key = ${locationKey(location)}`;
            await client`delete from vector_index_tables where table_key = ${locationKey(location)}`;
          }
        }
        await client`delete from storage_cleanup_queue where id = ${row.id}`;
        result.purged += 1;
      });
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
      const row = claimed as StorageCleanupRow | null;
      if (row) {
        failedIds.push(row.id);
        await sql`
          update storage_cleanup_queue
          set attempts = attempts + 1, last_error = ${message.slice(0, 2000)},
            not_before = case when kind = 'upload_original' and ${message === 'Original upload ownership cannot be verified'} then 'infinity'::timestamptz
              when kind = 'upload_original' then now() + interval '1 hour' else not_before end
          where id = ${row.id}
        `.catch(() => {});
      }
      if (row?.kind === "upload_original" && message === "Original upload ownership cannot be verified") {
        console.error(`[storage-cleanup] status=ownership-quarantined id=${row.id} org=${row.org_id} action=manual-reconciliation-required`);
      }
      console.warn(`[storage-cleanup] failed target=${row?.target ?? "?"} error=${message}`);
    }
    if (!claimed) break;
  }

  if (result.purged > 0 || result.failed > 0) {
    console.log(`[storage-cleanup] cleaned=${result.purged} failed=${result.failed}`);
  }
  return result;
}

/**
 * Removes everything under a deleted workspace's LanceDB root
 * (`<root>/<orgId>/<workspaceId>/`): the vector_table drops before it cover the
 * tables Postgres knew about; this also takes tables of models no document
 * indexes any more and the directories. Object-storage roots must live in the
 * artifact bucket (the sweep has no client for another one); other roots are
 * left to their table drops with a warning.
 */
async function purgeWorkspaceVectorPrefix(
  client: Sql<Record<string, unknown>>,
  storage: PurgeStorage,
  lancedbRoot: string,
  orgId: string,
  workspaceId: string,
): Promise<void> {
  const root = VectorNamespaceManager.getWorkspaceRoot(lancedbRoot, orgId, workspaceId);
  const target = workspaceVectorPrefixTarget(root, storage.bucket);
  if (target.kind === "local") {
    await rm(target.path, { recursive: true, force: true });
  } else if (target.kind === "bucket") {
    await purgePrefix(storage, target.prefix, () => false);
  } else {
    console.warn(`[storage-cleanup] cannot purge ${root}: not a local path or the artifact bucket; known tables were dropped`);
  }
  // Their write and maintenance bookkeeping go with them.
  await client`delete from vector_index_outbox where lance_uri like ${`${root}/%`}`;
  await client`delete from vector_index_tables where lance_uri like ${`${root}/%`} or table_key like ${`${root}/%`}`;
}

/** Where a workspace root lives: a local directory, a key prefix in the artifact bucket, or elsewhere. */
export function workspaceVectorPrefixTarget(
  root: string,
  bucket: string,
): { kind: "local"; path: string } | { kind: "bucket"; prefix: string } | { kind: "unsupported" } {
  const scheme = /^([a-z0-9+]+):\/\//i.exec(root)?.[1]?.toLowerCase();
  if (!scheme) return { kind: "local", path: root };
  if (scheme === "file") return { kind: "local", path: decodeURIComponent(new URL(root).pathname) };
  if (scheme === "s3" || scheme === "s3a" || scheme === "s3+ddb") {
    const rest = root.slice(scheme.length + 3);
    const slash = rest.indexOf("/");
    const rootBucket = slash < 0 ? rest : rest.slice(0, slash);
    const key = slash < 0 ? "" : rest.slice(slash + 1).replace(/\/+$/, "");
    // Two safe segments at least (<org>/<workspace>), never a bucket root.
    if (rootBucket !== bucket || key.split("/").length < 2) return { kind: "unsupported" };
    return { kind: "bucket", prefix: `${key}/` };
  }
  return { kind: "unsupported" };
}

/** Lists and deletes every key under a prefix, except kept ones, until none remain. */
async function purgePrefix(storage: PurgeStorage, prefix: string, keep: (key: string) => boolean): Promise<void> {
  let previous = "";
  for (let page = 0; page < 1_000; page += 1) {
    const { keys } = await storage.listKeys({ prefix, maxKeys: 100_000 });
    const deletable = keys.filter((key) => !keep(key));
    if (deletable.length === 0) return;
    const fingerprint = `${deletable.length}:${deletable[0]}:${deletable[deletable.length - 1]}`;
    if (fingerprint === previous) throw new Error(`Storage delete did not remove keys under ${prefix}`);
    previous = fingerprint;
    await storage.deleteKeys(deletable);
  }
  throw new Error(`Too many keys under ${prefix}; continuing on the next sweep`);
}
