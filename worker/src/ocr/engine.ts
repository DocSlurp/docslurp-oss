/*
 * One OCR read of a stored customer file, wherever the operator chose to run it (mode.ts). The host never decodes the
 * file: it hands the path to the VM provider (or, self-hosted only, the local sandbox), then reads back and validates a
 * bounded JSON result and, for pages that need a second opinion, a bounded PNG the boundary produced. Nothing here falls
 * back: a refused or failed read throws, and the caller fails the page or document.
 */
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ocrResultSchema, type OcrFrameRecord, type OcrResultRecord } from "@docslurp/shared";

import type { SandboxedOcrJob } from "../extractors/plugins.js";
import { sandboxedOcrProvider } from "../extractors/plugins.js";
import { parseRawRendition } from "../lib/page-rendition.js";
import type { CommandPlan, CommandRunner } from "../tools/runner.js";
import { ESCALATE_RECOGNISERS, planOcrLanguages, type OcrLanguagePlan } from "./languages.js";
import { classifyOcrRunError, OcrDeterministicFailure, OcrRefusedError, resolveOcrMode, type OcrMode } from "./mode.js";
import { pinnedOcrModelEntries, type PinnedOcrModel } from "./models.js";

/** Bound on the result JSON read back from the boundary. */
export const OCR_RESULT_MAX_BYTES = 64 * 1024 * 1024;
/** Bound on one escalation PNG read back from the boundary. */
export const OCR_ESCALATION_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
/** Default long-edge cap (pixels): PP-OCRv6 small holds ~1.4-1.7 GB RSS per call at full A4 resolution. */
export const OCR_DEFAULT_MAX_LONG_EDGE = 2000;
/** A frame below this mean confidence is retried with the next recogniser in the plan. */
export const OCR_RETRY_BELOW = 0.8;
/** A frame below this mean confidence after every attempt is escalated (when escalation is on). */
export const OCR_ESCALATE_BELOW = 0.8;
/** Frames one job reads at most (pages of a PDF job, frames of a multi-frame image). */
export const OCR_DEFAULT_MAX_FRAMES = 64;

export type OcrEscalationReason = "script" | "unsupported-script" | "low-confidence" | "empty";

export interface OcrPageRead {
  pageNumber: number;
  text: string;
  meanConfidence: number | null;
  recogniser: string;
  chars: number;
  elapsedMs: number;
  /** Why this page should get a hosted second read, and the boundary's PNG of it; null when it should not. */
  escalation: { reason: OcrEscalationReason; imagePath: string; width: number; height: number } | null;
  /** The boundary's bounded raw RGB rendition of the frame (validated by header and exact size; there is nothing to decode), when asked for. */
  rendition?: { imagePath: string; width: number; height: number };
  /** The frame's decoded pixel size before any downscaling (the boundary decoded it): its page area. */
  sourceWidth?: number;
  sourceHeight?: number;
}

export interface OcrReadOutcome {
  mode: Extract<OcrMode, "vm" | "local">;
  /** The provider id (vm) or `local-sandbox`. */
  engine: string;
  language: OcrLanguagePlan;
  pages: OcrPageRead[];
  /** The boundary stopped at the frame cap with more frames or requested pages left. */
  truncatedFrames: boolean;
  /**
   * Requested pages the boundary did not reach because the job named more than its frame cap. The caller must fail them
   * (they are neither read nor billed). Empty for a job without `pages`: its frames past the cap are signalled by
   * `truncatedFrames` alone.
   */
  unreadPages: number[];
  wallMs: number;
  cpuMs: number;
  peakRssKb: number;
  /** Removes the job's scratch directory (escalation PNGs live there until the caller is done with them). */
  dispose(): Promise<void>;
}

export interface OcrReadInput {
  /** Absolute path to the stored file (a private temp copy). Never decoded here. */
  source: string;
  kind: "image" | "pdf";
  /** 1-based pages (PDF) or frames to read; absent reads every frame up to the frame cap. */
  pages?: number[];
  /** A lower frame cap than the default (the frames the run can pay for); the boundary stops there and reports truncation. */
  maxFrames?: number;
  /** Workspace OCR language setting (`auto` or codes). */
  languageSetting?: string;
  /** Keep PNGs of pages that qualify for escalation. */
  escalation: boolean;
  /** Ask the boundary for a bounded rendition of every frame (visual indexing of uploaded images). */
  rendition?: { maxLongEdge: number; maxBytes: number };
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

type OcrRunner = Pick<CommandRunner, "run" | "sandboxedOcrRead" | "localOcrRead">;

/** Long-edge cap for OCR input (`DOCSLURP_OCR_MAX_LONG_EDGE`, 640 to 4000). */
export function ocrMaxLongEdge(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.DOCSLURP_OCR_MAX_LONG_EDGE?.trim());
  return Number.isInteger(parsed) && parsed >= 640 && parsed <= 4000 ? parsed : OCR_DEFAULT_MAX_LONG_EDGE;
}

