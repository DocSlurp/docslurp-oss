import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Credential } from "mppx";
import { stripe as stripeClientMethods } from "mppx/client";
import { Store } from "mppx/server";
import type { ValidatedKey } from "../services/api-keys.js";

process.env.MACHINE_PAYMENTS_ENABLED = "true";
process.env.STRIPE_PROFILE_ID = "profile_test_agent";
process.env.STRIPE_SECRET_KEY = "sk_test_agent_payments";

const validateApiKey = vi.fn();
vi.mock("../services/api-keys.js", () => ({ validateApiKey }));
vi.mock("../db.js", () => ({ sql: vi.fn() }));
// The MCP router statically mounts every adapter; stub what buyCredits never reaches.
vi.mock("../services/search.js", () => ({ hybridSearch: vi.fn(), MissingWorkspaceScopeError: class extends Error {} }));
vi.mock("../services/workspace-chat.js", () => ({ chatWorkspace: vi.fn(), workspaceChatDisabledBody: vi.fn(async () => null) }));
vi.mock("../services/workspaces.js", () => ({ resolveWorkspaceRef: vi.fn(), ensureDefaultWorkspace: vi.fn(), getWorkspace: vi.fn(), listWorkspaces: vi.fn() }));
vi.mock("../services/ingest-report.js", () => ({ loadIngestReport: vi.fn(), summarizeIngestReport: vi.fn() }));
vi.mock("../routes/uploads.js", async () => ({ uploadEstimateRoutes: new (await import("hono")).Hono(), uploadsRoutes: new (await import("hono")).Hono() }));
vi.mock("../routes/workspaces.js", async () => ({ workspacesRoutes: new (await import("hono")).Hono() }));
vi.mock("../routes/workspace-graph.js", async () => ({ workspaceGraphRoutes: new (await import("hono")).Hono() }));
vi.mock("../routes/documents.js", async () => ({ documentsRoutes: new (await import("hono")).Hono() }));
vi.mock("../routes/runs.js", async () => ({ runsRoutes: new (await import("hono")).Hono() }));
vi.mock("../routes/jobs.js", async () => ({ jobsRoutes: new (await import("hono")).Hono() }));

// Stripe as the SPT rail sees it: one PaymentIntent per (challenge, token), replayed on retry.
const createdIntents = new Map<string, { id: string; status: string }>();
const paymentIntentsCreate = vi.fn(async (params: Record<string, unknown>, options: { idempotencyKey: string }) => {
  const existing = createdIntents.get(options.idempotencyKey);
  if (existing) return { ...existing, lastResponse: { headers: { "idempotent-replayed": "true" } } };
  const intent = { id: `pi_agent_${createdIntents.size + 1}`, status: "succeeded", metadata: params.metadata };
  createdIntents.set(options.idempotencyKey, intent);
  return { ...intent, lastResponse: { headers: {} } };
});
vi.mock("../services/billing/stripe-client.js", () => ({
  getStripe: () => ({ paymentIntents: { create: paymentIntentsCreate }, rawRequest: vi.fn() }),
  isStripeConfigured: () => true,
}));
const memoryStore = Store.memory();
vi.mock("../services/billing/machine-payment-store.js", () => ({ postgresMachinePaymentStore: () => memoryStore, sweepMachinePaymentStore: vi.fn() }));
const grantOrgCredits = vi.fn(async (_client: unknown, _args: Record<string, unknown>) => true);
vi.mock("../services/billing/credits.js", () => ({ grantOrgCredits }));

const { mcpRoutes } = await import("../routes/mcp.js");

const validatedKey: ValidatedKey = {
  keyId: "key-1", userId: "user-1", orgId: "org-1", keyType: "server", allowedDomains: [],
  scopes: ["search"], rateLimitRpm: 600, rateLimitPpd: 10_000, rateLimits: [], workspaceIds: [],
};

async function connect(app: Hono) {
  const client = new Client({ name: "agent-wallet", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:4321/mcp"), {
    requestInit: { headers: { Authorization: "Bearer dslp_test" } },
    fetch: async (url, init) => app.request(new Request(url, init)),
  }));
  return client;
}

/** What an agent wallet does with a challenge: mint a Shared Payment Token and sign a credential. */
async function payWithCard(challenge: unknown) {
  const [card] = stripeClientMethods({ createToken: async () => "spt_test_wallet", paymentMethod: "pm_card_visa" });
  const serialized = await card!.createCredential({ challenge: challenge as never, context: {} });
  return Credential.deserialize(serialized);
}

