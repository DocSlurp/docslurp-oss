import { geoAnnotationSchema, geometryFromAnnotation } from "./geo.js";
import { z } from "zod";
import { layoutPolygonPointSchema, layoutRegionSchema, sourceTraceSchema } from "./layout.js";

// Structured schema definition with validators, examples, and review policies

export const structuredFieldTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "array",
  "object",
  "geo"
]);
export type StructuredFieldType = z.infer<typeof structuredFieldTypeSchema>;

export const evidenceBoxSchema = z.object({
  pageNumber: z.number().int().positive(),
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative()
});
export type EvidenceBox = z.infer<typeof evidenceBoxSchema>;

export const fieldValidatorSchema = z.object({
  // Simple deterministic validators; client may provide any subset
  required: z.boolean().default(false),
  pattern: z.string().optional(), // for strings
  min: z.number().optional(), // for number/integer/date(epoch ms)
  max: z.number().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  // normalizers run before validation
  normalizer: z.enum(["trim", "upper", "lower", "digits-only", "strip-non-alnum", "none"]).default("none"),
  // comparer for schema eval; "exact" or "loose" (case-insensitive/whitespace tolerant)
  compare: z.enum(["exact", "loose"]).default("exact")
});
export type FieldValidator = z.infer<typeof fieldValidatorSchema>;

export const fieldPolicySchema = z.object({
  // Policy thresholds for auto-accept/review/reject decisions
  autoAcceptMinConfidence: z.number().min(0).max(1).default(0.85),
  escalateIfMissing: z.boolean().default(true),
  rejectIfPatternFail: z.boolean().default(false)
});
export type FieldPolicy = z.infer<typeof fieldPolicySchema>;

export const structuredFieldDefSchema = z.object({
  description: z.string().optional(),
  "geo": geoAnnotationSchema.optional(),
  type: structuredFieldTypeSchema,
  validator: fieldValidatorSchema.default({ required: false, normalizer: "none", compare: "exact" }),
  policy: fieldPolicySchema.default({ autoAcceptMinConfidence: 0.85, escalateIfMissing: true, rejectIfPatternFail: false }),
  examples: z.array(z.unknown()).optional()
}).refine(field => field.geo === undefined || field.type === "geo", "Geo mapping requires explicit geo field type");
export type StructuredFieldDef = z.infer<typeof structuredFieldDefSchema>;

export const structuredSchemaDefSchema = z.object({
  name: z.string().min(1),
  version: z.string().default("v1"),
  description: z.string().optional(),
  fields: z.record(z.string(), structuredFieldDefSchema)
});
export type StructuredSchemaDef = z.infer<typeof structuredSchemaDefSchema>;

export const fieldEvidenceSchema = z.object({
  text: z.string().min(1),
  pageNumber: z.number().int().positive().nullable().default(null),
  blockIds: z.array(z.string()).default([]),
  regionBoxes: z.array(evidenceBoxSchema).default([]),
  regions: z.array(layoutRegionSchema).default([]),
  polygons: z.array(z.array(layoutPolygonPointSchema)).default([]),
  regionCoordinateSpace: z.string().nullable().default(null),
  canonicalDocumentUri: z.string().nullable().default(null),
  sourceTrace: sourceTraceSchema.default({
    canonicalDocumentUri: null,
    parserArtifactUri: null,
    sourceArtifactUri: null,
    blockIds: [],
    pageNumbers: [],
    extractor: null
  })
});
export type FieldEvidence = z.infer<typeof fieldEvidenceSchema>;

export const fieldResultSchema = z.object({
  value: z.unknown().nullable(),
  confidence: z.number().min(0).max(1).default(0.5),
  evidence: z.array(fieldEvidenceSchema).default([]),
  policy: z.enum(["auto-accept", "needs-review", "reject"]).default("needs-review"),
  errors: z.array(z.string()).default([])
});
export type FieldResult = z.infer<typeof fieldResultSchema>;

export const structuredResultEnvelopeSchema = z.object({
  schema: structuredSchemaDefSchema.pick({ name: true, version: true }),
  documentId: z.string(),
  canonicalDocumentUri: z.string().nullable().default(null),
  createdAt: z.string(),
  overallConfidence: z.number().min(0).max(1).default(0),
  overallPolicy: z.enum(["auto-accept", "needs-review", "reject"]).default("needs-review"),
  fields: z.record(z.string(), fieldResultSchema)
});
export type StructuredResultEnvelope = z.infer<typeof structuredResultEnvelopeSchema>;

// Utilities

function normalizeValue(value: unknown, validator: FieldValidator): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    let v = value;
    if (validator.normalizer === "trim" || validator.normalizer === "upper" || validator.normalizer === "lower") {
      v = v.trim();
    }
    switch (validator.normalizer) {
      case "upper":
        return v.toUpperCase();
      case "lower":
        return v.toLowerCase();
      case "digits-only":
        return v.replace(/\D+/g, "");
      case "strip-non-alnum":
        return v.replace(/[^a-zA-Z0-9]+/g, "");
      default:
        return v;
    }
  }
  return value;
}

export type ValidationIssue = { field: string; message: string };

