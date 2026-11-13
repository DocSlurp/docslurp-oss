import { z } from "zod";
import { projectFiguresEnabled } from "./doppler-figures.js";

/*
 * Figure resume (docs/extraction/doppler-figures.md, "Resuming partial figures"): when the worker finishes the images a
 * figure pass left resumable, and who may ask for it. The deploy flag DOCSLURP_FIGURE_RESUME is the ceiling; a project
 * chooses `auto` (resumes are queued when a partial level commits), `manual` (only on request: the API, the SDK or the
 * chat's offer) or `off`. A project whose figures are off (`pipeline.figures`) never resumes.
 */

export const FIGURE_RESUME_ENV = "DOCSLURP_FIGURE_RESUME";
export const FIGURE_RESUME_MODES = ["auto", "manual", "off"] as const;
export type FigureResumeMode = (typeof FIGURE_RESUME_MODES)[number];

/** Resume caps shared by the runner, the route and the chat tool. */
export const FIGURE_RESUME_LIMITS = {
  /** Resumes per document or shard (the ledger's host-side counter, DOCUMENT_ASSET_RESUME_CAP). */
  maxAttempts: 3,
  /** Backoff before attempt n+1 (ms). */
  backoffMs: [2 * 60_000, 15 * 60_000, 2 * 3600_000] as const,
  /** Delay before the first automatic attempt after a partial level commits (ms). */
  firstDelayMs: 2 * 60_000,
  /** Documents one bulk request (a project) may queue. */
  bulkMax: 100,
} as const;

/**
 * DOCSLURP_FIGURE_RESUME: `1`/`true`/`on` lets the runner claim resumes; unset/`0`/`false`/`off` stops it (requests still
 * queue, nothing is lost). Anything else is off and reported, never a silent `on`.
 */
export function figureResumeDeployEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env[FIGURE_RESUME_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  console.warn(`[figure-resume] ${FIGURE_RESUME_ENV}=${JSON.stringify(raw.slice(0, 16))} is not on/off; treated as off`);
  return false;
}

/**
 * Whether a project's figures are off. Reads the project-level opt-out (`pipeline.figures`, being added on the chart
 * export branch) in any of its plausible shapes, fail closed: `false`, `"off"`, or `{ enabled: false }` all mean off.
 */
export function projectFiguresOff(pipeline: unknown): boolean {
  // The same rule as projectFiguresEnabled (doppler-figures.ts) for the project part; the deploy flag is checked apart.
  return !projectFiguresEnabled(pipeline, { DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1" });
}

/** The project's resume mode (`pipeline.figureResume`, default `auto`); `off` when its figures are off. */
export function projectFigureResumeMode(pipeline: unknown): FigureResumeMode {
  if (projectFiguresOff(pipeline)) return "off";
  const mode = (pipeline as { figureResume?: unknown } | null | undefined)?.figureResume;
  return (FIGURE_RESUME_MODES as readonly unknown[]).includes(mode) ? (mode as FigureResumeMode) : "auto";
}

/** What a resume request may do for a project now: queue automatically, queue on request only, or nothing. */
export function figureResumeAllowed(pipeline: unknown, request: "auto" | "on-demand"): boolean {
  const mode = projectFigureResumeMode(pipeline);
  if (mode === "off") return false;
  return request === "on-demand" || mode === "auto";
}

/** Backoff before the next attempt after `attempts` resumes (the last delay repeats). */
export function figureResumeBackoffMs(attempts: number): number {
  const delays = FIGURE_RESUME_LIMITS.backoffMs;
  return delays[Math.min(Math.max(0, Math.trunc(attempts)), delays.length - 1)]!;
}

// ---- The chat's offer: "finish extracting the missing figures" (a proposal the user applies) ----


/** What the chat may propose: one document, or the project's resumable documents (at most 100 per Apply). */
export const figureResumeProposalInputSchema = z.object({
  project: z.string().min(1).optional(),
  /** A document of the project; omitted means every resumable document of the project (capped). */
  documentId: z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/).optional(),
}).strict();
export type FigureResumeProposalInput = z.infer<typeof figureResumeProposalInputSchema>;

/** The proposal card the first-party app renders; Apply queues the resumes. Never contains storage keys. */
export const figureResumeProposalSchema = z.object({
  token: z.string().min(1).max(32768),
  projectId: z.string(),
  documentId: z.string().nullable(),
  /** Documents the Apply would queue now (at most 100). */
  documents: z.number().int().nonnegative(),
  /** Whether more remain past the cap (a later Apply queues the next ones). */
  more: z.boolean(),
  expiresAt: z.string().datetime(),
  /** What it costs the customer: nothing (resume time is ours); stored figure bytes are billed as storage. */
  credits: z.literal(0),
});
export type FigureResumeProposal = z.infer<typeof figureResumeProposalSchema>;
