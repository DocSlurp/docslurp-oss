import { afterEach, expect, it, vi } from "vitest";
import { durableChatAdmissionEnabled, realtimeCanaryOrgAllowed, realtimeCanaryOrgIds } from "./rollout-scope.js";
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

it.each([
  ["0",undefined,false],["1",undefined,true],["1","0",false],["1","1",true],
])("combines global opt-in %s with admission policy %s",(master,admission,expected)=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT",master);vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION",admission);
  expect(durableChatAdmissionEnabled()).toBe(expected);
});
it.each(["","false","true","*","1,0"])("fails closed on malformed admission policy %s",value=>{
  vi.stubEnv("DOCSLURP_DURABLE_CHAT_ADMISSION",value);
  expect(()=>durableChatAdmissionEnabled()).toThrow("durable_chat_invalid_admission_policy");
});
