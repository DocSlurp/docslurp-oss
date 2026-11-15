import { z } from "zod";

/** Client-claimed re-selection identity. This does not prove storage integrity. */
export const uploadContentIdentitySchema = z.object({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type UploadContentIdentity = z.infer<typeof uploadContentIdentitySchema>;
export type UploadTransferState = "complete" | "missing" | "incomplete" | "unavailable";
