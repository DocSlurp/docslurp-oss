import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { BODY_PEEK_TIMEOUT_MS, rejectLegacyProjectSelection } from "../lib/reject-legacy-project-selection.js";

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
  it("preserves raw JSON transport readers and rejects stale MCP arguments", async () => {
    const raw = new Hono().use("*", rejectLegacyProjectSelection).post("/", async c => c.json(await c.req.raw.json()));
    const valid = { method: "tools/call", params: { arguments: { project: "mine" } } };
    expect(await (await raw.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid) })).json()).toEqual(valid);
    expect((await raw.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ params: { arguments: { workspaceId: "other" } } }) })).status).toBe(400);
  });

  it("lets an empty body stream through without a Content-Type", async () => {
    // Node hosts give every POST a body stream; with no bytes it is not content, even with no body limit in front.
    const route = new Hono().use("*", rejectLegacyProjectSelection).on(["POST", "DELETE"], "/", c => c.json({ ok: true }));
    for (const method of ["POST", "DELETE"]) for (const headers of [{}, { "content-type": "text/plain" }]) {
      const body = new ReadableStream({ start(controller) { controller.close(); } });
      const response = await route.request(new Request("http://localhost/", { method, headers, body, duplex: "half" } as RequestInit));
      expect(response.status).toBe(200);
    }
  });

  it("judges content by the transfer headers before reading, and bounds any peek", async () => {
    const route = new Hono().use("*", rejectLegacyProjectSelection).post("/", c => c.json({ ok: true }));
    const post = (headers: Record<string, string>, body: ReadableStream) =>
      route.request(new Request("http://localhost/", { method: "POST", headers, body, duplex: "half" } as RequestInit));
    // A stream that never delivers: any read of it would hang the test.
    const stalled = () => new ReadableStream({ pull: () => new Promise(() => {}) });
    // A declared body that never arrives is refused from the headers alone, without reading.
    expect((await post({ "content-type": "text/plain", "content-length": "5" }, stalled())).status).toBe(400);
    expect((await post({ "content-type": "text/plain", "transfer-encoding": "chunked" }, stalled())).status).toBe(400);
    expect((await post({ "content-length": "0" }, stalled())).status).toBe(200);
    // A zero-length first chunk followed by data is content.
    const late = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(0)); controller.enqueue(new TextEncoder().encode("{}")); controller.close(); } });
    expect((await post({ "content-type": "text/plain" }, late)).status).toBe(400);
  });

  it("refuses a silent header-less body once the peek bound passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const route = new Hono().use("*", rejectLegacyProjectSelection).post("/", c => c.json({ ok: true }));
      const pending = route.request(new Request("http://localhost/", {
        method: "POST", body: new ReadableStream({ pull: () => new Promise(() => {}) }), duplex: "half",
      } as RequestInit));
      await vi.advanceTimersByTimeAsync(BODY_PEEK_TIMEOUT_MS);
      expect((await pending).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot hide stale selection behind a non-JSON Content-Type", async () => {
    for (const contentType of ["text/plain", "application/octet-stream"]) {
      expect((await app().request("/", { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify({ workspaceId: "foreign" }) })).status).toBe(400);
    }
  });

});
