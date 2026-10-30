import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/** `PATCH /v1/organizations/:id { allowChinaProviders }` and the request policy OpenRouter calls read. */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let orgs: typeof import("../services/organizations.js");
let policy: typeof import("../lib/provider-policy.js");
let context: typeof import("../lib/request-context.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {}, types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } } }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x'), ('u2', 'B', 'b@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('open', 'Open', 'open', 'u1'), ('closed', 'Closed', 'closed', 'u1')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('open', 'u1', 'owner'), ('closed', 'u1', 'owner'), ('open', 'u2', 'owner')`;
  await sql`insert into workspaces(id, user_id, name, org_id, allow_china_providers) values
    ('ws-open', 'u1', 'Open', 'open', true), ('ws-narrow', 'u1', 'Narrow', 'open', false), ('ws-in-closed', 'u1', 'Wide', 'closed', true)`;
  orgs = await import("../services/organizations.js");
  policy = await import("../lib/provider-policy.js");
  context = await import("../lib/request-context.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

/** The policy as a request acting as `userId` (in `orgId`, carrying `workspaceIds`' content) sees it. */
async function policyFor(userId: string | null, orgId?: string, workspaceIds: string[] = []) {
  const app = new Hono().use("*", context.requestContextMiddleware).get("/", async (c) => {
    if (userId) context.setCurrentRequestUserId(userId);
    context.setCurrentRequestOrgId(orgId);
    for (const id of workspaceIds) context.noteProviderPolicyWorkspace(id);
    return c.json(await policy.requestProviderPolicy() ?? null);
  });
  return await (await app.request("/")).json();
}

describe("organization allowChinaProviders", () => {
  it("defaults to allowed and is stored when an admin turns it off", async () => {
    expect((await orgs.getOrganization("closed", "u1"))!.allowChinaProviders).toBe(true);
    await orgs.updateOrganization("closed", "u1", { allowChinaProviders: false });
    expect((await orgs.getOrganization("closed", "u1"))!.allowChinaProviders).toBe(false);
    expect((await orgs.listOrganizations("u1")).find((org) => org.id === "open")).toMatchObject({ allowChinaProviders: true });
  });

  it("applies the request's org setting, and restricts a request without one if any of the user's orgs is restricted", async () => {
    expect(await policyFor("u1", "open")).toEqual({ allowChinaProviders: true });
    expect(await policyFor("u1", "closed")).toEqual({ allowChinaProviders: false });
    expect(await policyFor("u1")).toEqual({ allowChinaProviders: false });
    expect(await policyFor("u2")).toEqual({ allowChinaProviders: true });
  });

  it("applies a changed setting at once on this instance", async () => {
    await orgs.updateOrganization("closed", "u1", { allowChinaProviders: true });
    expect(await policyFor("u1", "closed")).toEqual({ allowChinaProviders: true });
    expect(await policyFor("u1")).toEqual({ allowChinaProviders: true });
  });
});

describe("workspace allowChinaProviders", () => {
  it("narrows an allowing org, and can never widen a restricted one", async () => {
    await orgs.updateOrganization("closed", "u1", { allowChinaProviders: false });
    expect(await policyFor("u1", "open", ["ws-open"])).toEqual({ allowChinaProviders: true });
    expect(await policyFor("u1", "open", ["ws-narrow"])).toEqual({ allowChinaProviders: false });
    // A workspace set to true inside a restricted org stays restricted, with or without the request's org.
    expect(await policyFor("u1", undefined, ["ws-in-closed"])).toEqual({ allowChinaProviders: false });
    expect(await policyFor("u1", "closed", ["ws-in-closed"])).toEqual({ allowChinaProviders: false });
    // One restricted workspace among several restricts the whole request.
    expect(await policyFor("u1", "open", ["ws-open", "ws-narrow"])).toEqual({ allowChinaProviders: false });
  });

  it("fails closed on an unknown scope: no user, org or workspace, or a missing workspace or org", async () => {
    expect(await policyFor(null)).toEqual({ allowChinaProviders: false });
    expect(await policyFor("u1", "missing-org")).toEqual({ allowChinaProviders: false });
    expect(await policyFor("u1", "open", ["missing-ws"])).toEqual({ allowChinaProviders: false });
  });

  it("notes the workspace on every hosted-call privacy check, so the setting applies to that request's calls", async () => {
    const privacy = await import("../lib/privacy.js");
    const app = new Hono().use("*", context.requestContextMiddleware).get("/", async (c) => {
      context.setCurrentRequestUserId("u1");
      context.setCurrentRequestOrgId("open");
      await privacy.allowHostedCallForWorkspace({ privacyMode: "standard", workspaceId: "ws-narrow", call: privacy.openRouterCall("test", "z-ai/glm-5.3-flash") });
      return c.json(await policy.requestProviderPolicy());
    });
    expect(await (await app.request("/")).json()).toEqual({ allowChinaProviders: false });
  });

  it("sends an opted-out workspace's chat request only to known non-China providers (request body asserted)", async () => {
    const { CHINA_PROVIDER_SLUGS, NON_CHINA_PROVIDER_SLUGS, providerRegion, setOpenRouterProviderPolicyResolver } = await import("@docslurp/shared");
    const ai = await import("../lib/ai.js");
    policy.registerProviderPolicy();
    const bodies: Record<string, any>[] = [];
    const stub = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "g", object: "chat.completion", created: 0, model: "z-ai/glm-5.3-flash", provider: "Together", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.000001 } }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", stub);
    const generate = (workspaceId: string) => {
      const app = new Hono().use("*", context.requestContextMiddleware).get("/", async (c) => {
        context.setCurrentRequestUserId("u1");
        context.setCurrentRequestOrgId("open");
        context.setCurrentRequestWorkspaceId(workspaceId);
        // Only the outgoing body matters here; a stub response the SDK cannot parse is fine.
        await ai.generateOpenRouterText({ apiKey: "k", prompt: "hi", model: "z-ai/glm-5.3-flash", maxOutputTokens: 8, privacyMode: "standard" }).catch(() => undefined);
        return c.json({});
      });
      return app.request("/");
    };
    try {
      await generate("ws-narrow");
      await generate("ws-open");
    } finally {
      vi.unstubAllGlobals();
      setOpenRouterProviderPolicyResolver(undefined);
    }
    const chat = bodies.filter((body) => body.model === "z-ai/glm-5.3-flash");
    expect(chat).toHaveLength(2);
    expect(chat[0]!.provider).toMatchObject({ sort: "price", only: [...NON_CHINA_PROVIDER_SLUGS], ignore: expect.arrayContaining([...CHINA_PROVIDER_SLUGS]) });
    for (const slug of chat[0]!.provider.only) expect(providerRegion(slug)).toBe("other");
    // The default (allowing) workspace goes to the cheapest host, China-based ones included.
    expect(chat[1]!.provider).toEqual({ sort: "price", quantizations: ["fp8", "fp16", "bf16", "fp32"], allow_fallbacks: true });
  });
});
