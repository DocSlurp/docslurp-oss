import { randomUUID } from "node:crypto";

import type { JSONValue, Sql } from "postgres";

import type { DocumentGraph, GraphNodeKey } from "./extract.js";
import { graphEdgeEndpoints, graphNodeKey } from "./extract.js";

type Client = Sql<Record<string, unknown>>;

const BATCH = 500;

function batches<T>(rows: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) out.push(rows.slice(index, index + size));
  return out;
}

function json(client: Client, value: unknown) {
  return client.json(JSON.parse(JSON.stringify(value ?? {})) as JSONValue);
}

/** Serializes graph writes per workspace so batch upserts cannot deadlock. */
export async function lockWorkspaceGraph(client: Client, workspaceId: string): Promise<void> {
  await client`select pg_advisory_xact_lock(hashtextextended(${`kg:${workspaceId}`}, 0))`;
}

export interface ReplaceDocumentGraphInput {
  workspaceId: string;
  userId: string;
  /** Run attributed as the latest writer; null for workspace rebuild jobs. */
  runId: string | null;
  documentId: string;
  configHash: string;
  graph: DocumentGraph;
}

/**
 * Replaces one document's contribution to the workspace graph: its chunk
 * mentions and edge evidence are swapped for the new extraction, nodes and
 * edges upsert on their workspace keys, and every touched node/edge is
 * re-derived. Running it twice for the same document is a no-op, so pipeline
 * runs, retries and rebuild jobs can all write progressively.
 */
export async function replaceDocumentGraph(sql: Client, input: ReplaceDocumentGraphInput): Promise<{
  nodes: number;
  edges: number;
}> {
  return await sql.begin(async (tx) => {
    const client = tx as unknown as Client;
    await lockWorkspaceGraph(client, input.workspaceId);

    const [document] = await client<{ run_id: string }[]>`
      select run_id from documents where id = ${input.documentId}
    `;
    if (!document) return { nodes: 0, edges: 0 };

    const previousNodes = await client<{ node_id: string }[]>`
      select distinct ce.node_id
      from chunk_entities ce
      join document_chunks c on c.id = ce.chunk_id
      where c.document_id = ${input.documentId}
      union
      select e.source_node_id from kg_edge_evidence ev join kg_edges e on e.id = ev.edge_id
      where ev.document_id = ${input.documentId}
      union
      select e.target_node_id from kg_edge_evidence ev join kg_edges e on e.id = ev.edge_id
      where ev.document_id = ${input.documentId}
    `;
    const previousEdges = await client<{ edge_id: string }[]>`
      select edge_id from kg_edge_evidence where document_id = ${input.documentId}
    `;
    await client`
      delete from chunk_entities
      where chunk_id in (select id from document_chunks where document_id = ${input.documentId})
    `;
    await client`delete from kg_edge_evidence where document_id = ${input.documentId}`;

    const nodeIds = await upsertNodes(client, input);
    const edgeIds = await upsertEdges(client, input, nodeIds);

    const evidence = input.graph.edges.flatMap((edge) => {
      const id = edgeIds.get(edgeKey(nodeIds, edge.sourceKey, edge.targetKey, edge.normalizedPredicate));
      return id
        ? [{
            edge_id: id,
            document_id: input.documentId,
            workspace_id: input.workspaceId,
            weight: edge.weight,
            confidence: edge.confidence,
          }]
        : [];
    });
    for (const batch of batches(evidence)) {
      await client`
        insert into kg_edge_evidence ${client(batch, "edge_id", "document_id", "workspace_id", "weight", "confidence")}
        on conflict (edge_id, document_id) do update set weight = excluded.weight, confidence = excluded.confidence
      `;
    }

    const nodesByKey = new Map(input.graph.nodes.map((node) => [node.key, node]));
    const mentions = input.graph.chunkEntities.flatMap((mention) => {
      const nodeId = nodeIds.get(mention.nodeKey);
      const node = nodesByKey.get(mention.nodeKey);
      return nodeId && node
        ? [{
            chunk_id: mention.chunkId,
            workspace_id: input.workspaceId,
            run_id: document.run_id,
            user_id: input.userId,
            node_id: nodeId,
            entity_name: node.canonicalName,
            entity_type: node.entityType,
            mention_count: mention.mentionCount,
            confidence: mention.confidence,
            metadata: json(client, { documentId: input.documentId, pageNumbers: mention.pageNumbers }),
          }]
        : [];
    });
    for (const batch of batches(mentions)) {
      await client`
        insert into chunk_entities ${client(
          batch,
          "chunk_id", "workspace_id", "run_id", "user_id", "node_id",
          "entity_name", "entity_type", "mention_count", "confidence", "metadata",
        )}
        on conflict (chunk_id, node_id) do update set
          mention_count = excluded.mention_count,
          confidence = excluded.confidence,
          metadata = excluded.metadata
      `;
    }

    await refreshGraphElements(client, {
      nodeIds: [...new Set([...previousNodes.map((row) => row.node_id), ...nodeIds.values()])],
      edgeIds: [...new Set([...previousEdges.map((row) => row.edge_id), ...edgeIds.values()])],
    });

    const graph = input.graph;
    await client`
      insert into kg_document_state (
        document_id, workspace_id, config_hash, source, windows, entities, relationships,
        input_tokens, output_tokens, duration_ms, extracted_at
      )
      values (
        ${input.documentId}, ${input.workspaceId}, ${input.configHash}, ${graph.source}, ${graph.windows},
        ${graph.nodes.length}, ${graph.edges.length}, ${graph.inputTokens}, ${graph.outputTokens},
        ${graph.durationMs}, now()
      )
      on conflict (document_id) do update set
        workspace_id = excluded.workspace_id,
        config_hash = excluded.config_hash,
        source = excluded.source,
        windows = excluded.windows,
        entities = excluded.entities,
        relationships = excluded.relationships,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        duration_ms = excluded.duration_ms,
        extracted_at = excluded.extracted_at
    `;
    return { nodes: nodeIds.size, edges: edgeIds.size };
  });
}

