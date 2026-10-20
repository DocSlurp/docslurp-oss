import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openCapabilityToken, resetCapabilityKeyForTests, sealCapabilityToken } from "../lib/capability-tokens.js";
import type { CapabilityClaims } from "@docslurp/shared";

const now = 1_900_000_000_000;
const claims: CapabilityClaims = {
  v: 1, orgId: "org-1", workspaceIds: ["ws-a"], policy: { maxPagesPerQuery: 10 },
  issuedByKeyId: "key-1", exp: Math.floor(now / 1000) + 600, jti: "jti-1",
};

describe("search capability tokens", () => {
  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = "a".repeat(64);
    delete process.env.FILE_TOKEN_SECRET;
    resetCapabilityKeyForTests();
  });

  it("round-trips, hides claims and uses a random IV", () => {
    const token = sealCapabilityToken(claims);
    expect(openCapabilityToken(token, now)).toEqual(claims);
    expect(Buffer.from(token, "base64url").toString("latin1")).not.toContain("org-1");
    expect(sealCapabilityToken(claims)).not.toBe(token);
  });

  it("rejects a flipped byte, truncation, garbage and expiry", () => {
    const raw = Buffer.from(sealCapabilityToken(claims), "base64url");
    for (const index of [0, 20, raw.length - 1]) {
      const copy = Buffer.from(raw);
      copy[index] = copy[index]! ^ 1;
      expect(openCapabilityToken(copy.toString("base64url"), now)).toBeNull();
    }
    expect(openCapabilityToken(raw.subarray(0, 30).toString("base64url"), now)).toBeNull();
    expect(openCapabilityToken("not a token", now)).toBeNull();
    expect(openCapabilityToken(sealCapabilityToken({ ...claims, exp: Math.floor(now / 1000) }), now)).toBeNull();
  });

  it("does not open under a different secret", () => {
    const token = sealCapabilityToken(claims);
    process.env.SECRETS_ENCRYPTION_KEY = "b".repeat(64);
    resetCapabilityKeyForTests();
    expect(openCapabilityToken(token, now)).toBeNull();
  });
});

const actorRef: { current: unknown } = { current: null };
vi.mock("../services/workspaces.js", () => ({
  getWorkspace: vi.fn(async (id: string) => ({ id, orgId: "org-1" })),
  ensureDefaultWorkspace: vi.fn(async () => ({ id: "ws-default", orgId: "org-1" })),
}));
vi.mock("../lib/request-actor.js", async () => {
  const scope = await import("../lib/api-key-workspace-scope.js");
  return {
    getRequestActor: () => actorRef.current,
    actorHasAnyApiKeyScope: (actor: { type: string; apiKey?: { scopes: string[] } }, scopes: string[]) =>
      actor.type === "apiKey" && scopes.some((s) => actor.apiKey!.scopes.includes(s)),
    apiKeyCanUseWorkspace: scope.apiKeyCanUseWorkspace,
  };
});

describe("POST /v1/capabilities", () => {
  const key = (keyType: "server" | "client") => ({
    type: "apiKey", userId: "u1",
    apiKey: { keyId: "key-1", userId: "u1", orgId: "org-1", keyType, scopes: ["search"], workspaceIds: [], allowedDomains: [], rateLimitRpm: 1, rateLimitPpd: 1, rateLimits: [], materializationPolicy: { maxPagesPerQuery: 30 } },
  });
  const post = async (body: unknown) => {
    const { capabilitiesRoutes } = await import("../routes/capabilities.js");
    const app = new Hono().route("/caps", capabilitiesRoutes);
    return app.request("/caps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  };

  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = "a".repeat(64);
    process.env.DOCSLURP_DEFERRED_PROFILES = "1";
    resetCapabilityKeyForTests();
  });

  it("mints for a server key with the effective policy", async () => {
    actorRef.current = key("server");
    const res = await post({ workspaceIds: ["ws-a"], policy: { maxPagesPerQuery: 500 }, ttlSeconds: 600 });
    expect(res.status).toBe(200);
    const json = await res.json() as { token: string; policy: { maxPagesPerQuery: number } };
    expect(json.policy.maxPagesPerQuery).toBe(30);
    const opened = openCapabilityToken(json.token)!;
    expect(opened.issuedByKeyId).toBe("key-1");
    expect(opened.workspaceIds).toEqual(["ws-a"]);
  });

  it("mints for a session as session:<userId>", async () => {
    actorRef.current = { type: "session", userId: "u9" };
    const res = await post({});
    expect(res.status).toBe(200);
    const opened = openCapabilityToken(((await res.json()) as { token: string }).token)!;
    expect(opened.issuedByKeyId).toBe("session:u9");
    expect(opened.workspaceIds).toEqual(["ws-default"]);
  });

  it("rejects capabilities too large to open with 400", async () => {
    actorRef.current = key("server");
    const res = await post({ workspaceIds: ["ws-a"], allowedOrigins: Array.from({ length: 20 }, (_, i) => `https://${"x".repeat(280)}${i}.example`) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { details: { category: string } } }).error.details.category).toBe("capability_too_large");
  });

  it("refuses client keys with 403 and long ttls with 400", async () => {
    actorRef.current = key("client");
    expect((await post({ ttlSeconds: 60 })).status).toBe(403);
    actorRef.current = key("server");
    expect((await post({ ttlSeconds: 7200 })).status).toBe(400);
  });
});
