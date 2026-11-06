import type { InitializedParserSandbox } from "../sandbox/startup.js";

/**
 * The first two startup steps, in the only order that works under the service profile: the pricing provider loads, then
 * the parser sandbox is probed. The probe runs a VM command whose provider-cost meter prices it (`pricing()`), which
 * refuses under DOCSLURP_SERVICE_PROFILE=service until a provider is installed (real-Modal validation N2).
 */
export async function loadPricingThenParserSandbox(deps: {
  loadPricing: () => Promise<unknown>;
  initializeParserSandbox: () => Promise<InitializedParserSandbox>;
}): Promise<InitializedParserSandbox> {
  await deps.loadPricing();
  return deps.initializeParserSandbox();
}
