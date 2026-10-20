import type { MapRouterMode } from "@docslurp/shared";

import { sql } from "../../db.js";

export type MapRouterCall = (input: {
  query: string;
  nodes: Array<{ id: string; title: string; path: string; pages: string }>;
}) => Promise<string[]>;

export interface MapCandidatePage {
  documentId: string;
  page: number;
  nodeTitle: string | null;
}

export interface MapLocatorResult {
  pages: MapCandidatePage[];
  routerUsed: boolean;
  confident: boolean;
}

interface MapNode {
  id: string;
  title: string;
  level?: number;
  parentId?: string | null;
  physicalStart?: number | null;
  physicalEnd?: number | null;
}
interface MapTerm {
  term: string;
  physicalPages?: number[];
}
interface MapRow {
  document_id: string;
  nodes: MapNode[] | null;
  terms: MapTerm[] | null;
  rank: number | null;
}

/** Top-score margin below which the router is consulted in `auto` mode. */
export const ROUTER_AUTO_MARGIN = 0.15;
const MAX_PAGES_PER_NODE = 10;
const MAX_ROUTER_NODES = 40;
/** Maps loaded per query: top full-text matches, or a few recent maps when nothing matches. */
const MAX_MAP_DOCUMENTS = 20;
const FALLBACK_MAP_DOCUMENTS = 5;

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "what", "which", "who", "whom", "how", "does", "did",
  "with", "from", "that", "this", "these", "those", "about", "into", "has", "have", "had", "can",
  "any", "all", "its", "their", "there", "than", "then", "when", "where", "why", "you", "your",
]);

function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

export function queryTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    .map(stem);
  return [...new Set(tokens)];
}

function overlap(query: string[], text: string): number {
  if (query.length === 0) return 0;
  const tokens = new Set(queryTokens(text));
  let hits = 0;
  for (const token of query) if (tokens.has(token)) hits++;
  return hits / query.length;
}

