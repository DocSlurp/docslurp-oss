import { describe, expect, it, vi } from "vitest";

import { cookieHeaderFromAuthContext, landingPath, parseAttributionCookie, readCookie, recordSignupAttribution } from "../services/signup-attribution.js";

const cookie = (value: unknown) => encodeURIComponent(JSON.stringify(value));

describe("signup attribution cookie", () => {
  it("keeps referrer origin and path, landing path and UTM tags", () => {
    const parsed = parseAttributionCookie(cookie({
      r: "https://news.ycombinator.com/item?id=1&token=secret", l: "/pricing?utm_source=hn&email=a@b.c", t: Date.UTC(2026, 9, 1),
      us: "hn", um: "social", uc: "launch",
    }));
    expect(parsed).toEqual({
      referrerHost: "news.ycombinator.com", referrerUrl: "https://news.ycombinator.com/item", landingPath: "/pricing",
      utmSource: "hn", utmMedium: "social", utmCampaign: "launch", utmTerm: null, utmContent: null,
      firstSeenAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it.each([
    ["absent", undefined],
    ["not JSON", "not-json"],
    ["an array", cookie(["x"])],
    ["oversized", cookie({ us: "x".repeat(4000) })],
    ["empty fields", cookie({ r: "", l: "", t: Date.now() })],
    ["bad URI encoding", "%E0%A4%A"],
  ])("rejects a cookie that is %s", (_label, value) => {
    expect(parseAttributionCookie(value)).toBeNull();
  });

  it("drops hostile values instead of storing them", () => {
    const parsed = parseAttributionCookie(cookie({
      r: "javascript:alert(1)", l: "https://evil.example/landing", t: Date.UTC(2099, 0, 1),
      us: "a\u0000b\r\nc\u202e\u200b", um: "m".repeat(500), uc: 42,
    }));
    expect(parsed).toMatchObject({ referrerHost: null, referrerUrl: null, landingPath: null, firstSeenAt: null, utmSource: "abc", utmCampaign: null });
    expect(parsed?.utmMedium).toHaveLength(128);
  });

  it("reads the named cookie and the auth context header", () => {
    expect(readCookie("a=1; ds_attr=xyz; b=2", "ds_attr")).toBe("xyz");
    expect(readCookie("xds_attr=1", "ds_attr")).toBeNull();
    expect(cookieHeaderFromAuthContext({ headers: new Headers({ cookie: "ds_attr=1" }) })).toBe("ds_attr=1");
    expect(cookieHeaderFromAuthContext({ request: new Request("https://x.test", { headers: { cookie: "c=2" } }) })).toBe("c=2");
    expect(cookieHeaderFromAuthContext(undefined)).toBeNull();
  });

  it("keeps only safe landing paths, never queries or tokens", () => {
    expect(landingPath("/app/invites/abc123token")).toBe("/app");
    expect(landingPath("/api/auth/callback/github?code=x")).toBe("/api");
    expect(landingPath("/oauth/mcp/authorize?request=r")).toBe("/oauth");
    expect(landingPath("/docs/sdk?token=x#y")).toBe("/docs/sdk");
    expect(landingPath("/share/8f3c2a1b9d7e6f5a4b3c2d1e0f9a8b7c")).toBe("/share/:id");
    expect(landingPath("//evil.example/x")).toBeNull();
    expect(landingPath("https://evil.example/x")).toBeNull();
  });

  it("writes once per user and only with analytics consent", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    expect(await recordSignupAttribution({ query }, "u1", null)).toBe(false);
    expect(await recordSignupAttribution({ query }, "u1", `ds_attr=${cookie({ us: "newsletter" })}`)).toBe(false);
    expect(await recordSignupAttribution({ query }, "u1", `docslurp_analytics=denied; ds_attr=${cookie({ us: "newsletter" })}`)).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(await recordSignupAttribution({ query }, "u1", `docslurp_analytics=granted; ds_attr=${cookie({ us: "newsletter" })}`)).toBe(true);
    expect(query.mock.calls[0]![0]).toContain("on conflict (user_id) do nothing");
    expect(query.mock.calls[0]![1]).toEqual(["u1", null, null, null, "newsletter", null, null, null, null, null]);
  });
});
