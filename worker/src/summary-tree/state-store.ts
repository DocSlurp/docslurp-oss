import {
  piiWithholding,
  SUMMARY_TREE_BUILD_STALE_MS,
  SUMMARY_TREE_CLEANUP_KIND,
  SUMMARY_TREE_CORRECTED_SKIP_REASON,
  SUMMARY_TREE_KEY_VERSION,
  type SummaryTreeDocumentStatus,
  type SummaryTreeNodeStatus,
  type SummaryTreeSkipReason,
} from "@docslurp/shared";
import type { Sql } from "postgres";

/*
 * Postgres side of one document's summary tree: the state row (`document_summary_trees`), the node registry
 * (`document_summary_tree_nodes`, no text), the SQL coverage invariant and the lookup of the one document a
 * build may copy summaries from.
 *
 * Every statement names the organization and the project as well as the document. A write that matches no row
 * of that tenant throws `SummaryTreeStateRefused`; nothing here falls back to a document id alone.
 *
 * A corrected document has no tree. A completed correction reindex (the API) leaves the document's state row
 * `skipped` with skip reason `corrected`, creating the row when there is none. The worker has no access to the
 * corrections themselves; that row is how it knows. No write here replaces it and no node is registered under it, so
 * a build that was running when the correction landed is refused at its next write.
 */

type Client = Sql<Record<string, unknown>>;

export interface SummaryTreeScope {
  orgId: string;
  projectId: string;
}

/** The document is not a live document of this organization and project, or a row belongs to another tenant. */
export class SummaryTreeStateRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryTreeStateRefused";
  }
}

function assertScope(scope: SummaryTreeScope): void {
  if (!scope.orgId?.trim() || !scope.projectId?.trim()) {
    throw new SummaryTreeStateRefused("Summary tree state requires the document's orgId and projectId");
  }
}

export interface SummaryTreeStateRow {
  status: SummaryTreeDocumentStatus;
  skipReason: SummaryTreeSkipReason | null;
  runId: string | null;
  configHash: string | null;
  treeKeyVersion: number;
  embeddingModel: string | null;
  dimension: number | null;
  /** Who holds a `building` row (`run:<runId>`, `job:<jobId>`); null otherwise. */
  buildOwner: string | null;
  /**
   * A `building` row whose build still reports: touched within `SUMMARY_TREE_BUILD_STALE_MS` (the database's clock).
   * False for every other status and for a row a dead worker left behind.
   */
  buildLive: boolean;
}

export async function loadSummaryTreeState(sql: Client, scope: SummaryTreeScope, documentId: string, staleMs: number = SUMMARY_TREE_BUILD_STALE_MS): Promise<SummaryTreeStateRow | null> {
  assertScope(scope);
  const [row] = await sql<{ status: SummaryTreeDocumentStatus; skip_reason: SummaryTreeSkipReason | null; run_id: string | null; config_hash: string | null; tree_key_version: number; embedding_model: string | null; dimension: number | null; build_owner: string | null; build_live: boolean }[]>`
    select status, skip_reason, run_id, config_hash, tree_key_version, embedding_model, dimension, build_owner,
      (status = 'building' and updated_at > now() - ${`${Math.max(0, staleMs)} milliseconds`}::interval) as build_live
    from document_summary_trees
    where document_id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}
  `;
  return row ? {
    status: row.status, skipReason: row.skip_reason, runId: row.run_id, configHash: row.config_hash, treeKeyVersion: Number(row.tree_key_version),
    embeddingModel: row.embedding_model, dimension: row.dimension === null ? null : Number(row.dimension),
    buildOwner: row.build_owner, buildLive: row.build_live === true,
  } : null;
}

export interface SummaryTreeStateWrite {
  scope: SummaryTreeScope;
  documentId: string;
  runId: string;
  status: SummaryTreeDocumentStatus;
  skipReason?: SummaryTreeSkipReason | null;
  configHash?: string | null;
  space?: { model: string; dimensions: number } | null;
  leafCount?: number;
  nodeCount?: number;
  levelCount?: number;
  rootNodeId?: string | null;
  /** A short named reason (never document text or a provider message). */
  error?: string | null;
  /** The builder taking the row (`building` only); every other status clears the owner. */
  buildOwner?: string | null;
  /**
   * When set, an existing row is replaced only while this builder still holds it: a build that another one took
   * over cannot write its outcome over the newer build's state.
   */
  expectOwner?: string;
  /** Refuse a fresh different builder at the atomic claim, not only the earlier scan. */
  refuseLiveOwner?: boolean;
  buildStaleMs?: number;
}

