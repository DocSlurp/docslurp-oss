import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getDevSeedAccountDescriptors,
  isDevSeedQuickLoginEnabled
} from "../lib/better-auth.js";

describe("dev seed quick login", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is enabled automatically in the development environment", () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(isDevSeedQuickLoginEnabled()).toBe(true);
    expect(getDevSeedAccountDescriptors()).toEqual([
      {
        id: "admin",
        label: "Seed admin",
        email: "admin@docslurp.local"
      },
      {
        id: "member",
        label: "Seed member",
        email: "member@docslurp.local"
      }
    ]);
  });

  it.each(["test", "production", "preview", "staging", ""])(
    "stays unavailable when NODE_ENV is %j",
    (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);

      expect(isDevSeedQuickLoginEnabled()).toBe(false);
      expect(getDevSeedAccountDescriptors()).toEqual([]);
    },
  );

  it("uses the configured seed user emails for the dev buttons", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEED_ADMIN_EMAIL", "owner@example.test");
    vi.stubEnv("SEED_MEMBER_EMAIL", "reviewer@example.test");

    expect(getDevSeedAccountDescriptors()).toMatchObject([
      {
        id: "admin",
        email: "owner@example.test"
      },
      {
        id: "member",
        email: "reviewer@example.test"
      }
    ]);
  });
});
