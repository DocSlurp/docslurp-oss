import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "./openapi.js";

const document = buildOpenApiDocument("https://docslurp.io");

describe("project graph OpenAPI contract", () => {
  it("publishes settings, rebuild, job and stream routes with their schemas", () => {
    expect(Object.keys(document.paths).filter((path) => path.includes("/graph"))).toEqual([
      "/v1/projects/{projectId}/graph",
      "/v1/projects/{projectId}/graph/rebuild",
      "/v1/projects/{projectId}/graph/jobs/{jobId}",
      "/v1/projects/{projectId}/graph/jobs/{jobId}/events",
      "/v1/projects/{projectId}/graph/jobs/{jobId}/cancel",
      "/v1/projects/{projectId}/graph/jobs/estimate",
    ]);
    expect(document.components.schemas.UpdateProjectGraph.properties).toHaveProperty("entityTypes");
    expect(document.components.schemas.ProjectGraphStatus.properties).toHaveProperty("estimates");
    expect(document.components.schemas.GraphJob.properties).toHaveProperty("etaSeconds");
    expect(document.paths["/v1/projects/{projectId}/graph/jobs/{jobId}/events"].get.responses["200"]["x-sse-events"])
      .toHaveProperty("progress");
  });
});