/** Concurrent OCR jobs this process runs (`DOCSLURP_OCR_MAX_CONCURRENT`): 1 by default, so one ~1.7 GB call per slot. */
export function ocrMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.DOCSLURP_OCR_MAX_CONCURRENT?.trim());
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, 32) : 1;
}

let active = 0;
const waiting: Array<() => void> = [];
async function withOcrSlot<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (active >= ocrMaxConcurrent(env)) {
    // A cancelled job leaves the queue instead of starting a VM or process once a slot frees.
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal!.reason instanceof Error ? signal!.reason : new Error("aborted"));
      };
      const grant = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
      waiting.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  } else {
    active += 1;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

/** Plan the job: the VM provider, or (self-hosted only) the local sandbox. */
async function planJob(runner: OcrRunner, job: SandboxedOcrJob, mode: "vm" | "local", env: NodeJS.ProcessEnv): Promise<CommandPlan> {
  return mode === "vm" ? await runner.sandboxedOcrRead(job) : await runner.localOcrRead(job, env);
}

/** A result that fails validation is a deterministic rejection of this read (same bytes, same result). */
async function rejectInvalid<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (error) {
    throw new OcrDeterministicFailure(error instanceof Error ? error.message : String(error), "invalid-result", { cause: error });
  }
}

/** Read the result JSON the boundary wrote, bounded, as untrusted input. */
async function readResult(output: string): Promise<OcrResultRecord> {
  const info = await lstat(output).catch(() => null);
  if (!info?.isFile()) throw new Error("OCR produced no result file");
  if (info.size > OCR_RESULT_MAX_BYTES) throw new Error(`OCR result exceeds ${OCR_RESULT_MAX_BYTES} bytes`);
  let raw: unknown;
  try {
    const handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      raw = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("OCR result is not valid JSON");
  }
  const parsed = ocrResultSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`OCR result failed validation: ${parsed.error.issues[0]?.path.join(".") ?? "?"}`);
  return parsed.data;
}

/**
 * The result's frames must be the ones asked for, once each, read only by pinned models. Returns the requested pages the
 * boundary legitimately did not reach (a job naming more pages than its frame cap); the caller fails them. Every other
 * requested page must come back: no page is ever neither read nor failed.
 */
export function checkResultAgainstJob(result: OcrResultRecord, job: SandboxedOcrJob, pinned: ReadonlyMap<string, PinnedOcrModel>): { unreadPages: number[] } {
  const seen = new Set<number>();
  const allowed = job.pages ? new Set(job.pages) : null;
  const used = new Set<string>();
  for (const frame of result.frames) {
    if (seen.has(frame.frame)) throw new Error(`OCR result repeats frame ${frame.frame}`);
    seen.add(frame.frame);
    if (allowed ? !allowed.has(frame.frame) : frame.frame > job.maxFrames) throw new Error(`OCR result has unrequested frame ${frame.frame}`);
    if (frame.recogniser !== null && !job.recognisers.includes(frame.recogniser)) throw new Error(`OCR result used an unrequested recogniser ${frame.recogniser}`);
    for (const attempt of frame.attempts) {
      if (!job.recognisers.includes(attempt.recogniser)) throw new Error(`OCR result used an unrequested recogniser ${attempt.recogniser}`);
      used.add(attempt.recogniser);
    }
    if (frame.recogniser !== null) used.add(frame.recogniser);
    if (frame.chars !== [...frame.text].length && frame.chars !== frame.text.length) throw new Error(`OCR frame ${frame.frame} reports ${frame.chars} chars for different text`);
    if (frame.recogniser === null && frame.chars > 0) throw new Error(`OCR frame ${frame.frame} has text but no recogniser`);
    if (frame.image !== null && frame.image !== `frame-${String(frame.frame).padStart(4, "0")}.png`) throw new Error(`OCR frame ${frame.frame} names another frame's image`);
    if (frame.width > job.maxLongEdge || frame.height > job.maxLongEdge) throw new Error(`OCR frame ${frame.frame} exceeds the long-edge cap`);
  }
  if (result.frames.length > job.maxFrames) throw new Error("OCR result exceeds the frame cap");
  // Truncation is only legitimate when there was more to read than the frame cap allows, and then the cap was filled.
  if (result.truncatedFrames) {
    if (job.pages && job.pages.length <= job.maxFrames) throw new Error("OCR result claims truncation for a job within its frame cap");
    if (result.frames.length < job.maxFrames) throw new Error("OCR result claims truncation before reaching its frame cap");
  }
  const unreadPages = job.pages ? job.pages.filter((page) => !seen.has(page)) : [];
  if (unreadPages.length && !result.truncatedFrames) throw new Error(`OCR result is missing requested frames ${unreadPages.join(",")}`);
  // Models: each pinned (id and sha256), once; exactly one detector; a recogniser model for every family that ran (one may
  // also be listed when detection loaded it but found nothing). A result whose frames are all blank names only the
  // detector: a valid "no text" read.
  const families = new Set<string>();
  let detectors = 0;
  const ids = new Set<string>();
  for (const model of result.models) {
    const entry = pinned.get(model.id);
    if (!entry || entry.sha256 !== model.sha256) throw new Error(`OCR result names an unpinned model ${model.id}`);
    if (ids.has(model.id)) throw new Error(`OCR result names model ${model.id} twice`);
    ids.add(model.id);
    if (entry.role === "det") detectors += 1;
    else families.add(entry.family!);
  }
  if (detectors !== 1) throw new Error("OCR result must name exactly one detector model");
  for (const family of used) if (!families.has(family)) throw new Error(`OCR result names no model for recogniser ${family}`);
  return { unreadPages };
}