/**
 * Inserts or replaces the document's tree state. Refuses unless the document is a live document of exactly this
 * organization and project (not purged, superseded or archived), and unless an existing state row is this
 * tenant's (and, with `expectOwner`, still held by that builder), and never over a `corrected` row: the check is part
 * of the write itself, so a correction that commits while a build runs wins whichever order the two arrive in.
 * `built_at` is set only by a `ready` write, so a rebuild that ends `ready` again always carries a later `built_at`.
 * Every write is also the build's heartbeat (`updated_at`). A `building` write raises `build_generation`: a queued
 * removal of the document's summary data carries the generation it was asked at (`enqueueSummaryTreeCleanup`), and
 * the sweep leaves a tree of a later generation alone.
 */
export class SummaryTreeBuildInProgress extends SummaryTreeStateRefused {
  constructor() { super("Another live builder holds the tree"); this.name = "SummaryTreeBuildInProgress"; }
}

/** Serialize tree ownership and mutations with deletion and summary-row writes. Pass the
 * transaction client into work; never obtain another connection while holding this lock.
 * FOR NO KEY UPDATE: it still excludes deletion (FOR UPDATE), the supersession trigger's update and other
 * builders, but not the FOR KEY SHARE that run creation takes on a chain's latest version, so uploading a new
 * version while this tree builds is not refused. */
/**
 * Whether the PII outcome lets a tree be built, read through the shared fail-closed helper (a malformed or unknown
 * outcome withholds the whole document). Page- and section-scoped withholding build from the rewritten text (withheld
 * pages are already the placeholder), so the pre-scan artifacts they withhold and the earlier tree they withdrew do not
 * refuse a new one. Whole-document, redaction and every other withheld outcome do.
 */
function summaryTreePiiAllows(row: { status: string | null; pii: unknown; withheld_count: number; redacted_detection: boolean; withdrawn: boolean }): boolean {
  const withholding = piiWithholding({ status: row.status, metadata: row.pii === null || row.pii === undefined ? {} : { pii: row.pii } });
  if (withholding.scope === "document") return false;
  if ((row.pii as { redacted?: unknown } | null)?.redacted === true || row.redacted_detection) return false;
  if (withholding.scope === "pages" || withholding.scope === "sections") return true;
  return Number(row.withheld_count) === 0 && !row.withdrawn;
}

export async function withSummaryTreeDocumentLock<T>(sql: Client, scope: SummaryTreeScope, documentId: string, owner: string | undefined, work: (tx: Client) => Promise<T>): Promise<T> {
  assertScope(scope);
  const run = async (tx: Client): Promise<T> => {
    const [document] = await tx<Array<{ id: string; status: string | null; pii: unknown; withheld_count: number; redacted_detection: boolean; withdrawn: boolean }>>`
      select id, status, metadata->'pii' as pii,
        coalesce(jsonb_array_length(case when jsonb_typeof(metadata->'pii'->'withheldArtifactUris') = 'array'
          then metadata->'pii'->'withheldArtifactUris' else '[]'::jsonb end), 0) as withheld_count,
        exists (select 1 from pii_detections pd where pd.document_id = documents.id and pd.redacted) as redacted_detection,
        exists (select 1 from document_summary_trees t where t.document_id = documents.id and t.error = 'pii-withheld') as withdrawn
      from documents where id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}
        and purged_at is null and superseded_at is null and archived_at is null
        for no key update
    `;
    if (document && !summaryTreePiiAllows(document)) throw new SummaryTreeStateRefused("The document is not live in this project");
    if (!document) throw new SummaryTreeStateRefused("The document is not live in this project");
    if (owner !== undefined) {
      const [held] = await tx`select document_id from document_summary_trees
        where document_id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}
          and status = 'building' and build_owner = ${owner}`;
      if (!held) throw new SummaryTreeStateRefused("Another builder or withdrawal took the tree");
    }
    return work(tx);
  };
  return typeof (sql as { begin?: unknown }).begin === "function"
    ? await sql.begin((tx) => run(tx as unknown as Client)) as T
    : await run(sql);
}

/** A durable recovery watch exists before the first object PUT. It survives document deletion,
 * and its cleanup tombstone keeps catching PUTs that complete after a worker loses its DB connection. */
