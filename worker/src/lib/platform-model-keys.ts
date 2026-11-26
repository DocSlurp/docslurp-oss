import { DEEPINFRA_VISION_BASE_URL, normalizedModelBaseUrl, OPENROUTER_BASE_URL, platformKeyForDestination } from "@docslurp/shared";

import type { Config } from "../config.js";
import { configuredOpenAiBaseUrl } from "./vision-pricing.js";

/** Providers whose key the worker holds for model calls it sends itself. */
export type PlatformModelProvider = "openai" | "openrouter" | "deepinfra";

/**
 * An operator base URL the key resolver cannot bind a key to: one with user info, a query or a fragment, or not an
 * http(s) URL. Raised instead of sending the request without its key (which would fail later as "key required").
 */
export class PlatformModelBaseUrlError extends Error {
  readonly code = "platform-base-url-unsupported";
  constructor(readonly envVar: string) {
    super(`${envVar} must be a plain http(s) URL with no user info, query or fragment: the provider key is sent only to that exact base URL`);
    this.name = "PlatformModelBaseUrlError";
  }
}

/**
 * The one place a worker model call picks a platform key: the named provider's key, and only when `destination` is
 * that provider's own base URL (same scheme, host, port and path; OpenRouter's and DeepInfra's official endpoints, the
 * operator's `OPENAI_BASE_URL` or api.openai.com). Any other destination, a look-alike host or one a tenant setting
 * named, gets "" (no key). An `OPENAI_BASE_URL` the comparison cannot accept, with an OpenAI key configured, throws
 * `PlatformModelBaseUrlError`.
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
    case "openai": {
      const baseUrl = configuredOpenAiBaseUrl(cfg);
      if (cfg.openAiApiKey?.trim() && normalizedModelBaseUrl(baseUrl) === null) throw new PlatformModelBaseUrlError("OPENAI_BASE_URL");
      return platformKeyForDestination(destination, { baseUrl, key: cfg.openAiApiKey });
    }
    default:
      return "";
  }
}
