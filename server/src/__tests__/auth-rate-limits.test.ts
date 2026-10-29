import { describe, expect, it, vi } from "vitest";

import {
  createMemoryAuthBudgetStore,
  EMAIL_RECIPIENT_BUDGETS,
  EMAIL_SENDING_PATHS,
  emailRecipientLimiter,
  emailRecipientLimitsEnabled,
  hashedBudgetKey,
  recipientBudgetKey,
} from "../lib/auth-rate-limits.js";

describe("authentication budgets", () => {
  it("counts a fixed window and restarts it once elapsed", async () => {
    let now = 1_000_000;
    const store = createMemoryAuthBudgetStore(() => now);
    const budget = { windowSeconds: 60, max: 2 };
    expect((await store.consume("k", budget)).allowed).toBe(true);
    expect((await store.consume("k", budget)).allowed).toBe(true);
    now += 15_000;
    expect(await store.consume("k", budget)).toMatchObject({ allowed: false, retryAfterSeconds: 45 });
    now += 45_000;
    expect((await store.consume("k", budget)).allowed).toBe(true);
  });

  it("gives back one unit only to the window it was counted in", async () => {
    let now = 0;
    const store = createMemoryAuthBudgetStore(() => now);
    const budget = { windowSeconds: 60, max: 1 };
    const first = await store.consume("k", budget);
    await store.release("k", first.window);
    expect((await store.consume("k", budget)).allowed).toBe(true);
    expect((await store.consume("k", budget)).allowed).toBe(false);
    now += 61_000;
    expect((await store.consume("k", budget)).allowed).toBe(true);
    // A late refund from the old window can't open the new one.
    await store.release("k", first.window);
    expect((await store.consume("k", budget)).allowed).toBe(false);
  });

  it("keys never contain the address, IP or token they stand for", () => {
    expect(hashedBudgetKey("sso", "203.0.113.9:GET:/v1/auth/oidc/x/init")).toMatch(/^sso:[0-9a-f]{64}$/);
    const key = recipientBudgetKey("secret", "Person@Example.test", 900);
    expect(key).toMatch(/^email-recipient:900:[0-9a-f]{64}$/);
    expect(key).not.toContain("example");
  });

  it("normalizes the address and depends on the secret", () => {
    expect(recipientBudgetKey("secret", "  Person@Example.TEST ", 900)).toBe(recipientBudgetKey("secret", "person@example.test", 900));
    expect(recipientBudgetKey("other", "person@example.test", 900)).not.toBe(recipientBudgetKey("secret", "person@example.test", 900));
  });
});

describe("per-recipient email limits", () => {
  it("is always on in production and opt-in elsewhere", () => {
    expect(emailRecipientLimitsEnabled({ NODE_ENV: "production", AUTH_EMAIL_RECIPIENT_LIMITS: "off" })).toBe(true);
    expect(emailRecipientLimitsEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(emailRecipientLimitsEnabled({ NODE_ENV: "development", AUTH_EMAIL_RECIPIENT_LIMITS: "on" })).toBe(true);
  });

  it("covers every email-sending endpoint but never password sign-in", () => {
    expect([...EMAIL_SENDING_PATHS]).toEqual(expect.arrayContaining(["/email-otp/request-password-reset", "/email-otp/send-verification-otp", "/sign-in/magic-link"]));
    expect(EMAIL_SENDING_PATHS.has("/sign-in/email")).toBe(false);
    const hooked = (enabled: boolean, path: string) => emailRecipientLimiter({ store: createMemoryAuthBudgetStore(), enabled }).plugin.hooks!.before!
      .some((hook) => hook.matcher({ path } as never));
    for (const path of ["/email-otp/request-password-reset", "/email-otp/reset-password", "/sign-in/email-otp"]) {
      expect(hooked(true, path), path).toBe(true);
      expect(hooked(false, path), path).toBe(false);
    }
    expect(hooked(true, "/sign-in/email")).toBe(false);
  });

  it("keeps a targeted lockout short", () => {
    expect(Math.max(...EMAIL_RECIPIENT_BUDGETS.map((budget) => budget.windowSeconds))).toBeLessThanOrEqual(15 * 60);
  });

  it("refunds the address when delivery fails, and only then", async () => {
    const store = createMemoryAuthBudgetStore();
    const release = vi.spyOn(store, "release");
    const { guardDelivery } = emailRecipientLimiter({ store, enabled: true });
    const ctx = { context: { secret: "secret" } };
    await guardDelivery(async () => undefined)({ email: "a@example.test" }, ctx);
    expect(release).not.toHaveBeenCalled();
    const failure = new Error("provider down");
    await expect(guardDelivery(async () => { throw failure; })({ email: "A@Example.test " }, ctx)).rejects.toBe(failure);
    expect(release).toHaveBeenCalledWith(recipientBudgetKey("secret", "a@example.test", EMAIL_RECIPIENT_BUDGETS[0]!.windowSeconds), expect.any(String));
  });
});