export async function watchSummaryTreeArtifact(sql: Client, args: { scope: SummaryTreeScope; documentId: string; artifactRoot: string }): Promise<void> {
  assertScope(args.scope);
  await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, reason, not_before)
    values (${SUMMARY_TREE_CLEANUP_KIND}, ${args.scope.orgId}, ${`${args.scope.orgId}|${args.scope.projectId}|${args.documentId}|artifact-watch`},
      ${JSON.stringify({ projectId: args.scope.projectId, documentId: args.documentId, artifactWatch: true, artifactRoots: [args.artifactRoot] })}::text::jsonb,
      'summary_tree_artifact_watch', now() + interval '1 day')
    on conflict (kind, target) do update set payload = storage_cleanup_queue.payload || jsonb_build_object('artifactRoots',
      (select jsonb_agg(distinct root) from jsonb_array_elements(coalesce(storage_cleanup_queue.payload->'artifactRoots', '[]'::jsonb) || excluded.payload->'artifactRoots') root))`;
}

export async function writeSummaryTreeState(sql: Client, write: SummaryTreeStateWrite): Promise<void> {
  assertScope(write.scope);
  return withSummaryTreeDocumentLock(sql, write.scope, write.documentId, undefined, async (sql) => {
    if (write.refuseLiveOwner) {
      const [busy] = await sql`select document_id from document_summary_trees where document_id = ${write.documentId}
        and status = 'building' and build_owner is distinct from ${write.buildOwner ?? null}
        and updated_at > now() - ${`${write.buildStaleMs ?? SUMMARY_TREE_BUILD_STALE_MS} milliseconds`}::interval`;
      if (busy) throw new SummaryTreeBuildInProgress();
    }
    const rows = await sql<{ document_id: string }[]>`
      insert into document_summary_trees (
        document_id, org_id, project_id, run_id, status, skip_reason, tree_key_version, config_hash,
        embedding_model, dimension, leaf_count, node_count, level_count, root_node_id, error, build_owner, built_at, updated_at,
        build_generation
      )
      select d.id, d.org_id, d.project_id, ${write.runId}, ${write.status}, ${write.skipReason ?? null}, ${SUMMARY_TREE_KEY_VERSION},
        ${write.configHash ?? null}, ${write.space?.model ?? null}, ${write.space?.dimensions ?? null}::int,
        ${write.leafCount ?? 0}::int, ${write.nodeCount ?? 0}::int, ${write.levelCount ?? 0}::int, ${write.rootNodeId ?? null},
        ${write.error ?? null}, ${write.status === "building" ? write.buildOwner ?? null : null},
        case when ${write.status} = 'ready' then now() else null end, now(),
        case when ${write.status} = 'building' then 1 else 0 end
      from documents d
      where d.id = ${write.documentId} and d.org_id = ${write.scope.orgId} and d.project_id = ${write.scope.projectId}
        and d.purged_at is null and d.superseded_at is null and d.archived_at is null
      on conflict (document_id) do update set
        run_id = excluded.run_id, status = excluded.status, skip_reason = excluded.skip_reason,
        tree_key_version = excluded.tree_key_version, config_hash = excluded.config_hash,
        embedding_model = excluded.embedding_model, dimension = excluded.dimension,
        leaf_count = excluded.leaf_count, node_count = excluded.node_count, level_count = excluded.level_count,
        root_node_id = excluded.root_node_id, error = excluded.error, build_owner = excluded.build_owner,
        built_at = excluded.built_at, updated_at = now(),
        -- A build taking the row is a new generation (a heartbeat is not a write of this statement).
        build_generation = document_summary_trees.build_generation + excluded.build_generation
      where document_summary_trees.org_id = excluded.org_id and document_summary_trees.project_id = excluded.project_id
        and document_summary_trees.skip_reason is distinct from ${SUMMARY_TREE_CORRECTED_SKIP_REASON}
        and (${write.expectOwner ?? null}::text is null or document_summary_trees.build_owner is not distinct from ${write.expectOwner ?? null}::text)
      returning document_id
    `;
    if (rows.length !== 1) {
      throw new SummaryTreeStateRefused(write.expectOwner
        ? "The document is not a live document of this project, was corrected, or another build took its tree over"
        : "The document is not a live document of this project, or was corrected");
    }
  });
}

/**
 * The heartbeat of a build: touches the `building` row this builder holds. False when the row is gone, is no longer
 * `building`, or another builder took it: the caller stops without writing an outcome.
 */
export async function touchSummaryTreeBuild(sql: Client, scope: SummaryTreeScope, documentId: string, owner: string): Promise<boolean> {
  assertScope(scope);
  const rows = await sql<{ document_id: string }[]>`
    update document_summary_trees set updated_at = now()
    where document_id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}
      and status = 'building' and build_owner = ${owner}
    returning document_id
  `;
  return rows.length === 1;
}

/**
 * Where a document stands for its summary tree, read at the moment of asking:
 * - `live`: a current document of this organization and project that may have a tree;
 * - `corrected`: live, but a correction reindex replaced its chunks (see the note at the top of this file);
 * - `retired`: superseded or archived; the purge paths own what is left of it;
 * - `gone`: deleted, purged, or not this tenant's.
 */
export type SummaryTreeDocumentStanding = "live" | "corrected" | "retired" | "gone";

export async function summaryTreeDocumentStanding(sql: Client, scope: SummaryTreeScope, documentId: string): Promise<SummaryTreeDocumentStanding> {
  assertScope(scope);
  const [row] = await sql<{ purged: boolean; retired: boolean; corrected: boolean }[]>`
    select d.purged_at is not null as purged,
      (d.superseded_at is not null or d.archived_at is not null) as retired,
      exists (
        select 1 from document_summary_trees t
        where t.document_id = d.id and t.skip_reason = ${SUMMARY_TREE_CORRECTED_SKIP_REASON}
      ) as corrected
    from documents d
    where d.id = ${documentId} and d.org_id = ${scope.orgId} and d.project_id = ${scope.projectId}
  `;
  if (!row || row.purged) return "gone";
  if (row.retired) return "retired";
  return row.corrected ? "corrected" : "live";
}

/**
 * Queues strict removal of one document's summary rows and text artifact (`storage_cleanup_queue`, drained by
 * `drainStorageCleanupQueue`). `spaces` and `artifactRoots` name where a build of a document that no longer exists
 * wrote; for a document that still has rows in Postgres the sweep also finds them itself. Queuing again while an
 * entry waits makes that entry due now and resets its attempts, so a removal asked for after a failed one is not
 * lost to the first one's count.
 *
 * The entry is stamped with the document's build generation at this moment (0 when it has no tree state). A tree
 * that a later build finished is not this removal's to delete: the sweep keeps it and only prunes what was there
 * before (superseded-purge.ts `removeDocumentSummaryTree`).
 */
export async function enqueueSummaryTreeCleanup(sql: Client, args: {
  scope: SummaryTreeScope;
  documentId: string;
  reason: string;
  spaces?: ReadonlyArray<{ model: string; dimensions: number }>;
  artifactRoots?: readonly string[];
}): Promise<void> {
  assertScope(args.scope);
  const payload = {
    projectId: args.scope.projectId,
    documentId: args.documentId,
    spaces: (args.spaces ?? []).filter((space) => space.model && space.dimensions > 0).map((space) => ({ embeddingModel: space.model, dimension: space.dimensions })),
    artifactRoots: [...new Set(args.artifactRoots ?? [])],
  };
  await sql`
    insert into storage_cleanup_queue (kind, org_id, target, payload, reason)
    values (${SUMMARY_TREE_CLEANUP_KIND}, ${args.scope.orgId}, ${`${args.scope.orgId}|${args.scope.projectId}|${args.documentId}`},
      ${JSON.stringify(payload)}::text::jsonb || jsonb_build_object('generation', coalesce((
        select t.build_generation from document_summary_trees t
        where t.document_id = ${args.documentId} and t.org_id = ${args.scope.orgId} and t.project_id = ${args.scope.projectId}
      ), 0)), ${args.reason})
    on conflict (kind, target) do update set
      payload = jsonb_build_object(
        'projectId', excluded.payload -> 'projectId',
        'documentId', excluded.payload -> 'documentId',
        -- The latest request decides: a removal asked for again covers every build up to now.
        'generation', excluded.payload -> 'generation',
        'spaces', coalesce(storage_cleanup_queue.payload -> 'spaces', '[]'::jsonb) || coalesce(excluded.payload -> 'spaces', '[]'::jsonb),
        'artifactRoots', coalesce(storage_cleanup_queue.payload -> 'artifactRoots', '[]'::jsonb) || coalesce(excluded.payload -> 'artifactRoots', '[]'::jsonb)
      ),
      reason = excluded.reason, not_before = now(), attempts = 0, last_error = null
  `;
}

/**
 * A document that already has a tree was blocked or redacted by the PII policy (a rescan of a document processed
 * before the policy, a retry in place): what the tree says was written from the text that is now withheld. Its state
 * leaves `ready` at once (search reads only `ready` trees) and strict removal of its summary rows and artifact is
 * queued. A redacted or wholly withheld document cannot build again (a new document or version is required, so an old
 * in-flight object write can never overwrite a safe replacement under the same artifact root). A page- or
 * section-scoped document builds again from the rewritten text; a stale build of an earlier attempt of the same run is
 * fenced by its owner, which is unique per build (`run:<runId>#<build>`, summary-tree/build.ts), so its later writes are
 * refused once a newer build holds the tree. A document without
 * a tree (every first ingestion) is left alone, so its own build is not disturbed. Returns whether a tree was withdrawn.
 */