async function upsertNodes(client: Client, input: ReplaceDocumentGraphInput): Promise<Map<GraphNodeKey, string>> {
  const ids = new Map<GraphNodeKey, string>();
  // Sorted keys give every writer the same lock order on the unique index.
  const nodes = [...input.graph.nodes].sort((left, right) => (left.key < right.key ? -1 : 1));
  for (const batch of batches(nodes)) {
    const rows = batch.map((node) => ({
      id: randomUUID(),
      workspace_id: input.workspaceId,
      run_id: input.runId,
      user_id: input.userId,
      canonical_name: node.canonicalName,
      normalized_name: node.normalizedName,
      entity_type: node.entityType,
      aliases: json(client, node.aliases),
      metadata: json(client, {}),
      mention_count: node.mentionCount,
      source_document_count: 1,
      confidence: node.confidence,
    }));
    const persisted = await client<{ id: string; normalized_name: string; entity_type: string }[]>`
      insert into kg_nodes ${client(
        rows,
        "id", "workspace_id", "run_id", "user_id", "canonical_name", "normalized_name",
        "entity_type", "aliases", "metadata", "mention_count", "source_document_count", "confidence",
      )}
      on conflict (workspace_id, normalized_name, entity_type) do update set
        canonical_name = case
          when length(excluded.canonical_name) > length(kg_nodes.canonical_name) then excluded.canonical_name
          else kg_nodes.canonical_name
        end,
        aliases = (
          select coalesce(jsonb_agg(distinct alias), '[]'::jsonb)
          from jsonb_array_elements(
            case when jsonb_typeof(kg_nodes.aliases) = 'array' then kg_nodes.aliases else '[]'::jsonb end
              || excluded.aliases
          ) as alias
        ),
        confidence = greatest(kg_nodes.confidence, excluded.confidence),
        run_id = coalesce(excluded.run_id, kg_nodes.run_id),
        updated_at = now()
      returning id, normalized_name, entity_type
    `;
    for (const row of persisted) ids.set(graphNodeKey(row.normalized_name, row.entity_type), row.id);
  }
  return ids;
}

function edgeKey(nodeIds: Map<GraphNodeKey, string>, sourceKey: GraphNodeKey, targetKey: GraphNodeKey, predicate: string) {
  const [left, right] = graphEdgeEndpoints(nodeIds.get(sourceKey) ?? "", nodeIds.get(targetKey) ?? "", predicate);
  return `${left}\u0001${right}\u0001${predicate}`;
}

