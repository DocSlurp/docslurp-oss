import { searchCandidateDepthSchema, searchResultOrderSchema } from "@docslurp/shared";

/**
 * Retrieval flags from a query string, shared by GET /v1/search and the
 * workspace search stream. Flags are tri-state: an omitted flag stays
 * undefined so the workspace's retrieval defaults decide; only "true" and
 * "false" (or "1"/"0") set it explicitly.
 */
export interface RetrievalQueryFlags {
  useHyDE?: boolean;
  useRerank?: boolean;
  candidateDepth?: number;
  resultOrder?: "relevance" | "prompt";
  useMmr?: boolean;
  parentRetrieval?: boolean;
  summarySeed?: boolean;
  useContextualCompression?: boolean;
  queryRewrite?: boolean;
  queryDecompose?: boolean;
  stepback?: boolean;
  selfQuery?: boolean;
  iterativeMultiHop?: boolean;
  enableGraphExpansion?: boolean;
  enableCommunityExpansion?: boolean;
  graphHops?: number;
  mmrLambda?: number;
  minScore?: number;
}

/** A retrieval query parameter that cannot be honoured; routes answer it with 400. */
export class InvalidRetrievalQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRetrievalQueryError";
  }
}

export function parseRetrievalQueryFlags(read: (name: string) => string | undefined): RetrievalQueryFlags {
  const flag = (name: string) => {
    const value = read(name)?.trim().toLowerCase();
    if (value === undefined || value === "") return undefined;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return undefined;
  };
  const number = (name: string) => {
    const raw = read(name);
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const graphHops = number("graphHops");
  const mmrLambda = number("mmrLambda");
  // Like POST /v1/search, a bad relevance floor is a 400, not a silently different floor.
  const rawMinScore = read("minScore");
  let minScore: number | undefined;
  if (rawMinScore !== undefined && rawMinScore.trim() !== "") {
    minScore = Number(rawMinScore);
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      throw new InvalidRetrievalQueryError("minScore must be a number from 0 to 1");
    }
  }
  const rawDepth = read("candidateDepth")?.trim();
  const candidateDepth = rawDepth ? Number(rawDepth) : undefined;
  if (candidateDepth !== undefined && !searchCandidateDepthSchema.safeParse(candidateDepth).success) {
    throw new InvalidRetrievalQueryError("candidateDepth must be an integer from 1 to 200");
  }
  const rawOrder = read("resultOrder")?.trim();
  const resultOrder = rawOrder || undefined;
  if (resultOrder !== undefined && !searchResultOrderSchema.safeParse(resultOrder).success) {
    throw new InvalidRetrievalQueryError("resultOrder must be relevance or prompt");
  }
  return {
    candidateDepth,
    resultOrder: resultOrder as RetrievalQueryFlags["resultOrder"],
    useHyDE: flag("hyde"),
    useRerank: flag("rerank"),
    useMmr: flag("mmr"),
    parentRetrieval: flag("parentRetrieval"),
    summarySeed: flag("summarySeed"),
    useContextualCompression: flag("compression"),
    queryRewrite: flag("queryRewrite"),
    queryDecompose: flag("queryDecompose"),
    stepback: flag("stepback"),
    selfQuery: flag("selfQuery"),
    iterativeMultiHop: flag("iterativeMultiHop"),
    enableGraphExpansion: flag("graphExpansion"),
    enableCommunityExpansion: flag("communityExpansion"),
    graphHops: graphHops === undefined ? undefined : Math.max(1, Math.min(3, Math.round(graphHops))),
    mmrLambda: mmrLambda === undefined ? undefined : Math.max(0, Math.min(1, mmrLambda)),
    minScore,
  };
}
