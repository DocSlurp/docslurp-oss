/*
 * The pinned OCR models (`worker/ocr-models.json`): every model a result may name, by id and sha256. The CLI verifies
 * the files themselves before loading them; the host checks a result only ever names these.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveScriptsDir } from "../tools/scripts-dir.js";

export interface OcrModelEntry {
  id: string;
  family: string | null;
  role: "det" | "rec";
  file: string;
  sha256: string;
  bytes: number;
  url: string;
  license: string;
}

export interface PinnedOcrModel {
  sha256: string;
  role: "det" | "rec";
  /** The recogniser family a `rec` model reads; null for the detector. */
  family: string | null;
}

let cached: { file: string; models: ReadonlyMap<string, string>; entries: ReadonlyMap<string, PinnedOcrModel> } | null = null;

/** The manifest path: `DOCSLURP_OCR_MANIFEST`, else `worker/ocr-models.json` beside the scripts directory. */
export function ocrManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOCSLURP_OCR_MANIFEST?.trim() || path.join(resolveScriptsDir(), "..", "ocr-models.json");
}

/** Model id → sha256 for every pinned model. Throws when the manifest is missing or malformed. */
export function pinnedOcrModels(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, string> {
  return loadPinned(env).models;
}

/** Model id → sha256, role and family for every pinned model. Throws when the manifest is missing or malformed. */
export function pinnedOcrModelEntries(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, PinnedOcrModel> {
  return loadPinned(env).entries;
}

function loadPinned(env: NodeJS.ProcessEnv): NonNullable<typeof cached> {
  const file = ocrManifestPath(env);
  if (cached?.file === file) return cached;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion?: unknown; models?: unknown };
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.models) || raw.models.length === 0) throw new Error(`OCR model manifest is malformed: ${file}`);
  const models = new Map<string, string>();
  const entries = new Map<string, PinnedOcrModel>();
  for (const entry of raw.models as Array<Partial<OcrModelEntry>>) {
    if (typeof entry.id !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) throw new Error(`OCR model manifest entry is malformed: ${file}`);
    if (entry.role !== "det" && entry.role !== "rec") throw new Error(`OCR model manifest entry has no role: ${file}`);
    if (entry.role === "rec" && typeof entry.family !== "string") throw new Error(`OCR model manifest rec entry has no family: ${file}`);
    models.set(entry.id, entry.sha256!);
    entries.set(entry.id, { sha256: entry.sha256!, role: entry.role, family: entry.role === "rec" ? entry.family! : null });
  }
  cached = { file, models, entries };
  return cached;
}

/** Test hook. */
export function resetPinnedOcrModelsForTest(): void {
  cached = null;
}
