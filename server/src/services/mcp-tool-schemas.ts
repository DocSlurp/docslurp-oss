import { z } from "zod";

/** The one place a tool's zod input schema becomes the JSON Schema advertised to clients. */
export function toolInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _draft, ...jsonSchema } = z.toJSONSchema(schema, { io: "input" });
  return jsonSchema;
}
