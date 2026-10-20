import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidatedKey } from "../services/api-keys.js";
import { defaultPipelineFeatures, type CapabilityClaims } from "@docslurp/shared";

const live = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../services/api-keys.js", () => ({ getLiveApiKeyById: live.fn }));

const { resolveMaterializationPolicy, resetIssuerKeyCacheForTests } = await import("../services/materialization-policy.js");
const { sealCapabilityToken, resetCapabilityKeyForTests } = await import("../lib/capability-tokens.js");

const now = 1_900_000_000_000;
const pipeline = defaultPipelineFeatures;
const clientKey = { keyId: "client-1", userId: "u", orgId: "org-1", keyType: "client", allowedDomains: ["a.com"], scopes: ["search"], rateLimitRpm: 1, rateLimitPpd: 1, rateLimits: [], workspaceIds: [] } as ValidatedKey;
const claims = (over: Partial<CapabilityClaims> = {}): CapabilityClaims => ({
  v: 1, orgId: "org-1", workspaceIds: ["ws-a"], policy: {}, issuedByKeyId: "key-1", exp: Math.floor(now / 1000) + 600, jti: "j", ...over,
});
const resolve = (token: string | null, extra: Record<string, unknown> = {}) =>
  resolveMaterializationPolicy({ workspacePipeline: pipeline, apiKey: clientKey, capabilityHeader: token, workspaceId: "ws-a", nowMs: now, ...extra });

describe("resolveMaterializationPolicy", () => {
  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = "a".repeat(64);
    resetCapabilityKeyForTests();
    resetIssuerKeyCacheForTests();
    live.fn.mockReset();
    live.fn.mockResolvedValue({ keyType: "server", scopes: ["search"], workspaceIds: [], materializationPolicy: {} });
  });

  it("uses key-type defaults and narrows by workspace and key", async () => {
    expect(await resolveMaterializationPolicy({ workspacePipeline: pipeline, workspaceId: "w", nowMs: now }))
      .toMatchObject({ policy: { allowFullIndexRequest: true, maxPagesPerQuery: 40 } });
    const narrowed = await resolveMaterializationPolicy({
      workspacePipeline: { ...pipeline, materialization: { maxPagesPerQuery: 20, mapRouter: "auto" } },
      apiKey: { ...clientKey, materializationPolicy: { maxPagesPerQuery: 30, deadlineMs: 5000 } },
      workspaceId: "w", nowMs: now,
    });
    expect(narrowed).toMatchObject({ policy: { maxPagesPerQuery: 20, deadlineMs: 5000, mapRouter: "auto", allowFullIndexRequest: false } });
  });

  it("a token cannot widen a client key", async () => {
    const res = await resolve(sealCapabilityToken(claims({ policy: { maxPagesPerQuery: 500, allowFullIndexRequest: true } })));
    expect(res).toMatchObject({ policy: { maxPagesPerQuery: 40, allowFullIndexRequest: false } });
  });

  it("a token can narrow, and the issuer's own policy applies", async () => {
    live.fn.mockResolvedValue({ keyType: "server", scopes: ["search"], workspaceIds: [], materializationPolicy: { maxPagesPerQuery: 15 } });
    const res = await resolve(sealCapabilityToken(claims({ policy: { maxCreditsPerQuery: 3 } })));
    expect(res).toMatchObject({ policy: { maxPagesPerQuery: 15, maxCreditsPerQuery: 3 } });
  });

  it("rejects bad, expired, wrong-workspace, wrong-origin and mis-bound tokens", async () => {
    expect(await resolve("garbage")).toEqual({ error: "capability_invalid" });
    expect(await resolve(sealCapabilityToken(claims({ exp: Math.floor(now / 1000) - 1 })))).toEqual({ error: "capability_expired" });
    expect(await resolve(sealCapabilityToken(claims()), { workspaceId: "ws-b" })).toEqual({ error: "capability_scope" });
    const origin = sealCapabilityToken(claims({ allowedOrigins: ["https://a.com"] }));
    expect(await resolve(origin, { origin: "https://evil.com" })).toEqual({ error: "capability_origin" });
    expect(await resolve(origin)).toEqual({ error: "capability_origin" });
    expect(await resolve(origin, { origin: "https://a.com/" })).toHaveProperty("policy");
    expect(await resolve(sealCapabilityToken(claims({ boundClientKeyId: "other" })))).toEqual({ error: "capability_scope" });
    expect(await resolve(sealCapabilityToken(claims({ boundClientKeyId: "client-1" })))).toHaveProperty("policy");
  });

  it("rejects a revoked issuer, caches the lookup, and skips it for sessions", async () => {
    live.fn.mockResolvedValue(null);
    const token = sealCapabilityToken(claims());
    expect(await resolve(token)).toEqual({ error: "capability_invalid" });
    live.fn.mockResolvedValue({ keyType: "server", scopes: ["search"], workspaceIds: [], materializationPolicy: {} });
    expect(await resolve(token)).toEqual({ error: "capability_invalid" }); // cached 60 s
    expect(live.fn).toHaveBeenCalledTimes(1);
    expect(await resolve(token, { nowMs: now + 61_000 })).toHaveProperty("policy"); // cache expired, key looked up again
  });

  it("re-checks the issuer's current authority", async () => {
    const token = sealCapabilityToken(claims());
    live.fn.mockResolvedValue({ keyType: "server", scopes: ["ingest"], workspaceIds: [], materializationPolicy: {} });
    expect(await resolve(token)).toEqual({ error: "capability_invalid" });
    resetIssuerKeyCacheForTests();
    live.fn.mockResolvedValue({ keyType: "server", scopes: ["search"], workspaceIds: ["ws-z"], materializationPolicy: {} });
    expect(await resolve(token)).toEqual({ error: "capability_scope" });
    resetIssuerKeyCacheForTests();
    live.fn.mockResolvedValue({ keyType: "client", scopes: ["search"], workspaceIds: [], materializationPolicy: {} });
    expect(await resolve(token)).toEqual({ error: "capability_invalid" });
  });

  it("session-issued capabilities do not look up a key", async () => {
    const res = await resolve(sealCapabilityToken(claims({ issuedByKeyId: "session:u1" })));
    expect(res).toHaveProperty("policy");
    expect(live.fn).not.toHaveBeenCalled();
  });
});
