/*
 * Hosted page reads for OCR: the escalation read of a page the recogniser read poorly (`ocr-escalation`), and the read of
 * a stored image in DOCSLURP_OCR_MODE=hosted (`hosted-ocr`). Both go through the worker's guarded vision call path:
 * the workspace privacy mode, the run cost cap, the run's vision attempt guard (per-page, breaker, org and route
 * bounds, and a per-document page budget counted in its durable ledger), and the usage ledger with the provider's actual tokens and cost.
 *
 * The bytes sent are never produced on the worker host: an escalation image is the PNG the OCR boundary wrote (checked
 * by signature and size only), and a hosted-mode image is the stored file as uploaded. Neither is a substitute for a
 * missing VM: escalation only follows a VM (or self-hosted) read, and hosted mode is its own operator setting.
 */
import { rm } from "node:fs/promises";
import { resolveVisionRoute, type VisionConfig } from "@docslurp/shared";
import type { UsageEvent } from "../models.js";

import type { Config } from "../config.js";
import { isCostCapExceeded } from "../pipeline/checkpoints.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { priceVisionResult, visionFailureUsages } from "../lib/guarded-vision-call.js";
import { allowHostedCall } from "../lib/privacy-guard.js";
import { findVisionGuardStop, recordVisionRead, withVisionCall } from "../lib/vision-attempt-guard.js";
import { visionConfigForModel } from "../routing/routed-vision.js";
import type { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime, visionCall } from "../tools/vision-runtime.js";

export const DEFAULT_OCR_ESCALATION_MODEL = "llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct";
/** Escalation reads per document unless `DOCSLURP_OCR_ESCALATION_MAX_PAGES` says otherwise. */
export const DEFAULT_OCR_ESCALATION_MAX_PAGES = 25;

/**
 * Escalation requests per document, every page and retry included (`DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS`), counted in the
 * vision guard's durable ledger. Default: the page budget plus a fifth of it for retries.
 */
export function ocrEscalationMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS?.trim());
  if (Number.isInteger(parsed) && parsed >= 0) return Math.min(parsed, 20_000);
  const pages = ocrEscalationMaxPages(env);
  return pages + Math.ceil(pages / 5);
}
/** Image types a hosted model takes as stored; anything else would need host decoding and is refused. */
export const HOSTED_OCR_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Largest stored image hosted mode sends as is. */
export const HOSTED_OCR_MAX_BYTES = 20 * 1024 * 1024;

export type HostedOcrPurpose = "ocr-escalation" | "hosted-ocr";

export interface HostedOcrPage {
  documentId: string;
  pageNumber: number;
  imagePath: string;
  mimeType: string;
}

export interface HostedOcrRead {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

/** Why a hosted read did not happen. Escalation keeps the recogniser's text; hosted mode fails the page. */
export class HostedOcrSkipped extends Error {
  constructor(readonly reason: "disabled" | "privacy" | "cost-cap" | "budget" | "guard", message: string) {
    super(message);
    this.name = "HostedOcrSkipped";
  }
}

export interface HostedOcrReader {
  read(page: HostedOcrPage, purpose: HostedOcrPurpose, signal?: AbortSignal): Promise<HostedOcrRead>;
}

/** Whether escalation runs (`DOCSLURP_OCR_ESCALATION=on`): an explicit operator opt-in, off by default. */
export function ocrEscalationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DOCSLURP_OCR_ESCALATION?.trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true";
}

/** Hosted providers the OCR reader may use; a local or private route would read the boundary's PNGs on another host. */
const HOSTED_OCR_PROVIDERS = new Set(["deepinfra", "openrouter", "openai"]);

export function ocrEscalationModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOCSLURP_OCR_ESCALATION_MODEL?.trim() || DEFAULT_OCR_ESCALATION_MODEL;
}

export function ocrEscalationMaxPages(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.DOCSLURP_OCR_ESCALATION_MAX_PAGES?.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, 10_000) : DEFAULT_OCR_ESCALATION_MAX_PAGES;
}

