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
  });
});
