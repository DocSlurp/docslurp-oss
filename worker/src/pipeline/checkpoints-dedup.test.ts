import { describe, expect, it } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import type { WorkspaceRun } from "../models.js";
import { checkDedup, registerHash } from "./checkpoints.js";
import { WorkflowState } from "./pipeline.js";

const run = {
  id: "run-1", orgId: "org-1", userId: "user-1", kind: "bulk-upload", status: "processing", stage: "extract-markdown",
  totalDocuments: 1, processedDocuments: 0, pagesTotal: 1, pagesProcessed: 0, spentCents: 0,
  pipeline: { ...defaultPipelineFeatures }, error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
} as WorkspaceRun;

describe("checkDedup", () => {
  it("reuses an artifact registered for the same content on a first attempt", () => {
    const state = WorkflowState.create(run, []);
    registerHash(state, "sha-1", "s3://bucket/first.md");
    expect(checkDedup(state, "sha-1", "doc-1:extract-markdown")).toBe("s3://bucket/first.md");
  });

  it("does not short-circuit a retry strategy with the failed attempt's own artifact", () => {
    // Low-plausibility escalation retries the same document; the first attempt already registered its hash.
    const state = WorkflowState.create(run, []);
    registerHash(state, "sha-1", "s3://bucket/first.md");
    expect(checkDedup(state, "sha-1", "doc-1:extract-markdown", "native-pdf")).toBeUndefined();
  });
});
