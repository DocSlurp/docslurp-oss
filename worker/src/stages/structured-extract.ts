import { validateGeoAnnotations } from "@docslurp/shared";
import { resolvePipelineTextModel } from "@docslurp/shared";
import type { Config } from "../config.js";
import { generateOpenRouterText } from "../lib/ai.js";
import { textModelApiKey, textUsageLabels } from "../lib/text-model-route.js";
import { allowHostedCall, openRouterTextCall } from "../lib/privacy-guard.js";
import { measureOp } from "../lib/perf-context.js";
import { buildTrustedDocumentTaskPrompt } from "../lib/trusted-llm-task.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { chargeDocumentFeature } from "../pipeline/feature-charges.js";
import {
  runDocumentStage,
  runDocuments,
  DocumentStageError,
  emitDocumentPageProgress,
} from "../pipeline/checkpoints.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { CanonicalDocument } from "@docslurp/shared";
import {
  structuredResultEnvelopeSchema,
  structuredSchemaDefSchema,
  type StructuredFieldDef,
  type StructuredSchemaDef,
  type StructuredResultEnvelope,
  validateStructuredResult,
} from "@docslurp/shared";
import { indexableDocuments } from "../pipeline/pii-gate.js";
import { runArtifactRoot } from "../lib/artifact-root.js";

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RawStructuredField = {
  value: unknown;
  confidence?: number;
  evidence?: Array<{ text: string }>;
};

function parseJsonCandidate(rawOutput: string): unknown {
  const trimmed = rawOutput.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Providers occasionally wrap otherwise valid JSON in prose or fences.
    }
  }
  return null;
}

export function parseStructuredFields(
  rawOutput: string,
): Record<string, RawStructuredField> {
  const parsed = parseJsonCandidate(rawOutput);
  if (Array.isArray(parsed)) return parseLabelValueEntries(parsed);
  if (!isRecord(parsed)) return {};
  if (Array.isArray(parsed.fields)) return parseLabelValueEntries(parsed.fields);
  const source = isRecord(parsed.fields) ? parsed.fields : parsed;
  return Object.fromEntries(
    Object.entries(source).map(([key, rawField]) => {
      if (isRecord(rawField) && "value" in rawField) {
        return [key, rawField as RawStructuredField];
      }
      return [key, { value: rawField }];
    }),
  );
}

function parseLabelValueEntries(entries: unknown[]): Record<string, RawStructuredField> {
  return Object.fromEntries(entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const label = [entry.label, entry.name, entry.key, entry.field]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (!label) return [];
    return [[label, {
      value: entry.value ?? entry.text ?? null,
      confidence: typeof entry.confidence === "number" ? entry.confidence : undefined,
      evidence: Array.isArray(entry.evidence)
        ? entry.evidence as Array<{ text: string }>
        : undefined,
    }]];
  }));
}

function normalizedLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findStructuredField(
  fields: Record<string, RawStructuredField>,
  schemaKey: string,
): RawStructuredField | undefined {
  if (fields[schemaKey]) return fields[schemaKey];
  const target = normalizedLabel(schemaKey);
  return Object.entries(fields).find(([label]) => normalizedLabel(label) === target)?.[1];
}

function fieldTypeFromJsonSchema(property: Record<string, unknown>): StructuredFieldDef["type"] {
  if (property.format === "date" || property.format === "date-time") return "date";
  const type = Array.isArray(property.type)
    ? property.type.find((entry) => entry !== "null")
    : property.type;
  if (type === "number" || type === "integer" || type === "boolean" || type === "array" || type === "object") {
    return type;
  }
  return "string";
}

