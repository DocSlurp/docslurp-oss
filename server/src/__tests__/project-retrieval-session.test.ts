import { describe, expect, it } from "vitest";
import {
  defaultProjectSearchSettings,
  projectSearchSettingsSchema,
} from "@docslurp/shared";

import {
  applyProjectRetrievalDefaults,
  resolveProjectRetrievalControls,
  withProjectScope,
} from "../search/project-retrieval-session.js";
import { searchInputSchema, searchOptions } from "../lib/search-input.js";

describe("project retrieval session options", () => {
  it("applies project retrieval defaults while preserving explicit overrides", () => {
    const settings = {
      ...defaultProjectSearchSettings,
      retrievalDefaults: {
        ...defaultProjectSearchSettings.retrievalDefaults,
        resultCount: 11,
        useHyDE: true,
        useRerank: false,
        useMmr: true,
        mmrLambda: 0.25,
        queryRewrite: true,
      },
    };

    const options = applyProjectRetrievalDefaults(
      {
        limit: 3,
        useHyDE: false,
        filters: { projectId: "attacker-ws", filenameContains: "invoice" },
        suppressSessionLog: true,
      },
      "trusted-ws",
      settings,
    );

    expect(options.limit).toBe(3);
    expect(options.useHyDE).toBe(false);
    expect(options.useRerank).toBe(false);
    expect(options.useMmr).toBe(true);
    expect(options.mmrLambda).toBe(0.25);
    expect(options.queryRewrite).toBe(true);
    expect(options.suppressSessionLog).toBe(true);
    expect(options.filters).toEqual({
      projectId: "trusted-ws",
      filenameContains: "invoice",
    });
  });

  it("forces filters into the resolved project scope", () => {
    expect(withProjectScope(undefined, "ws-1")).toEqual({
      projectId: "ws-1",
    });
    expect(withProjectScope({ projectId: "ws-2", runId: "run-1" }, "ws-1"))
      .toEqual({
        projectId: "ws-1",
        runId: "run-1",
      });
  });

  it("resolves pipeline-backed retrieval controls with diagnostics", () => {
    const resolved = resolveProjectRetrievalControls({
      options: {},
      projectId: "ws-1",
      settings: ({
        retrievalDefaults: {
          ...defaultProjectSearchSettings.retrievalDefaults,
          enableGraphExpansion: undefined,
          enableCommunityExpansion: undefined,
          graphHops: undefined,
        },
      } as unknown) as Pick<typeof defaultProjectSearchSettings, "retrievalDefaults">,
      pipeline: {
        graphRag: true,
        entityIndex: false,
        graphCommunitySummaries: true,
      },
    });

    expect(resolved.options).toMatchObject({
      enableGraphExpansion: true,
      enableCommunityExpansion: true,
      graphHops: 2,
      filters: { projectId: "ws-1" },
    });
    expect(resolved.diagnostics).toMatchObject({
      projectId: "ws-1",
      pipelineCapabilities: {
        graphRag: true,
        entityIndex: false,
        graphCommunitySummaries: true,
      },
      enabled: {
        graphExpansion: true,
        communityExpansion: true,
        graphHops: 2,
      },
    });
  });

  it("derives graph expansion from the pipeline when the project has not chosen it", () => {
    const settings = projectSearchSettingsSchema.parse({ projectId: "ws-1", userId: "user-1" });
    const graph = resolveProjectRetrievalControls({
      options: { limit: 5 },
      projectId: "ws-1",
      settings,
      pipeline: { graphRag: true, entityIndex: true, graphCommunitySummaries: true },
    }).options;
    expect(graph).toMatchObject({ enableGraphExpansion: true, enableCommunityExpansion: true, graphHops: 2 });

    const plain = resolveProjectRetrievalControls({
      options: { limit: 5 },
      projectId: "ws-1",
      settings,
      pipeline: { graphRag: false, entityIndex: false, graphCommunitySummaries: false },
    }).options;
    expect(plain).toMatchObject({ enableGraphExpansion: false, enableCommunityExpansion: false, graphHops: 1 });

    const optedOut = resolveProjectRetrievalControls({
      options: { limit: 5 },
      projectId: "ws-1",
      settings: projectSearchSettingsSchema.parse({
        projectId: "ws-1",
        userId: "user-1",
        retrievalDefaults: { enableGraphExpansion: false },
      }),
      pipeline: { graphRag: true, entityIndex: true, graphCommunitySummaries: false },
    }).options;
    expect(optedOut.enableGraphExpansion).toBe(false);
  });

  it("applies project defaults to API search inputs that omit retrieval flags", () => {
    const settings = projectSearchSettingsSchema.parse({ projectId: "ws-1", userId: "user-1" });
    const pipeline = { graphRag: false, entityIndex: false, graphCommunitySummaries: false };

    const omitted = resolveProjectRetrievalControls({
      options: searchOptions({ ...searchInputSchema.parse({ q: "support hours", project: "ws-1" }), projectId: "ws-1" }),
      projectId: "ws-1",
      settings,
      pipeline,
    }).options;
    // Free quality defaults apply; provider-backed enhancements stay off.
    expect(omitted).toMatchObject({ useRerank: true, parentRetrieval: true, limit: 8, useHyDE: false, queryRewrite: false });

    const explicit = resolveProjectRetrievalControls({
      options: searchOptions({ ...searchInputSchema.parse({ q: "support hours", project: "ws-1", rerank: false, hyde: true }), projectId: "ws-1" }),
      projectId: "ws-1",
      settings,
      pipeline,
    }).options;
    expect(explicit).toMatchObject({ useRerank: false, useHyDE: true });
  });

  it("validates the minScore relevance floor on search input", () => {
    const parse = (minScore: unknown) => searchInputSchema.safeParse({ q: "support hours", minScore });
    for (const valid of [0, 0.1, 1]) expect(parse(valid).success).toBe(true);
    for (const invalid of [-0.01, 1.01, "0.5", Number.NaN]) expect(parse(invalid).success).toBe(false);
    expect(searchInputSchema.parse({ q: "support hours" }).minScore).toBeUndefined();
    expect(searchOptions({ ...searchInputSchema.parse({ q: "x", minScore: 0 }), projectId: "ws-1" }).minScore).toBe(0);
  });

  it("resolves minScore as request, then project default, else unset for the environment", () => {
    const base = projectSearchSettingsSchema.parse({ projectId: "ws-1", userId: "user-1" });
    const withDefault = {
      ...base,
      retrievalDefaults: projectSearchSettingsSchema.shape.retrievalDefaults.parse({ ...base.retrievalDefaults, minScore: 0.4 }),
    };
    const resolve = (options: { minScore?: number }, settings = base) =>
      resolveProjectRetrievalControls({ options, projectId: "ws-1", settings }).options.minScore;
    expect(resolve({})).toBeUndefined();
    expect(resolve({}, withDefault)).toBe(0.4);
    expect(resolve({ minScore: 0 }, withDefault)).toBe(0);
    expect(projectSearchSettingsSchema.shape.retrievalDefaults.safeParse({ ...base.retrievalDefaults, minScore: 2 }).success).toBe(false);
  });
});


