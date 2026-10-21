import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { CommandRunner } from "../tools/runner.js";

export const imageLayoutLabels = ["paragraph", "title", "list", "table", "chart", "photo", "logo", "formula", "caption", "header", "footer", "form", "mind_map", "illustration", "figure", "footnote", "code", "seal", "number", "formula_number", "unknown"] as const;
export type ImageLayoutLabel = typeof imageLayoutLabels[number];
export interface ImageLayoutResult {
  schemaVersion: 1;
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
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected nonempty layout string");
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid source image dimensions");
  return value;
}
/** CLI/service boundary. Malformed output is rejected, never silently repaired. */
export function parseImageLayout(value: unknown): ImageLayoutResult {
  const result = object(value);
  if (result.schemaVersion !== 1 || result.coordinateSpace !== "normalized-source") throw new Error("Unsupported image layout contract/coordinate space");
  if (result.device !== "cpu" && result.device !== "cuda") throw new Error("Unsupported layout device");
  const model = object(result.model);
  const image = object(result.image);
  if (image.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(text(image.sha256))) throw new Error("Invalid source image hash");
  if (model.artifactSha256 !== undefined && !/^[0-9a-f]{64}$/.test(text(model.artifactSha256))) throw new Error("Invalid model artifact hash");
  if (!Array.isArray(result.supportedLabels) || !Array.isArray(result.regions)) throw new Error("Missing layout taxonomy or regions");
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
      if (!Array.isArray(region.polygon) || region.polygon.length < 3) throw new Error("Invalid layout polygon");
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
  return { schemaVersion: 1, model: { id: text(model.id), revision: text(model.revision), ...(model.artifactSha256 ? { artifactSha256: text(model.artifactSha256) } : {}) }, device: result.device,
    image: { width: dimension(image.width), height: dimension(image.height), ...(image.sha256 ? { sha256: text(image.sha256) } : {}) }, coordinateSpace: "normalized-source", supportedLabels, regions, ...(result.diagnostics !== undefined ? { diagnostics: object(result.diagnostics) } : {}) };
}
export interface ImageLayoutCliOptions {
  /** Explicit runtime; never automatically install dependencies or download weights. */
  python: string;
  script: string;
  model: "heron" | "heron-custom" | "ppv3" | "pp-small" | "pp-small-onnx";
  device: "cpu" | "cuda";
  /** Pre-populated Hugging Face cache exposed read-only in the parser sandbox. */
  cacheDirectory: string;
  /** Explicit local model directory (required for pp-small), or optional ONNX export. */
  modelPath?: string;
  revision?: string;
  visualClassifier?: "none" | "siglip2";
  processor?: "slow" | "fast";
  modelSize?: number;
  orientationOnnxPath?: string;
  orientationRevision?: string;
  orientationMinimumScore?: number;
  rectifyPage?: boolean;
  rectifyMaxEdge?: number;
  classifierModelPath?: string;
  onnxPath?: string;
  timeoutMs?: number;
}
/** Opt-in invocation through the worker's bounded, usage-aware parser runner. */
export async function detectImageLayout(input: Buffer, options: ImageLayoutCliOptions, runner: Pick<CommandRunner, "run">, signal?: AbortSignal): Promise<ImageLayoutResult> {
  if (input.byteLength === 0 || input.byteLength > 25 * 1024 * 1024) throw new Error("Layout image payload must be between 1 byte and 25 MiB");
  if (signal?.aborted) throw signal.reason ?? new Error("Layout detection aborted");
  for (const location of [options.python, options.script, options.cacheDirectory, ...[options.modelPath, options.onnxPath, options.classifierModelPath, options.orientationOnnxPath].filter((value): value is string => value !== undefined)]) {
    if (!path.isAbsolute(location)) throw new Error("Layout runtime paths must be absolute");
    await stat(location);
  }
  if (!["cpu", "cuda"].includes(options.device) || !["heron", "heron-custom", "ppv3", "pp-small", "pp-small-onnx"].includes(options.model)) throw new Error("Unsupported layout model/device");
  if (options.model === "heron-custom" && !options.modelPath) throw new Error("heron-custom requires an explicit local modelPath");
  if (options.model === "pp-small" && !options.modelPath) throw new Error("pp-small requires an explicit local modelPath");
  if (options.model === "pp-small-onnx" && !options.onnxPath) throw new Error("pp-small-onnx requires an explicit local onnxPath");
  if (options.modelSize !== undefined && (!Number.isSafeInteger(options.modelSize) || options.modelSize < 32 || options.modelSize > 2048 || options.modelSize % 32 !== 0 || !["heron", "heron-custom", "ppv3"].includes(options.model))) throw new Error("Model size requires a Transformers detector and a multiple of 32 in 32..2048");
  if (options.orientationMinimumScore !== undefined && (typeof options.orientationMinimumScore !== "number" || !Number.isFinite(options.orientationMinimumScore) || options.orientationMinimumScore < 0 || options.orientationMinimumScore > 1)) throw new Error("Invalid orientation minimum score");
  if ((options.orientationRevision !== undefined || options.orientationMinimumScore !== undefined) && !options.orientationOnnxPath) throw new Error("Orientation settings require a local ONNX path");
  if (options.rectifyPage !== undefined && typeof options.rectifyPage !== "boolean") throw new Error("Invalid page rectification flag");
  if (options.rectifyMaxEdge !== undefined && (!options.rectifyPage || !Number.isSafeInteger(options.rectifyMaxEdge) || options.rectifyMaxEdge < 64 || options.rectifyMaxEdge > 4096)) throw new Error("Rectification edge requires enabled rectification and 64..4096 pixels");
  const venvRoot = path.dirname(path.dirname(options.python));
  const runtimeRoots = existsSync(path.join(venvRoot, "pyvenv.cfg")) ? [venvRoot] : [];
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid layout timeout");
  const metadata = await sharp(input, { limitInputPixels: 100_000_000 }).metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("Layout input must be one raster image");
  if (!["png", "jpeg", "webp", "tiff", "gif", "avif", "heif"].includes(metadata.format ?? "")) throw new Error("Unsupported layout raster format");
  const directory = await mkdtemp(path.join(tmpdir(), "docslurp-image-layout-"));
  try {
    const source = path.join(directory, "source.image");
    const output = path.join(directory, "layout.json");
    await writeFile(source, input, { mode: 0o600 });
    await runner.run({ binary: options.python,
      args: [options.script, "--model", options.model, "--device", options.device, "--image", source, "--output", output, ...(options.modelPath ? ["--model-path", options.modelPath] : []), ...(options.revision ? ["--revision", options.revision] : []), ...(options.onnxPath ? ["--onnx-path", options.onnxPath] : []), ...(options.processor ? ["--processor", options.processor] : []), ...(options.modelSize !== undefined ? ["--model-size", String(options.modelSize)] : []), ...(options.orientationOnnxPath ? ["--orientation-onnx-path", options.orientationOnnxPath] : []), ...(options.orientationRevision ? ["--orientation-revision", options.orientationRevision] : []), ...(options.orientationMinimumScore !== undefined ? ["--orientation-minimum-score", String(options.orientationMinimumScore)] : []), ...(options.rectifyPage ? ["--rectify-page"] : []), ...(options.rectifyMaxEdge !== undefined ? ["--rectify-max-edge", String(options.rectifyMaxEdge)] : []), ...(options.visualClassifier ? ["--visual-classifier", options.visualClassifier] : []), ...(options.classifierModelPath ? ["--classifier-model-path", options.classifierModelPath] : [])],
      available: true, pages: 1, timeoutMs,
      bundleRoots: [options.cacheDirectory, path.dirname(options.script), ...runtimeRoots, ...[options.modelPath, options.onnxPath, options.classifierModelPath, options.orientationOnnxPath].filter((value): value is string => value !== undefined)],
      bundleEnv: { HF_HOME: options.cacheDirectory, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1" },
    }, signal);
    if ((await stat(output)).size > 10 * 1024 * 1024) throw new Error("Layout output exceeds 10 MiB");
    const result = parseImageLayout(JSON.parse(await readFile(output, "utf8")));
    if (options.revision && result.model.revision !== options.revision) throw new Error("Layout detector model revision differs from configuration");
    if (result.device !== options.device) throw new Error("Layout detector silently changed requested device");
    if (result.image.width !== metadata.width || result.image.height !== metadata.height) throw new Error("Layout output dimensions do not match source raster");
    const expectedModels = { heron: "docling-project/docling-layout-heron", "heron-custom": "docslurp/heron-custom", ppv3: "PaddlePaddle/PP-DocLayoutV3_safetensors", "pp-small": "PaddlePaddle/PP-DocLayout-S", "pp-small-onnx": "PaddlePaddle/PP-DocLayout-S" };
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
  device: "cpu" | "cuda";
  timeoutMs?: number;
}

/** Warm transport: raw source bytes, one resident model, no temporary files or per-page model load. */
export async function detectImageLayoutAtEndpoint(input: Buffer, options: ImageLayoutEndpointOptions, signal?: AbortSignal): Promise<ImageLayoutResult> {
  const url = new URL(options.endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/layout" || url.search || url.hash) {
    throw new Error("Layout endpoint must be http://127.0.0.1:<port>/layout with no credentials or query");
  }
  if (input.byteLength === 0 || input.byteLength > 25 * 1024 * 1024) throw new Error("Layout image payload must be between 1 byte and 25 MiB");
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("Invalid layout timeout");
  text(options.expectedModelId); text(options.expectedRevision);
  const metadata = await sharp(input, { limitInputPixels: 100_000_000 }).metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("Layout input must be one raster image");
  if (!["png", "jpeg", "webp", "tiff", "gif", "avif", "heif"].includes(metadata.format ?? "")) throw new Error("Unsupported layout raster format");
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(input),
    redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Layout service failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Layout service returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 10 * 1024 * 1024) throw new Error("Layout output exceeds 10 MiB");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = parseImageLayout(raw);
  if (result.device !== options.device) throw new Error("Layout service changed requested device");
  if (options.expectedArtifactSha256 && result.model.artifactSha256 !== options.expectedArtifactSha256) throw new Error("Layout service model artifact hash differs from configuration");
  if (result.model.id !== options.expectedModelId || result.model.revision !== options.expectedRevision) throw new Error("Layout service model identity differs from configuration");
  if (result.image.width !== metadata.width || result.image.height !== metadata.height) throw new Error("Layout output dimensions do not match source raster");
  const sha256 = createHash("sha256").update(input).digest("hex");
  if (object(object(raw).image).sha256 !== sha256) throw new Error("Layout service source hash does not match request");
  result.image.sha256 = sha256;
  return result;
}
