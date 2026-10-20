import { z } from "zod";

/** Tags are case-sensitive labels, shared by everyone with access to a document. */
export const documentTagsSchema = z.array(
  z.string().trim().min(1).max(100).refine((tag) => !/[\u0000,]/.test(tag), "Tags cannot contain NUL or commas"),
).max(24).overwrite((tags) => [...new Set(tags)]);