describe("buyCredits over MPP", () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono().route("/mcp", mcpRoutes);
    validateApiKey.mockReset();
    validateApiKey.mockResolvedValue(validatedKey);
    grantOrgCredits.mockClear();
    paymentIntentsCreate.mockClear();
    createdIntents.clear();
  });

  it("challenges, takes a card credential, grants the key's org once and returns a receipt", async () => {
    const client = await connect(app);
    const buyCredits = (await client.listTools()).tools.find(tool => tool.name === "buyCredits");
    expect(buyCredits?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false, openWorldHint: true });
    expect(client.getServerCapabilities()?.experimental).toEqual({ payment: { methods: { stripe: { intents: ["charge"] } } } });

    const required = await client.callTool({ name: "buyCredits", arguments: { amountCents: 2500 } }).then(() => null, (error: unknown) => error);
    expect(required).toMatchObject({ code: -32042, data: { httpStatus: 402 } });
    const challenges = (required as { data: { challenges: Array<{ method: string; intent: string; request: Record<string, unknown> }> } }).data.challenges;
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({ method: "stripe", intent: "charge", request: { amount: "2500", currency: "usd" } });
    expect(grantOrgCredits).not.toHaveBeenCalled();

    const credential = await payWithCard(challenges[0]);
    const paid = await client.callTool({ name: "buyCredits", arguments: { amountCents: 2500 }, _meta: { "org.paymentauth/credential": credential } });
    expect(paid.isError).toBe(false);
    expect(paid.structuredContent).toMatchObject({ tool: "buyCredits", credits: 2500, amountCents: 2500, granted: true, method: "stripe", reference: "pi_agent_1" });
    expect(paid._meta?.["org.paymentauth/receipt"]).toMatchObject({ method: "stripe", reference: "pi_agent_1", status: "success", challengeId: credential.challenge.id });
    expect(paymentIntentsCreate.mock.calls[0]![0]).toMatchObject({
      amount: 2500, currency: "usd", shared_payment_granted_token: "spt_test_wallet",
      metadata: { orgId: "org-1", purpose: "agent_credit_topup", credits: "2500" },
    });
    expect(grantOrgCredits).toHaveBeenCalledTimes(1);
    expect(grantOrgCredits.mock.calls[0]![1]).toMatchObject({
      orgId: "org-1", source: "topup", externalId: "pi_agent_1", pool: "prepaid", credits: 2500, userId: "user-1",
      metadata: { rail: "mpp", method: "stripe", paymentIntentId: "pi_agent_1" },
    });

    // A replayed credential reaches Stripe's idempotency replay and is refused; nothing more is granted.
    const replay = await client.callTool({ name: "buyCredits", arguments: { amountCents: 2500 }, _meta: { "org.paymentauth/credential": credential } }).then(() => null, (error: unknown) => error);
    expect(replay).toMatchObject({ code: -32043, data: { httpStatus: 402, problem: { type: "https://paymentauth.org/problems/verification-failed" } } });
    expect(grantOrgCredits).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("refuses a credential for a different amount or a malformed one", async () => {
    const client = await connect(app);
    const required = await client.callTool({ name: "buyCredits", arguments: { amountCents: 500 } }).then(() => null, (error: unknown) => error);
    const credential = await payWithCard((required as { data: { challenges: unknown[] } }).data.challenges[0]);
    const swapped = await client.callTool({ name: "buyCredits", arguments: { amountCents: 100_000 }, _meta: { "org.paymentauth/credential": credential } }).then(() => null, (error: unknown) => error);
    // The org and amount are bound into the HMAC'd challenge.
    expect(swapped).toMatchObject({ code: -32043, data: { problem: { type: "https://paymentauth.org/problems/invalid-challenge" } } });
    const malformed = await client.callTool({ name: "buyCredits", arguments: { amountCents: 500 }, _meta: { "org.paymentauth/credential": { nope: true } } }).then(() => null, (error: unknown) => error);
    expect(malformed).toMatchObject({ code: -32602 });
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
    expect(grantOrgCredits).not.toHaveBeenCalled();
    await client.close();
  });

  it("speaks MPP over the REST adapter with Payment-Authorization beside the API key", async () => {
    const headers = { Authorization: "Bearer dslp_test", "Content-Type": "application/json" };
    const body = JSON.stringify({ amountCents: 1000 });
    const challenge = await app.request("/mcp/tools/buyCredits", { method: "POST", headers, body });
    expect(challenge.status).toBe(402);
    expect(challenge.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
    const { Challenge } = await import("mppx");
    const credential = await payWithCard(Challenge.fromResponse(challenge));
    const paid = await app.request("/mcp/tools/buyCredits", { method: "POST", headers: { ...headers, "Payment-Authorization": Credential.serialize(credential) }, body });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("Payment-Receipt")).toBeTruthy();
    expect(await paid.json()).toMatchObject({ credits: 1000, granted: true });
    const again = await app.request("/mcp/tools/buyCredits", { method: "POST", headers: { ...headers, "Payment-Authorization": Credential.serialize(credential) }, body });
    expect(again.status).toBe(402);
    expect(await again.json()).toMatchObject({ type: "https://paymentauth.org/problems/verification-failed" });
    expect(grantOrgCredits).toHaveBeenCalledTimes(1);
  });

  it("offers USDC on Tempo beside cards once a deposit address is configured", async () => {
    process.env.MPP_TEMPO_DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000000a1";
    try {
      const client = await connect(app);
      expect(client.getServerCapabilities()?.experimental).toEqual({ payment: { methods: { tempo: { intents: ["charge"] }, stripe: { intents: ["charge"] } } } });
      const required = await client.callTool({ name: "buyCredits", arguments: { amountCents: 500 } }).then(() => null, (error: unknown) => error);
      const challenges = (required as { data: { challenges: Array<{ method: string; request: Record<string, unknown> }> } }).data.challenges;
      expect(challenges.map(challenge => challenge.method).sort()).toEqual(["stripe", "tempo"]);
      // $5.00 as 6-decimal USDC, paid to the Stripe deposit address.
      expect(challenges.find(challenge => challenge.method === "tempo")?.request).toMatchObject({ amount: "5000000", recipient: "0x00000000000000000000000000000000000000a1" });
      await client.close();
    } finally {
      delete process.env.MPP_TEMPO_DEPOSIT_ADDRESS;
    }
  });

  it("refuses keys outside an organization before any charge", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, orgId: null });
    const response = await app.request("/mcp/tools/buyCredits", { method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: JSON.stringify({ amountCents: 1000 }) });
    expect(response.status).toBe(403);
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });
});