/**
 * A frame's rendition, accepted only when it is the raw RGB file the job asked for: named for this frame, a regular file
 * within the job's byte cap, with the fixed header and exactly width x height x 3 pixel bytes, its long edge within the
 * job's cap (lib/page-rendition.ts parseRawRendition). Anything else is refused (logged; the page then has no visual
 * index). It is never decoded: there is no encoded image to decode.
 */
async function validRendition(
  frame: { frame: number; rendition?: string | null },
  imageDir: string,
  cap: { maxLongEdge: number; maxBytes: number },
): Promise<OcrPageRead["rendition"] | undefined> {
  if (!frame.rendition) return undefined;
  const refuse = (why: string) => { console.warn(`[ocr] frame=${frame.frame} rendition refused: ${why}`); return undefined; };
  if (frame.rendition !== `rendition-${String(frame.frame).padStart(4, "0")}.rgb`) return refuse("names another frame");
  const imagePath = path.join(imageDir, frame.rendition);
  const info = await lstat(imagePath).catch(() => null);
  if (!info?.isFile() || info.size > cap.maxBytes) return refuse("missing, not a regular file or over the byte cap");
  const handle = await open(imagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  const raw = parseRawRendition(bytes, cap);
  if (!raw) return refuse("not a raw RGB rendition within its caps");
  return { imagePath, width: raw.width, height: raw.height };
}

/** A PNG's signature and IHDR size, read without decoding pixels. Null when the file is not that PNG. */
async function pngDimensions(file: string, maxBytes = OCR_ESCALATION_IMAGE_MAX_BYTES): Promise<{ width: number; height: number; bytes: number } | null> {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size < 33 || info.size > maxBytes) return null;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const head = Buffer.alloc(24);
    await handle.read(head, 0, 24, 0);
    if (!head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
    if (head.readUInt32BE(8) !== 13 || head.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), bytes: info.size };
  } finally {
    await handle.close();
  }
}

/** Why a frame deserves a hosted second read, or null. */
export function escalationReason(frame: { recogniser: string | null; meanConfidence: number | null; chars: number }, language: OcrLanguagePlan, belowConfidence = OCR_ESCALATE_BELOW): OcrEscalationReason | null {
  if (frame.recogniser !== null && (ESCALATE_RECOGNISERS as readonly string[]).includes(frame.recogniser)) return "script";
  if (language.unsupportedScript) return "unsupported-script";
  // Nothing detected at all (a blank or picture-only frame): no second read. Text regions the recogniser could not read
  // are what escalation is for.
  if (frame.chars === 0) return frame.recogniser === null || frame.recogniser === "none" ? null : "empty";
  if (frame.meanConfidence !== null && frame.meanConfidence < belowConfidence) return "low-confidence";
  return null;
}

/**
 * OCR `input.source` in the configured boundary. Throws OcrRefusedError when the mode refuses OCR, and a plain Error
 * when the boundary failed or returned anything malformed; either way nothing was read and nothing should be billed.
 */
