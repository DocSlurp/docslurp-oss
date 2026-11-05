import { acceptedGeoSource, geoSchemaFields } from "../db/geo-final-source.js";
import { geoProviderSchema, validateGeoAnnotations } from "@docslurp/shared";
import { resolvePipelineTextModel } from "@docslurp/shared";
import type { Config } from "../config.js";
import { generateOpenRouterText } from "../lib/ai.js";
import { textModelApiKey, textUsageLabels } from "../lib/text-model-route.js";
import { allowHostedCall, openRouterTextCall } from "../lib/privacy-guard.js";
import { measureOp } from "../lib/perf-context.js";
import { buildTrustedDocumentTaskPrompt } from "../lib/trusted-llm-task.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { chargeFeatureForTextRead, cjkCount, textPagesOfText } from "../pipeline/feature-charges.js";
import { isCostCapExceeded } from "../pipeline/checkpoints.js";
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
import { runBounded } from "../lib/bounded-concurrency.js";
import { buildEvidenceIndex, locateEvidence } from "../lib/evidence-locator.js";
import { mergeFieldAnswers, pickField, planStructuredWindows, type RawField } from "../lib/structured-windows.js";
import { readCanonicalDocumentArtifact, readExtractedText } from "./embedding-runtime.js";

/** Characters of document text per model read, and the most reads per document (about 800 pages of prose). */
export const STRUCTURED_WINDOW_CHARS = 100_000;
/** The ceiling on model reads per document; `DOCSLURP_STRUCTURED_MAX_WINDOWS` lowers it (an integer from 1 to this). */
export const STRUCTURED_MAX_WINDOWS = 8;

/** Reads per document this worker allows: the env value when it is an integer in 1..STRUCTURED_MAX_WINDOWS, else the ceiling. */
export function structuredMaxWindows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOCSLURP_STRUCTURED_MAX_WINDOWS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, STRUCTURED_MAX_WINDOWS) : STRUCTURED_MAX_WINDOWS;
}
const STRUCTURED_WINDOW_CONCURRENCY = 3;

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

/**
 * The model's answer for a schema key: the exact key, else (for human-readable
 * labels such as "Vessel Name") the one label whose letters and numbers match,
 * and only when no other schema key could claim it. `請求日` and `支払期限` are
 * different keys; an ASCII-only normalizer reduced both to "" and gave one the
 * other's value.
 */
export function findStructuredField(
  fields: Record<string, RawStructuredField>,
  schemaKey: string,
  schemaKeys?: readonly string[],
): RawStructuredField | undefined {
  return pickField(fields, schemaKey, schemaKeys);
}

