import { afterEach, describe, expect, it, vi } from "vitest";

describe("social sign-in", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("asks Google to show its account picker", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    const { auth, configuredSocialProviders } = await import("../lib/better-auth.js");

    expect(configuredSocialProviders.google).toBe(true);
    expect(auth.options.socialProviders?.google).toMatchObject({ prompt: "select_account" });
  });

  it("leaves Google off when its credentials are blank", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", " ");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const { configuredSocialProviders } = await import("../lib/better-auth.js");

    expect(configuredSocialProviders.google).toBe(false);
  });

  it("strips sign-in tokens from account updates", async () => {
    const { auth } = await import("../lib/better-auth.js");
    const before = auth.options.databaseHooks?.account?.update?.before;
    const expiresAt = new Date();

    await expect(before?.({ accessToken: "a", idToken: "i", accessTokenExpiresAt: expiresAt }))
      .resolves.toEqual({ data: { accessToken: null, idToken: null, accessTokenExpiresAt: expiresAt } });
    await expect(before?.({ password: "hash" })).resolves.toEqual({ data: { password: "hash" } });
  });
});
