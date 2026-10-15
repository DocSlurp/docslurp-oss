import { z } from "zod";
import { citationLocatorSchema } from "./citation-locator.js";
import {
  layoutPolygonPointSchema,
  layoutRegionSchema,
  sourceTraceSchema,
} from "./layout.js";

export const canonicalBlockTypeSchema = z.enum([
  "heading",
  "paragraph",
  "list",
  "table",
  "code",
  "quote",
  "raw",
]);
export type CanonicalBlockType = z.infer<typeof canonicalBlockTypeSchema>;

export const canonicalEvidenceTypeSchema = z.union([
  canonicalBlockTypeSchema,
  z.literal("mixed"),
]);
export type CanonicalEvidenceType = z.infer<typeof canonicalEvidenceTypeSchema>;
export const tableChunkGranularitySchema = z.enum(["table", "row", "cell"]);
export type TableChunkGranularity = z.infer<typeof tableChunkGranularitySchema>;
export const tableCellValueTypeSchema = z.enum([
  "empty",
  "string",
  "number",
  "boolean",
  "date",
  "currency",
  "percentage",
]);
export type TableCellValueType = z.infer<typeof tableCellValueTypeSchema>;
export const tableCellSchema = z.object({
  columnIndex: z.number().int().nonnegative(),
  columnName: z.string(),
  rawValue: z.string(),
  valueType: tableCellValueTypeSchema,
  typedValue: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .default(null),
  pageNumber: z.number().int().positive().nullable().optional(),
  bbox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable()
    .optional(),
  polygon: z.array(layoutPolygonPointSchema).optional(),
  coordinateSpace: z.string().nullable().optional(),
  geometrySource: z
    .enum(["cell", "row", "table", "block-fallback"])
    .nullable()
    .optional(),
});
export type TableCell = z.infer<typeof tableCellSchema>;

export const canonicalBlockSchema = z.object({
  id: z.string(),
  type: canonicalBlockTypeSchema,
  order: z.number().int().nonnegative(),
  text: z.string(),
  headingPath: z.array(z.string()).default([]),
  pageNumber: z.number().int().positive().nullable().default(null),
  lineStart: z.number().int().positive().nullable().default(null),
  lineEnd: z.number().int().positive().nullable().default(null),
  bbox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable()
    .default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CanonicalBlock = z.infer<typeof canonicalBlockSchema>;

export const canonicalDocumentSchema = z.object({
  documentId: z.string(),
  generator: z.string(),
  source: z.object({
    format: z.enum(["markdown", "plain-text", "native-pdf-json"]),
    artifactUri: z.string().nullable().default(null),
    extractor: z.string(),
    parser: z.string().nullable().default(null),
    parserArtifactUri: z.string().nullable().default(null),
  }),
  stats: z.object({
    blockCount: z.number().int().nonnegative(),
    headingCount: z.number().int().nonnegative(),
    paragraphCount: z.number().int().nonnegative(),
    codeBlockCount: z.number().int().nonnegative(),
    tableCount: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
  }),
  blocks: z.array(canonicalBlockSchema),
});
export type CanonicalDocument = z.infer<typeof canonicalDocumentSchema>;

export const searchCitationSchema = z.object({
  /**
   * Precise position of the cited evidence; null when the source type has no finer locator yet.
   * A locator that fails validation degrades to null instead of invalidating the whole citation list.
   */
  locator: citationLocatorSchema.nullable().optional().catch(null),
  source: z.enum(["document", "community_summary", "web"]).default("document"),
  regionBoxes: z.array(layoutRegionSchema).default([]),
  regions: z.array(layoutRegionSchema).default([]),
  regionCoordinateSpace: z.string().nullable().default(null),
  documentId: z.string(),
  filename: z.string(),
  pageNumber: z.number().int().positive().nullable().optional(),
  pageNumbers: z.array(z.number().int().positive()).default([]),
  headingPath: z.array(z.string()),
  chunkIndex: z.number(),
  blockIds: z.array(z.string()).default([]),
  blockTypes: z.array(canonicalBlockTypeSchema).default([]),
  evidenceType: canonicalEvidenceTypeSchema.nullable().optional(),
  canonicalDocumentUri: z.string().nullable().optional(),
  sourceTrace: sourceTraceSchema.optional(),
  tableGranularity: tableChunkGranularitySchema.nullable().optional(),
  tableRowIndex: z.number().int().nonnegative().nullable().optional(),
  tableRowCount: z.number().int().nonnegative().nullable().optional(),
  tableColumnNames: z.array(z.string()).optional(),
  tableColumnTypes: z.array(tableCellValueTypeSchema).optional(),
  tableCells: z.array(tableCellSchema).optional(),
  tableCell: tableCellSchema.nullable().optional(),
});
export type SearchCitation = z.infer<typeof searchCitationSchema>;