export async function readWithOcr(runner: OcrRunner, input: OcrReadInput): Promise<OcrReadOutcome> {
  const env = input.env ?? process.env;
  const mode = resolveOcrMode(env);
  if (mode === "off") throw new OcrRefusedError("OCR is off (DOCSLURP_OCR_MODE=off)", "off");
  if (mode === "hosted") throw new OcrRefusedError("DOCSLURP_OCR_MODE=hosted reads pages with the hosted reader, not a recogniser", "hosted");
  const language = planOcrLanguages(input.languageSetting, env);
  const capped = Number.isSafeInteger(input.maxFrames) && input.maxFrames! >= 1 ? input.maxFrames! : OCR_DEFAULT_MAX_FRAMES;
  const maxFrames = Math.min(input.pages?.length ?? OCR_DEFAULT_MAX_FRAMES, OCR_DEFAULT_MAX_FRAMES, capped);
  const provider = mode === "vm" ? sandboxedOcrProvider() : null;
  if (provider) {
    const size = (await lstat(input.source)).size;
    if (size > provider.maxSourceBytes) throw new OcrRefusedError(`OCR source exceeds the provider's ${provider.maxSourceBytes}-byte limit`, "too-large");
  }
  const dir = await mkdtemp(path.join(env.DOCSLURP_OCR_SCRATCH_DIR?.trim() || tmpdir(), "docslurp-ocr-"));
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    const imageDir = path.join(dir, "images");
    await mkdir(imageDir, { mode: 0o700 });
    const job: SandboxedOcrJob = {
      input: input.source,
      kind: input.kind,
      ...(input.pages?.length ? { pages: [...input.pages] } : {}),
      output: path.join(dir, "result.json"),
      imageDir,
      recognisers: language.recognisers,
      maxAttempts: language.recognisers.length,
      retryBelow: OCR_RETRY_BELOW,
      maxFrames,
      maxLongEdge: ocrMaxLongEdge(env),
      escalation: input.escalation ? { belowConfidence: OCR_ESCALATE_BELOW, recognisers: [...ESCALATE_RECOGNISERS] } : null,
      // Renditions only where the boundary makes them (local CLI, or a VM provider whose guest declares them).
      ...(input.rendition && input.kind === "image" && (mode === "local" || provider?.renditions === true) ? { rendition: { ...input.rendition } } : {}),
    };
    const started = Date.now();
    const result = await withOcrSlot(env, async () => {
      let plan: CommandPlan;
      try {
        plan = await planJob(runner, job, mode, env);
      } catch (error) {
        // A provider that is not ready (assertConfigured) is the deployment's, not the input's.
        throw classifyOcrRunError(error, input.signal);
      }
      if (!plan.available) throw new OcrRefusedError(`OCR runtime unavailable for DOCSLURP_OCR_MODE=${mode}`, "unavailable");
      try {
        await runner.run(plan, input.signal);
      } catch (error) {
        throw classifyOcrRunError(error, input.signal);
      }
      return await rejectInvalid(() => readResult(job.output));
    }, input.signal);
    const pinned = pinnedOcrModelEntries();
    const { unreadPages } = await rejectInvalid(async () => checkResultAgainstJob(result, job, pinned));
    const pages: OcrPageRead[] = [];
    for (const frame of result.frames) {
      let escalation: OcrPageRead["escalation"] = null;
      const reason = input.escalation ? escalationReason(frame, language) : null;
      if (reason && frame.image) {
        const imagePath = path.join(imageDir, frame.image);
        const dims = await pngDimensions(imagePath);
        // The PNG must be the frame the boundary read; anything else is dropped, never decoded here.
        if (dims && dims.width === frame.width && dims.height === frame.height) escalation = { reason, imagePath, width: dims.width, height: dims.height };
        else console.warn(`[ocr] frame=${frame.frame} escalation image refused (missing or not the frame read)`);
      }
      const rendition = input.rendition ? await validRendition(frame, imageDir, input.rendition) : undefined;
      pages.push({
        ...(rendition ? { rendition } : {}),
        pageNumber: frame.frame,
        text: frame.text,
        meanConfidence: frame.meanConfidence,
        recogniser: frame.recogniser ?? "none",
        chars: frame.chars,
        elapsedMs: frame.elapsedMs,
        escalation,
        sourceWidth: frame.sourceWidth,
        sourceHeight: frame.sourceHeight,
      });
    }
    pages.sort((a, b) => a.pageNumber - b.pageNumber);
    return {
      mode,
      engine: provider?.id ?? "local-sandbox",
      language,
      pages,
      truncatedFrames: result.truncatedFrames,
      unreadPages,
      wallMs: Date.now() - started,
      cpuMs: result.cpuMs,
      peakRssKb: result.peakRssKb,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
