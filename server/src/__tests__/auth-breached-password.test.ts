import { createHash } from "node:crypto";

import { runWithEndpointContext } from "@better-auth/core/context";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BREACHED_PASSWORD_PATHS,
  BreachLookupError,
  breachedPasswordPlugins,
  compromiseCount,
  createBreachLookup,
  resolveBreachedPasswordPolicy,
  type BreachLookup,
} from "../lib/auth-breached-password.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const sha1 = (value: string) => createHash("sha1").update(value).digest("hex").toUpperCase();
const pad = (char: string) => `${"0".repeat(34)}${char}:0`;

describe("breached-password policy", () => {
  it("is on in production and off elsewhere unless configured", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveBreachedPasswordPolicy({ NODE_ENV: "production" })).toEqual({ enabled: true, timeoutMs: 3000, maxInFlight: 32 });
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

  it("covers every password-storing endpoint and never sign-in", () => {
    expect(BREACHED_PASSWORD_PATHS).toEqual(expect.arrayContaining(["/sign-up/email", "/change-password", "/email-otp/reset-password", "/set-password"]));
    expect(BREACHED_PASSWORD_PATHS.some((path) => path.startsWith("/sign-in"))).toBe(false);
    expect(breachedPasswordPlugins({ enabled: false, timeoutMs: 3000, maxInFlight: 32 })).toEqual([]);
  });

  it("reads a range answer strictly", () => {
    const listed = sha1("x").slice(5);
    expect(compromiseCount(`${listed}:3\r\n${pad("A")}`, listed.toLowerCase())).toBe(3);
    expect(compromiseCount(`${pad("A")}\r\n${pad("B")}\r\n`, listed)).toBe(0);
    for (const body of ["", "\r\n", "<html><body>Service Unavailable</body></html>", `${pad("A")}\r\n${listed}:lots`, `${pad("A")}\r\nABC:3`]) {
      expect(() => compromiseCount(body, listed), JSON.stringify(body)).toThrow(BreachLookupError);
    }
  });
});

describe("range lookup", () => {
  it("sends only a padded five-character prefix and detects a listed password", async () => {
    const digest = sha1("hunter2-secret");
    const http = vi.fn(async (_url: string, _init?: RequestInit) => new Response(`${digest.slice(5)}:9\r\n${pad("A")}`));
    vi.stubGlobal("fetch", http);
    expect(await createBreachLookup({ timeoutMs: 1000, maxInFlight: 4 }).isCompromised("hunter2-secret")).toBe(true);
    const [url, init] = http.mock.calls[0]!;
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`);
    expect(new Headers(init!.headers).get("add-padding")).toBe("true");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(http.mock.calls)).not.toContain("hunter2-secret");
  });

  it("aborts the request at the deadline and releases its slot", async () => {
    let aborted = false;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); });
    }));
    const lookup = createBreachLookup({ timeoutMs: 500, maxInFlight: 4 });
    const started = Date.now();
    const attempts = [lookup.isCompromised("a"), lookup.isCompromised("b")];
    expect(lookup.inFlight).toBe(2);
    const results = await Promise.allSettled(attempts);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(results.map((result) => result.status === "rejected" && (result.reason as BreachLookupError).reason)).toEqual(["timeout", "timeout"]);
    expect(aborted).toBe(true);
    expect(lookup.inFlight).toBe(0);
  });

  it("keeps the upstream status and refuses once saturated", async () => {
    vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429 }));
    const error = await createBreachLookup({ timeoutMs: 1000, maxInFlight: 4 }).isCompromised("x").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "upstream_status", upstreamStatus: 429 });

    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    const lookup = createBreachLookup({ timeoutMs: 5000, maxInFlight: 1 });
    void lookup.isCompromised("first").catch(() => undefined);
    await expect(lookup.isCompromised("second")).rejects.toMatchObject({ reason: "saturated" });
  });

  it("treats an empty or HTML 200 as a failed lookup, not a clean one", async () => {
    for (const body of ["", "<html>Gateway</html>"]) {
      vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));
      await expect(createBreachLookup({ timeoutMs: 1000, maxInFlight: 4 }).isCompromised("x"), body).rejects.toMatchObject({ reason: "malformed" });
    }
  });

  it("calls a network failure a network failure", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    await expect(createBreachLookup({ timeoutMs: 1000, maxInFlight: 4 }).isCompromised("x")).rejects.toMatchObject({ reason: "network" });
  });
});

describe("password hash hook", () => {
  function hook(lookup: BreachLookup, hash = async (password: string) => `hashed:${password}`) {
    const [plugin] = breachedPasswordPlugins({ enabled: true, timeoutMs: 1000, maxInFlight: 4 }, lookup);
    const init = plugin!.init!({ password: { hash } } as never) as { context: { password: { hash: (password: string) => Promise<string> } } };
    return (path: string | null, password: string) => path
      ? runWithEndpointContext({ path } as never, () => init.context.password.hash(password))
      : init.context.password.hash(password);
  }
  const lookupThat = (isCompromised: BreachLookup["isCompromised"]): BreachLookup => ({ inFlight: 0, isCompromised });

  async function refusal(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(APIError);
    return error as APIError & { body: { code?: string } };
  }

  it("refuses a breached password with the native code", async () => {
    const error = await refusal(hook(lookupThat(async () => true))("/sign-up/email", "pw"));
    expect(error.statusCode).toBe(400);
    expect(error.body.code).toBe("PASSWORD_COMPROMISED");
  });

  it("turns any lookup failure into a retryable 503 and reports the cause without the password", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = await refusal(hook(lookupThat(async () => { throw new BreachLookupError("upstream_status", 503); }))("/email-otp/reset-password", "hunter2-secret"));
    expect(error.statusCode).toBe(503);
    expect(error.body.code).toBe("PASSWORD_CHECK_UNAVAILABLE");
    expect(error.headers).toMatchObject({ "Retry-After": "60" });
    const logged = String(vi.mocked(console.error).mock.calls[0]![0]);
    expect(logged).toMatch(/reason=upstream_status status=503 duration_ms=\d+ path=\/email-otp\/reset-password/);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("hunter2-secret");
  });

  it("checks before hashing, skips verification-only endpoints, and refuses outside any endpoint", async () => {
    const lookup = vi.fn(async () => false);
    const hash = vi.fn(async (password: string) => `hashed:${password}`);
    const run = hook({ inFlight: 0, isCompromised: lookup }, hash);
    expect(await run("/change-password", "pw")).toBe("hashed:pw");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.invocationCallOrder[0]!).toBeLessThan(hash.mock.invocationCallOrder[0]!);
    expect(await run("/sign-in/email", "pw")).toBe("hashed:pw");
    await expect(run(null, "pw")).rejects.toThrow(/outside a Better Auth endpoint/);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledTimes(2);
  });
});
