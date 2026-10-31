import { runWithProviderRateScope } from "../lib/provider-rate-limit.js";

/**
 * Runs `fn` the way a run of an organization with China-based providers allowed (the default) does. Outside a
 * provider scope the worker restricts every call (unknown scope fails closed), so tests of default routing use this.
 */
export function inAllowingRun<T>(fn: () => Promise<T>): Promise<T> {
  return runWithProviderRateScope({ orgId: "org-test", allowChinaProviders: true }, fn);
}
