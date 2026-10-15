import { z } from "zod";

export const layoutPolygonPointSchema = z.object({
  x: z.number(),
  y: z.number()
});
export type LayoutPolygonPoint = z.infer<typeof layoutPolygonPointSchema>;

export const layoutRegionSchema = z.object({
  pageNumber: z.number().int().positive(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  polygon: z.array(layoutPolygonPointSchema).default([])
});
export type LayoutRegion = z.infer<typeof layoutRegionSchema>;

export const sourceTraceSchema = z.object({
  canonicalDocumentUri: z.string().nullable().default(null),
  parserArtifactUri: z.string().nullable().default(null),
  sourceArtifactUri: z.string().nullable().default(null),
  blockIds: z.array(z.string()).default([]),
  pageNumbers: z.array(z.number().int().positive()).default([]),
  extractor: z.string().nullable().default(null)
});
export type SourceTrace = z.infer<typeof sourceTraceSchema>;
