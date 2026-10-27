import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRunner } from "../tools/runner.js";

export const imageLayoutLabels = ["paragraph", "title", "list", "table", "chart", "photo", "logo", "formula", "caption", "header", "footer", "form", "mind_map", "illustration", "figure", "footnote", "code", "seal", "number", "formula_number", "unknown"] as const;
export type ImageLayoutLabel = typeof imageLayoutLabels[number];
export interface ImageLayoutResult {
  schemaVersion: 1;
  /** Hash of complete detector runtime configuration, distinct from graph identity. */
  inferenceProfileSha256?: string;
  model: { id: string; revision: string; artifactSha256?: string };
  device: "cpu" | "cuda";
  /** Stored raster coordinates: EXIF orientation is not applied. */
  image: { width: number; height: number; sha256?: string };
  coordinateSpace: "normalized-source";
  supportedLabels: ImageLayoutLabel[];
  /** Bounded JSON metadata from the detector, including transforms and actual runtime timing. */
  diagnostics?: Record<string, unknown>;
  regions: Array<{
    label: ImageLayoutLabel;
    rawLabel: string;
    confidence: number;
    /** x0, y0, x1, y1 in source raster coordinates, not resized model input. */
    bbox: [number, number, number, number];
    /** Optional model-native polygon and logical order, in stored source coordinates. */
    polygon?: Array<[number, number]>;
    readingOrder?: number;
    /** Optional geometric coverage and visual crop fingerprint; not semantic identity. */
    imageCoverage?: number;
    coverageKind?: "full-page" | "half-page" | "region";
    fingerprint?: { algorithm: "dhash-64"; value: string };
    exactCropSha256?: string;
    detectorLabel?: ImageLayoutLabel;
    classification?: {
      label: ImageLayoutLabel; candidateLabel: ImageLayoutLabel; score: number; margin: number;
      accepted: boolean; scoreKind: "cosine-similarity-not-probability"; model: string; promptVersion: string;
    };
  }>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected layout object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error("Expected nonempty layout string");
  return value;
}
function label(value: unknown): ImageLayoutLabel {
  if (!imageLayoutLabels.includes(value as ImageLayoutLabel)) throw new Error(`Unsupported layout label: ${String(value)}`);
  return value as ImageLayoutLabel;
}
function unit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Layout coordinate/confidence must be finite in [0,1]");
  return value;
}
function dimension(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 4096) throw new Error("Invalid source image dimensions");
  return value;
}
/** CLI/service boundary. Malformed output is rejected, never silently repaired. */
export function parseImageLayout(value: unknown): ImageLayoutResult {
  const result = object(value);
  if (result.schemaVersion !== 1 || result.coordinateSpace !== "normalized-source") throw new Error("Unsupported image layout contract/coordinate space");
  if (result.device !== "cpu" && result.device !== "cuda") throw new Error("Unsupported layout device");
  if (result.inferenceProfileSha256 !== undefined && !/^[0-9a-f]{64}$/.test(text(result.inferenceProfileSha256))) throw new Error("Invalid inference profile hash");
  const model = object(result.model);
  const image = object(result.image);
  if (image.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(text(image.sha256))) throw new Error("Invalid source image hash");
  if (model.artifactSha256 !== undefined && !/^[0-9a-f]{64}$/.test(text(model.artifactSha256))) throw new Error("Invalid model artifact hash");
  if (!Array.isArray(result.supportedLabels) || !Array.isArray(result.regions)) throw new Error("Missing layout taxonomy or regions");
  if (result.regions.length > 4096 || result.supportedLabels.length > imageLayoutLabels.length) throw new Error("Layout collection exceeds bounds");
  if (dimension(image.width) * dimension(image.height) > 16_000_000) throw new Error("Layout pixels exceed bounds");
  const supportedLabels = [...new Set(result.supportedLabels.map(label))];
  const regions = result.regions.map((entry) => {
    const region = object(entry);
    const kind = label(region.label);
    if (kind !== "unknown" && !supportedLabels.includes(kind)) throw new Error(`Region label ${kind} not declared supported`);
    if (!Array.isArray(region.bbox) || region.bbox.length !== 4) throw new Error("Expected xyxy layout box");
    const bbox = region.bbox.map(unit) as [number, number, number, number];
    if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error("Layout box must have positive area");
    const extras: Pick<ImageLayoutResult["regions"][number], "imageCoverage" | "coverageKind" | "fingerprint" | "exactCropSha256" | "detectorLabel" | "classification" | "polygon" | "readingOrder"> = {};
    if (region.polygon !== undefined) {
      if (!Array.isArray(region.polygon) || region.polygon.length < 3 || region.polygon.length > 128) throw new Error("Invalid layout polygon");
      extras.polygon = region.polygon.map((point) => {
        if (!Array.isArray(point) || point.length !== 2) throw new Error("Invalid layout polygon point");
        return [unit(point[0]), unit(point[1])];
      });
    }
    if (region.readingOrder !== undefined) {
      if (typeof region.readingOrder !== "number" || !Number.isSafeInteger(region.readingOrder) || region.readingOrder < 0) throw new Error("Invalid layout reading order");
      extras.readingOrder = region.readingOrder;
    }
    if (region.imageCoverage !== undefined) extras.imageCoverage = unit(region.imageCoverage);
    if (region.coverageKind !== undefined) {
      if (!["full-page", "half-page", "region"].includes(String(region.coverageKind))) throw new Error("Invalid layout coverage kind");
      extras.coverageKind = region.coverageKind as "full-page" | "half-page" | "region";
    }
    if (region.fingerprint !== undefined) {
      const fingerprint = object(region.fingerprint);
      if (fingerprint.algorithm !== "dhash-64" || !/^[0-9a-f]{16}$/.test(text(fingerprint.value))) throw new Error("Invalid crop fingerprint");
      extras.fingerprint = { algorithm: "dhash-64", value: text(fingerprint.value) };
    }
    if (region.exactCropSha256 !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(text(region.exactCropSha256))) throw new Error("Invalid exact crop hash");
      extras.exactCropSha256 = text(region.exactCropSha256);
    }
    if (region.detectorLabel !== undefined) extras.detectorLabel = label(region.detectorLabel);
    if (region.classification !== undefined) {
      const classified = object(region.classification);
      if (typeof classified.score !== "number" || !Number.isFinite(classified.score) || classified.score < -1.00001 || classified.score > 1.00001 ||
        typeof classified.margin !== "number" || !Number.isFinite(classified.margin) || classified.margin < 0 ||
        typeof classified.accepted !== "boolean" || classified.scoreKind !== "cosine-similarity-not-probability") throw new Error("Invalid visual classification scores");
      extras.classification = { label: label(classified.label), candidateLabel: label(classified.candidateLabel),
        score: classified.score, margin: classified.margin, accepted: classified.accepted,
        scoreKind: "cosine-similarity-not-probability", model: text(classified.model), promptVersion: text(classified.promptVersion) };
      if (extras.classification.label !== kind) throw new Error("Visual classification disagrees with region label");
    }
    return { label: kind, rawLabel: text(region.rawLabel), confidence: unit(region.confidence), bbox, ...extras };
  });
  return { schemaVersion: 1, ...(result.inferenceProfileSha256 ? { inferenceProfileSha256: text(result.inferenceProfileSha256) } : {}), model: { id: text(model.id), revision: text(model.revision), ...(model.artifactSha256 ? { artifactSha256: text(model.artifactSha256) } : {}) }, device: result.device,
    image: { width: dimension(image.width), height: dimension(image.height), ...(image.sha256 ? { sha256: text(image.sha256) } : {}) }, coordinateSpace: "normalized-source", supportedLabels, regions, ...(result.diagnostics !== undefined ? { diagnostics: object(result.diagnostics) } : {}) };
}
export interface ImageLayoutCliOptions {
  model: "heron" | "heron-custom" | "ppv3" | "pp-small" | "pp-small-onnx";
  device: "cpu" | "cuda";
  revision: string;
  artifactSha256: string;
  inferenceProfileSha256: string;
  timeoutMs?: number;
}
/** Opt-in invocation through the worker's bounded, usage-aware parser runner. */
export async function detectImageLayout(input: Buffer, options: ImageLayoutCliOptions, runner: Pick<CommandRunner, "run">, signal?: AbortSignal): Promise<ImageLayoutResult> {
  if (input.byteLength === 0 || input.byteLength > 25 * 1024 * 1024) throw new Error("Layout image payload must be between 1 byte and 25 MiB");
  if (signal?.aborted) throw signal.reason ?? new Error("Layout detection aborted");
  if (options.device !== "cpu") throw new Error("CUDA layout inference is unsupported: dedicated VM runtime is CPU-only");
  if (!options.revision || options.revision === "unknown") throw new Error("Layout VM requires a pinned model revision");
  if (!/^[0-9a-f]{64}$/.test(options.artifactSha256) || !/^[0-9a-f]{64}$/.test(options.inferenceProfileSha256)) throw new Error("Layout VM requires artifact and profile hashes");
  const expectedModels = { heron: "docling-project/docling-layout-heron", "heron-custom": "docslurp/heron-custom", ppv3: "PaddlePaddle/PP-DocLayoutV3_safetensors", "pp-small": "PaddlePaddle/PP-DocLayout-S", "pp-small-onnx": "PaddlePaddle/PP-DocLayout-S" };
  if (!Object.hasOwn(expectedModels, options.model)) throw new Error("Unsupported layout model");
  const timeoutMs = Math.min(options.timeoutMs ?? 60_000, 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid layout timeout");
  const directory = await mkdtemp(path.join(tmpdir(), "docslurp-image-layout-"));
  try {
    const source = path.join(directory, "source.image");
    const output = path.join(directory, "layout.json");
    await writeFile(source, input, { mode: 0o600 });
    await runner.run({ binary: "document-vm-layout", args: [], available: true, timeoutMs,
      documentVm: { operation: "layout", input: source, output, layout: {
        model: options.model, device: "cpu", modelId: expectedModels[options.model], revision: options.revision, artifactSha256: options.artifactSha256, inferenceProfileSha256: options.inferenceProfileSha256,
      } },
    }, signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
    if ((await stat(output)).size > 10 * 1024 * 1024) throw new Error("Layout output exceeds 10 MiB");
    const result = parseImageLayout(JSON.parse(await readFile(output, "utf8")));
    if (options.revision && result.model.revision !== options.revision) throw new Error("Layout detector model revision differs from configuration");
    if (result.device !== options.device) throw new Error("Layout detector silently changed requested device");
    if (result.model.artifactSha256 !== options.artifactSha256 || result.inferenceProfileSha256 !== options.inferenceProfileSha256) throw new Error("Layout VM artifact or profile identity mismatch");
    if (result.model.id !== expectedModels[options.model]) throw new Error("Layout detector model identity differs from configuration");
    const sourceHash = createHash("sha256").update(input).digest("hex");
    if (result.image.sha256 !== sourceHash) throw new Error("Layout detector source hash does not match request");
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface ImageLayoutEndpointOptions {
  /** Resident service is deliberately restricted to literal loopback; redirects are rejected. */
  endpoint: string;
  expectedModelId: string;
  expectedRevision: string;
  expectedArtifactSha256?: string;
  expectedInferenceProfileSha256?: string;
  device: "cpu" | "cuda";
  timeoutMs?: number;
  /** Synchronous accounting hook immediately before HTTP dispatch; throwing prevents dispatch. */
  onRequest?: () => void;
}

/** Warm transport: raw source bytes, one resident model, no temporary files or per-page model load. */
export async function detectImageLayoutAtEndpoint(input: Buffer, options: ImageLayoutEndpointOptions, signal?: AbortSignal): Promise<ImageLayoutResult> {
  if (options.endpoint !== "modal-vm://layout") throw new Error("Layout endpoint must be modal-vm://layout; loopback is not a VM boundary");
  if (options.device !== "cpu") throw new Error("CUDA layout inference is unsupported: dedicated VM runtime is CPU-only");
  const models = { "docling-project/docling-layout-heron": "heron", "docslurp/heron-custom": "heron-custom", "PaddlePaddle/PP-DocLayoutV3_safetensors": "ppv3", "PaddlePaddle/PP-DocLayout-S": "pp-small-onnx" } as const;
  const model = models[options.expectedModelId as keyof typeof models];
  if (!model) throw new Error("Unsupported offline layout model");
  if (!options.expectedRevision || options.expectedRevision === "unknown" || !options.expectedArtifactSha256 || !options.expectedInferenceProfileSha256 || !/^[0-9a-f]{64}$/.test(options.expectedArtifactSha256) || !/^[0-9a-f]{64}$/.test(options.expectedInferenceProfileSha256)) throw new Error("VM layout requires pinned model, artifact and profile identity");
  if (input.length === 0 || input.length > 25 * 1024 * 1024) throw new Error("Layout image payload must be between 1 byte and 25 MiB");
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid layout timeout");
  signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), "docslurp-image-layout-"));
  try {
    const source = path.join(directory, "source.image"), output = path.join(directory, "layout.json");
    await writeFile(source, input, { mode: 0o600 });
    options.onRequest?.();
    const runner = new CommandRunner();
    await runner.run({ binary: "document-vm-layout", args: [], available: true, documentVm: {
      operation: "layout", input: source, output, layout: { model, device: "cpu", modelId: options.expectedModelId, revision: options.expectedRevision,
        artifactSha256: options.expectedArtifactSha256, inferenceProfileSha256: options.expectedInferenceProfileSha256 },
    } }, signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
    if ((await stat(output)).size > 10 * 1024 * 1024) throw new Error("Layout output exceeds 10 MiB");
    const result = parseImageLayout(JSON.parse(await readFile(output, "utf8")));
    if (result.device !== "cpu" || result.model.id !== options.expectedModelId || result.model.revision !== options.expectedRevision || result.model.artifactSha256 !== options.expectedArtifactSha256 || result.inferenceProfileSha256 !== options.expectedInferenceProfileSha256) throw new Error("VM layout model or profile identity mismatch");
    if (result.image.sha256 !== createHash("sha256").update(input).digest("hex")) throw new Error("VM layout source hash mismatch");
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
