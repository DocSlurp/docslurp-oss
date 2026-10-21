import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { CommandRunner } from "../tools/runner.js";

export const imageLayoutLabels = ["paragraph", "title", "list", "table", "chart", "photo", "logo", "formula", "caption", "header", "footer", "form", "mind_map", "illustration", "figure", "footnote", "code", "seal", "number", "formula_number", "unknown"] as const;
export type ImageLayoutLabel = typeof imageLayoutLabels[number];
export interface ImageLayoutResult {
  schemaVersion: 1;
  model: { id: string; revision: string };
  device: "cpu" | "cuda";
  /** Stored raster coordinates: EXIF orientation is not applied. */
  image: { width: number; height: number; sha256?: string };
  coordinateSpace: "normalized-source";
  supportedLabels: ImageLayoutLabel[];
  regions: Array<{
    label: ImageLayoutLabel;
    rawLabel: string;
    confidence: number;
    /** x0, y0, x1, y1 in source raster coordinates, not resized model input. */
    bbox: [number, number, number, number];
    /** Optional geometric coverage and visual crop fingerprint; not semantic identity. */
    imageCoverage?: number;
    coverageKind?: "full-page" | "half-page" | "region";
    fingerprint?: { algorithm: "dhash-64"; value: string };
    exactCropSha256?: string;
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
  if (!Array.isArray(result.supportedLabels) || !Array.isArray(result.regions)) throw new Error("Missing layout taxonomy or regions");
  const supportedLabels = [...new Set(result.supportedLabels.map(label))];
  const regions = result.regions.map((entry) => {
    const region = object(entry);
    const kind = label(region.label);
    if (kind !== "unknown" && !supportedLabels.includes(kind)) throw new Error(`Region label ${kind} not declared supported`);
    if (!Array.isArray(region.bbox) || region.bbox.length !== 4) throw new Error("Expected xyxy layout box");
    const bbox = region.bbox.map(unit) as [number, number, number, number];
    if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error("Layout box must have positive area");
    const extras: Pick<ImageLayoutResult["regions"][number], "imageCoverage" | "coverageKind" | "fingerprint" | "exactCropSha256"> = {};
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
    return { label: kind, rawLabel: text(region.rawLabel), confidence: unit(region.confidence), bbox, ...extras };
  });
  return { schemaVersion: 1, model: { id: text(model.id), revision: text(model.revision) }, device: result.device,
    image: { width: dimension(image.width), height: dimension(image.height) }, coordinateSpace: "normalized-source", supportedLabels, regions };
}
export interface ImageLayoutCliOptions {
  /** Explicit runtime; never automatically install dependencies or download weights. */
  python: string;
  script: string;
  model: "heron" | "ppv3" | "pp-small" | "pp-small-onnx";
  device: "cpu" | "cuda";
  /** Pre-populated Hugging Face cache exposed read-only in the parser sandbox. */
  cacheDirectory: string;
  /** Explicit local model directory (required for pp-small), or optional ONNX export. */
  modelPath?: string;
  onnxPath?: string;
  timeoutMs?: number;
}
/** Opt-in invocation through the worker's bounded, usage-aware parser runner. */
export async function detectImageLayout(input: Buffer, options: ImageLayoutCliOptions, runner: Pick<CommandRunner, "run">, signal?: AbortSignal): Promise<ImageLayoutResult> {
  if (signal?.aborted) throw signal.reason ?? new Error("Layout detection aborted");
  for (const location of [options.python, options.script, options.cacheDirectory, ...[options.modelPath, options.onnxPath].filter((value): value is string => value !== undefined)]) {
    if (!path.isAbsolute(location)) throw new Error("Layout runtime paths must be absolute");
    await stat(location);
  }
  if (!["cpu", "cuda"].includes(options.device) || !["heron", "ppv3", "pp-small", "pp-small-onnx"].includes(options.model)) throw new Error("Unsupported layout model/device");
  if (options.model === "pp-small" && !options.modelPath) throw new Error("pp-small requires an explicit local modelPath");
  if (options.model === "pp-small-onnx" && !options.onnxPath) throw new Error("pp-small-onnx requires an explicit local onnxPath");
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
      args: [options.script, "--model", options.model, "--device", options.device, "--image", source, "--output", output, ...(options.modelPath ? ["--model-path", options.modelPath] : []), ...(options.onnxPath ? ["--onnx-path", options.onnxPath] : [])],
      available: true, pages: 1, timeoutMs,
      bundleRoots: [options.cacheDirectory, path.dirname(options.script), ...[options.modelPath, options.onnxPath].filter((value): value is string => value !== undefined)],
      bundleEnv: { HF_HOME: options.cacheDirectory, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1" },
    }, signal);
    if ((await stat(output)).size > 10 * 1024 * 1024) throw new Error("Layout output exceeds 10 MiB");
    const result = parseImageLayout(JSON.parse(await readFile(output, "utf8")));
    if (result.device !== options.device) throw new Error("Layout detector silently changed requested device");
    if (result.image.width !== metadata.width || result.image.height !== metadata.height) throw new Error("Layout output dimensions do not match source raster");
    result.image.sha256 = createHash("sha256").update(input).digest("hex");
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
