import { describe, expect, it } from "vitest";

import { querySite, querySummary } from "../dependency-postgres.js";

describe("postgres span attributes", () => {
  it("summarizes a statement by operation and first table", () => {
    expect(querySummary("SELECT", "select count(*) from search_sessions s where s.metadata ->> 'workspaceId' = $1")).toBe("SELECT search_sessions");
    expect(querySummary("INSERT", "insert into document_exports (id) values ($1)")).toBe("INSERT document_exports");
    expect(querySummary("UPDATE", 'update "user" set name = $1')).toBe("UPDATE user");
    expect(querySummary("SELECT", "select 1")).toBe("SELECT");
    // Function calls are not tables; schema-qualified names keep the table.
    expect(querySummary("SELECT", "select extract(epoch from now()) from runs")).toBe("SELECT runs");
    expect(querySummary("SELECT", "select * from unnest($1::text[]) as x")).toBe("SELECT");
    expect(querySummary("INSERT", 'insert into "public"."user" (id) values ($1)')).toBe("INSERT user");
    expect(querySummary("SELECT", "select * from analytics.events")).toBe("SELECT analytics.events");
  });

  it("finds the application frame that issued the query, skipping instrumentation and libraries", () => {
    const stack = [
      "Error",
      "    at query (file:///app/packages/shared/dist/dependency-postgres.js:40:20)",
      "    at Proxy.apply (file:///app/packages/shared/dist/dependency-postgres.js:90:10)",
      "    at getWorkspace (file:///app/server/dist/services/workspaces.js:612:21)",
      "    at async file:///app/server/dist/routes/workspaces.js:808:23",
    ].join("\n");
    expect(querySite(stack)).toEqual({ "code.function.name": "getWorkspace", "code.file.path": "server/dist/services/workspaces.js", "code.line.number": 612 });
    expect(querySite("Error\n    at node:internal/process/task_queues:95:5")).toEqual({});
  });
});
