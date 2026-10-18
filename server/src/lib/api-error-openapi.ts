import { z } from "zod";
import { apiErrorEnvelopeSchema } from "@docslurp/shared";

/** `components.schemas.ApiError`: the native error envelope, generated from the shared zod schema. */
export const apiErrorSchema = {
  ...z.toJSONSchema(apiErrorEnvelopeSchema, { unrepresentable: "any" }),
  description: "Native API error envelope. Branch on `error.code` (a closed vocabulary), never on `message`. `details` carries validation `issues` (field paths) and limit metadata such as `retryAfterSeconds` or `maxBytes`. `requestId` identifies the request in support and logs. Protocol surfaces (OpenAI-compatible chat, MCP, OAuth, search compat adapters, Stripe webhook) keep their own error shapes.",
};

/** An error response documented as the `ApiError` envelope; extra `headers` (e.g. Retry-After) are kept. */
export function apiErrorOpenApiResponse(description: string, headers?: Record<string, object>) {
  return {
    description,
    ...(headers ? { headers } : {}),
    content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
  };
}
