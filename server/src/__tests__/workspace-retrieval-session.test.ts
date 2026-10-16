import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceSearchSettings,
  workspaceSearchSettingsSchema,
} from "@docslurp/shared";

import {
  applyWorkspaceRetrievalDefaults,
  resolveWorkspaceRetrievalControls,
  withWorkspaceScope,
} from "../search/workspace-retrieval-session.js";
import { searchInputSchema, searchOptions } from "../lib/search-input.js";

describe("workspace retrieval session options", () => {
  it("applies workspace retrieval defaults while preserving explicit overrides", () => {
    const settings = {
      ...defaultWorkspaceSearchSettings,
      retrievalDefaults: {
        ...defaultWorkspaceSearchSettings.retrievalDefaults,
        resultCount: 11,
        useHyDE: true,
        useRerank: false,
        useMmr: true,
        mmrLambda: 0.25,
        queryRewrite: true,
      },
    };

    const options = applyWorkspaceRetrievalDefaults(
      {
        limit: 3,
        useHyDE: false,
        filters: { workspaceId: "attacker-ws", filenameContains: "invoice" },
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
      workspaceId: "trusted-ws",
      filenameContains: "invoice",
    });
  });

  it("forces filters into the resolved workspace scope", () => {
    expect(withWorkspaceScope(undefined, "ws-1")).toEqual({
      workspaceId: "ws-1",
    });
    expect(withWorkspaceScope({ workspaceId: "ws-2", runId: "run-1" }, "ws-1"))
      .toEqual({
        workspaceId: "ws-1",
        runId: "run-1",
      });
  });

  it("resolves pipeline-backed retrieval controls with diagnostics", () => {
    const resolved = resolveWorkspaceRetrievalControls({
      options: {},
      workspaceId: "ws-1",
      settings: ({
        retrievalDefaults: {
          ...defaultWorkspaceSearchSettings.retrievalDefaults,
          enableGraphExpansion: undefined,
          enableCommunityExpansion: undefined,
          graphHops: undefined,
        },
      } as unknown) as Pick<typeof defaultWorkspaceSearchSettings, "retrievalDefaults">,
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
      filters: { workspaceId: "ws-1" },
    });
    expect(resolved.diagnostics).toMatchObject({
      workspaceId: "ws-1",
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

  it("derives graph expansion from the pipeline when the workspace has not chosen it", () => {
    const settings = workspaceSearchSettingsSchema.parse({ workspaceId: "ws-1", userId: "user-1" });
    const graph = resolveWorkspaceRetrievalControls({
      options: { limit: 5 },
      workspaceId: "ws-1",
      settings,
      pipeline: { graphRag: true, entityIndex: true, graphCommunitySummaries: true },
    }).options;
    expect(graph).toMatchObject({ enableGraphExpansion: true, enableCommunityExpansion: true, graphHops: 2 });

    const plain = resolveWorkspaceRetrievalControls({
      options: { limit: 5 },
      workspaceId: "ws-1",
      settings,
      pipeline: { graphRag: false, entityIndex: false, graphCommunitySummaries: false },
    }).options;
    expect(plain).toMatchObject({ enableGraphExpansion: false, enableCommunityExpansion: false, graphHops: 1 });

    const optedOut = resolveWorkspaceRetrievalControls({
      options: { limit: 5 },
      workspaceId: "ws-1",
      settings: workspaceSearchSettingsSchema.parse({
        workspaceId: "ws-1",
        userId: "user-1",
        retrievalDefaults: { enableGraphExpansion: false },
      }),
      pipeline: { graphRag: true, entityIndex: true, graphCommunitySummaries: false },
    }).options;
    expect(optedOut.enableGraphExpansion).toBe(false);
  });

  it("applies workspace defaults to API search inputs that omit retrieval flags", () => {
    const settings = workspaceSearchSettingsSchema.parse({ workspaceId: "ws-1", userId: "user-1" });
    const pipeline = { graphRag: false, entityIndex: false, graphCommunitySummaries: false };

    const omitted = resolveWorkspaceRetrievalControls({
      options: searchOptions({ ...searchInputSchema.parse({ q: "support hours", workspaceId: "ws-1" }), workspaceId: "ws-1" }),
      workspaceId: "ws-1",
      settings,
      pipeline,
    }).options;
    // Free quality defaults apply; provider-backed enhancements stay off.
    expect(omitted).toMatchObject({ useRerank: true, parentRetrieval: true, limit: 8, useHyDE: false, queryRewrite: false });

    const explicit = resolveWorkspaceRetrievalControls({
      options: searchOptions({ ...searchInputSchema.parse({ q: "support hours", workspaceId: "ws-1", rerank: false, hyde: true }), workspaceId: "ws-1" }),
      workspaceId: "ws-1",
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
    expect(searchOptions({ ...searchInputSchema.parse({ q: "x", minScore: 0 }), workspaceId: "ws-1" }).minScore).toBe(0);
  });

  it("resolves minScore as request, then workspace default, else unset for the environment", () => {
    const base = workspaceSearchSettingsSchema.parse({ workspaceId: "ws-1", userId: "user-1" });
    const withDefault = {
      ...base,
      retrievalDefaults: workspaceSearchSettingsSchema.shape.retrievalDefaults.parse({ ...base.retrievalDefaults, minScore: 0.4 }),
    };
    const resolve = (options: { minScore?: number }, settings = base) =>
      resolveWorkspaceRetrievalControls({ options, workspaceId: "ws-1", settings }).options.minScore;
    expect(resolve({})).toBeUndefined();
    expect(resolve({}, withDefault)).toBe(0.4);
    expect(resolve({ minScore: 0 }, withDefault)).toBe(0);
    expect(workspaceSearchSettingsSchema.shape.retrievalDefaults.safeParse({ ...base.retrievalDefaults, minScore: 2 }).success).toBe(false);
  });
});
