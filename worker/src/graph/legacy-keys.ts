/**
 * Heals project graphs written before entities were keyed by Unicode names (fingerprint g4, graph.ts).
 *
 * Earlier keys kept ASCII letters only, so "Müller" was stored as "mller" (and never met the "müller" a newer
 * document produces: one entity, two nodes that no query joins) and a name with no ASCII letters, every Chinese,
 * Japanese, Korean, Arabic or Cyrillic name, was stored under the empty key, one node per entity type that
 * merged every such name in the project into a single "entity".
 *
 * A rebuild would re-extract those documents with a model and spend credits, so nothing is enqueued. This pass
 * costs nothing: it re-keys each old node from the names the node itself holds, merges it into the node that
 * already has the new key (mentions, edges and edge evidence move across), and removes the empty-key nodes,
 * whose mentions mix unrelated names and cannot be split. The documents keep their stale fingerprint, so a
 * rebuild the user asks for still re-extracts them properly. It is idempotent and runs once per project per
 * worker process, before the first graph write (`replaceDocumentGraph`).
 */
import type { Sql } from "postgres";

import { graphEdgeEndpoints, normalizeName } from "./extract.js";
import { lockProjectGraph, refreshGraphElements } from "./graph-store.js";

type Client = Sql<Record<string, unknown>>;

export interface LegacyKeyHealResult {
  /** Nodes whose key was rewritten in place. */
  renamed: number;
  /** Nodes merged into the node that already had their new key. */
  merged: number;
  /** Empty-key nodes (and nodes whose names have no keyable letter) removed. */
  removed: number;
}

/** The key the ASCII-only normalizer (fingerprint g3 and earlier) produced for a name. */
export function legacyNormalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, " ");
}

type NodeRow = { id: string; canonical_name: string; normalized_name: string; entity_type: string; aliases: unknown };

/** What a node's key should be today, or null when it is current or cannot be told. `""` means: remove it. */
export function currentKeyOf(node: Pick<NodeRow, "canonical_name" | "normalized_name" | "aliases">): string | null {
  const names = [node.canonical_name, ...(Array.isArray(node.aliases) ? node.aliases.filter((alias): alias is string => typeof alias === "string") : [])];
  if (node.normalized_name === "") return "";
  // The names this node's old key could have come from; the longest is the best spelling.
  const sources = names.filter((name) => legacyNormalizeName(name) === node.normalized_name).sort((left, right) => right.length - left.length);
  if (sources.length === 0) return null;
  const key = normalizeName(sources[0]!);
  return key === node.normalized_name ? null : key;
}

async function mergeNode(tx: Client, projectId: string, from: string, into: string): Promise<string[]> {
  await tx`
    update chunk_entities set node_id = ${into}
    where node_id = ${from}
      and not exists (select 1 from chunk_entities x where x.chunk_id = chunk_entities.chunk_id and x.node_id = ${into})
  `;
  const edges = await tx<{ id: string; source_node_id: string; target_node_id: string; normalized_predicate: string }[]>`
    select id, source_node_id, target_node_id, normalized_predicate from kg_edges
    where project_id = ${projectId} and (source_node_id = ${from} or target_node_id = ${from})
  `;
  const touched = new Set<string>([into]);
  for (const edge of edges) {
    const source = edge.source_node_id === from ? into : edge.source_node_id;
    const target = edge.target_node_id === from ? into : edge.target_node_id;
    touched.add(source);
    touched.add(target);
    if (source === target) continue; // a self-loop is dropped with the old node
    const [left, right] = graphEdgeEndpoints(source, target, edge.normalized_predicate);
    const [existing] = await tx<{ id: string }[]>`
      select id from kg_edges
      where project_id = ${projectId} and source_node_id = ${left} and target_node_id = ${right}
        and normalized_predicate = ${edge.normalized_predicate} and id <> ${edge.id}
    `;
    if (existing) {
      await tx`
        insert into kg_edge_evidence (edge_id, document_id, project_id, weight, confidence)
        select ${existing.id}, document_id, project_id, weight, confidence from kg_edge_evidence where edge_id = ${edge.id}
        on conflict (edge_id, document_id) do nothing
      `;
    } else {
      await tx`update kg_edges set source_node_id = ${left}, target_node_id = ${right}, updated_at = now() where id = ${edge.id}`;
    }
  }
  // The old node's names stay findable on the surviving node.
  await tx`
    update kg_nodes n set
      aliases = (
        select coalesce(jsonb_agg(distinct alias), '[]'::jsonb) from jsonb_array_elements(
          case when jsonb_typeof(n.aliases) = 'array' then n.aliases else '[]'::jsonb end
          || case when jsonb_typeof(o.aliases) = 'array' then o.aliases else '[]'::jsonb end
          || to_jsonb(o.canonical_name)
        ) as alias
      ),
      canonical_name = case when length(o.canonical_name) > length(n.canonical_name) then o.canonical_name else n.canonical_name end,
      updated_at = now()
    from kg_nodes o where n.id = ${into} and o.id = ${from}
  `;
  // Deleting the node cascades what could not move: duplicate mentions, self-loops, merged edges and their evidence.
  await tx`delete from kg_nodes where id = ${from}`;
  return [...touched].filter((id) => id !== from);
}