export function structuredSchemaFromJsonSchema(
  schema: Record<string, unknown>,
): StructuredSchemaDef {
  validateGeoAnnotations(schema);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  const fields = Object.fromEntries(
    Object.entries(properties).map(([key, rawProperty]) => {
      const property = isRecord(rawProperty) ? rawProperty : {};
      const enumValues = Array.isArray(property.enum)
        ? property.enum.filter(
            (value): value is string | number | boolean =>
              typeof value === "string" || typeof value === "number" || typeof value === "boolean",
          )
        : undefined;
      return [key, {
        type: fieldTypeFromJsonSchema(property),
        "x-docslurp-geo": property["x-docslurp-geo"],
        description: typeof property.description === "string" ? property.description : undefined,
        validator: {
          required: required.has(key),
          pattern: typeof property.pattern === "string" ? property.pattern : undefined,
          min: typeof property.minimum === "number" ? property.minimum : undefined,
          max: typeof property.maximum === "number" ? property.maximum : undefined,
          enum: enumValues,
          normalizer: "none" as const,
          compare: "exact" as const,
        },
        policy: {
          autoAcceptMinConfidence: 0.85,
          escalateIfMissing: true,
          rejectIfPatternFail: false,
        },
      }];
    }),
  );

  return structuredSchemaDefSchema.parse({
    name: typeof schema.title === "string" && schema.title.trim() ? schema.title : "ad-hoc",
    version: typeof schema.version === "string" && schema.version.trim() ? schema.version : "v1",
    description: typeof schema.description === "string" ? schema.description : undefined,
    fields,
  });
}

export class StructuredExtractStage implements Stage {
  readonly name = "structured-extract";

  constructor(
    private readonly storage: ArtifactStore,
    private readonly config: Config,
  ) {}

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    const outputSchema = state.run.pipeline.outputSchema;
    if (!outputSchema) {
      return;
    }

    const schemaDef = structuredSchemaFromJsonSchema(outputSchema);
    const extractionConfig = { ...state.run.pipeline.structuredExtraction,
      model: state.run.pipeline.structuredExtraction.model ?? resolvePipelineTextModel(state.run.pipeline, "structured-extraction", this.config.textGenerationModel),
    };
    if (!textModelApiKey(this.config.openRouterApiKey, extractionConfig.model)) {
      console.log("structured-extract: skipping, OPENROUTER_API_KEY not set");
      return;
    }
    // Structured extraction only has hosted text models; skip it like a missing key.
    if (!(await allowHostedCall(state, openRouterTextCall("structured-extraction", extractionConfig.model), state.documents.map((document) => document.id)))) {
      return;
    }

