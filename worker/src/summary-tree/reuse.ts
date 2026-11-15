export interface StoredSummary {
  title: string;
  text: string;
}

/**
 * Summaries a new build may copy from, keyed by node hash.
 *
 * The planner is a pure function and cannot see where the entries came from, so the caller attests to it.
 * Each flag must be the literal `true`, set only after the caller has checked it against the database:
 *
 * - `sameOrgProjectAndCanonicalChain`: the source is the direct predecessor of this document in the same
 *   organization, project and canonical chain (or this document's own partial artifact, on resume). A node
 *   hash holds no tenant or document id, so identical text in another tenant hashes the same; this flag is
 *   the only thing that keeps one tenant's summary out of another's tree.
 * - `sourceNotPurged`: the source document is not deleted, purged or queued for either. Delete then
 *   re-upload regenerates; it never resurrects.
 * - `sourceNotPiiBlockedOrRedacted`: the source is not PII-blocked and its text was not redacted after the
 *   summaries were written.
 *
 * A source with any flag missing or false is ignored: every node is planned as a model call.
 */
export interface SummaryReuseSource {
  entries: ReadonlyMap<string, StoredSummary>;
  eligibility: {
    sameOrgProjectAndCanonicalChain: true;
    sourceNotPurged: true;
    sourceNotPiiBlockedOrRedacted: true;
  };
}

export interface SummaryReusePlan {
  /** Nodes whose text is copied into the new version's own artifact. */
  reuse: Array<{ node: number; hash: string; summary: StoredSummary }>;
  /** One entry per distinct hash needing a model call; `nodes` are every node the result is written for. */
  generate: Array<{ hash: string; nodes: number[] }>;
  stats: { nodes: number; reused: number; modelCalls: number; sourceAccepted: boolean };
}

export function reuseSourceAccepted(source: SummaryReuseSource | null | undefined): source is SummaryReuseSource {
  const eligibility = source?.eligibility as Record<string, unknown> | undefined;
  return eligibility?.sameOrgProjectAndCanonicalChain === true
    && eligibility.sourceNotPurged === true
    && eligibility.sourceNotPiiBlockedOrRedacted === true;
}

/**
 * Which nodes copy text and which need a model call. `nodeHashes[i]` is the hash of node `i`; pass the
 * hashes of one level or of the whole tree. A stored entry with empty text is treated as absent.
 */
export function planSummaryReuse(args: {
  nodeHashes: readonly string[];
  /** Offset added to positions in `nodeHashes` to get node indexes, for per-level planning. */
  firstNode?: number;
  source?: SummaryReuseSource | null;
}): SummaryReusePlan {
  const accepted = reuseSourceAccepted(args.source);
  const entries = accepted ? args.source!.entries : null;
  const reuse: SummaryReusePlan["reuse"] = [];
  const generate = new Map<string, number[]>();
  args.nodeHashes.forEach((hash, position) => {
    const node = (args.firstNode ?? 0) + position;
    const summary = entries?.get(hash);
    if (summary && typeof summary.text === "string" && summary.text.trim().length > 0) {
      reuse.push({ node, hash, summary });
      return;
    }
    const waiting = generate.get(hash);
    if (waiting) waiting.push(node);
    else generate.set(hash, [node]);
  });
  return {
    reuse,
    generate: [...generate].map(([hash, nodes]) => ({ hash, nodes })),
    stats: { nodes: args.nodeHashes.length, reused: reuse.length, modelCalls: generate.size, sourceAccepted: accepted },
  };
}
