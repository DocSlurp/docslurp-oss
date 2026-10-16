import {
  defaultWorkspaceSearchSettings,
  type PipelineFeatures,
  type WorkspaceSearchSettings,
} from "@docslurp/shared";

import type { SearchFilters } from "./filters.js";

export interface WorkspaceRetrievalOptions {
  limit?: number;
  useHyDE?: boolean;
  useRerank?: boolean;
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

export interface ResolvedWorkspaceRetrievalControls<
  TOptions extends WorkspaceRetrievalOptions,
> {
  options: TOptions & WorkspaceRetrievalOptions;
  diagnostics: {
    workspaceId: string;
    defaultsApplied: Array<keyof WorkspaceRetrievalOptions>;
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

export function applyWorkspaceRetrievalDefaults<
  TOptions extends WorkspaceRetrievalOptions,
>(
  options: TOptions,
  workspaceId: string,
  settings: Pick<WorkspaceSearchSettings, "retrievalDefaults"> =
    defaultWorkspaceSearchSettings,
): TOptions & WorkspaceRetrievalOptions {
  return resolveWorkspaceRetrievalControls({
    options,
    workspaceId,
    settings,
  }).options;
}

export function resolveWorkspaceRetrievalControls<
  TOptions extends WorkspaceRetrievalOptions,
>(args: {
  options: TOptions;
  workspaceId: string;
  settings?: Pick<WorkspaceSearchSettings, "retrievalDefaults">;
  pipeline?: Pick<
    PipelineFeatures,
    "graphRag" | "entityIndex" | "graphCommunitySummaries"
  >;
}): ResolvedWorkspaceRetrievalControls<TOptions> {
  const defaults =
    args.settings?.retrievalDefaults ??
    defaultWorkspaceSearchSettings.retrievalDefaults;
  const options = args.options;
  const defaultsApplied: Array<keyof WorkspaceRetrievalOptions> = [];
  const fromDefault = <K extends keyof WorkspaceRetrievalOptions>(
    key: K,
    value: WorkspaceRetrievalOptions[K],
  ): WorkspaceRetrievalOptions[K] => {
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
    useHyDE: fromDefault("useHyDE", defaults.useHyDE) as boolean,
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
    filters: withWorkspaceScope(options.filters, args.workspaceId),
    // Left undefined when neither the request nor the workspace sets it, so the
    // environment default (SEARCH_MIN_SCORE) decides at search time.
    minScore: options.minScore ?? defaults.minScore,
  };

  return {
    options: resolved as TOptions & WorkspaceRetrievalOptions,
    diagnostics: {
      workspaceId: args.workspaceId,
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

export function withWorkspaceScope(
  filters: SearchFilters | undefined,
  workspaceId: string,
): SearchFilters {
  return {
    ...(filters ?? {}),
    workspaceId,
  };
}
