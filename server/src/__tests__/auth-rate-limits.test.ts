import { describe, expect, it } from "vitest";

import {
  createMemoryAuthBudgetStore,
  EMAIL_SENDING_PATHS,
  emailRecipientLimitPlugin,
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
    expect(await store.consume("k", budget)).toEqual({ allowed: false, retryAfterSeconds: 45 });
    now += 45_000;
    expect((await store.consume("k", budget)).allowed).toBe(true);
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
    const plugin = emailRecipientLimitPlugin({ store: createMemoryAuthBudgetStore(), enabled: true });
    const matcher = plugin.hooks!.before![0]!.matcher;
    expect(matcher({ path: "/email-otp/request-password-reset" } as never)).toBe(true);
    expect(matcher({ path: "/sign-in/email" } as never)).toBe(false);
    const disabled = emailRecipientLimitPlugin({ store: createMemoryAuthBudgetStore(), enabled: false });
    expect(disabled.hooks!.before![0]!.matcher({ path: "/email-otp/request-password-reset" } as never)).toBe(false);
  });
});
