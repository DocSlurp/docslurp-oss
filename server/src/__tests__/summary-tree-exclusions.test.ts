import { describe, expect, it } from "vitest";
import { defaultPipelineFeatures, normalizePipelineFeatures } from "@docslurp/shared";

import { SummariesTargetRefused, summariesSearchTarget } from "../search/lancedb.js";
import { seedPipelineFromProcessingDefaults } from "../services/processing-defaults.js";
import { projectSettingsProposalInputSchema } from "../services/project-settings-proposal-input.js";
import { updateGeneralSettingsSchema } from "../services/user-settings.js";

/** The places a summary tree must not be reachable from: user defaults, chat proposals, and an unscoped table read. */

describe("summary tree exclusions", () => {
  it("user processing defaults never turn it on", () => {
    const everything = { enableGraphRag: true, enableSummarization: true, contextualChunking: true, piiReviewMode: true, defaultAnswerStyle: "detailed" as const };
    const seeded = seedPipelineFromProcessingDefaults(normalizePipelineFeatures(defaultPipelineFeatures), everything);
    expect(seeded).toMatchObject({ summarize: true, graphRag: true, summaryTree: { enabled: false } });
    // The defaults have no key for it; an unknown one is dropped, not stored.
    const parsed = updateGeneralSettingsSchema.parse({ enableSummaryTree: true, summaryTree: { enabled: true } });
    expect(Object.keys(parsed).filter((key) => /tree/i.test(key))).toEqual([]);
  });

  it("chat settings proposals cannot name it, in the pipeline or in retrieval", () => {
    const propose = (changes: unknown) => projectSettingsProposalInputSchema.safeParse({ changes });
    expect(propose({ pipeline: { summarize: true } }).success).toBe(true);
    expect(propose({ retrieval: { resultCount: 5 } }).success).toBe(true);
    expect(propose({ pipeline: { summaryTree: { enabled: true } } }).success).toBe(false);
    expect(propose({ pipeline: { summarize: true, summaryTree: { enabled: true } } }).success).toBe(false);
    expect(propose({ retrieval: { summaryTree: "guide" } }).success).toBe(false);
    expect(propose({ retrieval: { resultCount: 5, summaryTree: "include" } }).success).toBe(false);
  });
});

describe("summaries search target", () => {
  const args = { orgId: "org1", projectId: "proj1", embeddingModel: "provider/model", dimension: 8, documentIds: ["doc-1", "doc-2"] };
  const SERVE = { DOCSLURP_SUMMARY_TREE_SERVE: "on" };

  it("names the summaries table of that project's database, scoped to the given documents", () => {
    const target = summariesSearchTarget(args, SERVE);
    expect(target.name).toBe("summaries");
    expect(target.uri.endsWith("/org1/proj1/vectors-provider%2Fmodel-8")).toBe(true);
    expect(target.documentIds).toEqual(["doc-1", "doc-2"]);
    expect(summariesSearchTarget({ ...args, projectId: "proj2" }, SERVE).uri).not.toBe(target.uri);
    expect(summariesSearchTarget({ ...args, orgId: "org2" }, SERVE).uri).not.toBe(target.uri);
  });

  it("refuses without the serve switch", () => {
    for (const env of [{}, { DOCSLURP_SUMMARY_TREE_SERVE: "off" }, { DOCSLURP_SUMMARY_TREE_SERVE: "maybe" }, { DOCSLURP_SUMMARY_TREE_BUILD: "on" }]) {
      expect(() => summariesSearchTarget(args, env)).toThrow(SummariesTargetRefused);
    }
    try { summariesSearchTarget(args, {}); } catch (error) { expect(error).toMatchObject({ reason: "serve-off" }); }
  });

  it("refuses without an explicit document scope: there is no unscoped read", () => {
    for (const documentIds of [[], undefined, null, "doc-1"]) {
      expect(() => summariesSearchTarget({ ...args, documentIds: documentIds as never }, SERVE)).toThrow(SummariesTargetRefused);
    }
    try { summariesSearchTarget({ ...args, documentIds: [] }, SERVE); } catch (error) { expect(error).toMatchObject({ reason: "no-document-scope" }); }
    // Unsafe tenant segments never resolve to a path.
    expect(() => summariesSearchTarget({ ...args, projectId: "../proj2" }, SERVE)).toThrow(/safe projectId/);
    expect(() => summariesSearchTarget({ ...args, orgId: "" }, SERVE)).toThrow(/safe orgId/);
  });
});