export function createHostedOcrReader(args: {
  state: WorkflowState;
  cfg: Config;
  runner: CommandRunner;
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to the worker's vision runtime. */
  execute?: typeof executeVisionRuntime;
}): HostedOcrReader {
  const env = args.env ?? process.env;
  const execute = args.execute ?? executeVisionRuntime;
  const { state } = args;
  return {
    async read(page, purpose, signal) {
      if (purpose === "ocr-escalation" && !ocrEscalationEnabled(env)) throw new HostedOcrSkipped("disabled", "OCR escalation is off");
      if (!HOSTED_OCR_MIME_TYPES.has(page.mimeType)) throw new Error(`hosted OCR refuses ${page.mimeType}: it would need host decoding`);
      const vision: VisionConfig = { ...visionConfigForModel(state.run.pipeline.vision, ocrEscalationModel(env)), prompt: "markdown-transcription", remoteFallbackModelUri: null };
      const route = resolveVisionRoute(vision);
      if (!HOSTED_OCR_PROVIDERS.has(route.provider)) {
        console.error(`[ocr] ${purpose} refused: DOCSLURP_OCR_ESCALATION_MODEL must be a hosted, priced model (provider=${route.provider})`);
        throw new HostedOcrSkipped("disabled", `${purpose} model is not a hosted route`);
      }
      if (!(await allowHostedCall(state, visionCall(route), [page.documentId]))) {
        throw new HostedOcrSkipped("privacy", `privacy mode refuses ${purpose}`);
      }
      if (isCostCapExceeded(state)) throw new HostedOcrSkipped("cost-cap", `run cost cap reached before ${purpose}`);
      const maxPages = ocrEscalationMaxPages(env);
      const pageRef = { documentId: page.documentId, pageNumber: page.pageNumber };
      const outputPath = `${page.imagePath}.${purpose}.json`;
      // Escalation reads are persisted as each call returns (ocr_escalation_reads). A retried activity reuses the page's
      // completed read instead of calling the provider again, and re-buffers every earlier call's usage under its own id, so
      // its provider cost is recorded exactly once even when the activity that made it never reached its checkpoint.
      const store = state.store;
      const durable = purpose === "ocr-escalation" && store?.ocrEscalationReads && store.recordOcrEscalationRead ? store : null;
      let attempt = 1;
      if (durable) {
        const prior = await durable.ocrEscalationReads!(state.run.id, page.documentId, page.pageNumber);
        const pending = new Set(state.usageLedger.snapshot().map((event) => event.id));
        for (const row of prior) for (const event of row.usageEvents) if (event.id && !pending.has(event.id)) state.usageLedger.enqueue(event);
        attempt = prior.reduce((max, row) => Math.max(max, row.attempt), 0) + 1;
        const done = prior.find((row) => row.status === "completed" && row.text !== null);
        if (done) {
          console.log(`[ocr] ${purpose} reused document=${page.documentId} page=${page.pageNumber} attempt=${done.attempt}: no new provider call`);
          return { text: done.text!, model: done.model, inputTokens: 0, outputTokens: 0, costCents: 0 };
        }
      }
      const callId = `${purpose}:${state.run.id}:${page.documentId}:${page.pageNumber}:${attempt}`;
      const persist = async (status: "completed" | "failed", text: string | null, model: string, events: Array<UsageEvent | null>) => {
        if (!durable) return;
        await durable.recordOcrEscalationRead!({
          runId: state.run.id, documentId: page.documentId, pageNumber: page.pageNumber, attempt, status, text, model,
          usageEvents: events.filter((event): event is UsageEvent => event !== null),
        });
      };
      try {
        // The per-document page and attempt budgets are counted by the guard's durable attempt ledger (run, document, page),
        // so an activity retry or a worker restart cannot reset them; a retried call counts against the attempt budget.
        return await withVisionCall(state, { ...pageRef, purpose: "ocr", documentPageLimit: maxPages, documentAttemptLimit: ocrEscalationMaxAttempts(env) }, async (gate) => {
          let result: Awaited<ReturnType<typeof executeVisionRuntime>>;
          try {
            result = await execute({
              imagePath: page.imagePath, mimeType: page.mimeType, outputPath, vision, cfg: args.cfg, runner: args.runner,
              privacyMode: state.run.pipeline.privacyMode, outputSchema: null, signal, gate,
            });
          } catch (error) {
            // Every billed request behind a failed read is recorded on the route that billed it, and persisted with the call.
            const failed: Array<UsageEvent | null> = [];
            for (const [index, usage] of visionFailureUsages(error, vision, args.cfg, { ...pageRef, purpose }).entries()) {
              const event = usage.kind === "rejected"
                ? state.usageLedger.record(usage.input)
                : state.usageLedger.enqueue({ ...usage.input, amount: usage.input.amount ?? 1, unit: usage.input.unit ?? "attempt", costCents: usage.input.costCents ?? 0, inputTokens: usage.input.inputTokens ?? 0, outputTokens: usage.input.outputTokens ?? 0 }, { logAiUsage: true });
              if (event) event.id = `${callId}:failed:${index}`;
              failed.push(event);
            }
            if (failed.some((event) => event !== null)) await persist("failed", null, ocrEscalationModel(env), failed);
            const stop = findVisionGuardStop(error);
            if (stop?.reason === "document-page-limit" || stop?.reason === "document-attempt-limit") {
              console.warn(`[ocr] ${purpose} budget spent document=${page.documentId} page=${page.pageNumber} max=${maxPages}`);
              throw new HostedOcrSkipped("budget", `${purpose} page budget spent for this document`);
            }
            if (stop) throw new HostedOcrSkipped("guard", toMessage(error));
            throw error;
          }
          const costCents = priceVisionResult(result, args.cfg);
          // A Rich page read, once per run and page (the recogniser's read of the same page already charged it); the
          // provider's actual tokens and cost are recorded on the served route.
          const read = recordVisionRead(state.usageLedger, gate, pageRef, {
            provider: result.route.provider,
            model: result.model,
            metric: purpose,
            amount: 1,
            unit: "page",
            costCents,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            metadata: {
              ...result.costMetadata,
              costSource: result.costMetadata?.costSource ?? (result.costCents !== undefined ? "provider" : "estimate"),
              billing: result.route.billing,
              documentId: page.documentId,
              pageNumber: page.pageNumber,
              purpose,
              usageSource: result.usageSource,
              outcome: result.text.trim() ? "completed" : "empty-output",
              ...(result.servedModel ? { servedModel: result.servedModel } : {}),
            },
          });
          if (read) read.id = callId;
          await persist("completed", result.text, result.model, [read]);
          return { text: result.text, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costCents };
        });
      } finally {
        await rm(outputPath, { force: true }).catch(() => undefined);
      }
    },
  };
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
