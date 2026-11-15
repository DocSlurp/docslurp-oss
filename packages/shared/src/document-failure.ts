import { z } from "zod";

/** Closed public vocabulary. Unknown historical failures never acquire retry advice. */
export const documentFailureSchema = z.object({
  code: z.enum(["source_encrypted", "source_rejected", "capability_unavailable", "infrastructure_unavailable", "processing_failed"]),
  retryable: z.boolean().nullable(),
}).strict();
export type DocumentFailure = z.infer<typeof documentFailureSchema>;

/** Project only reviewed fields, never nested diagnostic data or caller-controlled prose. */
export function publicDocumentFailure(value: unknown): DocumentFailure | null {
  const result = documentFailureSchema.safeParse(value);
  if (!result.success) return null;
  const { code, retryable } = result.data;
  if (code === "processing_failed" && retryable !== null) return null;
  if ((code === "source_encrypted" || code === "source_rejected" || code === "capability_unavailable") && retryable !== false) return null;
  if (code === "infrastructure_unavailable" && retryable !== true) return null;
  return result.data;
}