function rangeLabel(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

function validRange(node: MapNode): [number, number] | null {
  const { physicalStart: start, physicalEnd: end } = node;
  if (typeof start !== "number" || typeof end !== "number" || start < 1 || end < start) return null;
  return [start, end];
}

function nodePath(node: MapNode, byId: Map<string, MapNode>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (let current: MapNode | undefined = node; current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    parts.unshift(current.title);
  }
  return parts.join(" > ");
}

interface ScoredNode {
  key: string;
  documentId: string;
  node: MapNode;
  range: [number, number];
  score: number;
  docRank: number;
}

function pagesOfNode(scored: ScoredNode): number[] {
  const [start, end] = scored.range;
  const pages: number[] = [];
  for (let page = start; page <= end && pages.length < MAX_PAGES_PER_NODE; page++) pages.push(page);
  return pages;
}

/**
 * Find candidate pages from the Index Maps of `documentIds`: Postgres full-text
 * recall over each map's `search_text`, then node-title and term overlap
 * scoring, most specific node first. An optional router (an LLM choosing among
 * outline nodes) refines or replaces the lexical pick per `router` mode.
 */
export async function locateMapCandidates(args: {
  query: string;
  documentIds: string[];
  maxPages: number;
  router: MapRouterMode;
  routerCall?: MapRouterCall;
}): Promise<MapLocatorResult> {
  const { query, maxPages } = args;
  const tokens = queryTokens(query);
  if (args.documentIds.length === 0 || tokens.length === 0 || maxPages <= 0) {
    return { pages: [], routerUsed: false, confident: false };
  }
  const tsquery = tokens.map((token) => `${token.replace(/[^\p{L}\p{N}]/gu, "")}:*`).filter((t) => t.length > 2).join(" | ");
  // Recall in SQL: only the best-ranked maps leave the database. A query the
  // full-text index cannot match falls back to a few recent maps, which the
  // router (when enabled) can still search by outline.
  let rows: MapRow[] = tsquery
    ? await sql<MapRow[]>`
        select document_id, nodes, terms, ts_rank_cd(search_text, to_tsquery('simple', ${tsquery}::text)) as rank
        from document_maps
        where document_id = any(${sql.array(args.documentIds, 25)})
          and search_text @@ to_tsquery('simple', ${tsquery}::text)
        order by rank desc
        limit ${MAX_MAP_DOCUMENTS}`
    : [];
  if (rows.length === 0) {
    rows = await sql<MapRow[]>`
      select document_id, nodes, terms, 0 as rank
      from document_maps
      where document_id = any(${sql.array(args.documentIds, 25)})
      order by updated_at desc
      limit ${FALLBACK_MAP_DOCUMENTS}`;
  }

  const maxRank = Math.max(0, ...rows.map((row) => Number(row.rank) || 0));
  const scored: ScoredNode[] = [];
  const termPages = new Map<string, number>(); // `${doc}:${page}` -> score
  const allNodes: Array<{ documentId: string; node: MapNode; byId: Map<string, MapNode> }> = [];
  for (const row of rows) {
    const nodes = Array.isArray(row.nodes) ? row.nodes : [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const docRank = maxRank > 0 ? (Number(row.rank) || 0) / maxRank : 0;
    for (const node of nodes) {
      allNodes.push({ documentId: row.document_id, node, byId });
      const range = validRange(node);
      if (!range) continue;
      const score = overlap(tokens, node.title);
      if (score > 0) scored.push({ key: `${row.document_id}:${node.id}`, documentId: row.document_id, node, range, score, docRank });
    }
    for (const term of Array.isArray(row.terms) ? row.terms : []) {
      const score = overlap(tokens, term.term) * 0.8;
      if (score <= 0) continue;
      for (const page of term.physicalPages ?? []) {
        const key = `${row.document_id}:${page}`;
        termPages.set(key, Math.max(termPages.get(key) ?? 0, score));
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || (a.range[1] - a.range[0]) - (b.range[1] - b.range[0]) || b.docRank - a.docRank);
  const top = scored[0]?.score ?? 0;
  const second = scored[1]?.score ?? 0;
  const margin = top > 0 ? (top - second) / top : 0;

  const pageMap = new Map<string, { score: number; title: string | null; documentId: string; page: number }>();
  const addPage = (documentId: string, page: number, score: number, title: string | null) => {
    const key = `${documentId}:${page}`;
    const existing = pageMap.get(key);
    if (!existing || score > existing.score) pageMap.set(key, { documentId, page, score, title: title ?? existing?.title ?? null });
  };
  for (const entry of scored) {
    const span = entry.range[1] - entry.range[0] + 1;
    for (const page of pagesOfNode(entry)) addPage(entry.documentId, page, entry.score + 0.1 * entry.docRank - 0.001 * span, entry.node.title);
  }
  for (const [key, score] of termPages) {
    const sep = key.lastIndexOf(":");
    addPage(key.slice(0, sep), Number(key.slice(sep + 1)), score, null);
  }
  const ranked = [...pageMap.values()].sort((a, b) => b.score - a.score || a.page - b.page);
  const toResult = (list: typeof ranked): MapCandidatePage[] =>
    list.slice(0, maxPages).map((p) => ({ documentId: p.documentId, page: p.page, nodeTitle: p.title }));

  const wantRouter =
    args.router === "always"
      ? allNodes.length > 0
      : args.router === "auto" && (ranked.length === 0 || margin < ROUTER_AUTO_MARGIN || ranked.length > maxPages);
  if (wantRouter && args.routerCall) {
    const pool: Array<{ documentId: string; node: MapNode; byId: Map<string, MapNode>; range: [number, number] }> = [];
    const byKey = new Map<string, (typeof pool)[number]>();
    const byIdIndex = new Map(allNodes.map((e) => [`${e.documentId}:${e.node.id}`, e]));
    const push = (key: string) => {
      const entry = byIdIndex.get(key);
      const range = entry && validRange(entry.node);
      if (entry && range && !byKey.has(key)) {
        const item = { ...entry, range };
        byKey.set(key, item);
        pool.push(item);
      }
    };
    for (const entry of scored.slice(0, MAX_ROUTER_NODES)) push(entry.key);
    // Fill with the rest of the outline (shallowest first) so the router can
    // rescue sections the lexical pass missed, not just reorder its hits.
    const rest = [...allNodes].sort((a, b) => (a.node.level ?? 0) - (b.node.level ?? 0));
    for (const entry of rest) {
      if (pool.length >= MAX_ROUTER_NODES) break;
      push(`${entry.documentId}:${entry.node.id}`);
    }
    if (pool.length > 0) {
      try {
        const chosen = await args.routerCall({
          query,
          nodes: pool.map((item) => ({
            id: `${item.documentId}:${item.node.id}`,
            title: item.node.title,
            path: nodePath(item.node, item.byId),
            pages: rangeLabel(...item.range),
          })),
        });
        const picked = [...new Set(chosen)].map((id) => byKey.get(id)).filter((item): item is (typeof pool)[number] => Boolean(item));
        if (picked.length > 0) {
          const routed: typeof ranked = [];
          picked.forEach((item, index) => {
            for (const page of pagesOfNode({ ...item, key: "", score: 0, docRank: 0 })) {
              routed.push({ documentId: item.documentId, page, score: 1 - index * 0.01, title: item.node.title });
            }
          });
          return { pages: toResult(routed), routerUsed: true, confident: true };
        }
        return { pages: toResult(ranked), routerUsed: true, confident: false };
      } catch {
        // A failing router never blocks search; fall through to the lexical pick.
      }
    }
  }
  return { pages: toResult(ranked), routerUsed: false, confident: ranked.length > 0 && top >= 0.5 && margin >= ROUTER_AUTO_MARGIN };
}
