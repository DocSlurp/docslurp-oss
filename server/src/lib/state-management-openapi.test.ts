import { describe, expect, it } from "vitest";
import { workspaceRunProgressSnapshotSchema, workspaceStateSchema } from "@docslurp/shared";
import { buildOpenApiDocument } from "./openapi.js";
import { runProgressExample, workspaceStateExample } from "./state-management-openapi.js";

const document = buildOpenApiDocument("https://docslurp.io");

describe("state and organization OpenAPI contracts", () => {
  it("publishes full progress and workspace state schemas instead of reduced run records", () => {
    const progress = document.paths["/v1/runs/{runId}/progress"].get;
    expect(progress.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/RunProgressSnapshot" });
    expect(document.components.schemas.RunProgressSnapshot.properties).toHaveProperty("progress");
    expect(document.components.schemas.WorkspaceState.properties).toHaveProperty("storage");
    expect(workspaceRunProgressSnapshotSchema.parse(runProgressExample)).toEqual(runProgressExample);
    expect(workspaceStateSchema.parse(workspaceStateExample)).toEqual(workspaceStateExample);
    expect(document.paths["/v1/workspaces/{workspaceId}/state"].get.parameters[1]).toMatchObject({ name: "recentWindowHours", schema: { minimum: 1, maximum: 720, default: 24 } });
  });

  it("documents actual SSE frames and rate limiting", () => {
    const stream = document.paths["/v1/runs/{runId}/progress/stream"].get;
    expect(stream.responses["200"].content["text/event-stream"].example).toContain("event: snapshot\ndata: {");
    expect(stream.responses["200"]["x-sse-events"].snapshot).toEqual({ $ref: "#/components/schemas/RunProgressSnapshot" });
    expect(stream.responses["429"].headers?.["Retry-After"]).toBeDefined();
  });

  it("publishes complete organization operations with session-only creation and protected role inputs", () => {
    expect(document.paths["/v1/organizations"].post.security).toEqual([{ sessionAuth: [] }]);
    expect(document.components.schemas.CreateOrganization.properties).not.toHaveProperty("userId");
    expect("post" in document.paths["/v1/organizations/{orgId}/members"]).toBe(false);
    expect(document.components.schemas.CreateOrganizationInvite.properties).not.toHaveProperty("userId");
    expect(document.components.schemas.CreateOrganizationInvite.required).toEqual(["email"]);
    expect(document.components.schemas.UpdateOrganization).toMatchObject({ additionalProperties: false, minProperties: 1 });
    expect(document.paths["/v1/organizations/{orgId}"].patch.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/OrganizationDetails" });
    expect(document.paths["/v1/organizations/{orgId}/leave"].post.responses["409"]).toBeDefined();
    expect(document.paths["/v1/organizations/{orgId}/members/{memberUserId}"].patch.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/UpdateOrganizationMember" });
    expect(document.components.schemas.OrganizationApiKey.properties).not.toHaveProperty("rawKey");
  });

  it("resolves published component references without introducing broken local schema refs", () => {
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      if ("$ref" in value) {
        const reference = String(value.$ref);
        expect(reference.startsWith("#/components/schemas/")).toBe(true);
        expect(document.components.schemas).toHaveProperty(reference.slice("#/components/schemas/".length));
      }
      for (const child of Object.values(value)) visit(child);
    }
    visit(document);
  });
});
