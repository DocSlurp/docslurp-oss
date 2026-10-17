import { describe, expect, it } from "vitest";
import { simpleServicePaths } from "./simple-service-openapi.js";
import { apiKeySurfacePaths } from "./api-key-surface-openapi.js";

describe("canonical public API documentation", () => {
  it("deprecates aliases without deprecating canonical upload and search operations", () => {
    const paths: Record<string, any> = { ...simpleServicePaths, ...apiKeySurfacePaths };
    for (const path of ["/v1/ingest/bulk", "/v1/ingest/url", "/v1/ingest/direct/sessions", "/v1/search/batch", "/v1/search/chat", "/v1/search/chat/stream"]) {
      expect(Object.values(paths[path]).every((operation: any) => operation.deprecated)).toBe(true);
    }
    for (const path of ["/v1/uploads/bulk", "/v1/uploads/url", "/v1/uploads/direct/sessions", "/v1/search", "/v1/chat"]) {
      expect(Object.values(paths[path]).every((operation: any) => !operation.deprecated)).toBe(true);
    }
    expect(paths["/v1/uploads/bulk"].post.description).toContain("/v1/uploads/direct/sessions");
  });
});
