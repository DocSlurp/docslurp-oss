import { afterEach, expect, it, vi } from "vitest";
import { realtimeCanaryOrgAllowed, realtimeCanaryOrgIds } from "./rollout-scope.js";
const org = "00000000-0000-4000-8000-000000000001";
afterEach(() => vi.unstubAllEnvs());
it("keeps the existing global flag contract only when no cohort is configured", () => {
  vi.stubEnv("REALTIME_CANARY_ORG_IDS", undefined);
  expect(realtimeCanaryOrgIds()).toBeNull();
  expect(realtimeCanaryOrgAllowed("other")).toBe(true);
});
it.each(["", " ", "*", org + ",", "foreign", Array(17).fill(org).join(","), "a".repeat(2049)])("fails closed for malformed scope %s", value => {
  vi.stubEnv("REALTIME_CANARY_ORG_IDS", value);
  expect(() => realtimeCanaryOrgAllowed(org)).toThrow("realtime_invalid_canary_scope");
});
it("accepts only listed organizations and never a missing organization", () => {
  vi.stubEnv("REALTIME_CANARY_ORG_IDS", ` ${org},${org} `);
  expect(realtimeCanaryOrgIds()).toEqual([org]);
  expect(realtimeCanaryOrgAllowed(org)).toBe(true);
  expect(realtimeCanaryOrgAllowed("00000000-0000-4000-8000-000000000002")).toBe(false);
  expect(realtimeCanaryOrgAllowed(undefined)).toBe(false);
});
