import { DEEPINFRA_VISION_BASE_URL, OPENROUTER_BASE_URL, platformKeyForDestination } from "@docslurp/shared";

import type { Config } from "../config.js";
import { configuredOpenAiBaseUrl } from "./vision-pricing.js";

/** Providers whose key the worker holds for model calls it sends itself. */
export type PlatformModelProvider = "openai" | "openrouter" | "deepinfra";

/**
 * The one place a worker model call picks a platform key: the named provider's key, and only when `destination` is
 * that provider's own origin (OpenRouter's and DeepInfra's official endpoints, the operator's `OPENAI_BASE_URL` or
 * api.openai.com). Any other destination, a look-alike host or one a tenant setting named, gets "" (no key).
 */
export function platformModelKey(
  provider: PlatformModelProvider,
  destination: string | null | undefined,
  cfg: Pick<Config, "openRouterApiKey" | "openAiApiKey" | "deepInfraApiKey" | "openAiBaseUrl">,
): string {
  switch (provider) {
    case "openrouter":
      return platformKeyForDestination(destination, { baseUrl: OPENROUTER_BASE_URL, key: cfg.openRouterApiKey });
    case "deepinfra":
      return platformKeyForDestination(destination, { baseUrl: DEEPINFRA_VISION_BASE_URL, key: cfg.deepInfraApiKey });
    case "openai":
      return platformKeyForDestination(destination, { baseUrl: configuredOpenAiBaseUrl(cfg), key: cfg.openAiApiKey });
    default:
      return "";
  }
}
