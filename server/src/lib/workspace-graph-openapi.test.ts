import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "./openapi.js";

const document = buildOpenApiDocument("https://docslurp.io");

describe("workspace graph OpenAPI contract", () => {
  it("publishes settings, rebuild, job and stream routes with their schemas", () => {
    expect(Object.keys(document.paths).filter((path) => path.includes("/graph"))).toEqual([
      "/v1/workspaces/{workspaceId}/graph",
      "/v1/workspaces/{workspaceId}/graph/rebuild",
      "/v1/workspaces/{workspaceId}/graph/jobs/{jobId}",
      "/v1/workspaces/{workspaceId}/graph/jobs/{jobId}/events",
      "/v1/workspaces/{workspaceId}/graph/jobs/{jobId}/cancel",
    ]);
    expect(document.components.schemas.UpdateWorkspaceGraph.properties).toHaveProperty("entityTypes");
    expect(document.components.schemas.WorkspaceGraphStatus.properties).toHaveProperty("estimates");
    expect(document.components.schemas.GraphJob.properties).toHaveProperty("etaSeconds");
    expect(document.paths["/v1/workspaces/{workspaceId}/graph/jobs/{jobId}/events"].get.responses["200"]["x-sse-events"])
      .toHaveProperty("progress");
  });
});
