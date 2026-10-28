import { describe, expect, it, vi } from "vitest";

import { avatarUrl, GravatarClient, gravatarHash, sanitizeGravatarProfile } from "../services/gravatar.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("gravatar", () => {
  it("hashes the trimmed, lowercased email with SHA-256", () => {
    expect(gravatarHash(" MyEmailAddress@example.com ")).toBe(gravatarHash("myemailaddress@example.com"));
    expect(gravatarHash("a@b.c")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prefers GitHub/Google avatars and falls back to Gravatar for anything else", () => {
    expect(avatarUrl("a@b.c", "https://avatars.githubusercontent.com/u/1?v=4")).toBe("https://avatars.githubusercontent.com/u/1?v=4");
    expect(avatarUrl("a@b.c", "https://lh3.googleusercontent.com/a/x")).toBe("https://lh3.googleusercontent.com/a/x");
    for (const image of [null, "http://avatars.githubusercontent.com/u/1", "https://evil.example/pixel.gif", "https://googleusercontent.com.evil.example/x",
      "https://script.googleusercontent.com/macros/beacon", "https://x:y@lh3.googleusercontent.com/a/x", "javascript:alert(1)"]) {
      expect(avatarUrl("a@b.c", image)).toBe(`https://gravatar.com/avatar/${gravatarHash("a@b.c")}?s=64&d=404`);
    }
  });

  it("keeps only allowlisted, sanitized profile fields", () => {
    const profile = sanitizeGravatarProfile({
      display_name: "Ada‮ Lovelace", location: "London", job_title: "Engineer", company: "Analytical", description: "x".repeat(900),
      profile_url: "javascript:alert(1)", contact_info: { email: "secret@example.com" }, phone: "555",
      verified_accounts: [{ service_label: "GitHub", url: "https://github.com/ada" }, { service_label: "Bad", url: "http://insecure.example" }],
    });
    expect(profile).toMatchObject({ displayName: "Ada Lovelace", location: "London", jobTitle: "Engineer", company: "Analytical", profileUrl: null,
      verifiedAccounts: [{ service: "GitHub", url: "https://github.com/ada" }] });
    expect(profile.description).toHaveLength(500);
    expect(JSON.stringify(profile)).not.toContain("secret@example.com");
    expect(sanitizeGravatarProfile(null).verifiedAccounts).toEqual([]);
  });

  it("does nothing without a key, sends the key as a bearer token and caches results", async () => {
    const fetchImpl = vi.fn(async () => json({ display_name: "Ada" }));
    expect(await new GravatarClient(() => undefined, fetchImpl as never).lookup("a@b.c")).toEqual({ status: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const client = new GravatarClient(() => "key-1", fetchImpl as never);
    expect(await client.lookup("A@b.c")).toMatchObject({ status: "found", profile: { displayName: "Ada" } });
    await client.lookup("a@b.c");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.gravatar.com/v3/profiles/${gravatarHash("a@b.c")}`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer key-1");
    expect(init.redirect).toBe("error");
  });

  it("remembers failures for a minute so retries do not spend the quota", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => json({}, 429));
    const client = new GravatarClient(() => "k", fetchImpl as never, () => now);
    await expect(client.lookup("x@y.z")).rejects.toThrow("HTTP 429");
    await expect(client.lookup("x@y.z")).rejects.toThrow("HTTP 429");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 61_000;
    await expect(client.lookup("x@y.z")).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a missing profile and throws on other failures", async () => {
    expect(await new GravatarClient(() => "k", (async () => json({}, 404)) as never).lookup("x@y.z")).toEqual({ status: "not_found" });
    await expect(new GravatarClient(() => "k", (async () => json({}, 429)) as never).lookup("x@y.z")).rejects.toThrow("HTTP 429");
  });
});
