import {
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
  runId: string | null;
  configHash: string | null;
  treeKeyVersion: number;
  embeddingModel: string | null;
  dimension: number | null;
}

export async function loadSummaryTreeState(sql: Client, scope: SummaryTreeScope, documentId: string): Promise<SummaryTreeStateRow | null> {
  assertScope(scope);
  const [row] = await sql<{ status: SummaryTreeDocumentStatus; run_id: string | null; config_hash: string | null; tree_key_version: number; embedding_model: string | null; dimension: number | null }[]>`
    select status, run_id, config_hash, tree_key_version, embedding_model, dimension
    from document_summary_trees
    where document_id = ${documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}
  `;
  return row ? {
    status: row.status, runId: row.run_id, configHash: row.config_hash, treeKeyVersion: Number(row.tree_key_version),
    embeddingModel: row.embedding_model, dimension: row.dimension === null ? null : Number(row.dimension),
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
}

/**
 * Inserts or replaces the document's tree state. Refuses unless the document is a live document of exactly this
 * organization and project (not purged, superseded or archived), and unless an existing state row is this
 * tenant's. `built_at` is set only by a `ready` write.
 */
export async function writeSummaryTreeState(sql: Client, write: SummaryTreeStateWrite): Promise<void> {
  assertScope(write.scope);
  const rows = await sql<{ document_id: string }[]>`
    insert into document_summary_trees (
      document_id, org_id, project_id, run_id, status, skip_reason, tree_key_version, config_hash,
      embedding_model, dimension, leaf_count, node_count, level_count, root_node_id, error, built_at, updated_at
    )
    select d.id, d.org_id, d.project_id, ${write.runId}, ${write.status}, ${write.skipReason ?? null}, ${SUMMARY_TREE_KEY_VERSION},
      ${write.configHash ?? null}, ${write.space?.model ?? null}, ${write.space?.dimensions ?? null}::int,
      ${write.leafCount ?? 0}::int, ${write.nodeCount ?? 0}::int, ${write.levelCount ?? 0}::int, ${write.rootNodeId ?? null},
      ${write.error ?? null}, case when ${write.status} = 'ready' then now() else null end, now()
    from documents d
    where d.id = ${write.documentId} and d.org_id = ${write.scope.orgId} and d.project_id = ${write.scope.projectId}
      and d.purged_at is null and d.superseded_at is null and d.archived_at is null
    on conflict (document_id) do update set
      run_id = excluded.run_id, status = excluded.status, skip_reason = excluded.skip_reason,
      tree_key_version = excluded.tree_key_version, config_hash = excluded.config_hash,
      embedding_model = excluded.embedding_model, dimension = excluded.dimension,
      leaf_count = excluded.leaf_count, node_count = excluded.node_count, level_count = excluded.level_count,
      root_node_id = excluded.root_node_id, error = excluded.error, built_at = excluded.built_at, updated_at = now()
    where document_summary_trees.org_id = excluded.org_id and document_summary_trees.project_id = excluded.project_id
    returning document_id
  `;
  if (rows.length !== 1) throw new SummaryTreeStateRefused("The document is not a live document of this project");
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
export async function upsertSummaryTreeNodes(sql: Client, args: { scope: SummaryTreeScope; documentId: string; runId: string; rows: readonly SummaryTreeNodeRecord[] }): Promise<void> {
  assertScope(args.scope);
  if (args.rows.length === 0) return;
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
    throw new SummaryTreeStateRefused("Summary tree nodes were not written: the document has no tree state in this project, or a node id belongs elsewhere");
  }
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
    id: string; purged: boolean; pii: boolean; tree_status: string | null; artifact_uri: string | null;
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
      s.artifact_uri
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
  if (!candidate.artifact_uri) return { refused: "predecessor-artifact-unregistered" };
  return { predecessor: { documentId: candidate.id, artifactUri: candidate.artifact_uri } };
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
