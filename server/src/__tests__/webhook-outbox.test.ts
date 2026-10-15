import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  outbox: [] as Array<{ id: string; user_id: string; event_type: string; payload: Record<string, unknown> }>,
  dispatched: [] as Array<{ id: string; error: string | null }>,
  requests: [] as Array<{ url: string; headers: Record<string, string>; body: string }>,
  workspacePipeline: null as Record<string, unknown> | null,
  access: true,
}));

vi.mock("../db.js", () => {
  const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join("?");
    if (text.includes("update webhook_outbox") && text.includes("claimed_at = now()")) {
      return state.outbox.splice(0);
    }
    if (text.includes("select pipeline from workspaces")) {
      return state.workspacePipeline ? [{ pipeline: state.workspacePipeline }] : [];
    }
    if (text.includes("from webhooks")) {
      return [{ id: "wh-1", user_id: "u1", url: "https://hooks.example/x", secret: "whsec_plain", events: ["document.replaced"], active: true, created_at: "" }];
    }
    if (text.includes("insert into webhook_deliveries")) {
      return [{ id: String(values[0]), webhook_id: "wh-1", user_id: "u1", event_type: String(values[3]), target_url: "x", payload: {}, response_status: values[6], delivered: values[8], error: values[9], replay_of_delivery_id: null, created_at: "" }];
    }
    if (text.includes("set dispatched_at = now()")) {
      state.dispatched.push({ error: values[0] as string | null, id: String(values[1]) });
    }
    return [];
  });
  return { sql };
});

vi.mock("../lib/network-security.js", () => ({
  assertSafeExternalUrl: vi.fn(async (url: string) => url),
  safeExternalFetch: vi.fn(async (url: string, init: RequestInit) => {
    state.requests.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response("ok", { status: 200 });
  }),
}));

vi.mock("../services/organizations.js", () => ({
  getWorkspaceAccess: vi.fn(async (workspaceId: string) => (state.access ? { workspaceId } : null)),
}));

const { drainWebhookOutbox } = await import("../services/webhooks.js");

describe("webhook outbox", () => {
  beforeEach(() => {
    state.outbox = [];
    state.dispatched = [];
    state.requests = [];
    state.workspacePipeline = null;
    state.access = true;
  });

  it("stops delivering a workspace's events once the subscriber lost access to it (G-06)", async () => {
    state.access = false;
    state.outbox = [{ id: "ob-4", user_id: "u1", event_type: "document.replaced", payload: { workspaceId: "w" } }];
    expect(await drainWebhookOutbox()).toBe(1);
    expect(state.requests).toHaveLength(0);
    expect(state.dispatched).toEqual([{ id: "ob-4", error: "Skipped: subscriber no longer has access to this workspace" }]);
  });

  it("skips events from a workspace that turned webhook notifications off", async () => {
    state.workspacePipeline = { webhooks: { enabled: false, events: [] } };
    state.outbox = [{ id: "ob-2", user_id: "u1", event_type: "document.replaced", payload: { workspaceId: "w" } }];

    expect(await drainWebhookOutbox()).toBe(1);
    expect(state.requests).toEqual([]);
    expect(state.dispatched).toEqual([{ id: "ob-2", error: "Skipped: webhook notifications are off for this workspace" }]);
  });

  it("skips events the workspace did not select", async () => {
    state.workspacePipeline = { webhooks: { enabled: true, events: ["run.failed"] } };
    state.outbox = [{ id: "ob-3", user_id: "u1", event_type: "document.replaced", payload: { workspaceId: "w" } }];

    await drainWebhookOutbox();
    expect(state.requests).toEqual([]);
  });

  it("delivers worker-recorded events with the standard verifiable signature and marks them dispatched", async () => {
    state.outbox = [{
      id: "ob-1",
      user_id: "u1",
      event_type: "document.replaced",
      payload: { workspaceId: "w", documentId: "v2", canonicalId: "/products", replacedDocumentIds: ["v1"] },
    }];

    expect(await drainWebhookOutbox()).toBe(1);
    expect(await drainWebhookOutbox()).toBe(0);

    const [request] = state.requests;
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ event: "document.replaced", canonicalId: "/products", replacedDocumentIds: ["v1"] });
    const timestamp = request.headers["X-DocSlurp-Timestamp"];
    const deliveryId = request.headers["X-DocSlurp-Delivery"];
    const expected = createHmac("sha256", "whsec_plain").update(`${timestamp}.${deliveryId}.${request.body}`).digest("hex");
    expect(request.headers["X-DocSlurp-Signature"]).toBe(`t=${timestamp},id=${deliveryId},v1=${expected}`);
    expect(state.dispatched).toEqual([{ id: "ob-1", error: null }]);
  });
});