export async function withdrawSummaryTreeForPii(sql: Client, documentId: string): Promise<boolean> {
  if (typeof (sql as { begin?: unknown }).begin === "function") {
    return await sql.begin((tx) => withdrawSummaryTreeForPii(tx as unknown as Client, documentId)) as boolean;
  }
  const [document] = await sql<{ org_id: string | null; project_id: string | null }[]>`
    select org_id, project_id from documents where id = ${documentId} for no key update
  `;
  if (!document?.org_id || !document.project_id) return false;
  const scope = { orgId: document.org_id, projectId: document.project_id };
  const withdrawn = await sql<{ document_id: string }[]>`
    update document_summary_trees
    set status = 'partial', error = 'pii-withheld', build_owner = null, built_at = null, root_node_id = null, updated_at = now()
    where document_id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}
      and status <> 'skipped'
    returning document_id
  `;
  // The full-tree root is also the document summary. Erase that derived text in the
  // same transaction that withdraws serving, including a tree previously skipped.
  await sql`delete from document_summaries s using documents d
    where s.document_id = d.id and d.id = ${documentId} and d.org_id = ${scope.orgId} and d.project_id = ${scope.projectId}
      and exists (select 1 from document_summary_trees t where t.document_id = d.id)`;
  if (withdrawn.length === 0) return false;
  await enqueueSummaryTreeCleanup(sql, { scope, documentId, reason: "pii_withheld" });
  return true;
}

