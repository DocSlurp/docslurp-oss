import { z } from "zod";

/*
 * Figure resume (docs/extraction/doppler-figures.md, "Resuming partial figures"): when the worker finishes the images a
 * figure pass left resumable, and who may ask for it. The deploy flag DOCSLURP_FIGURE_RESUME is the ceiling; a project
 * chooses `auto` (resumes are queued when a partial level commits), `manual` (only on request: the API, the SDK or the
 * chat's offer) or `off`. A project whose figures are off (`pipeline.figures`) never resumes. The setting is per project:
 * DocSlurp has no organization-level pipeline settings (a project inherits nothing from its organization), so there is
 * no organization default to cap it (M9).
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
  /**
   * Resume VM launches per document over its lifetime (H4): counted when a VM starts, never reset by a request, reset only
   * by a fresh, customer-paid pass (a new run). Past it the document is blocked `attempts`.
   */
  maxVmLaunches: 6,
  /** Resume VM minutes per organization per UTC day (DOCSLURP_FIGURE_RESUME_ORG_DAILY_VM_MINUTES overrides). */
  orgDailyVmMinutes: 120,
  /** Resumes running at once on one worker (DOCSLURP_FIGURE_RESUME_CONCURRENCY overrides, 1..16). */
  concurrency: 2,
  /** Resumes running at once across the fleet (DOCSLURP_FIGURE_RESUME_GLOBAL_MAX overrides, 1..256). */
  globalMax: 8,
} as const;

export const FIGURE_RESUME_ORG_DAILY_ENV = "DOCSLURP_FIGURE_RESUME_ORG_DAILY_VM_MINUTES";
export const FIGURE_RESUME_CONCURRENCY_ENV = "DOCSLURP_FIGURE_RESUME_CONCURRENCY";
/** The audit's ledger writes (`markAssetsLost`, adopting aged pending rows): `1`/`on` writes, anything else logs only. */
export const FIGURE_AUDIT_ENV = "DOCSLURP_FIGURE_AUDIT";
/** The orphan GC's deletes: `1`/`on` deletes, anything else is a dry run (log and metric only). */
export const FIGURE_GC_DELETE_ENV = "DOCSLURP_FIGURE_GC_DELETE";

function flagOn(env: Record<string, string | undefined>, name: string): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}
/** The chat's resume offer (the `proposeFigureResume` tool, its instruction and the settings count): off until the app's card ships. */
export const FIGURE_RESUME_CHAT_ENV = "DOCSLURP_FIGURE_RESUME_CHAT";
/**
 * Whether the chat may offer a figure resume (R2-M5): the runner is on (DOCSLURP_FIGURE_RESUME) and the chat offer is
 * switched on (DOCSLURP_FIGURE_RESUME_CHAT, once the app renders the proposal card). Otherwise the tool, its instruction
 * and `getProjectSettings`' figures block are not offered.
 */
export function figureResumeChatEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return figureResumeDeployEnabled(env) && flagOn(env, FIGURE_RESUME_CHAT_ENV);
}
/** Whether the audit may write the ledger (default off: dry run). */
export function figureAuditWrites(env: Record<string, string | undefined> = process.env): boolean { return flagOn(env, FIGURE_AUDIT_ENV); }
/** Whether the orphan GC may delete objects (default off: dry run). */
export function figureGcDeletes(env: Record<string, string | undefined> = process.env): boolean { return flagOn(env, FIGURE_GC_DELETE_ENV); }

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
/** Resume VM milliseconds one organization may use per UTC day. */
export function figureResumeOrgDailyVmMs(env: Record<string, string | undefined> = process.env): number {
  return boundedInt(env[FIGURE_RESUME_ORG_DAILY_ENV], FIGURE_RESUME_LIMITS.orgDailyVmMinutes, 0, 24 * 60) * 60_000;
}
export const FIGURE_RESUME_GLOBAL_ENV = "DOCSLURP_FIGURE_RESUME_GLOBAL_MAX";
/** Resumes running at once across the fleet (live leases). */
export function figureResumeGlobalMax(env: Record<string, string | undefined> = process.env): number {
  return boundedInt(env[FIGURE_RESUME_GLOBAL_ENV], FIGURE_RESUME_LIMITS.globalMax, 1, 256);
}
/** Resumes one worker runs at once. */
export function figureResumeConcurrency(env: Record<string, string | undefined> = process.env): number {
  return boundedInt(env[FIGURE_RESUME_CONCURRENCY_ENV], FIGURE_RESUME_LIMITS.concurrency, 1, 16);
}

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
 * Whether a project's figures are off (`pipeline.figures`, #363), fail closed: `false`, `"off"`, or `{ enabled: false }`
 * all mean off.
 */
export function projectFiguresOff(pipeline: unknown): boolean {
  // figuresEnabled (doppler-figures.ts) for the project part, failing closed on other shapes; the deploy flag is apart.
  const figures = (pipeline as { figures?: unknown } | null | undefined)?.figures;
  if (figures === false || figures === "off") return true;
  return !!figures && typeof figures === "object" && (figures as { enabled?: unknown }).enabled === false;
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