function fieldTypeFromJsonSchema(property: Record<string, unknown>): StructuredFieldDef["type"] {
  if (property.format === "geojson") return "geo";
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
        "geo": property["geo"],
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
            if (geoSchemaFields(outputSchema).length && (!state.store?.beginGeoAttempt || !state.run.workspaceId || !state.run.orgId)) {
              throw new Error("Geo extraction requires a scoped persistent store");
            }
            const geoAttempt = geoSchemaFields(outputSchema).length
              ? await state.store!.beginGeoAttempt!(state, document.id, outputSchema) : undefined;
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
            // A recorded artifact that cannot be read is an error to retry, not an empty document.
            const markdownText = markdownArtifactUri
              ? await readExtractedText(this.storage, markdownArtifactUri)
              : "";
            const canonicalDoc: CanonicalDocument | null = canonicalUri
              ? await readCanonicalDocumentArtifact(this.storage, canonicalUri)
              : null;

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
            const fieldKeys = Object.keys(schemaDef.fields);
            // Long documents are read in page windows (map), then each field's answers are
            // merged (reduce). The model never silently sees only the first ~30 pages.
            const plan = planStructuredWindows({
              markdown: markdownText,
              pageCount,
              windowChars: STRUCTURED_WINDOW_CHARS,
              maxWindows: structuredMaxWindows(),
            });
            if (plan.truncated) {
              console.warn(
                `[structured-extract] document=${document.id} truncated=true pagesRead=${plan.pagesRead}/${plan.pagesTotal} windows=${plan.windows.length}`,
              );
            }
            let usageInputTokens = 0;
            let usageOutputTokens = 0;
            let partialEnvelopeSaved = false;
            const windowFields: Array<Record<string, RawStructuredField>> = new Array(plan.windows.length);
            // What the model has read so far: the price follows the text read (3,500 characters a page), window by window, so a
            // window that finished before a later one failed is billed and a retry that re-reads it adds nothing.
            let readChars = 0;
            let readCjk = 0;
            let windowsRead = 0;
            let skippedForCap = 0;
            const documentTextPages = textPagesOfText(markdownText);
            const billRead = (floorPages: boolean) => chargeFeatureForTextRead(state, document, "structuredFields", {
              chars: readChars,
              cjk: readCjk,
              floorPages,
              textPages: documentTextPages,
              ...(plan.truncated || skippedForCap > 0 ? { total: { chars: plan.charsTotal } } : {}),
            });

            const readWindow = async (windowIndex: number) => {
              // The run's cost cap counts this stage's own spend: once it is reached no further window is read.
              if (isCostCapExceeded(state)) {
                skippedForCap += 1;
                return;
              }
              const window = plan.windows[windowIndex]!;
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
                  ...(plan.windows.length > 1
                    ? [{
                        label: "Document part",
                        value: `Excerpt ${windowIndex + 1} of ${plan.windows.length}` +
                          (window.pages.length ? ` (pages ${window.pages[0]}-${window.pages.at(-1)})` : "") +
                          ". Return null for any field this excerpt does not contain; other excerpts are read separately.",
                      }]
                    : []),
                ],
                untrustedContentLabel: "document markdown excerpt",
                untrustedContent: window.text,
                maxContentChars: -1,
              });

              let result: Awaited<ReturnType<typeof generateOpenRouterText>>;
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
                  { metadata: { documentId: document.id, window: windowIndex + 1 } },
                );
              } catch (llmError) {
                console.error(
                  `[extract-error] stage=${this.name} document=${document.id} window=${windowIndex + 1} ` +
                    `llmCallFailed=${toError(llmError).message}`,
                );
                throw llmError;
              }
              windowFields[windowIndex] = parseStructuredFields(result.text || "{}");
              windowsRead += 1;
              readChars += window.text.length;
              readCjk += cjkCount(window.text);
              billRead(false);
              const inputTokens = result.usage.inputTokens;
              const outputTokens = result.usage.outputTokens;
              usageInputTokens += inputTokens;
              usageOutputTokens += outputTokens;
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
                  window: windowIndex + 1,
                  windows: plan.windows.length,
                },
              });
            };
            try {
              await runBounded(plan.windows.length, STRUCTURED_WINDOW_CONCURRENCY, readWindow);
            } catch (error) {
              // The windows that finished were read and are billed (text read, no page floor); the failed one adds nothing.
              billRead(false);
              throw error;
            }
            if (skippedForCap > 0) {
              console.warn(`[structured-extract] document=${document.id} cost cap reached; skipped ${skippedForCap} of ${plan.windows.length} windows`);
            }
            const capTruncated = skippedForCap > 0;

            const fields: Record<string, RawStructuredField> = {};
            for (const k of fieldKeys) {
              const answers = windowFields
                .map((answerSet) => findStructuredField(answerSet, k, fieldKeys))
                .filter((answer): answer is RawStructuredField => answer !== undefined);
              if (answers.length) fields[k] = mergeFieldAnswers(answers as RawField[]) as RawStructuredField;
            }

            // Locate each quotation in the canonical blocks (whitespace-insensitive, may span blocks)
            const evidenceIndex = canonicalDoc ? buildEvidenceIndex(canonicalDoc.blocks) : null;
            const emptyProvenance = () => ({
              pageNumber: null as number | null,
              blockIds: [] as string[],
              regionBoxes: [] as Array<{ pageNumber: number; x: number; y: number; width: number; height: number; polygon: Array<{ x: number; y: number }> }>,
              regionCoordinateSpace: null as string | null,
              pageNumbers: [] as number[],
            });
            function mapEvidence(snippet: string) {
              const found = evidenceIndex && snippet ? locateEvidence(evidenceIndex, snippet) : null;
              const provenance = emptyProvenance();
              for (const block of found ?? []) {
                provenance.blockIds.push(block.id);
                if (block.pageNumber && !provenance.pageNumbers.includes(block.pageNumber)) provenance.pageNumbers.push(block.pageNumber);
                if (block.bbox) {
                  const b = block.bbox;
                  provenance.regionBoxes.push({
                    pageNumber: block.pageNumber ?? 1,
                    x: b.x, y: b.y, width: b.width, height: b.height,
                    polygon: [
                      { x: b.x, y: b.y },
                      { x: b.x + b.width, y: b.y },
                      { x: b.x + b.width, y: b.y + b.height },
                      { x: b.x, y: b.y + b.height },
                    ],
                  });
                }
                if (!provenance.regionCoordinateSpace && typeof block.metadata.bboxCoordinateSpace === "string") {
                  provenance.regionCoordinateSpace = block.metadata.bboxCoordinateSpace;
                }
              }
              // One page only when every block is on it; a quotation across pages has no single page.
              provenance.pageNumber = provenance.pageNumbers.length === 1 ? provenance.pageNumbers[0]! : null;
              return {
                ...provenance,
                regions: provenance.regionBoxes,
                polygons: provenance.regionBoxes.map((box) => box.polygon),
                sourceTrace: {
                  canonicalDocumentUri: canonicalUri,
                  parserArtifactUri: canonicalDoc?.source.parserArtifactUri ?? null,
                  sourceArtifactUri: canonicalDoc?.source.artifactUri ?? null,
                  blockIds: provenance.blockIds,
                  pageNumbers: provenance.pageNumbers,
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
              coverage: {
                windows: plan.windows.length,
                pagesRead: plan.pagesRead,
                pagesTotal: plan.pagesTotal,
                charsRead: capTruncated ? readChars : plan.charsRead,
                charsTotal: plan.charsTotal,
                truncated: plan.truncated || capTruncated,
              },
            };

            for (const k of fieldKeys) {
              const raw = fields[k] ?? { value: null };
              const confidence =
                typeof raw.confidence === "number"
                  ? Math.min(1, Math.max(0, raw.confidence))
                  : 0.5;
              const evText =
                Array.isArray(raw.evidence) && raw.evidence.length > 0
                  ? String(raw.evidence[0].text || "")
                  : "";
              const provenance = mapEvidence(evText);
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
            if (plan.truncated || capTruncated) {
              // A null here may only mean the value is beyond the pages read; never auto-accept such a result.
              const warning = capTruncated
                ? "not found in the windows read before the run's cost cap was reached; the rest of the document was not read"
                : `not found in the first ${plan.pagesRead} of ${plan.pagesTotal} pages read; the rest of the document was not read`;
              for (const field of Object.values(envelope.fields)) {
                if (field.value === null || field.value === undefined) field.errors.push(warning);
              }
              if (overallPolicy === "auto-accept") overallPolicy = "needs-review";
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

            const inputTokens = usageInputTokens;
            const outputTokens = usageOutputTokens;
            // Price card: structured fields per started 10 pages, once per document per run (charged even on a policy
            // reject: the extraction ran), on the text the model read: the document's pages at least, or their share when
            // only part was read, and never fewer than the pages of text read (3,500 characters a page).
            billRead(true);

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
                pagesRead: plan.pagesRead,
                truncated: plan.truncated || capTruncated,
              },
            );

            return {
              geoFinalSource: geoAttempt ? acceptedGeoSource(geoAttempt, outputSchema, envelope) : undefined,
              artifactUri: this.storage.uri(key),
              stats: {
                inputTokens,
                outputTokens,
                fields: Object.keys(envelope.fields).length,
                overallPolicy,
                overallConfidence: envelope.overallConfidence,
                windows: plan.windows.length,
                windowsRead,
                charsRead: readChars,
                pagesRead: plan.pagesRead,
                pagesTotal: plan.pagesTotal,
                truncated: plan.truncated || capTruncated,
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
  const field = (valueSchema: unknown) => ({
    type: "object",
    properties: {
      value: valueSchema && typeof valueSchema === "object" ? { anyOf: [geoProviderSchema(valueSchema), { type: "null" }] } : {},
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
