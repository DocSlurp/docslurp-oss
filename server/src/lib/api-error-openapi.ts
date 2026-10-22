import { z } from "zod";
import { apiErrorEnvelopeSchema } from "@docslurp/shared";

/** `components.schemas.ApiError`: the native error envelope, generated from the shared zod schema. */
export const apiErrorSchema = {
  ...z.toJSONSchema(apiErrorEnvelopeSchema, { unrepresentable: "any" }),
  description: "Native API error envelope. Branch on `error.code` (a closed vocabulary), never on `message`. `details` carries validation `issues` (field paths) and limit metadata such as `retryAfterSeconds`, `category`, `policy`, `account` (`starter` or `funded`) or `maxBytes`. On hosted deployments, 402 (credits, budgets) and 429 (rate limits) responses add `details.links` (`billing`, `buyCredits`, `autoTopUp` (only while auto top-up is off), `apiKeys`, `docs`: absolute URLs) and a `Link` header, and the message says where to go. There are no plans: buying credits raises a starter organization to the funded limits. `requestId` identifies the request in support and logs. Protocol surfaces (OpenAI-compatible chat, MCP, OAuth, search compat adapters, Stripe webhook) keep their own error shapes.",
};

/** An error response documented as the `ApiError` envelope; extra `headers` (e.g. Retry-After) are kept. */
export function apiErrorOpenApiResponse(description: string, headers?: Record<string, object>) {
  return {
    description,
    ...(headers ? { headers } : {}),
    content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
  };
}
