import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { defaultPipelineFeatures, normalizePipelineFeatures, resolveManagedPipeline } from "@docslurp/shared";
import { customerPipelineGuard } from "./customer-pipeline-guard.js";

/**
 * Council round 4: the backstop strips managed model fields from any `pipeline` in a JSON response to a non-operator,
 * at any depth (a project, a project list, created runs, an MCP tool result), and leaves operators and streams alone.
 */
const privateRoute = "llm://private/acme-gpu/qwen/qwen3-vl-30b-a3b-instruct";
const pipeline = resolveManagedPipeline(normalizePipelineFeatures(defaultPipelineFeatures), null, "test").pipeline;
const withModels = { ...pipeline, vision: { ...(pipeline as { vision: object }).vision, modelUri: privateRoute } };

function app(user: { id: string; isAdmin?: boolean }) {
  return new Hono()
    .use("*", async (c, next) => { (c.set as (key: string, value: unknown) => void)("sessionUser", { email: "u@example.test", name: "U", ...user }); await next(); })
    .use("*", customerPipelineGuard)
    .get("/project", (c) => c.json({ id: "p", pipeline: withModels }))
    .get("/nested", (c) => c.json({ projects: [{ id: "p", pipeline: withModels }], runs: [{ id: "r", pipeline: withModels, stats: { pages: 3 } }] }))
    .get("/text", (c) => c.text(`pipeline ${privateRoute}`))
    .get("/stream", (c) => new Response(`data: {"pipeline":{"vision":{"modelUri":"${privateRoute}"}}}\n\n`, { headers: { "content-type": "text/event-stream" } }));
}

describe("customerPipelineGuard", () => {
  it("removes managed model fields from every pipeline a customer receives", async () => {
    for (const path of ["/project", "/nested"]) {
      const response = await app({ id: "member" }).request(path);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("llm://");
      expect(text).not.toContain("modelUri");
    }
    const nested = await (await app({ id: "member" }).request("/nested")).json() as { runs: Array<{ stats: unknown; pipeline: Record<string, unknown> }> };
    expect(nested.runs[0]!.stats).toEqual({ pages: 3 });
    expect(nested.runs[0]!.pipeline.quality).toBe((pipeline as { quality: unknown }).quality);
  });

  it("leaves a platform operator's response whole", async () => {
    const body = await (await app({ id: "operator", isAdmin: true }).request("/project")).json() as { pipeline: { vision: { modelUri: string } } };
    expect(body.pipeline.vision.modelUri).toBe(privateRoute);
  });

  it("passes non-JSON bodies and streams through untouched", async () => {
    expect(await (await app({ id: "member" }).request("/text")).text()).toBe(`pipeline ${privateRoute}`);
    expect(await (await app({ id: "member" }).request("/stream")).text()).toContain(privateRoute);
  });
});