/** Re-keys the old nodes of one project; see the module note. */
export async function healLegacyGraphKeys(sql: Client, projectId: string): Promise<LegacyKeyHealResult> {
  return await sql.begin(async (transaction) => {
    const tx = transaction as unknown as Client;
    await lockProjectGraph(tx, projectId);
    const nodes = await tx<NodeRow[]>`
      select id, canonical_name, normalized_name, entity_type, aliases from kg_nodes
      where project_id = ${projectId} order by id
    `;
    const byKey = new Map(nodes.map((node) => [`${node.normalized_name}\u0000${node.entity_type}`, node.id]));
    const result: LegacyKeyHealResult = { renamed: 0, merged: 0, removed: 0 };
    const refresh = new Set<string>();
    for (const node of nodes) {
      const key = currentKeyOf(node);
      if (key === null) continue;
      const oldKey = `${node.normalized_name}\u0000${node.entity_type}`;
      if (key === "") {
        // Neighbours lose an edge; they are re-derived below.
        const neighbours = await tx<{ id: string }[]>`
          select case when source_node_id = ${node.id} then target_node_id else source_node_id end as id from kg_edges
          where source_node_id = ${node.id} or target_node_id = ${node.id}
        `;
        for (const neighbour of neighbours) refresh.add(neighbour.id);
        await tx`delete from kg_nodes where id = ${node.id}`;
        byKey.delete(oldKey);
        result.removed += 1;
        continue;
      }
      const target = byKey.get(`${key}\u0000${node.entity_type}`);
      if (target && target !== node.id) {
        for (const id of await mergeNode(tx, projectId, node.id, target)) refresh.add(id);
        byKey.delete(oldKey);
        result.merged += 1;
      } else {
        await tx`update kg_nodes set normalized_name = ${key}, updated_at = now() where id = ${node.id}`;
        byKey.delete(oldKey);
        byKey.set(`${key}\u0000${node.entity_type}`, node.id);
        result.renamed += 1;
      }
    }
    // Counts and edge weights follow the moved evidence; nodes nothing supports any more are dropped.
    if (refresh.size > 0) {
      const live = await tx<{ id: string }[]>`select id from kg_nodes where project_id = ${projectId} and id = any(${tx.array([...refresh])})`;
      if (live.length > 0) await refreshGraphElements(tx, { nodeIds: live.map((row) => row.id) });
    }
    return result;
  });
}

const healed = new Map<string, Promise<LegacyKeyHealResult | null>>();

/** `healLegacyGraphKeys` once per project per process, and only when the project holds a pre-g4 document. */
export function healLegacyGraphKeysOnce(sql: Client, projectId: string): Promise<LegacyKeyHealResult | null> {
  let pending = healed.get(projectId);
  if (!pending) {
    pending = (async () => {
      const [legacy] = await sql<{ legacy: boolean }[]>`
        select exists (select 1 from kg_document_state where project_id = ${projectId} and config_hash not like 'g4-%') as legacy
      `;
      return legacy?.legacy ? await healLegacyGraphKeys(sql, projectId) : null;
    })().catch((error: unknown) => {
      healed.delete(projectId);
      console.warn(`[graph] legacy key heal failed project=${projectId}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      return null;
    });
    healed.set(projectId, pending);
  }
  return pending;
}

export function resetLegacyGraphKeyHeal(): void {
  healed.clear();
}
