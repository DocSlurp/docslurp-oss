import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "./openapi.js";

const document = buildOpenApiDocument("https://docslurp.io");

describe("project summary tree OpenAPI contract", () => {
  it("publishes the state and the one endpoint that changes the setting", () => {
    const path = document.paths["/v1/projects/{projectId}/summary-tree"];
    expect(Object.keys(path)).toEqual(["get", "patch"]);
    const schemas = document.components.schemas as Record<string, { properties: Record<string, { enum?: string[] }>; required?: string[]; additionalProperties?: boolean }>;
    expect(schemas.UpdateProjectSummaryTree).toMatchObject({ required: ["enabled"], additionalProperties: false });
    expect(Object.keys(schemas.UpdateProjectSummaryTree.properties)).toEqual(["enabled"]);
    expect(schemas.ProjectSummaryTreeState.properties).toHaveProperty("constants");
    expect(schemas.ProjectSummaryTreeState.properties.status.enum).toEqual(["off", "building", "partial", "ready"]);
    expect(path.patch.responses).toHaveProperty("409");
    expect(schemas.ProjectState.properties).toHaveProperty("summaryTree");
    const constants = (schemas.ProjectSummaryTreeState.properties.constants as unknown as { properties: Record<string, unknown> }).properties;
    for (const key of ["minFanIn", "baseNodesPerDocument", "maxNodesPerLeaf", "searchHits", "guideHits", "guideChunksPerHit", "guideMaxRange", "guideResultShare", "buildStaleSeconds"]) {
      expect(constants).toHaveProperty(key);
    }
  });

  it("publishes the backfill: estimate, start with a mandatory cap, status and cancel", () => {
    expect(Object.keys(document.paths["/v1/projects/{projectId}/summary-tree/backfill"])).toEqual(["get", "post"]);
    expect(Object.keys(document.paths["/v1/projects/{projectId}/summary-tree/backfill/estimate"])).toEqual(["post"]);
    expect(Object.keys(document.paths["/v1/projects/{projectId}/summary-tree/backfill/{jobId}"])).toEqual(["get"]);
    expect(Object.keys(document.paths["/v1/projects/{projectId}/summary-tree/backfill/{jobId}/cancel"])).toEqual(["post"]);
    const schemas = document.components.schemas as Record<string, { properties: Record<string, { enum?: string[]; minimum?: number }>; required?: string[]; additionalProperties?: boolean }>;
    expect(schemas.StartSummaryTreeBackfill).toMatchObject({ required: ["maxCostCents"], additionalProperties: false });
    // A cap that would round to nothing in storage is refused by the schema.
    expect(schemas.StartSummaryTreeBackfill.properties.maxCostCents.minimum).toBe(0.01);
    expect(schemas.SummaryTreeJob.properties.blockedReason).toBeDefined();
    expect(schemas.SummaryTreeJob.properties.status.enum).toEqual(["queued", "running", "blocked", "completed", "failed", "cancelled"]);
    const start = document.paths["/v1/projects/{projectId}/summary-tree/backfill"].post;
    expect(start.responses).toHaveProperty("202");
    expect(start.responses).toHaveProperty("402");
    // No model vendor, host or price in what the API publishes about the job.
    const published = JSON.stringify([document.paths["/v1/projects/{projectId}/summary-tree/backfill"], schemas.SummaryTreeJob, schemas.ProjectSummaryTreeBackfill]);
    expect(published).not.toMatch(/openrouter|deepseek|qwen|openai|anthropic|\$\d/i);
  });
});