async function upsertEdges(
  client: Client,
  input: ReplaceDocumentGraphInput,
  nodeIds: Map<GraphNodeKey, string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const rows = input.graph.edges
    .flatMap((edge) => {
      const source = nodeIds.get(edge.sourceKey);
      const target = nodeIds.get(edge.targetKey);
      if (!source || !target || source === target) return [];
      // Only co-mentions canonicalize persisted ids; directed predicates keep their meaning.
      const [left, right] = graphEdgeEndpoints(source, target, edge.normalizedPredicate);
      return [{
        id: randomUUID(),
        workspace_id: input.workspaceId,
        run_id: input.runId,
        user_id: input.userId,
        source_node_id: left,
        target_node_id: right,
        predicate: edge.predicate,
        normalized_predicate: edge.normalizedPredicate,
        confidence: edge.confidence,
        weight: edge.weight,
        metadata: json(client, {}),
      }];
    })
    .sort((left, right) =>
      `${left.source_node_id}${left.target_node_id}${left.normalized_predicate}` <
      `${right.source_node_id}${right.target_node_id}${right.normalized_predicate}` ? -1 : 1,
    );
  for (const batch of batches(rows)) {
    const persisted = await client<{
      id: string;
      source_node_id: string;
      target_node_id: string;
      normalized_predicate: string;
    }[]>`
      insert into kg_edges ${client(
        batch,
        "id", "workspace_id", "run_id", "user_id", "source_node_id", "target_node_id",
        "predicate", "normalized_predicate", "confidence", "weight", "metadata",
      )}
      on conflict (workspace_id, source_node_id, target_node_id, normalized_predicate) do update set
        run_id = coalesce(excluded.run_id, kg_edges.run_id),
        updated_at = now()
      returning id, source_node_id, target_node_id, normalized_predicate
    `;
    for (const row of persisted) {
      ids.set(`${row.source_node_id}\u0001${row.target_node_id}\u0001${row.normalized_predicate}`, row.id);
    }
  }
  return ids;
}

/**
 * Re-derives graph elements from their evidence: edge weight/confidence from
 * `kg_edge_evidence`, node mentions from `chunk_entities` and node document
 * counts from both. Edges without evidence and nodes no current document
 * supports are deleted (cascading memberships). Edges touching the given
 * nodes are included, so callers that removed evidence wholesale only need to
 * pass the affected nodes.
 */
export async function refreshGraphElements(
  client: Client,
  targets: { nodeIds: string[]; edgeIds?: string[] },
): Promise<void> {
  const nodeIds = [...new Set(targets.nodeIds)];
  const incident = nodeIds.length
    ? await client<{ id: string }[]>`
        select id from kg_edges
        where source_node_id = any(${client.array(nodeIds)}) or target_node_id = any(${client.array(nodeIds)})
      `
    : [];
  const edgeIds = [...new Set([...(targets.edgeIds ?? []), ...incident.map((row) => row.id)])];

  for (const batch of batches(edgeIds, 2000)) {
    await client`
      update kg_edges e
      set weight = evidence.weight, confidence = evidence.confidence, updated_at = now()
      from (
        select edge_id, sum(weight)::int as weight, max(confidence) as confidence
        from kg_edge_evidence
        where edge_id = any(${client.array(batch)})
        group by edge_id
      ) evidence
      where e.id = evidence.edge_id
    `;
    await client`
      delete from kg_edges e
      where e.id = any(${client.array(batch)})
        and not exists (select 1 from kg_edge_evidence ev where ev.edge_id = e.id)
    `;
  }

  for (const batch of batches(nodeIds, 2000)) {
    await client`
      update kg_nodes n
      set mention_count = coalesce(mentions.mentions, 0),
          source_document_count = coalesce(documents.documents, 0),
          updated_at = now()
      from unnest(${client.array(batch)}::text[]) as target(id)
      left join (
        select node_id, sum(mention_count)::int as mentions
        from chunk_entities
        where node_id = any(${client.array(batch)})
        group by node_id
      ) mentions on mentions.node_id = target.id
      left join (
        select node_id, count(distinct document_id)::int as documents
        from (
          select ce.node_id, c.document_id
          from chunk_entities ce
          join document_chunks c on c.id = ce.chunk_id
          where ce.node_id = any(${client.array(batch)})
          union
          select e.source_node_id, ev.document_id
          from kg_edges e join kg_edge_evidence ev on ev.edge_id = e.id
          where e.source_node_id = any(${client.array(batch)})
          union
          select e.target_node_id, ev.document_id
          from kg_edges e join kg_edge_evidence ev on ev.edge_id = e.id
          where e.target_node_id = any(${client.array(batch)})
        ) supported
        group by node_id
      ) documents on documents.node_id = target.id
      where n.id = target.id
    `;
    await client`
      delete from kg_nodes where id = any(${client.array(batch)}) and source_document_count = 0
    `;
  }
}
