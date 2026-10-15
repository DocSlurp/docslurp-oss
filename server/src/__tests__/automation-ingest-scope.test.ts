import { describe, expect, it, vi } from "vitest";
import { aiSimpleRequestSchema, aiAdvancedRequestSchema } from "@docslurp/shared";
import type { ValidatedKey } from "../services/api-keys.js";

const sql = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ sql }));
import { submitSimpleAutomation, submitAdvancedAutomation } from "../services/automation.js";

const apiKey: ValidatedKey = {
  keyId: "delegated-key", userId: "user", orgId: "org", keyType: "server",
  allowedDomains: [], scopes: ["search", "read"], rateLimitRpm: 120, rateLimitPpd: 10000, rateLimits: [], workspaceIds: [],
};
const input = { userId: "user", workspaceId: "workspace", goal: "Retrieve evidence", sourceUrls: ["https://example.com/document"] };

describe("automation ingestion authorization", () => {
  it("denies source ingestion through simple automation before any persisted work", async () => {
    await expect(submitSimpleAutomation({ apiKey, request: aiSimpleRequestSchema.parse(input) })).rejects.toThrow("ingest");
    expect(sql).not.toHaveBeenCalled();
  });
  it("denies source ingestion through advanced automation before any persisted work", async () => {
    await expect(submitAdvancedAutomation({ apiKey, request: aiAdvancedRequestSchema.parse(input) })).rejects.toThrow("ingest");
    expect(sql).not.toHaveBeenCalled();
  });
});
