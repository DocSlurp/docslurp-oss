import { afterEach, describe, expect, it, vi } from "vitest";

import { assertServerSecretKeyConfig, privateChatLayout, resetServerSecretKeysForTests, serverSecretKey } from "./org-prompt-salt.js";

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerSecretKeysForTests();
});

describe("server secret subkeys", () => {
  it("derives one key per label from the same secret, and another secret gives another key", () => {
    vi.stubEnv("EVIDENCE_TAG_KEY", "k".repeat(40));
    resetServerSecretKeysForTests();
    const a = serverSecretKey("label-a");
    expect(serverSecretKey("label-a").equals(a)).toBe(true);
    expect(serverSecretKey("label-b").equals(a)).toBe(false);
    vi.stubEnv("EVIDENCE_TAG_KEY", "z".repeat(40));
    resetServerSecretKeysForTests();
    expect(serverSecretKey("label-a").equals(a)).toBe(false);
  });

  it("ignores a short EVIDENCE_TAG_KEY outside production and refuses it in production, at startup and on use", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
    vi.stubEnv("EVIDENCE_TAG_KEY", "short");
    resetServerSecretKeysForTests();
    const weak = serverSecretKey("label-a");
    vi.stubEnv("EVIDENCE_TAG_KEY", "");
    resetServerSecretKeysForTests();
    expect(serverSecretKey("label-a").equals(weak)).toBe(true); // the short key was ignored: BETTER_AUTH_SECRET was used
    expect(() => assertServerSecretKeyConfig({ EVIDENCE_TAG_KEY: "short", NODE_ENV: "development" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertServerSecretKeyConfig({ EVIDENCE_TAG_KEY: "short", NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/at least 32/);
    expect(() => assertServerSecretKeyConfig({ EVIDENCE_TAG_KEY: "k".repeat(32), NODE_ENV: "production" } as NodeJS.ProcessEnv)).not.toThrow();
    vi.stubEnv("EVIDENCE_TAG_KEY", "short");
    vi.stubEnv("NODE_ENV", "production");
    resetServerSecretKeysForTests();
    expect(() => serverSecretKey("label-a")).toThrow(/at least 32/);
  });
});

describe("private chat layout", () => {
  it("sends instructions as the system message, or in the user turn for a model without the system role, with no salt", () => {
    expect(privateChatLayout({}, { system: "Rules.", prompt: "Tenant." })).toEqual({ system: "Rules.", prompt: "Tenant." });
    expect(privateChatLayout({}, { prompt: "Tenant." })).toEqual({ system: undefined, prompt: "Tenant." });
    expect(privateChatLayout({ systemMessage: false }, { system: "Rules.", prompt: "Tenant." })).toEqual({ prompt: "Rules.\n\nTenant." });
    expect(privateChatLayout({ systemMessage: false }, { prompt: "Tenant." })).toEqual({ prompt: "Tenant." });
  });
});
