import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import {
  MAX_SUMMARIZED_GRAPH_COMMUNITIES,
  type PrivacyMode,
  type TextGenerationConfig,
  type TextGenerationProfile,
} from "@docslurp/shared";

import { generateOpenRouterText } from "../lib/ai.js";
import { lockWorkspaceGraph } from "./graph-store.js";

type Client = Sql<Record<string, unknown>>;

const MAX_COMMUNITY_SUMMARY_CHARS = 6_000;
const LABEL_PROPAGATION_ROUNDS = 20;
const CO_MENTION_WEIGHT = 0.5;

export interface CommunityGraphNode {
  id: string;
  name: string;
  type: string;
  mentions: number;
}

export interface CommunityGraphEdge {
  source: string;
  target: string;
  predicate: string;
  weight: number;
}

export interface DetectedCommunity {
  level: number;
  nodeIds: string[];
  memberHash: string;
  childHashes: string[];
}

/**
 * Weighted label propagation, deterministic by node id: splits large
 * connected components into topical clusters, which connected components
 * alone cannot. Level 0 groups entities; level 1 groups level-0 communities
 * by the edges between them. Singletons are not communities.
 */
export function detectCommunities(nodes: CommunityGraphNode[], edges: CommunityGraphEdge[]): DetectedCommunity[] {
  const level0 = propagateLabels(
    nodes.map((node) => node.id),
    edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      weight: edge.weight * (edge.predicate === "co_mentions" ? CO_MENTION_WEIGHT : 1),
    })),
  ).filter((members) => members.length >= 2);

  const communities: DetectedCommunity[] = level0.map((nodeIds) => ({
    level: 0,
    nodeIds,
    memberHash: hashMembers(nodeIds),
    childHashes: [],
  }));

  const communityOf = new Map<string, number>();
  level0.forEach((members, index) => members.forEach((id) => communityOf.set(id, index)));
  const superEdges = new Map<string, number>();
  for (const edge of edges) {
    const left = communityOf.get(edge.source);
    const right = communityOf.get(edge.target);
    if (left === undefined || right === undefined || left === right) continue;
    const key = left < right ? `${left}:${right}` : `${right}:${left}`;
    superEdges.set(key, (superEdges.get(key) ?? 0) + edge.weight);
  }
  const groups = propagateLabels(
    level0.map((_, index) => String(index)),
    [...superEdges.entries()].map(([key, weight]) => {
      const [source, target] = key.split(":") as [string, string];
      return { source, target, weight };
    }),
  ).filter((group) => group.length >= 2);
  for (const group of groups) {
    const children = group.map((index) => communities[Number(index)]!);
    const nodeIds = children.flatMap((child) => child.nodeIds).sort();
    communities.push({
      level: 1,
      nodeIds,
      memberHash: hashMembers(nodeIds, 1),
      childHashes: children.map((child) => child.memberHash),
    });
  }
  return communities;
}

