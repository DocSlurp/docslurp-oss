import { z } from "zod";
export const configChangeKindSchema = z.enum(["none", "search-only", "new-uploads", "reindex-recommended", "reindex-required"]);
export type ConfigChangeKind = z.infer<typeof configChangeKindSchema>;
