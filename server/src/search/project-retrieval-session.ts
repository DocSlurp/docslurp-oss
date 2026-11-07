import {
  defaultProjectSearchSettings,
  type PipelineFeatures,
  type ProjectSearchSettings,
} from "@docslurp/shared";

import type { SearchFilters } from "./filters.js";

export interface ProjectRetrievalOptions {
  limit?: number;
  useHyDE?: boolean;
  useRerank?: boolean;
  rerankProvider?: "bm25" | "deepinfra";
  rerankModel?: "Qwen/Qwen3-Reranker-0.6B";
  candidateDepth?: number;
  resultOrder?: "relevance" | "prompt";
  useMmr?: boolean;
  mmrLambda?: number;
  filters?: SearchFilters;
  parentRetrieval?: boolean;
  summarySeed?: boolean;
  queryRewrite?: boolean;
  queryDecompose?: boolean;
  stepback?: boolean;
  useContextualCompression?: boolean;
  selfQuery?: boolean;
  iterativeMultiHop?: boolean;
  enableGraphExpansion?: boolean;
  enableCommunityExpansion?: boolean;
  graphHops?: number;
  minScore?: number;
}

export interface ResolvedProjectRetrievalControls<
  TOptions extends ProjectRetrievalOptions,
> {
  options: TOptions & ProjectRetrievalOptions;
  diagnostics: {
    projectId: string;
    defaultsApplied: Array<keyof ProjectRetrievalOptions>;
    pipelineCapabilities: {
      graphRag: boolean;
      entityIndex: boolean;
      graphCommunitySummaries: boolean;
    };
    enabled: {
      graphExpansion: boolean;
      communityExpansion: boolean;
      graphHops: number;
    };
  };
}

export function applyProjectRetrievalDefaults<
  TOptions extends ProjectRetrievalOptions,
>(
  options: TOptions,
  projectId: string,
  settings: Pick<ProjectSearchSettings, "retrievalDefaults"> =
    defaultProjectSearchSettings,
): TOptions & ProjectRetrievalOptions {
  return resolveProjectRetrievalControls({
    options,
    projectId,
    settings,
  }).options;
}

export function resolveProjectRetrievalControls<
  TOptions extends ProjectRetrievalOptions,
>(args: {
  options: TOptions;
  projectId: string;
  settings?: Pick<ProjectSearchSettings, "retrievalDefaults">;
  pipeline?: Pick<
    PipelineFeatures,
    "graphRag" | "entityIndex" | "graphCommunitySummaries"
  >;
}): ResolvedProjectRetrievalControls<TOptions> {
  const defaults =
    args.settings?.retrievalDefaults ??
    defaultProjectSearchSettings.retrievalDefaults;
  const options = args.options;
  const defaultsApplied: Array<keyof ProjectRetrievalOptions> = [];
  const fromDefault = <K extends keyof ProjectRetrievalOptions>(
    key: K,
    value: ProjectRetrievalOptions[K],
  ): ProjectRetrievalOptions[K] => {
    if (options[key] !== undefined) {
      return options[key];
    }
    defaultsApplied.push(key);
    return value;
  };

  const graphRag = args.pipeline?.graphRag ?? false;
  const entityIndex = args.pipeline?.entityIndex ?? false;
  const graphCommunitySummaries =
    args.pipeline?.graphCommunitySummaries ?? false;

  const resolved = {
    ...options,
    limit: fromDefault("limit", defaults.resultCount) as number,
    candidateDepth: fromDefault("candidateDepth", defaults.candidateDepth) as number | undefined,
    resultOrder: fromDefault("resultOrder", defaults.resultOrder) as "relevance" | "prompt" | undefined,
    useHyDE: fromDefault("useHyDE", defaults.useHyDE) as boolean,
    rerankProvider: fromDefault("rerankProvider", defaults.rerankProvider),
    rerankModel: fromDefault("rerankModel", defaults.rerankModel),
    useRerank: fromDefault("useRerank", defaults.useRerank) as boolean,
    useContextualCompression:
      fromDefault(
        "useContextualCompression",
        defaults.useContextualCompression,
      ) as boolean,
    useMmr: fromDefault("useMmr", defaults.useMmr) as boolean,
    mmrLambda: fromDefault("mmrLambda", defaults.mmrLambda) as number,
    queryRewrite: fromDefault("queryRewrite", defaults.queryRewrite) as boolean,
    queryDecompose: fromDefault(
      "queryDecompose",
      defaults.queryDecompose,
    ) as boolean,
    stepback: fromDefault("stepback", defaults.stepback) as boolean,
    parentRetrieval: fromDefault(
      "parentRetrieval",
      defaults.parentRetrieval,
    ) as boolean,
    summarySeed: fromDefault("summarySeed", defaults.summarySeed) as boolean,
    selfQuery: fromDefault("selfQuery", defaults.selfQuery) as boolean,
    iterativeMultiHop: fromDefault(
      "iterativeMultiHop",
      defaults.iterativeMultiHop,
    ) as boolean,
    enableGraphExpansion:
      fromDefault(
        "enableGraphExpansion",
        defaults.enableGraphExpansion ?? (graphRag || entityIndex),
      ) as boolean,
    enableCommunityExpansion:
      fromDefault(
        "enableCommunityExpansion",
        defaults.enableCommunityExpansion ?? graphCommunitySummaries,
      ) as boolean,
    graphHops: fromDefault(
      "graphHops",
      defaults.graphHops ?? (graphRag ? 2 : entityIndex ? 1 : 1),
    ) as number,
    filters: withProjectScope(options.filters, args.projectId),
    // Left undefined when neither the request nor the project sets it, so the
    // environment default (SEARCH_MIN_SCORE) decides at search time.
    minScore: options.minScore ?? defaults.minScore,
  };

  return {
    options: resolved as TOptions & ProjectRetrievalOptions,
    diagnostics: {
      projectId: args.projectId,
      defaultsApplied,
      pipelineCapabilities: {
        graphRag,
        entityIndex,
        graphCommunitySummaries,
      },
      enabled: {
        graphExpansion: Boolean(resolved.enableGraphExpansion),
        communityExpansion: Boolean(resolved.enableCommunityExpansion),
        graphHops: resolved.graphHops ?? 1,
      },
    },
  };
}

export function withProjectScope(
  filters: SearchFilters | undefined,
  projectId: string,
): SearchFilters {
  return {
    ...(filters ?? {}),
    projectId,
  };
}
