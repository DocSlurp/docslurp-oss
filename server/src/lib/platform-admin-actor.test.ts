import { expect, it, vi } from "vitest";

const isConfiguredAdminUser = vi.fn(async (_pool: unknown, userId: string) => userId === "admin-user");
vi.mock("./auth.js", () => ({ auth: { api: {} }, appDbPool: {} }));
vi.mock("./admin-emails.js", () => ({ isConfiguredAdminUser }));
const { isPlatformAdminActor } = await import("./request-actor.js");

const key = (userId: string, keyType: "server" | "client") => ({ type: "apiKey" as const, userId,
  apiKey: { keyId: "k", userId, orgId: "org", keyType, allowedDomains: [], scopes: ["search"], rateLimitRpm: 60, rateLimitPpd: 1, rateLimits: [], workspaceIds: [] } });

it("treats ADMIN_EMAILS sessions and their server keys as platform admins, never client keys", async () => {
  expect(await isPlatformAdminActor(undefined)).toBe(false);
  expect(await isPlatformAdminActor({ type: "session", userId: "u", sessionId: "s", user: { id: "u", email: "", name: "", isAdmin: true } })).toBe(true);
  expect(await isPlatformAdminActor({ type: "session", userId: "u", sessionId: "s", user: { id: "u", email: "", name: "" } })).toBe(false);
  expect(await isPlatformAdminActor(key("admin-user", "server"))).toBe(true);
  expect(await isPlatformAdminActor(key("member-user", "server"))).toBe(false);
  expect(await isPlatformAdminActor(key("admin-user", "client"))).toBe(false);
  expect(isConfiguredAdminUser).toHaveBeenCalledTimes(2);
});
