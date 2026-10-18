import { z } from "zod";

import { aiAdvancedRequestSchema, aiSimpleRequestSchema } from "@docslurp/shared";

export const WORKSPACE_REF_DESCRIPTION = 'Optional workspace slug (e.g. "legal-contracts"), former slug, or UUID. Omit or pass "default" for the organization default workspace.';

// Tool inputs are the request schemas without identity. Cost approval is never
// a tool argument (the request schemas have none, and unknown keys are
// stripped): every surface built from the capability manifest (remote MCP,
// WebMCP, chat, CLI stdio) inherits that from here.
export const aiSimpleToolSchema = aiSimpleRequestSchema.omit({ userId: true }).extend({
  workspaceId: z.string().min(1).max(256).optional().describe(WORKSPACE_REF_DESCRIPTION),
});
export const aiAdvancedToolSchema = aiAdvancedRequestSchema.omit({ userId: true }).extend({
  workspaceId: z.string().min(1).max(256).optional().describe(WORKSPACE_REF_DESCRIPTION),
});

/** The one place a tool's zod input schema becomes the JSON Schema advertised to clients. */
export function toolInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _draft, ...jsonSchema } = z.toJSONSchema(schema, { io: "input" });
  return jsonSchema;
}
