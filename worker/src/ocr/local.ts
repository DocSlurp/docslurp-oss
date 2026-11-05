/*
 * The fixed OCR CLI's arguments (`worker/scripts/docslurp_ocr.py`, protocol docslurp-ocr@1). The VM guest and the
 * self-hosted local sandbox run the same program with the same arguments; nothing in a job is a free-form flag.
 */
import path from "node:path";

import type { SandboxedOcrJob } from "../extractors/plugins.js";

export interface LocalOcrPaths {
  python: string;
  venvRoot: string;
  modelDir: string;
  manifest: string;
}

/** Where the self-hosted OCR runtime lives (`DOCSLURP_OCR_PYTHON`, `DOCSLURP_OCR_MODEL_DIR`). */
export function localOcrPaths(scriptsDir: string, env: NodeJS.ProcessEnv = process.env): LocalOcrPaths {
  const python = env.DOCSLURP_OCR_PYTHON?.trim() || "/opt/docslurp/ocr-venv/bin/python3";
  const modelDir = env.DOCSLURP_OCR_MODEL_DIR?.trim() || "/opt/docslurp/ocr-models";
  if (!path.isAbsolute(python) || !path.isAbsolute(modelDir)) {
    throw new Error("DOCSLURP_OCR_PYTHON and DOCSLURP_OCR_MODEL_DIR must be absolute paths");
  }
  return {
    python,
    venvRoot: path.dirname(path.dirname(python)),
    modelDir,
    // The manifest ships beside the scripts directory (worker/ocr-models.json).
    manifest: path.join(scriptsDir, "..", "ocr-models.json"),
  };
}

/** CLI arguments for one job, in the order the CLI documents them. */
export function ocrCliArgs(job: SandboxedOcrJob, models: { modelDir: string; manifest: string }, extra: { pdftoppm?: string; threads?: number } = {}): string[] {
  const args = [
    "--input", job.input,
    "--kind", job.kind,
    "--output", job.output,
    "--models", models.modelDir,
    "--manifest", models.manifest,
    "--recognisers", job.recognisers.join(","),
    "--max-attempts", String(job.maxAttempts),
    "--retry-below", String(job.retryBelow),
    "--max-frames", String(job.maxFrames),
    "--max-long-edge", String(job.maxLongEdge),
    "--threads", String(extra.threads ?? 1),
    "--image-dir", job.imageDir,
  ];
  if (job.pages?.length) args.push("--pages", job.pages.join(","));
  if (job.kind === "pdf" && extra.pdftoppm) args.push("--pdftoppm", extra.pdftoppm);
  if (job.escalation) {
    args.push("--escalate-below", String(job.escalation.belowConfidence));
    if (job.escalation.recognisers.length) args.push("--escalate-recognisers", job.escalation.recognisers.join(","));
  }
  return args;
}

/** Arguments for the local sandbox run (models and manifest from the worker's own install). */
export function localOcrCommandArgs(job: SandboxedOcrJob, paths: LocalOcrPaths, env: NodeJS.ProcessEnv = process.env): string[] {
  return ocrCliArgs(job, paths, { pdftoppm: env.DOCSLURP_OCR_PDFTOPPM?.trim() || "/usr/bin/pdftoppm" });
}
