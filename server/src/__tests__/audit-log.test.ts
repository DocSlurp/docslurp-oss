import { describe, expect, it } from "vitest";

import { buildAuditLogListQuery } from "../services/audit-log.js";

describe("buildAuditLogListQuery", () => {
  it("scopes to the actor's memberships and passes cursor filters as parameters", () => {
    const { query, params, limit } = buildAuditLogListQuery({
      actorUserId: "admin-user",
      orgId: "org-1",
      workspaceId: "ws-1",
      runId: "run-1",
      before: "2026-03-07T00:00:00.000Z",
      limit: 50
    });

    expect(limit).toBe(50);
    expect(params).toEqual([
      "admin-user",
      "org-1",
      "ws-1",
      "run-1",
      "2026-03-07T00:00:00.000Z",
      51
    ]);
    expect(query).toContain("org_memberships where user_id = $1");
  });
});
