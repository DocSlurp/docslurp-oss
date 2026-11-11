import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { visualSpecSchema } from "@docslurp/shared";

import { vmOnlyParsing } from "../../lib/vm-only-parsing.js";
import { resolveScriptsDir } from "../../tools/scripts-dir.js";
import type { CommandRunner } from "../../tools/runner.js";
import { extractDeterministicVisuals as guestExtract, type DeterministicVisualInput, type DeterministicVisualOptions } from "./index.js";
import { CHART_EXTRACT_LIMITS } from "./limits.js";
import type { DeterministicVisualResult } from "./types.js";

/*
 * Host side of the deterministic chart rungs. Customer bytes are parsed only by the guest entry
 * (`scripts/chart-export-extract.mjs` → `index.ts`), which production runs inside the parser VM through the command
 * runner. The host sends a file path plus a tiny request, receives JSON, and validates every field before use. When the
 * VM run fails (no provider, timeout, bad output) the call throws `ChartExtractRefusedError`: the caller skips the
 * deterministic rungs for that file; nothing is ever parsed on the host instead.
 */

export type DeterministicInputKind = DeterministicVisualInput["kind"];

export class ChartExtractRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`deterministic chart extraction refused: ${reason}`);
    this.name = "ChartExtractRefusedError";
  }
}

const RESULT_LIMIT_BYTES = 16 * 1024 * 1024;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isNullableStr = (v: unknown, max: number) => v === null || isStr(v, max);
const VISUAL_KEYS = ["source", "kind", "confidence", "spec", "digest", "locator", "slide", "sheet", "generator", "reason"].sort().join(",");

function validVisual(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== VISUAL_KEYS) return false;
  if (!["office-chart-xml", "embedded-spec", "svg-geometry"].includes(o.source as string)) return false;
  if (o.kind !== "chart" && o.kind !== "diagram") return false;
  if (typeof o.confidence !== "number" || !(o.confidence >= 0 && o.confidence <= 1)) return false;
  if (!isNullableStr(o.digest, CHART_EXTRACT_LIMITS.maxDigestChars) || !isStr(o.locator, 512) || !isNullableStr(o.sheet, 200)
    || !isNullableStr(o.generator, 40) || !isNullableStr(o.reason, 120)) return false;
  if (!(o.slide === null || (Number.isSafeInteger(o.slide) && (o.slide as number) > 0))) return false;
  if (o.spec !== null) {
    const spec = visualSpecSchema.safeParse(o.spec);
    if (!spec.success || spec.data.kind !== o.kind) return false;
    o.spec = spec.data;
  }
  return true;
}

/** Validate a guest result (also used on in-process results so both paths return the same shape). */
export function validateDeterministicResult(raw: unknown): DeterministicVisualResult {
  const o = raw as Record<string, unknown> | null;
  const ok = !!o && typeof o === "object" && !Array.isArray(o)
    && Object.keys(o).sort().join(",") === "refusals,schemaVersion,visuals"
    && o.schemaVersion === "chart-export-deterministic@v1"
    && Array.isArray(o.visuals) && o.visuals.length <= CHART_EXTRACT_LIMITS.maxVisuals && o.visuals.every(validVisual)
    && Array.isArray(o.refusals) && o.refusals.length <= 1000
    && o.refusals.every((r) => !!r && typeof r === "object" && Object.keys(r).sort().join(",") === "locator,reason" && isStr((r as Record<string, unknown>).locator, 512) && isStr((r as Record<string, unknown>).reason, 120));
  if (!ok) throw new ChartExtractRefusedError("invalid-guest-result");
  return o as unknown as DeterministicVisualResult;
}

/** In-process extraction for tests and local development. Refused wherever parsing must stay in the VM. */
export function extractDeterministicVisualsInProcess(input: DeterministicVisualInput, options: DeterministicVisualOptions = {}): DeterministicVisualResult {
  if (vmOnlyParsing()) throw new ChartExtractRefusedError("requires-parser-vm");
  return validateDeterministicResult(guestExtract(input, options));
}

function maxBytesFor(kind: DeterministicInputKind): number {
  return kind === "office" || kind === "epub" ? CHART_EXTRACT_LIMITS.maxPackageBytes : CHART_EXTRACT_LIMITS.maxTextBytes;
}

export interface DeterministicFileArgs {
  inputPath: string;
  kind: DeterministicInputKind;
  options?: DeterministicVisualOptions;
  runner: Pick<CommandRunner, "run">;
  signal?: AbortSignal;
  /** Logger for refusals (defaults to console.warn). Receives only machine reasons, never file content. */
  log?: (message: string) => void;
  /** Our own ids for refusal logs (`document=<id>`), never customer content. */
  context?: string;
}

/**
 * Extract deterministic visuals from a staged file. Production (`vmOnlyParsing`) runs the guest in the parser VM and
 * fails closed; elsewhere the same guest code runs in-process, like the other guest parsers.
 */