export function validateStructuredResult(args: {
  schema: StructuredSchemaDef;
  result: StructuredResultEnvelope;
}): { fieldIssues: Record<string, string[]>; overallPolicy: "auto-accept" | "needs-review" | "reject" } {
  const fieldIssues: Record<string, string[]> = {};
  let worstPolicy: "auto-accept" | "needs-review" | "reject" = "auto-accept";

  for (const [key, def] of Object.entries(args.schema.fields)) {
    const res = args.result.fields[key];
    const issues: string[] = [];
    const validator = def.validator;

    const present = res && res.value !== null && res.value !== undefined && (typeof res.value !== "string" || String(res.value).length > 0);
    if (!present && validator.required) {
      issues.push("required-but-missing");
    }

    const normalized = normalizeValue(res?.value ?? null, validator);

    if (def.type === "string" && typeof normalized === "string") {
      if (validator.pattern) {
        try {
          const re = new RegExp(validator.pattern);
          if (!re.test(normalized)) {
            issues.push("pattern-mismatch");
          }
        } catch {
          // ignore bad regex
        }
      }
      if (validator.enum && !validator.enum.includes(normalized)) {
        issues.push("enum-mismatch");
      }
    }

    if ((def.type === "number" || def.type === "integer") && typeof normalized === "number") {
      if (validator.min !== undefined && normalized < validator.min) issues.push("min-violation");
      if (validator.max !== undefined && normalized > validator.max) issues.push("max-violation");
    }

    if (def.type === "geo" && present) {
      try { geometryFromAnnotation(normalized, def.geo ?? geoAnnotationSchema.parse({ encoding: "geojson" })); }
      catch { issues.push("invalid-geo"); }
    }

    if (def.type === "date") {
      const n = typeof normalized === "number" ? normalized : Date.parse(String(normalized));
      if (Number.isNaN(n)) {
        issues.push("invalid-date");
      } else {
        if (validator.min !== undefined && n < validator.min) issues.push("min-violation");
        if (validator.max !== undefined && n > validator.max) issues.push("max-violation");
      }
    }

    // compute policy per-field
    let fieldPolicy: "auto-accept" | "needs-review" | "reject" = "needs-review";
    const conf = res?.confidence ?? 0;
    if (!present && def.policy.escalateIfMissing) fieldPolicy = "needs-review";
    if (present && issues.length === 0 && conf >= def.policy.autoAcceptMinConfidence) fieldPolicy = "auto-accept";
    if (issues.includes("pattern-mismatch") && def.policy.rejectIfPatternFail) fieldPolicy = "reject";

    // attach issues back
    if (!res) {
      args.result.fields[key] = {
        value: null,
        confidence: 0,
        evidence: [],
        policy: fieldPolicy,
        errors: issues
      };
    } else {
      res.policy = fieldPolicy;
      res.errors = issues;
    }

    if (fieldPolicy === "reject") worstPolicy = "reject";
    else if (fieldPolicy === "needs-review" && worstPolicy !== "reject") worstPolicy = "needs-review";

    if (issues.length > 0) fieldIssues[key] = issues;
  }

  return { fieldIssues, overallPolicy: worstPolicy };
}

export type SchemaEvalCase = {
  documentId: string;
  expected: Record<string, unknown>;
};

export function evaluateSchemaCases(args: {
  schema: StructuredSchemaDef;
  results: StructuredResultEnvelope[];
  cases: SchemaEvalCase[];
}): {
  perField: Record<string, { total: number; correct: number; coverage: number }>;
  accuracy: number;
} {
  const byDoc = new Map<string, StructuredResultEnvelope>(args.results.map((r) => [r.documentId, r]));
  const fieldStats: Record<string, { total: number; correct: number; present: number }> = {};

  for (const c of args.cases) {
    const r = byDoc.get(c.documentId);
    if (!r) continue;
    for (const [field, def] of Object.entries(args.schema.fields)) {
      fieldStats[field] = fieldStats[field] ?? { total: 0, correct: 0, present: 0 };
      fieldStats[field]!.total++;

      const expected = c.expected[field];
      const got = r.fields[field]?.value;
      const validator = def.validator;

      const normalize = (v: unknown) => normalizeValue(v, validator);

      const a = normalize(expected);
      const b = normalize(got);

      const present = b !== null && b !== undefined && (typeof b !== "string" || String(b).length > 0);
      if (present) fieldStats[field]!.present++;

      let equal = false;
      if (validator.compare === "exact") {
        equal = JSON.stringify(a) === JSON.stringify(b);
      } else {
        if (typeof a === "string" && typeof b === "string") {
          equal = a.trim().toLowerCase() === b.trim().toLowerCase();
        } else {
          equal = JSON.stringify(a) === JSON.stringify(b);
        }
      }

      if (equal) fieldStats[field]!.correct++;
    }
  }

  const perField: Record<string, { total: number; correct: number; coverage: number }> = {};
  let correctSum = 0;
  let totalSum = 0;
  for (const [k, v] of Object.entries(fieldStats)) {
    perField[k] = { total: v.total, correct: v.correct, coverage: v.total ? v.present / v.total : 0 };
    correctSum += v.correct;
    totalSum += v.total;
  }

  return { perField, accuracy: totalSum ? correctSum / totalSum : 0 };
}
