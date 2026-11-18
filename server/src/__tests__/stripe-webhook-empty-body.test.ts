import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value }) }));

const { nativeBodyLimit } = await import("../lib/api-error.js");
const { stripeWebhookRoutes } = await import("../routes/stripe-webhook.js");

/** server.ts mounts the Stripe webhook behind a 1 MiB actual-byte cap. */
function app() {
  const app = new Hono();
  app.use("/webhooks/stripe", nativeBodyLimit(1024 * 1024));
  app.route("/webhooks", stripeWebhookRoutes);
  return app;
}

/** The shape Node hosts hand over for a body-less POST: an empty body stream. */
function emptyPost(headers: Record<string, string>) {
  const body = new ReadableStream({ start(controller) { controller.close(); } });
  return new Request("http://localhost/webhooks/stripe", { method: "POST", headers, body, duplex: "half" } as RequestInit);
}

afterEach(() => vi.unstubAllEnvs());

describe("Stripe webhook with an empty body", () => {
  it("still fails its signature check", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_empty_body");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_empty_body");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app().request(emptyPost({ "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }));
      expect(response.status).toBe(400);
      expect(await response.json()).not.toMatchObject({ ok: true });
    } finally {
      error.mockRestore();
    }
  });

  it("still requires the signature header", async () => {
    expect((await app().request(emptyPost({}))).status).toBe(400);
  });
});
