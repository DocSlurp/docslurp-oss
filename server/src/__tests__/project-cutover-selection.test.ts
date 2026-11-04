import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rejectLegacyProjectSelection } from "../lib/reject-legacy-project-selection.js";

function app() {
  return new Hono().use("*", rejectLegacyProjectSelection)
    .post("/", async c => c.json(await c.req.json()))
    .get("/", c => c.json({ project: c.req.query("projectId") ?? "default" }));
}

describe("project cutover rejects stale scope instead of selecting default", () => {
  it.each(["workspace", "workspaceId", "workspaceIds", "workspaceName", "newWorkspace", "workspace_id"])("rejects %s JSON selection", async key => {
    const response = await app().request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: "foreign-project" }) });
    expect(response.status).toBe(400);
  });
  it("rejects mixed old/new selectors and nested OpenAI extension scope", async () => {
    for (const body of [{ projectId: "mine", workspaceId: "other" }, { docslurp: { workspaceId: "other" } }]) {
      expect((await app().request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(400);
    }
  });
  it("rejects stale query scope", async () => {
    expect((await app().request("/?workspaceId=other")).status).toBe(400);
  });
  it("preserves canonical selection and opaque customer metadata", async () => {
    const body = { projectId: "mine", metadata: { workspaceId: "a customer field" } };
    const response = await app().request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
    expect(await (await app().request("/")).json()).toEqual({ project: "default" });
  });
});
