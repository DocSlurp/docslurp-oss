import { runWithEndpointContext } from "@better-auth/core/context";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BREACHED_PASSWORD_PATHS,
  breachedPasswordOutagePolicy,
  breachedPasswordPlugins,
  resolveBreachedPasswordPolicy,
} from "../lib/auth-breached-password.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("breached-password policy", () => {
  it("is on in production and off elsewhere unless configured", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveBreachedPasswordPolicy({ NODE_ENV: "production" })).toEqual({ enabled: true, timeoutMs: 3000 });
    expect(resolveBreachedPasswordPolicy({ NODE_ENV: "test" }).enabled).toBe(false);
    expect(resolveBreachedPasswordPolicy({ NODE_ENV: "development", AUTH_BREACHED_PASSWORD_CHECK: "on" }).enabled).toBe(true);
    expect(resolveBreachedPasswordPolicy({ NODE_ENV: "production", AUTH_BREACHED_PASSWORD_CHECK: "OFF" }).enabled).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("not checked against known breaches"));
  });

  it("fails startup on a misspelt switch or an unbounded deadline", () => {
    expect(() => resolveBreachedPasswordPolicy({ AUTH_BREACHED_PASSWORD_CHECK: "yes" })).toThrow("on or off");
    for (const value of ["0", "100", "60000", "1.5", "soon"]) {
      expect(() => resolveBreachedPasswordPolicy({ AUTH_BREACHED_PASSWORD_TIMEOUT_MS: value }), value).toThrow("500 to 10000");
    }
  });

  it("registers nothing when off, and the native check before its outage policy when on", () => {
    expect(breachedPasswordPlugins({ enabled: false, timeoutMs: 3000 })).toEqual([]);
    expect(breachedPasswordPlugins({ enabled: true, timeoutMs: 3000 }).map((plugin) => plugin.id)).toEqual(["have-i-been-pwned", "docslurp-breached-password-policy"]);
  });

  it("covers every password-storing endpoint and never sign-in", () => {
    expect(BREACHED_PASSWORD_PATHS).toEqual(expect.arrayContaining(["/sign-up/email", "/change-password", "/email-otp/reset-password", "/set-password"]));
    expect(BREACHED_PASSWORD_PATHS.some((path) => path.startsWith("/sign-in"))).toBe(false);
  });
});

describe("breached-password outage policy", () => {
  function wrap(hash: (password: string) => Promise<string>, timeoutMs = 500) {
    const plugin = breachedPasswordOutagePolicy({ enabled: true, timeoutMs });
    const init = plugin.init!({ password: { hash } } as never) as { context: { password: { hash: (password: string) => Promise<string> } } };
    return (path: string | null, password: string) => path
      ? runWithEndpointContext({ path } as never, () => init.context.password.hash(password))
      : init.context.password.hash(password);
  }

  async function refusal(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(APIError);
    return error as APIError & { body: { code?: string } };
  }

  it("passes a compromised-password refusal through unchanged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const compromised = new APIError("BAD_REQUEST", { code: "PASSWORD_COMPROMISED", message: "compromised" });
    const error = await refusal(wrap(async () => { throw compromised; })("/sign-up/email", "pw"));
    expect(error).toBe(compromised);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("turns a failed lookup into a retryable 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = await refusal(wrap(async () => { throw new APIError("INTERNAL_SERVER_ERROR", { message: "Failed to check password. Status: 503" }); })("/email-otp/reset-password", "pw"));
    expect(error.statusCode).toBe(503);
    expect(error.body.code).toBe("PASSWORD_CHECK_UNAVAILABLE");
    expect(error.headers).toMatchObject({ "Retry-After": "60" });
    expect(String(vi.mocked(console.error).mock.calls[0]![0])).toContain("reason=lookup_failed");
  });

  it("enforces the deadline without an unhandled rejection from the abandoned lookup", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let rejectLate: (error: Error) => void = () => undefined;
      const slow = () => new Promise<string>((_, reject) => { rejectLate = reject; });
      const started = Date.now();
      const error = await refusal(wrap(slow, 500)("/change-password", "pw"));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(error.body.code).toBe("PASSWORD_CHECK_UNAVAILABLE");
      expect(String(vi.mocked(console.error).mock.calls[0]![0])).toContain("reason=timeout");
      rejectLate(new Error("late failure"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("leaves hashing on other endpoints, and outside any endpoint, untouched", async () => {
    const failure = new Error("scrypt failed");
    const hash = wrap(async () => { throw failure; });
    await expect(hash("/sign-in/email", "pw")).rejects.toBe(failure);
    await expect(hash(null, "pw")).rejects.toBe(failure);
    await expect(wrap(async (password) => `hashed:${password}`)("/sign-up/email", "pw")).resolves.toBe("hashed:pw");
  });

  it("never logs the password", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await refusal(wrap(async () => { throw new Error("boom"); })("/sign-up/email", "hunter2-secret"));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("hunter2-secret");
  });
});
