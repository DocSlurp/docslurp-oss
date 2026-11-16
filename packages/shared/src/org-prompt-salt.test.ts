import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertServerSecretKeyConfig,
  orgPromptSalt,
  orgPromptSaltLine,
  privateChatLayout,
  resetServerSecretKeysForTests,
  serverSecretKey,
  withOrgPromptSalt,
} from "./org-prompt-salt.js";

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerSecretKeysForTests();
});

describe("org prompt salt (the one helper for server and worker)", () => {
  it("is stable within an organization, differs across organizations, and is random without one", () => {
    vi.stubEnv("EVIDENCE_TAG_KEY", "k".repeat(40));
    resetServerSecretKeysForTests();
    const a = orgPromptSalt("org-a");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(orgPromptSalt("org-a")).toBe(a);
    expect(orgPromptSalt(" org-a ")).toBe(a);
    expect(orgPromptSalt("org-b")).not.toBe(a);
    for (const none of [null, undefined, "", "   "]) expect(orgPromptSalt(none)).not.toBe(orgPromptSalt(none));
    expect(orgPromptSaltLine("org-a")).toBe(`Workspace ${a}.`);
    expect(withOrgPromptSalt("org-a", "Rules.")).toBe(`Workspace ${a}.\n\nRules.`);
  });

  it("cannot be computed from the org id: another key gives another salt", () => {
    vi.stubEnv("EVIDENCE_TAG_KEY", "k".repeat(40));
    resetServerSecretKeysForTests();
    const a = orgPromptSalt("org-a");
    vi.stubEnv("EVIDENCE_TAG_KEY", "z".repeat(40));
    resetServerSecretKeysForTests();
    expect(orgPromptSalt("org-a")).not.toBe(a);
  });

  it("derives one key per label from the same secret (evidence tags and salts never share a key)", () => {
    vi.stubEnv("EVIDENCE_TAG_KEY", "k".repeat(40));
    resetServerSecretKeysForTests();
    expect(serverSecretKey("label-a").equals(serverSecretKey("label-a"))).toBe(true);
    expect(serverSecretKey("label-a").equals(serverSecretKey("label-b"))).toBe(false);
  });

  it("ignores a short EVIDENCE_TAG_KEY outside production and refuses it in production, at startup and on use", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
    vi.stubEnv("EVIDENCE_TAG_KEY", "short");
    resetServerSecretKeysForTests();
    const weak = orgPromptSalt("org-a");
    vi.stubEnv("EVIDENCE_TAG_KEY", "");
    resetServerSecretKeysForTests();
    expect(orgPromptSalt("org-a")).toBe(weak); // the short key was ignored: BETTER_AUTH_SECRET was used
    expect(() => assertServerSecretKeyConfig({ EVIDENCE_TAG_KEY: "short", NODE_ENV: "development" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertServerSecretKeyConfig({ EVIDENCE_TAG_KEY: "short", NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/at least 32/);
    expect(() => assertServerSecretKeyConfig({ EVIDENCE_TAG_KEY: "k".repeat(32), NODE_ENV: "production" } as NodeJS.ProcessEnv)).not.toThrow();
    vi.stubEnv("EVIDENCE_TAG_KEY", "short");
    vi.stubEnv("NODE_ENV", "production");
    resetServerSecretKeysForTests();
    expect(() => orgPromptSalt("org-a")).toThrow(/at least 32/);
  });

  it("lays out private chat calls: salt line first, or no system message for a model without the system role", () => {
    vi.stubEnv("EVIDENCE_TAG_KEY", "k".repeat(40));
    resetServerSecretKeysForTests();
    expect(privateChatLayout({}, { orgId: "org-a", system: "Rules.", prompt: "Tenant." }))
      .toEqual({ system: `${orgPromptSaltLine("org-a")}\n\nRules.`, prompt: "Tenant." });
    expect(privateChatLayout({ systemMessage: false }, { orgId: "org-a", system: "Rules.", prompt: "Tenant." }))
      .toEqual({ prompt: "Rules.\n\nTenant." });
    expect(privateChatLayout({ systemMessage: false }, { orgId: "org-a", prompt: "Tenant." })).toEqual({ prompt: "Tenant." });
  });
});