/**
 * Whether a builder may still write for its document, read at the moment of asking:
 * - `holding`: the document is a live document of this tenant and its `building` row is this builder's;
 * - `taken-over`: the document is live and uncorrected, but another build (or a cleanup) holds its tree now;
 * - `refused`: the document was deleted, purged, superseded, archived or corrected, or is not this tenant's.
 */
export async function summaryTreeBuildStanding(sql: Client, scope: SummaryTreeScope, documentId: string, owner: string): Promise<"holding" | "taken-over" | "refused"> {
  assertScope(scope);
  const [row] = await sql<{ live: boolean; holding: boolean | null; corrected: boolean | null }[]>`
    select (d.purged_at is null and d.superseded_at is null and d.archived_at is null) as live,
      (t.status = 'building' and t.build_owner = ${owner}) as holding,
      (t.skip_reason = ${SUMMARY_TREE_CORRECTED_SKIP_REASON}) as corrected
    from documents d
    left join document_summary_trees t on t.document_id = d.id and t.org_id = d.org_id and t.project_id = d.project_id
    where d.id = ${documentId} and d.org_id = ${scope.orgId} and d.project_id = ${scope.projectId}
  `;
  if (!row || !row.live || row.corrected === true) return "refused";
  return row.holding === true ? "holding" : "taken-over";
}