    await runDocuments(
      indexableDocuments(state),
      state.docConcurrency,
      async (document) => {
        const artifactSlot = `${document.id}:structured`;
        const key = `${runArtifactRoot(state.run, document.userId)}/structured/${document.id}.json`;

        console.log(
          `[extract-debug] stage=${this.name} document=${document.id} ` +
            `fields=${Object.keys(schemaDef.fields).length}`,
        );

        await runDocumentStage(
          state,
          document,
          this.name,
          artifactSlot,
          "structured extraction complete",
          async () => {
            const pageCount = Math.max(1, document.pageCount);
            await emitDocumentPageProgress(
              state,
              document,
              this.name,
              1,
              pageCount,
              "processing",
            );

            const markdownArtifactUri =
              state.artifactLedger.readDocument(document.id, "markdown");
            const canonicalUri =
              state.artifactLedger.readDocument(document.id, "canonical-document") ?? null;
            let markdownText = "";
            let canonicalDoc: CanonicalDocument | null = null;

            if (markdownArtifactUri) {
              try {
                const k = markdownArtifactUri.replace(/^s3:\/\/[^/]+\//, "");
                const bytes = await this.storage.getBytes(k);
                const raw = bytes.toString("utf8");
                if (markdownArtifactUri.endsWith(".json")) {
                  const parsed = JSON.parse(raw) as {
                    textArtifactUri?: string;
                  };
                  if (parsed.textArtifactUri) {
                    const textKey = parsed.textArtifactUri.replace(
                      /^s3:\/\/[^/]+\//,
                      "",
                    );
                    const textBytes = await this.storage.getBytes(textKey);
                    markdownText = textBytes.toString("utf8");
                  }
                } else {
                  markdownText = raw;
                }
              } catch {
                markdownText = "";
              }
            }

            if (canonicalUri) {
              try {
                const k = canonicalUri.replace(/^s3:\/\/[^/]+\//, "");
                const bytes = await this.storage.getBytes(k);
                canonicalDoc = JSON.parse(
                  bytes.toString("utf8"),
                ) as CanonicalDocument;
              } catch {
                canonicalDoc = null;
              }
            }

            console.log(
              `[extract-debug] document=${document.id} markdownLength=${markdownText.length} ` +
                `canonicalAvailable=${canonicalDoc !== null}`,
            );

            if (!markdownText) {
              console.log(
                `[extract-debug] document=${document.id} skipped=no-markdown`,
              );
              return {
                artifactUri: "",
                stats: { skipped: true, reason: "no-markdown" },
              };
            }

            const schemaDescription = JSON.stringify(outputSchema, null, 2);
            const task = buildTrustedDocumentTaskPrompt({
              instruction: [
                "Extract structured fields from document text.",
                extractionConfig.supportingPrompt,
              ].filter(Boolean).join("\n\n"),
              outputContract: `Return ONLY JSON with this shape:
{
  "fields": {
    "<schemaFieldName>": { "value": <any or null>, "confidence": <0..1>, "evidence": [{ "text": "verbatim snippet from source" }] }
  }
}
Do not include explanations. Use short evidence snippets that appear verbatim in the document.`,
              trustedContext: [
                {
                  label: "Schema (JSON describing required fields)",
                  value: schemaDescription,
                },
              ],
              untrustedContentLabel: "document markdown excerpt",
              untrustedContent: markdownText,
            });

            let result: { text: string; usage: { inputTokens: number; outputTokens: number; costCents?: number; metadata?: Record<string, unknown> } } | null = null;
            let partialEnvelopeSaved = false;

            try {
              result = await measureOp(
                "structured-extract-llm-latency",
                () =>
                  generateOpenRouterText({
                    operation: "structured-extraction",
                    apiKey: textModelApiKey(this.config.openRouterApiKey, extractionConfig.model),
                    privacyMode: state.run.pipeline.privacyMode,
                    model: extractionConfig.model,
                    responseJsonSchema: { name: "structured_fields", schema: buildStructuredFieldsEnvelopeSchema(outputSchema) },
                    maxOutputTokens: extractionConfig.maxOutputTokens,
                    textGeneration: state.run.pipeline.textGeneration,
                    deploymentProfile: this.config.textGenerationProfile,
                    system: task.system,
                    prompt: task.prompt,
                    signal,
                  }),
                { metadata: { documentId: document.id } },
              );
            } catch (llmError) {
              console.error(
                `[extract-error] stage=${this.name} document=${document.id} ` +
                  `llmCallFailed=${toError(llmError).message}`,
              );
              throw llmError;
            }

            const rawOutput = result.text || "{}";

            // Coerce the model response into an envelope we control
            const fields = parseStructuredFields(rawOutput);

            // Map evidence snippets to canonical blocks for provenance where possible
            function mapEvidence(snippet: string): {
              pageNumber: number | null;
              blockIds: string[];
              regionBoxes: Array<{
                pageNumber: number;
                x: number;
                y: number;
                width: number;
                height: number;
                polygon: Array<{ x: number; y: number }>;
              }>;
              regions: Array<{
                pageNumber: number;
                x: number;
                y: number;
                width: number;
                height: number;
                polygon: Array<{ x: number; y: number }>;
              }>;
              polygons: Array<Array<{ x: number; y: number }>>;
              regionCoordinateSpace: string | null;
              sourceTrace: {
                canonicalDocumentUri: string | null;
                parserArtifactUri: string | null;
                sourceArtifactUri: string | null;
                blockIds: string[];
                pageNumbers: number[];
                extractor: string | null;
              };
            } {
              if (!canonicalDoc || !snippet) {
                return {
                  pageNumber: null,
                  blockIds: [],
                  regionBoxes: [],
                  regions: [],
                  polygons: [],
                  regionCoordinateSpace: null,
                  sourceTrace: {
                    canonicalDocumentUri: canonicalUri,
                    parserArtifactUri:
                      canonicalDoc?.source.parserArtifactUri ?? null,
                    sourceArtifactUri: canonicalDoc?.source.artifactUri ?? null,
                    blockIds: [],
                    pageNumbers: [],
                    extractor: canonicalDoc?.source.extractor ?? null,
                  },
                };
              }
              const lowered = snippet.slice(0, 160).toLowerCase();
              for (const block of canonicalDoc.blocks) {
                if (!block.text) continue;
                if ((block.text as string).toLowerCase().includes(lowered)) {
                  const boxes = (block.bbox ? [block.bbox] : []).map((b) => ({
                    pageNumber: block.pageNumber ?? 1,
                    x: b.x,
                    y: b.y,
                    width: b.width,
                    height: b.height,
                    polygon: [
                      { x: b.x, y: b.y },
                      { x: b.x + b.width, y: b.y },
                      { x: b.x + b.width, y: b.y + b.height },
                      { x: b.x, y: b.y + b.height },
                    ],
                  }));
                  return {
                    pageNumber: block.pageNumber ?? null,
                    blockIds: [block.id],
                    regionBoxes: boxes,
                    regions: boxes,
                    polygons: boxes.map((box) => box.polygon),
                    regionCoordinateSpace:
                      typeof block.metadata.bboxCoordinateSpace === "string"
                        ? block.metadata.bboxCoordinateSpace
                        : null,
                    sourceTrace: {
                      canonicalDocumentUri: canonicalUri,
                      parserArtifactUri:
                        canonicalDoc.source.parserArtifactUri ?? null,
                      sourceArtifactUri:
                        canonicalDoc.source.artifactUri ?? null,
                      blockIds: [block.id],
                      pageNumbers: block.pageNumber ? [block.pageNumber] : [],
                      extractor: canonicalDoc.source.extractor ?? null,
                    },
                  };
                }
              }
              return {
                pageNumber: null,
                blockIds: [],
                regionBoxes: [],
                regions: [],
                polygons: [],
                regionCoordinateSpace: null,
                sourceTrace: {
                  canonicalDocumentUri: canonicalUri,
                  parserArtifactUri:
                    canonicalDoc?.source.parserArtifactUri ?? null,
                  sourceArtifactUri: canonicalDoc?.source.artifactUri ?? null,
                  blockIds: [],
                  pageNumbers: [],
                  extractor: canonicalDoc?.source.extractor ?? null,
                },
              };
            }

            const envelope: StructuredResultEnvelope = {
              schema: {
                name: schemaDef.name,
                version: schemaDef.version,
              },
              documentId: document.id,
              canonicalDocumentUri: canonicalUri,
              createdAt: new Date().toISOString(),
              overallConfidence: 0,
              overallPolicy: "needs-review",
              fields: {},
            };

            const fieldKeys = Object.keys(schemaDef.fields);
            for (const k of fieldKeys) {
              const raw = findStructuredField(fields, k) ?? { value: null };
              const confidence =
                typeof raw.confidence === "number"
                  ? Math.min(1, Math.max(0, raw.confidence))
                  : 0.5;
              const evText =
                Array.isArray(raw.evidence) && raw.evidence.length > 0
                  ? String(raw.evidence[0].text || "")
                  : "";
              const provenance = evText
                ? mapEvidence(evText)
                : {
                    pageNumber: null,
                    blockIds: [],
                    regionBoxes: [],
                    regions: [],
                    polygons: [],
                    regionCoordinateSpace: null,
                    sourceTrace: {
                      canonicalDocumentUri: canonicalUri,
                      parserArtifactUri:
                        canonicalDoc?.source.parserArtifactUri ?? null,
                      sourceArtifactUri:
                        canonicalDoc?.source.artifactUri ?? null,
                      blockIds: [],
                      pageNumbers: [],
                      extractor: canonicalDoc?.source.extractor ?? null,
                    },
                  };
              envelope.fields[k] = {
                value: (raw as any).value ?? null,
                confidence,
                evidence: evText
                  ? [
                      {
                        text: evText,
                        pageNumber: provenance.pageNumber,
                        blockIds: provenance.blockIds,
                        regionBoxes: provenance.regionBoxes,
                        regions: provenance.regions,
                        polygons: provenance.polygons,
                        regionCoordinateSpace: provenance.regionCoordinateSpace,
                        canonicalDocumentUri: canonicalUri,
                        sourceTrace: provenance.sourceTrace,
                      },
                    ]
                  : [],
                policy: "needs-review",
                errors: [],
              };
            }

            // Validate and compute policies
            let overallPolicy: "needs-review" | "reject" | "auto-accept" = "needs-review";
            let fieldIssues: Record<string, string[]> = {};
            try {
              const validation = validateStructuredResult({
                schema: schemaDef,
                result: envelope,
              });
              overallPolicy = validation.overallPolicy;
              fieldIssues = validation.fieldIssues;
            } catch (validationError) {
              console.error(
                `[extract-error] stage=${this.name} document=${document.id} ` +
                  `validationFailed=${toError(validationError).message}`,
              );
            }
            envelope.overallPolicy = overallPolicy;
            const confidences = Object.values(envelope.fields).map(
              (f) => f.confidence ?? 0,
            );
            envelope.overallConfidence = confidences.length
              ? confidences.reduce((a, b) => a + b, 0) / confidences.length
              : 0;

            // Save partial envelope early so we have usable data even if later steps fail
            try {
              await this.storage.putJson(
                key,
                structuredResultEnvelopeSchema.parse(envelope),
              );
              partialEnvelopeSaved = true;
              console.log(
                `[extract-debug] document=${document.id} envelopeSaved ` +
                  `fields=${fieldKeys.length} policy=${overallPolicy} ` +
                  `confidence=${envelope.overallConfidence.toFixed(3)}`,
              );
            } catch (storageError) {
              console.error(
                `[extract-error] stage=${this.name} document=${document.id} ` +
                  `envelopeStorageFailed=${toError(storageError).message}`,
              );
            }

            const inputTokens = result.usage.inputTokens;
            const outputTokens = result.usage.outputTokens;
            state.usageLedger.record({
              ...textUsageLabels(extractionConfig.model),
              metric: "structured-extract",
              amount: inputTokens + outputTokens,
              unit: "token",
              costCents: result.usage.costCents ?? (
                (inputTokens / 1000) * this.config.costPer1kInputTokens +
                  (outputTokens / 1000) * this.config.costPer1kOutputTokens
              ),
              inputTokens,
              outputTokens,
              metadata: {
                ...result.usage.metadata,
                documentId: document.id,
                overallPolicy,
              },
            });
            // Price card: structured fields per started 10 pages, once per document per run
            // (charged even on a policy reject: the extraction ran).
            chargeDocumentFeature(state, document, "structuredFields");

            // Fail the stage on hard reject so it enters the review queue with schema_errors
            if (overallPolicy === "reject") {
              throw new DocumentStageError(
                "structured-extract: policy reject",
                {
                  artifactUri: this.storage.uri(key),
                  stats: { overallPolicy, fieldIssues },
                },
              );
            }

            await emitDocumentPageProgress(
              state,
              document,
              this.name,
              pageCount,
              pageCount,
              "completed",
              {
                inputTokens,
                outputTokens,
                overallPolicy,
                overallConfidence: envelope.overallConfidence,
              },
            );

            return {
              artifactUri: this.storage.uri(key),
              stats: {
                inputTokens,
                outputTokens,
                fields: Object.keys(envelope.fields).length,
                overallPolicy,
                overallConfidence: envelope.overallConfidence,
              },
            };
          },
          signal,
        );
      },
    );
  }
}

/**
 * JSON schema for the `{ fields: { <name>: { value, confidence, evidence } } }`
 * envelope the extraction prompt asks for, built from the workspace schema's
 * own property names and value schemas at runtime.
 */
export function buildStructuredFieldsEnvelopeSchema(outputSchema: Record<string, unknown>): Record<string, unknown> {
  const properties = outputSchema.properties && typeof outputSchema.properties === "object" && !Array.isArray(outputSchema.properties)
    ? outputSchema.properties as Record<string, unknown>
    : {};
  const names = Object.keys(properties);
  // Provider schema is disposable; never mutate authoritative annotation metadata.
  const providerCopy = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(providerCopy);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "x-docslurp-geo").map(([key, child]) => [key, providerCopy(child)]));
    return value;
  };
  const field = (valueSchema: unknown) => ({
    type: "object",
    properties: {
      value: valueSchema && typeof valueSchema === "object" ? { anyOf: [providerCopy(valueSchema), { type: "null" }] } : {},
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidence: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    },
    required: ["value", "confidence", "evidence"],
  });
  return {
    type: "object",
    properties: {
      fields: { type: "object", properties: Object.fromEntries(names.map((name) => [name, field(properties[name])])), required: names },
    },
    required: ["fields"],
  };
}
