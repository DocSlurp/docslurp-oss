import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertEstimateSigningKeyConfigured,
  estimateSigningKey,
  estimateSigningKeySource,
  resetEstimateSigningKeyForTests,
} from "../lib/estimate-signing-key.js";

const DEDICATED = "d".repeat(40);
const SECRETS = "s".repeat(40);
const AUTH = "a".repeat(40);
const FILE = "f".repeat(40);

afterEach(() => {
  resetEstimateSigningKeyForTests();
  vi.restoreAllMocks();
});

describe("estimate signing key", () => {
  it("prefers the dedicated secret, then SECRETS_ENCRYPTION_KEY, BETTER_AUTH_SECRET, FILE_TOKEN_SECRET", () => {
    const all = { DOCSLURP_ESTIMATE_SIGNING_SECRET: DEDICATED, SECRETS_ENCRYPTION_KEY: SECRETS, BETTER_AUTH_SECRET: AUTH, FILE_TOKEN_SECRET: FILE };
    expect(estimateSigningKeySource(all)).toBe("DOCSLURP_ESTIMATE_SIGNING_SECRET");
    expect(estimateSigningKeySource({ ...all, DOCSLURP_ESTIMATE_SIGNING_SECRET: "  " })).toBe("SECRETS_ENCRYPTION_KEY");
    expect(estimateSigningKeySource({ BETTER_AUTH_SECRET: AUTH, FILE_TOKEN_SECRET: FILE })).toBe("BETTER_AUTH_SECRET");
    expect(estimateSigningKeySource({ FILE_TOKEN_SECRET: FILE })).toBe("FILE_TOKEN_SECRET");
    expect(estimateSigningKeySource({})).toBe("random");

    const dedicatedKey = estimateSigningKey(all);
    resetEstimateSigningKeyForTests();
    const fallbackKey = estimateSigningKey({ SECRETS_ENCRYPTION_KEY: SECRETS, BETTER_AUTH_SECRET: AUTH });
    expect(dedicatedKey.equals(fallbackKey)).toBe(false);
  });

  it("refuses a dedicated secret shorter than 32 characters in every environment, without echoing it", () => {
    for (const NODE_ENV of ["production", "development", "test"]) {
      const short = "short-secret-value";
      expect(() => assertEstimateSigningKeyConfigured({ NODE_ENV, DOCSLURP_ESTIMATE_SIGNING_SECRET: short, SECRETS_ENCRYPTION_KEY: SECRETS }))
        .toThrow(/DOCSLURP_ESTIMATE_SIGNING_SECRET must be at least 32 characters/);
      try { assertEstimateSigningKeyConfigured({ NODE_ENV, DOCSLURP_ESTIMATE_SIGNING_SECRET: short }); } catch (error) {
        expect(String((error as Error).message)).not.toContain(short);
      }
    }
  });

  it("refuses to start in production with no stable key, and never hands out a random one there", () => {
    expect(() => assertEstimateSigningKeyConfigured({ NODE_ENV: "production" })).toThrow(/DOCSLURP_ESTIMATE_SIGNING_SECRET is required in production/);
    expect(() => estimateSigningKey({ NODE_ENV: "production" })).toThrow(/required in production/);
    expect(assertEstimateSigningKeyConfigured({ NODE_ENV: "production", DOCSLURP_ESTIMATE_SIGNING_SECRET: DEDICATED })).toBe("DOCSLURP_ESTIMATE_SIGNING_SECRET");
    expect(assertEstimateSigningKeyConfigured({ NODE_ENV: "production", BETTER_AUTH_SECRET: AUTH })).toBe("BETTER_AUTH_SECRET");
  });

  it("falls back to a per-process random key in development, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = estimateSigningKey({ NODE_ENV: "development" });
    expect(first).toHaveLength(32);
    expect(estimateSigningKey({ NODE_ENV: "development" }).equals(first)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/per-process random key/);
    // A fresh process gets another key: signatures do not carry across processes without a secret.
    resetEstimateSigningKeyForTests();
    expect(estimateSigningKey({ NODE_ENV: "development" }).equals(first)).toBe(false);
  });

  it("two instances with the same env produce the same signature", async () => {
    const env = { NODE_ENV: "production", DOCSLURP_ESTIMATE_SIGNING_SECRET: DEDICATED };
    const sign = async () => {
      vi.resetModules();
      const fresh = await import("../lib/estimate-signing-key.js");
      return createHmac("sha256", fresh.estimateSigningKey(env)).update("{\"project\":\"proj-a\",\"credits\":12}").digest("hex");
    };
    const a = await sign();
    const b = await sign();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
    // Different secret, different signature.
    vi.resetModules();
    const other = await import("../lib/estimate-signing-key.js");
    const c = createHmac("sha256", other.estimateSigningKey({ ...env, DOCSLURP_ESTIMATE_SIGNING_SECRET: "e".repeat(40) })).update("{\"project\":\"proj-a\",\"credits\":12}").digest("hex");
    expect(c).not.toBe(a);
  });

  it("never logs the secret value", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    estimateSigningKey({ DOCSLURP_ESTIMATE_SIGNING_SECRET: DEDICATED });
    for (const call of [...log.mock.calls, ...warn.mock.calls]) expect(JSON.stringify(call)).not.toContain(DEDICATED);
  });
});