function propagateLabels(ids: string[], edges: Array<{ source: string; target: string; weight: number }>): string[][] {
  const order = [...ids].sort();
  const neighbors = new Map<string, Map<string, number>>(order.map((id) => [id, new Map()]));
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const left = neighbors.get(edge.source);
    const right = neighbors.get(edge.target);
    if (!left || !right) continue;
    left.set(edge.target, (left.get(edge.target) ?? 0) + edge.weight);
    right.set(edge.source, (right.get(edge.source) ?? 0) + edge.weight);
  }
  const label = new Map(order.map((id) => [id, id]));
  for (let round = 0; round < LABEL_PROPAGATION_ROUNDS; round += 1) {
    let changed = false;
    for (const id of order) {
      const scores = new Map<string, number>();
      for (const [neighbor, weight] of neighbors.get(id) ?? []) {
        const neighborLabel = label.get(neighbor)!;
        scores.set(neighborLabel, (scores.get(neighborLabel) ?? 0) + weight);
      }
      let best = label.get(id)!;
      let bestScore = scores.get(best) ?? 0;
      for (const [candidate, score] of scores) {
        if (score > bestScore || (score === bestScore && candidate < best)) {
          best = candidate;
          bestScore = score;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const groups = new Map<string, string[]>();
  for (const id of order) {
    const key = label.get(id)!;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  return [...groups.values()];
}

function hashMembers(ids: string[], level = 0): string {
  let hash = 0x811c9dc5;
  const text = `${level}|${[...ids].sort().join(",")}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${level}-${ids.length}-${hash.toString(16).padStart(8, "0")}`;
}

export interface CommunitySummaryContext {
  scope: string;
  model: string;
  apiKey?: string;
  privacyMode: PrivacyMode;
  textGeneration?: TextGenerationConfig;
  deploymentProfile?: TextGenerationProfile;
  signal?: AbortSignal;
}

export interface CommunityRefreshResult {
  communities: number;
  summarized: number;
  reused: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Re-clusters the whole workspace graph. Communities whose members did not
 * change keep their summary; new ones are summarized (LLM up to the cap,
 * heuristic beyond it). Search matches summaries by full text. The swap
 * happens in one locked transaction.
 */
export async function refreshWorkspaceCommunities(args: {
  sql: Client;
  workspaceId: string;
  userId: string;
  runId: string | null;
  context: CommunitySummaryContext;
}): Promise<CommunityRefreshResult> {
  const { sql, workspaceId } = args;
  const nodes = await sql<{ id: string; name: string; type: string; mentions: number }[]>`
    select id, canonical_name as name, entity_type as type, mention_count as mentions
    from kg_nodes where workspace_id = ${workspaceId}
  `;
  const edges = await sql<{ source: string; target: string; predicate: string; weight: number }[]>`
    select source_node_id as source, target_node_id as target, normalized_predicate as predicate, weight
    from kg_edges where workspace_id = ${workspaceId}
  `;
  const detected = detectCommunities([...nodes], [...edges]);
  const existing = await sql<{ member_hash: string; label: string; summary: string }[]>`
    select member_hash, label, summary
    from kg_communities
    where workspace_id = ${workspaceId} and member_hash is not null
  `;
  const previous = new Map(existing.map((row) => [row.member_hash, row]));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const result: CommunityRefreshResult = { communities: detected.length, summarized: 0, reused: 0, inputTokens: 0, outputTokens: 0 };
  const records: Array<{
    id: string;
    level: number;
    label: string;
    summary: string;
    memberHash: string;
    nodeIds: string[];
    childHashes: string[];
  }> = [];
  // Largest communities first, so the LLM cap goes where retrieval benefits most.
  const ordered = [...detected].sort((left, right) => right.nodeIds.length - left.nodeIds.length);
  let llmBudget = MAX_SUMMARIZED_GRAPH_COMMUNITIES;

  for (const community of ordered) {
    const members = community.nodeIds
      .map((id) => nodesById.get(id))
      .filter((node): node is (typeof nodes)[number] => Boolean(node))
      .sort((left, right) => right.mentions - left.mentions);
    const label = members.slice(0, 5).map((member) => member.name).join(", ").slice(0, 120) || "Graph community";
    const reused = previous.get(community.memberHash);
    if (reused) {
      result.reused += 1;
      records.push({ id: randomUUID(), level: community.level, label: reused.label, summary: reused.summary, memberHash: community.memberHash, nodeIds: community.nodeIds, childHashes: community.childHashes });
      continue;
    }

    const memberSet = new Set(community.nodeIds);
    const memberLabels = members.slice(0, 8).map((node) => `${node.name} (${node.type})`);
    const edgeLabels = edges
      .filter((edge) => memberSet.has(edge.source) && memberSet.has(edge.target))
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 8)
      .map((edge) => `${nodesById.get(edge.source)?.name ?? edge.source} -> ${edge.predicate} -> ${nodesById.get(edge.target)?.name ?? edge.target} (weight: ${edge.weight})`);
    let summary = `Community focus: ${memberLabels.join(", ")}. Strongest relations: ${edgeLabels.join("; ") || "sparse graph connections"}.`.slice(0, MAX_COMMUNITY_SUMMARY_CHARS);

    if (args.context.apiKey && llmBudget > 0) {
      llmBudget -= 1;
      try {
        const generated = await generateOpenRouterText({
          operation: "community-summary",
          apiKey: args.context.apiKey,
          privacyMode: args.context.privacyMode,
          system: [
            "Write a concise retrieval-oriented summary for this graph community.",
            "Highlight the shared theme, the most central entities, and the key relationships operators should follow first.",
            `Frame the summary for this workspace domain and scope:\n${args.context.scope}`,
          ].join("\n"),
          prompt: [
            `Community label: ${label}`,
            `Level: ${community.level}`,
            `Entities: ${memberLabels.join(", ")}`,
            `Relationships: ${edgeLabels.join("; ") || "none"}`,
          ].join("\n"),
          model: args.context.model,
          maxOutputTokens: 220,
          textGeneration: args.context.textGeneration,
          deploymentProfile: args.context.deploymentProfile,
          signal: args.context.signal,
        });
        console.log(
          `[ai-usage] community-summary model=${args.context.model} input_tokens=${generated.usage.inputTokens} output_tokens=${generated.usage.outputTokens}`,
        );
        result.inputTokens += generated.usage.inputTokens;
        result.outputTokens += generated.usage.outputTokens;
        summary = generated.text.trim() || summary;
      } catch (error) {
        if (args.context.signal?.aborted) throw error;
        // Keep the heuristic summary when the optional LLM path is unavailable.
      }
    }
    result.summarized += 1;
    records.push({ id: randomUUID(), level: community.level, label, summary, memberHash: community.memberHash, nodeIds: community.nodeIds, childHashes: community.childHashes });
  }

  const idByHash = new Map(records.map((record) => [record.memberHash, record.id]));
  await sql.begin(async (tx) => {
    const client = tx as unknown as Client;
    await lockWorkspaceGraph(client, workspaceId);
    await client`delete from kg_communities where workspace_id = ${workspaceId}`;
    if (!records.length) return;
    await client`
      insert into kg_communities (id, workspace_id, run_id, user_id, level, label, summary, member_count, member_hash, metadata)
      select id, ${workspaceId}, ${args.runId}, ${args.userId}, level, label, summary, member_count, member_hash, metadata::jsonb
      from unnest(
        ${client.array(records.map((record) => record.id))}::text[],
        ${client.array(records.map((record) => record.level))}::int[],
        ${client.array(records.map((record) => record.label))}::text[],
        ${client.array(records.map((record) => record.summary))}::text[],
        ${client.array(records.map((record) => record.nodeIds.length))}::int[],
        ${client.array(records.map((record) => record.memberHash))}::text[],
        ${client.array(records.map((record) => JSON.stringify({
          childCommunityIds: record.childHashes.map((hash) => idByHash.get(hash)).filter(Boolean),
        })))}::text[]
      ) as community(id, level, label, summary, member_count, member_hash, metadata)
    `;
    const members = records.flatMap((record) => record.nodeIds.map((nodeId) => ({ community: record.id, node: nodeId })));
    for (let index = 0; index < members.length; index += 5000) {
      const batch = members.slice(index, index + 5000);
      // Nodes deleted since the graph was read are skipped, not FK failures.
      await client`
        insert into kg_community_members (community_id, node_id, workspace_id)
        select member.community_id, member.node_id, ${workspaceId}
        from unnest(
          ${client.array(batch.map((member) => member.community))}::text[],
          ${client.array(batch.map((member) => member.node))}::text[]
        ) as member(community_id, node_id)
        where exists (select 1 from kg_nodes n where n.id = member.node_id)
        on conflict do nothing
      `;
    }
  });
  return result;
}