describe("independent candidate and ordering request controls", () => {
  it("validates and forwards bounded controls without changing result count", () => {
    const body = searchInputSchema.parse({ q: "pump maintenance", candidateDepth: 50, resultOrder: "relevance", limit: 4, rerank: false });
    expect(searchOptions({ ...body, projectId: "ws-1" })).toMatchObject({ candidateDepth: 50, resultOrder: "relevance", limit: 4, useRerank: false });
    for (const candidateDepth of [0, -1, 201, 50.5, "50"]) {
      expect(searchInputSchema.safeParse({ q: "q", candidateDepth }).success).toBe(false);
    }
    expect(searchInputSchema.safeParse({ q: "q", resultOrder: "unknown" }).success).toBe(false);
    const legacy = searchInputSchema.parse({ q: "q" });
    expect(legacy.candidateDepth).toBeUndefined();
    expect(legacy.resultOrder).toBeUndefined();
  });

  it("inherits optional project controls and respects per-request overrides", () => {
    const settings = { ...defaultProjectSearchSettings, retrievalDefaults: { ...defaultProjectSearchSettings.retrievalDefaults, candidateDepth: 100, resultOrder: "prompt" as const } };
    expect(applyProjectRetrievalDefaults({}, "ws-1", settings)).toMatchObject({ candidateDepth: 100, resultOrder: "prompt" });
    expect(applyProjectRetrievalDefaults({ candidateDepth: 50, resultOrder: "relevance" }, "ws-1", settings)).toMatchObject({ candidateDepth: 50, resultOrder: "relevance" });
    expect(applyProjectRetrievalDefaults({}, "ws-1").candidateDepth).toBeUndefined();
  });
});