export async function extractDeterministicVisualsFile(args: DeterministicFileArgs): Promise<DeterministicVisualResult> {
  const log = args.log ?? ((m: string) => console.warn(m));
  const where = args.context ? ` ${args.context}` : "";
  const refuse = (reason: string): never => {
    log(`[chart-export] deterministic extraction refused${where} kind=${args.kind} reason=${reason}`);
    throw new ChartExtractRefusedError(reason);
  };
  if (!["office", "epub", "svg", "html", "json"].includes(args.kind)) refuse("invalid-kind");
  const size = (await stat(args.inputPath)).size;
  if (size > maxBytesFor(args.kind)) refuse("input-too-large");
  if (!vmOnlyParsing()) {
    const bytes = await readFile(args.inputPath);
    const input: DeterministicVisualInput = args.kind === "office" || args.kind === "epub" ? { kind: args.kind, bytes } : { kind: args.kind, text: bytes.toString("utf8") };
    return validateDeterministicResult(guestExtract(input, args.options));
  }
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-chart-extract-"));
  try {
    const request = path.join(dir, "request.json");
    const output = path.join(dir, "result.json");
    await writeFile(request, JSON.stringify({ kind: args.kind, diagrams: args.options?.diagrams !== false }), { mode: 0o600 });
    try {
      await args.runner.run({ binary: "node", args: [path.join(resolveScriptsDir(), "chart-export-extract.mjs"), args.inputPath, request, output], available: true, readOnlyInputs: true, timeoutMs: 60_000 }, args.signal);
    } catch (error) {
      args.signal?.throwIfAborted();
      log(`[chart-export] parser VM run failed${where} kind=${args.kind} error=${error instanceof Error ? error.name : "error"}`);
      return refuse("guest-unavailable");
    }
    let outSize: number;
    try { outSize = (await stat(output)).size; } catch { return refuse("guest-no-output"); }
    if (outSize > RESULT_LIMIT_BYTES) refuse("guest-output-too-large");
    let raw: unknown;
    try { raw = JSON.parse(await readFile(output, "utf8")); } catch { return refuse("guest-output-not-json"); }
    try { return validateDeterministicResult(raw); } catch { return refuse("invalid-guest-result"); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** SVG inputs one batched guest run takes (the Doppler figures of one document). */
export const MAX_BATCH_INPUTS = 40;
const BATCH_SCHEMA = "chart-export-deterministic-batch@v1";

/** Validate a batched guest result: one standard result per input, in order. */
export function validateDeterministicBatch(raw: unknown, inputs: number): DeterministicVisualResult[] {
  const o = raw as Record<string, unknown> | null;
  const ok = !!o && typeof o === "object" && !Array.isArray(o)
    && Object.keys(o).sort().join(",") === "results,schemaVersion"
    && o.schemaVersion === BATCH_SCHEMA
    && Array.isArray(o.results) && o.results.length === inputs;
  if (!ok) throw new ChartExtractRefusedError("invalid-guest-result");
  return (o.results as unknown[]).map((result) => validateDeterministicResult(result));
}

export interface DeterministicBatchArgs extends Omit<DeterministicFileArgs, "inputPath" | "kind"> {
  /** Staged SVG files (at most `MAX_BATCH_INPUTS`). */
  inputPaths: readonly string[];
}

/**
 * Several SVG files in ONE parser-VM run (a document's Doppler figures), each extracted and limited on its own inside the
 * guest. An input over the size limit, or one the guest fails on, comes back as a result with a refusal; the others
 * stand. A VM failure refuses the whole batch (fail closed, no host fallback).
 */
export async function extractDeterministicVisualsBatch(args: DeterministicBatchArgs): Promise<DeterministicVisualResult[]> {
  const log = args.log ?? ((m: string) => console.warn(m));
  const where = args.context ? ` ${args.context}` : "";
  const refuse = (reason: string): never => {
    log(`[chart-export] deterministic extraction refused${where} kind=svg-batch inputs=${args.inputPaths.length} reason=${reason}`);
    throw new ChartExtractRefusedError(reason);
  };
  if (args.inputPaths.length === 0) return [];
  if (args.inputPaths.length > MAX_BATCH_INPUTS) refuse("too-many-inputs");
  const tooLarge = new Set<number>();
  for (const [i, file] of args.inputPaths.entries()) if ((await stat(file)).size > CHART_EXTRACT_LIMITS.maxTextBytes) tooLarge.add(i);
  const refused = (reason: string): DeterministicVisualResult => ({ schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [{ locator: "svg", reason }] } as DeterministicVisualResult);
  if (!vmOnlyParsing()) {
    const out: DeterministicVisualResult[] = [];
    for (const [i, file] of args.inputPaths.entries()) {
      if (tooLarge.has(i)) { out.push(refused("input-too-large")); continue; }
      try {
        out.push(validateDeterministicResult(guestExtract({ kind: "svg", text: (await readFile(file)).toString("utf8") }, args.options)));
      } catch {
        out.push(refused("extract-failed"));
      }
    }
    return out;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-chart-extract-"));
  try {
    const request = path.join(dir, "request.json");
    const output = path.join(dir, "result.json");
    await writeFile(request, JSON.stringify({ kind: "svg", diagrams: args.options?.diagrams !== false, batch: args.inputPaths.length }), { mode: 0o600 });
    // argv: <first input> <request> <output> <more inputs...>: the single-input layout, extended.
    const [first, ...rest] = args.inputPaths;
    const timeoutMs = Math.min(180_000, 60_000 + 3_000 * rest.length);
    try {
      await args.runner.run({ binary: "node", args: [path.join(resolveScriptsDir(), "chart-export-extract.mjs"), first!, request, output, ...rest], available: true, readOnlyInputs: true, timeoutMs }, args.signal);
    } catch (error) {
      args.signal?.throwIfAborted();
      log(`[chart-export] parser VM run failed${where} kind=svg-batch inputs=${args.inputPaths.length} error=${error instanceof Error ? error.name : "error"}`);
      return refuse("guest-unavailable");
    }
    let outSize: number;
    try { outSize = (await stat(output)).size; } catch { return refuse("guest-no-output"); }
    if (outSize > RESULT_LIMIT_BYTES) refuse("guest-output-too-large");
    let raw: unknown;
    try { raw = JSON.parse(await readFile(output, "utf8")); } catch { return refuse("guest-output-not-json"); }
    try { return validateDeterministicBatch(raw, args.inputPaths.length); } catch { return refuse("invalid-guest-result"); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
