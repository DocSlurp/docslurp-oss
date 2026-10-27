import { describe, expect, it } from "vitest";
import { simpleServicePaths } from "./simple-service-openapi.js";
import { apiKeySurfacePaths } from "./api-key-surface-openapi.js";
import { buildOpenApiDocument } from "./openapi.js";

describe("canonical public API documentation", () => {
  it("documents canonical upload, search and chat paths, and marks the upload alias deprecated", () => {
    const paths: Record<string, any> = { ...simpleServicePaths, ...apiKeySurfacePaths };
    for (const path of ["/v1/ingest/bulk", "/v1/ingest/url", "/v1/ingest/direct/sessions"]) {
      expect(Object.values(paths[path]).every((operation: any) => operation.deprecated)).toBe(true);
    }
    for (const path of ["/v1/search/chat", "/v1/search/chat/stream", "/v1/artifacts/resolve", "/v1/documents/review-queue"]) {
      expect(paths[path], path).toBeUndefined();
    }
    for (const path of ["/v1/uploads/bulk", "/v1/uploads/url", "/v1/uploads/direct/sessions", "/v1/search", "/v1/chat", "/v1/chat/stream"]) {
      expect(Object.values(paths[path]).every((operation: any) => !operation.deprecated)).toBe(true);
    }
    expect(paths["/v1/uploads/bulk"].post.description).toContain("/v1/uploads/direct/sessions");
  });

  it("documents the native error envelope once and references it from native error responses", () => {
    const document: any = buildOpenApiDocument("https://api.example.test");
    const schema = document.components.schemas.ApiError;
    expect(schema.properties.error.required).toEqual(["code", "message", "requestId"]);
    expect(schema.properties.error.properties.code.enum).toContain("workspace_not_found");

    const refersToEnvelope = (response: any) => response?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/ApiError";
    for (const [path, method] of [["/v1/search", "post"], ["/v1/chat", "post"], ["/v1/uploads/bulk", "post"], ["/v1/runs/{runId}/progress", "get"], ["/v1/workspaces/{workspaceId}", "patch"]]) {
      const responses = document.paths[path]?.[method]?.responses;
      expect(responses, `${method} ${path}`).toBeDefined();
      for (const status of ["400", "401", "403", "404", "429"].filter((status) => responses[status])) {
        expect(refersToEnvelope(responses[status]), `${method} ${path} ${status}`).toBe(true);
      }
    }
    // The OpenAI-compatible surface keeps its own error shape.
    expect(refersToEnvelope(document.paths["/v1/chat/completions"].post.responses["400"])).toBe(false);
  });
});