export interface SummaryTreeNodeRecord {
  id: string;
  nodeHash: string;
  level: number;
  ordinal: number;
  status: SummaryTreeNodeStatus;
  chunkStart: number;
  chunkEnd: number;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface StoredSummaryTreeNode {
  id: string;
  nodeHash: string;
  status: SummaryTreeNodeStatus;
  runId: string | null;
}

export async function loadSummaryTreeNodes(sql: Client, scope: SummaryTreeScope, documentId: string): Promise<Map<string, StoredSummaryTreeNode>> {
  assertScope(scope);
  const rows = await sql<{ id: string; node_hash: string; status: SummaryTreeNodeStatus; run_id: string | null }[]>`
    select id, node_hash, status, run_id from document_summary_tree_nodes
    where document_id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}
  `;
  return new Map(rows.map((row) => [row.id, { id: row.id, nodeHash: row.node_hash, status: row.status, runId: row.run_id }]));
}

/**
 * Upserts registry rows (keyed by node id; safe to replay). The rows are written only while the document has a
 * tree state row of this tenant, and an existing row is replaced only if it is this document's and this
 * tenant's. Parent links are written once, by `linkSummaryTreeNodes`, when the tree is complete.
 */
export async function upsertSummaryTreeNodes(sql: Client, args: { scope: SummaryTreeScope; documentId: string; runId: string; owner?: string; rows: readonly SummaryTreeNodeRecord[] }): Promise<void> {
  assertScope(args.scope);
  if (args.rows.length === 0) return;
  return withSummaryTreeDocumentLock(sql, args.scope, args.documentId, args.owner, async (sql) => {
    const payload = JSON.stringify(args.rows.map((row) => ({
      id: row.id, node_hash: row.nodeHash, level: row.level, ordinal: row.ordinal, status: row.status,
      chunk_start: row.chunkStart, chunk_end: row.chunkEnd, page_start: row.pageStart, page_end: row.pageEnd,
    })));
    const written = await sql<{ id: string }[]>`
      insert into document_summary_tree_nodes (
        id, document_id, org_id, project_id, run_id, node_hash, level, ordinal, status,
        chunk_start, chunk_end, page_start, page_end, updated_at
      )
      select r.id, ${args.documentId}, ${args.scope.orgId}, ${args.scope.projectId}, ${args.runId}, r.node_hash, r.level, r.ordinal, r.status,
        r.chunk_start, r.chunk_end, r.page_start, r.page_end, now()
      from jsonb_to_recordset(${payload}::text::jsonb) as r(
        id text, node_hash text, level int, ordinal int, status text, chunk_start int, chunk_end int, page_start int, page_end int
      )
      where exists (
        select 1 from document_summary_trees t
        where t.document_id = ${args.documentId} and t.org_id = ${args.scope.orgId} and t.project_id = ${args.scope.projectId}
          and t.status <> 'skipped'
      )
      on conflict (id) do update set
        run_id = excluded.run_id, node_hash = excluded.node_hash, level = excluded.level, ordinal = excluded.ordinal,
        status = excluded.status, chunk_start = excluded.chunk_start, chunk_end = excluded.chunk_end,
        page_start = excluded.page_start, page_end = excluded.page_end, updated_at = now()
      where document_summary_tree_nodes.document_id = excluded.document_id
        and document_summary_tree_nodes.org_id = excluded.org_id
        and document_summary_tree_nodes.project_id = excluded.project_id
      returning id
    `;
    if (written.length !== args.rows.length) {
      throw new SummaryTreeStateRefused("Summary tree nodes were not written: the document has no tree being built in this project, or a node id belongs elsewhere");
    }
  });
}

/** Sets every node's parent and ordinal from the finished tree, in one statement. */
export async function linkSummaryTreeNodes(sql: Client, args: { scope: SummaryTreeScope; documentId: string; links: ReadonlyArray<{ id: string; parentId: string | null; ordinal: number }> }): Promise<void> {
  assertScope(args.scope);
  if (args.links.length === 0) return;
  const payload = JSON.stringify(args.links.map((link) => ({ id: link.id, parent_id: link.parentId, ordinal: link.ordinal })));
  const updated = await sql<{ id: string }[]>`
    update document_summary_tree_nodes n
    set parent_id = r.parent_id, ordinal = r.ordinal, updated_at = now()
    from jsonb_to_recordset(${payload}::text::jsonb) as r(id text, parent_id text, ordinal int)
    where n.id = r.id and n.document_id = ${args.documentId} and n.org_id = ${args.scope.orgId} and n.project_id = ${args.scope.projectId}
    returning n.id
  `;
  if (updated.length !== args.links.length) throw new SummaryTreeStateRefused("Summary tree nodes were not linked: a node of the tree has no registry row");
}

/** Registry ids of the document that are not in `keep` (nodes a rebuild replaced). */
export async function staleSummaryTreeNodeIds(sql: Client, scope: SummaryTreeScope, documentId: string, keep: readonly string[]): Promise<string[]> {
  assertScope(scope);
  const rows = await sql<{ id: string }[]>`
    select id from document_summary_tree_nodes
    where document_id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}
      and not (id = any(${sql.array([...keep])}::text[]))
  `;
  return rows.map((row) => row.id);
}

export async function deleteSummaryTreeNodes(sql: Client, scope: SummaryTreeScope, documentId: string, ids: readonly string[] | "all"): Promise<void> {
  assertScope(scope);
  if (ids === "all") {
    await sql`delete from document_summary_tree_nodes where document_id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}`;
    return;
  }
  if (ids.length === 0) return;
  await sql`
    delete from document_summary_tree_nodes
    where document_id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}
      and id = any(${sql.array([...ids])}::text[])
  `;
}

export interface SummaryTreeSqlCoverage {
  /** Registry rows of the document. */
  nodes: number;
  /** Rows that are not `ready`. */
  notReady: number;
  /** Rows without a parent; a complete tree has exactly one, the root. */
  roots: number;
  /** Rows whose parent is missing, not ready, another document's, or not above them. */
  badParents: number;
  /** Parents with fewer than two children. */
  thinParents: number;
  /** Parents whose chunk range is not exactly the span of their children. */
  rangeMismatches: number;
  /** Level-1 groups whose chunk range overlaps the group before them. */
  overlappingGroups: number;
  /** Leaves inside no level-1 group. */
  uncoveredLeaves: number;
  rootId: string | null;
}

/**
 * The coverage invariant, read back from Postgres after the last write: every leaf lies in exactly one level-1
 * group (the groups do not overlap and each leaf's chunk index falls inside one), every node except one root has
 * exactly one ready parent above it in the same document, and no row is unfinished. `leafChunkIndexes` are the
 * document's leaves as the build selected them.
 */
export async function readSummaryTreeCoverage(sql: Client, args: { scope: SummaryTreeScope; documentId: string; leafChunkIndexes: readonly number[] }): Promise<SummaryTreeSqlCoverage> {
  assertScope(args.scope);
  const [row] = await sql<Record<string, string | number | null>[]>`
    with nodes as (
      select id, parent_id, level, status, chunk_start, chunk_end
      from document_summary_tree_nodes
      where document_id = ${args.documentId} and org_id = ${args.scope.orgId} and project_id = ${args.scope.projectId}
    ),
    children as (
      select parent_id, count(*) as child_count, min(chunk_start) as span_start, max(chunk_end) as span_end
      from nodes where parent_id is not null group by parent_id
    ),
    groups as (
      select chunk_start, chunk_end, lag(chunk_end) over (order by chunk_start, chunk_end) as previous_end
      from nodes where level = 1 and status = 'ready'
    ),
    events as (
      select chunk_start as position, 0 as kind, chunk_end as group_end from groups
      union all
      select leaf.position, 1 as kind, null::int as group_end from unnest(${sql.array([...args.leafChunkIndexes])}::int[]) as leaf(position)
    ),
    walked as (
      select position, kind, max(group_end) over (order by position, kind rows between unbounded preceding and current row) as reach
      from events
    )
    select
      (select count(*) from nodes) as nodes,
      (select count(*) from nodes where status <> 'ready') as not_ready,
      (select count(*) from nodes where parent_id is null) as roots,
      (select count(*) from nodes n where n.parent_id is not null and not exists (
        select 1 from nodes p where p.id = n.parent_id and p.status = 'ready' and p.level > n.level
      )) as bad_parents,
      (select count(*) from children where child_count < 2) as thin_parents,
      (select count(*) from children c join nodes p on p.id = c.parent_id where p.chunk_start <> c.span_start or p.chunk_end <> c.span_end) as range_mismatches,
      (select count(*) from groups where previous_end is not null and previous_end >= chunk_start) as overlapping_groups,
      (select count(*) from walked where kind = 1 and (reach is null or reach < position)) as uncovered_leaves,
      (select min(id) from nodes where parent_id is null) as root_id
  `;
  const count = (key: string) => Number(row?.[key] ?? 0);
  return {
    nodes: count("nodes"), notReady: count("not_ready"), roots: count("roots"), badParents: count("bad_parents"),
    thinParents: count("thin_parents"), rangeMismatches: count("range_mismatches"),
    overlappingGroups: count("overlapping_groups"), uncoveredLeaves: count("uncovered_leaves"),
    rootId: typeof row?.root_id === "string" ? row.root_id : null,
  };
}

/** Names of the checks a coverage reading fails; empty when the tree may be served. */
export function summaryTreeCoverageProblems(coverage: SummaryTreeSqlCoverage, expected: { nodes: number; rootId: string | null }): string[] {
  const problems: string[] = [];
  if (coverage.nodes !== expected.nodes) problems.push("node-count");
  if (coverage.notReady > 0) problems.push("node-not-ready");
  if (coverage.roots !== 1 || coverage.rootId !== expected.rootId) problems.push("root");
  if (coverage.badParents > 0) problems.push("node-parent");
  if (coverage.thinParents > 0) problems.push("single-child-parent");
  if (coverage.rangeMismatches > 0) problems.push("parent-range");
  if (coverage.overlappingGroups > 0) problems.push("leaf-in-multiple-groups");
  if (coverage.uncoveredLeaves > 0) problems.push("leaf-without-group");
  return problems;
}

export interface SummaryReusePredecessor {
  documentId: string;
  /** The stage artifact its build registered (`.../summary-tree/<documentId>/summaries.jsonl`). */
  artifactUri: string;
  /**
   * `<run root>` of the run the predecessor's tree was built in, from its own rows: the run's storage prefix, else
   * `<the predecessor's user>/<that run>`. Its artifact can only be `<runRoot>/summary-tree/<documentId>/…`.
   */
  runRoot: string;
}

export type SummaryReuseRefusal =
  | "no-canonical-chain"
  | "no-predecessor"
  | "ambiguous-predecessor"
  | "predecessor-purged"
  | "predecessor-pii"
  | "predecessor-has-no-tree"
  | "predecessor-artifact-unregistered";

/**
 * The one document a build may copy summaries from: the version this document directly replaces.
 *
 * It is the completed document of the same organization, project and canonical id that is older than this one
 * and is either still current (this document has not completed yet) or was superseded by exactly this document.
 * A node hash holds no tenant or document id, so this lookup is the tenant boundary of reuse; it fails closed:
 *
 * - no canonical id, no such document, or more than one candidate: no reuse;
 * - the predecessor (or its run's artifacts) is purged or archived: no reuse. A deleted document has no row at
 *   all, and a version superseded by a since-deleted document names that document, not this one, so delete then
 *   re-upload regenerates;
 * - the predecessor is PII-blocked, redacted, or withholds artifacts: no reuse;
 * - the predecessor has no tree of this tenant, or its build registered no artifact: no reuse.
 */
export async function findSummaryReusePredecessor(sql: Client, scope: SummaryTreeScope, documentId: string): Promise<{ predecessor: SummaryReusePredecessor } | { refused: SummaryReuseRefusal }> {
  assertScope(scope);
  const [current] = await sql<{ canonical_id: string | null }[]>`
    select canonical_id from documents
    where id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId} and purged_at is null
  `;
  if (!current?.canonical_id) return { refused: "no-canonical-chain" };
  const candidates = await sql<{
    id: string; purged: boolean; pii: boolean; tree_status: string | null; artifact_uri: string | null; run_root: string | null;
  }[]>`
    select p.id,
      (p.purged_at is not null or p.archived_at is not null or coalesce(r.artifacts_purged_at is not null, false)) as purged,
      (
        coalesce((p.metadata->'pii'->>'blocked')::boolean, false)
        or coalesce((p.metadata->'pii'->>'redacted')::boolean, false)
        or coalesce(jsonb_array_length(case when jsonb_typeof(p.metadata->'pii'->'withheldArtifactUris') = 'array'
          then p.metadata->'pii'->'withheldArtifactUris' else '[]'::jsonb end), 0) > 0
        or exists (select 1 from pii_detections pd where pd.document_id = p.id and pd.redacted)
      ) as pii,
      t.status as tree_status,
      s.artifact_uri,
      -- The tree's own run, of the predecessor's own project.
      (select coalesce(tr.storage_prefix, p.user_id || '/' || tr.id) from project_runs tr
        where tr.id = t.run_id and tr.project_id = p.project_id and tr.org_id = p.org_id) as run_root
    from documents d
    join documents p
      on p.org_id = d.org_id and p.project_id = d.project_id and p.canonical_id = d.canonical_id and p.id <> d.id
    left join project_runs r on r.id = p.run_id
    left join document_summary_trees t
      on t.document_id = p.id and t.org_id = d.org_id and t.project_id = d.project_id
    left join document_run_stage_states s
      on s.document_id = p.id and s.run_id = t.run_id and s.stage_name = 'summary-tree' and s.status = 'completed'
    where d.id = ${documentId} and d.org_id = ${scope.orgId} and d.project_id = ${scope.projectId}
      and p.org_id = ${scope.orgId} and p.project_id = ${scope.projectId}
      and p.status = 'completed'
      and (p.created_at, p.id) < (d.created_at, d.id)
      and (p.superseded_at is null or p.superseded_by_document_id = d.id)
    limit 2
  `;
  if (candidates.length === 0) return { refused: "no-predecessor" };
  if (candidates.length > 1) return { refused: "ambiguous-predecessor" };
  const candidate = candidates[0]!;
  if (candidate.purged) return { refused: "predecessor-purged" };
  if (candidate.pii) return { refused: "predecessor-pii" };
  if (candidate.tree_status !== "ready" && candidate.tree_status !== "partial") return { refused: "predecessor-has-no-tree" };
  if (!candidate.artifact_uri || !candidate.run_root) return { refused: "predecessor-artifact-unregistered" };
  return { predecessor: { documentId: candidate.id, artifactUri: candidate.artifact_uri, runRoot: candidate.run_root } };
}

/**
 * Registers a build's text artifact as the document's `summary-tree` stage artifact, for a build that ran outside
 * a run's own stage checkpoint (the backfill job). The document delete and purge paths remove registered
 * artifacts, and the next version's reuse lookup reads the predecessor's artifact from here. `runId` must be a run
 * of the document's project.
 */
export async function registerSummaryTreeArtifact(sql: Client, args: { scope: SummaryTreeScope; documentId: string; runId: string; artifactUri: string; stats?: Record<string, unknown> }): Promise<void> {
  assertScope(args.scope);
  const rows = await sql<{ document_id: string }[]>`
    insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, artifact_uri, stats, started_at, completed_at, updated_at)
    select r.id, d.id, 'summary-tree', 'completed', 1, ${args.artifactUri}, ${JSON.stringify(args.stats ?? {})}::text::jsonb, now(), now(), now()
    from documents d
    join project_runs r on r.id = ${args.runId} and r.project_id = d.project_id
    where d.id = ${args.documentId} and d.org_id = ${args.scope.orgId} and d.project_id = ${args.scope.projectId} and d.purged_at is null
    on conflict (run_id, document_id, stage_name) do update set
      status = 'completed', artifact_uri = excluded.artifact_uri, stats = excluded.stats, error = null, completed_at = now(), updated_at = now()
    returning document_id
  `;
  if (rows.length !== 1) throw new SummaryTreeStateRefused("The summary tree artifact was not registered: the document or the run is not this project's");
}

/**
 * Marks documents that have no tree state yet as `skipped`, in one statement: the backfill job's path for the many
 * small documents of a project (below the long-document floor by their stored chunk count), which need no artifact
 * read and no per-document round trips. A document that already has a state row, or is not a live document of
 * exactly this organization and project, is left alone. Returns the ids that were marked.
 */
export async function markSummaryTreesSkipped(sql: Client, args: { scope: SummaryTreeScope; documentIds: readonly string[]; skipReason: SummaryTreeSkipReason }): Promise<string[]> {
  assertScope(args.scope);
  if (args.documentIds.length === 0) return [];
  const rows = await sql<{ document_id: string }[]>`
    insert into document_summary_trees (document_id, org_id, project_id, run_id, status, skip_reason, tree_key_version, updated_at)
    select d.id, d.org_id, d.project_id, d.run_id, 'skipped', ${args.skipReason}, ${SUMMARY_TREE_KEY_VERSION}, now()
    from documents d
    where d.id = any(${sql.array([...args.documentIds])}::text[])
      and d.org_id = ${args.scope.orgId} and d.project_id = ${args.scope.projectId}
      and d.purged_at is null and d.superseded_at is null and d.archived_at is null
    on conflict (document_id) do nothing
    returning document_id
  `;
  return rows.map((row) => row.document_id);
}
