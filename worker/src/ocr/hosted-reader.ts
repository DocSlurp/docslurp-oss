/*
 * Hosted page reads for OCR: the escalation read of a page the recogniser read poorly (`ocr-escalation`), and the read of
 * a stored image in DOCSLURP_OCR_MODE=hosted (`hosted-ocr`). Both go through the worker's guarded vision call path:
 * the project privacy mode, the run cost cap, the run's vision attempt guard (per-page, breaker, org and route
 * bounds, and a per-document page budget counted in its durable ledger), and the usage ledger with the provider's actual tokens and cost.
 *
 * The bytes sent are never produced on the worker host: an escalation image is the PNG the OCR boundary wrote (checked
 * by signature and size only), and a hosted-mode image is the stored file as uploaded. Neither is a substitute for a
 * missing VM: escalation only follows a VM (or self-hosted) read, and hosted mode is its own operator setting.
 */
import { admitAutomaticCall, DEFAULT_OCR_ESCALATION_MODEL, isAutomaticSelectionDenied, ocrEscalationAutomaticRoute, ocrEscalationRoutes, pageUpgradeCredits, prepareAutomaticCallPrices, reportAutomaticCallOutcome, speedBoostMultiplier, switchDisabled, type OcrEscalationRoute } from "@docslurp/shared";
import { randomUUID } from "node:crypto";
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
import { recordOcrEscalationPages, type OcrEscalationSkipReason } from "./escalation-stats.js";
import { findProviderRoutingExclusion } from "../lib/provider-retry.js";
import { recordPoolFailover, recordPoolServed, secondReadPoolMemberId } from "../lib/capability-pools.js";
import { findVisionBilledUsage, findVisionOutputRejected } from "../tools/vision-stream.js";

export { DEFAULT_OCR_ESCALATION_MODEL } from "@docslurp/shared";
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
  /** The capability pool member that read the page (capability-pools.ts poolMemberId), for per-page records. */
  poolMemberId?: string;
}

/** Why a hosted read did not happen. Escalation keeps the recogniser's text; hosted mode fails the page. */
export class HostedOcrSkipped extends Error {
  constructor(readonly reason: "disabled" | "privacy" | "cost-cap" | "budget" | "guard" | "margin" | "unfunded" | "unknown-billed", message: string) {
    super(message);
    this.name = "HostedOcrSkipped";
  }
}

export interface HostedOcrReader {
  read(page: HostedOcrPage, purpose: HostedOcrPurpose, signal?: AbortSignal): Promise<HostedOcrRead>;
  /** Record a document's escalated pages and the pages the per-document cap left on their first read (escalation-stats.ts). */
  recordEscalation?(documentId: string, pages: { escalated: readonly number[]; capped: readonly number[]; skipped?: Partial<Record<OcrEscalationSkipReason, readonly number[]>> }): void;
}

/** Whether escalation runs (`DOCSLURP_OCR_ESCALATION=on`): an explicit operator opt-in, off by default. */
export function ocrEscalationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // DOCSLURP_DISABLE=ai-escalation (or `ai`) turns escalation off whatever the flag says.
  if (switchDisabled(env, "ai-escalation")) return false;
  const raw = env.DOCSLURP_OCR_ESCALATION?.trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true";
}

/** Hosted providers the OCR reader may use; a local or private route would read the boundary's PNGs on another host. */
const HOSTED_OCR_PROVIDERS = new Set(["deepinfra", "openrouter", "openai"]);

/**
 * The escalation model: `DOCSLURP_OCR_ESCALATION_MODEL`, else the default (the first reader of OCR_ESCALATION_ROUTES).
 * Escalation is automatic, so a denylisted model (automatic-model-selection.ts) is refused as an override (logged) and
 * the default used; every escalation read also passes the automatic-call gate at its route's price (`read`).
 */
export function ocrEscalationModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DOCSLURP_OCR_ESCALATION_MODEL?.trim();
  if (configured && isAutomaticSelectionDenied(configured)) {
    console.warn("[ocr] DOCSLURP_OCR_ESCALATION_MODEL names a model that is never selected automatically; using the default");
    return DEFAULT_OCR_ESCALATION_MODEL;
  }
  return configured || DEFAULT_OCR_ESCALATION_MODEL;
}

/**
 * The hosted readers to try, in order (shared ocr-escalation-routes.ts): the configured model alone, or the default
 * chain (GLM 5.3 Flash under its price ceiling, then Qwen3-VL on DeepInfra).
 */
export function ocrEscalationReaders(env: NodeJS.ProcessEnv = process.env): readonly OcrEscalationRoute[] {
  const configured = env.DOCSLURP_OCR_ESCALATION_MODEL?.trim();
  return ocrEscalationRoutes(configured && !isAutomaticSelectionDenied(configured) ? configured : null);
}

/** Every model an escalation may read with (the price refresher tracks them). */
export function ocrEscalationModels(env: NodeJS.ProcessEnv = process.env): string[] {
  return ocrEscalationReaders(env).map((route) => route.model);
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
  /** Test seam: a route's read timeout (default: the route's own `timeoutMs`). */
  routeTimeoutMs?: (route: OcrEscalationRoute) => number | undefined;
}): HostedOcrReader {
  const env = args.env ?? process.env;
  const execute = args.execute ?? executeVisionRuntime;
  const { state } = args;
  return {
    recordEscalation(documentId, pages) {
      recordOcrEscalationPages(state.artifactLedger, documentId, pages);
    },
    async read(page, purpose, signal) {
      if (purpose === "ocr-escalation" && !ocrEscalationEnabled(env)) throw new HostedOcrSkipped("disabled", "OCR escalation is off");
      if (!HOSTED_OCR_MIME_TYPES.has(page.mimeType)) throw new Error(`hosted OCR refuses ${page.mimeType}: it would need host decoding`);
      // The readers to try, in order. Each must be a hosted route the project's privacy mode allows and, for an escalation,
      // pass the automatic-call gate at the price its request can reach (automatic-call-margin.ts); a refused reader is
      // skipped with a logged reason and the next one tried. None left: the recogniser's text stands.
      type Candidate = { route: OcrEscalationRoute; vision: VisionConfig; decision: ReturnType<typeof admitAutomaticCall> | null; memberId: string | null };
      const candidates: Candidate[] = [];
      let refusal: HostedOcrSkipped | null = null;
      // The ocr pool's second-read members, in pool order (capability-pools.ts); an operator pool that leaves a route out skips it.
      const readers = ocrEscalationReaders(env).map((route) => ({ route, memberId: secondReadPoolMemberId(route.optionId) }))
        .filter(({ memberId }) => memberId !== null);
      const nextMember = (index: number) => readers[index + 1]?.memberId ?? null;
      for (const [readerIndex, { route: reader, memberId }] of readers.entries()) {
        const vision: VisionConfig = { ...visionConfigForModel(state.run.pipeline.vision, reader.model), prompt: "markdown-transcription", remoteFallbackModelUri: null };
        const route = resolveVisionRoute(vision);
        if (!HOSTED_OCR_PROVIDERS.has(route.provider)) {
          console.error(`[ocr] ${purpose} reader refused: DOCSLURP_OCR_ESCALATION_MODEL must be a hosted, priced model (provider=${route.provider})`);
          refusal ??= new HostedOcrSkipped("disabled", `${purpose} model is not a hosted route`);
          continue;
        }
        if (!(await allowHostedCall(state, visionCall(route), [page.documentId]))) {
          refusal ??= new HostedOcrSkipped("privacy", `privacy mode refuses ${purpose}`);
          recordPoolFailover("ocr", memberId, nextMember(readerIndex), "privacy");
          continue;
        }
        let decision: ReturnType<typeof admitAutomaticCall> | null = null;
        if (purpose === "ocr-escalation") {
          const automatic = ocrEscalationAutomaticRoute(reader);
          await prepareAutomaticCallPrices("page-transcription", [automatic]);
          decision = admitAutomaticCall("page-transcription", automatic, purpose, { role: "escalation" });
          if (!decision.allowed) {
            if (!refusal || refusal.reason !== "margin") refusal = new HostedOcrSkipped("margin", `${purpose} refused by the automatic-call gate (${decision.reason})`);
            recordPoolFailover("ocr", memberId, nextMember(readerIndex), "margin");
            continue;
          }
        }
        candidates.push({ route: reader, vision, decision, memberId });
      }
      if (candidates.length === 0) throw refusal ?? new HostedOcrSkipped("disabled", `no ${purpose} reader`);
      if (isCostCapExceeded(state)) throw new HostedOcrSkipped("cost-cap", `run cost cap reached before ${purpose}`);
      const maxPages = ocrEscalationMaxPages(env);
      const pageRef = { documentId: page.documentId, pageNumber: page.pageNumber };
      const outputPath = `${page.imagePath}.${purpose}.json`;
      // Escalation reads are persisted as each call returns (ocr_escalation_reads). A retried activity reuses the page's
      // completed read instead of calling the provider again, and re-buffers every earlier call's usage under its own id, so
      // its provider cost is recorded exactly once even when the activity that made it never reached its checkpoint.
      const store = state.store;
      const durable = purpose === "ocr-escalation" && store?.ocrEscalationReads && store.recordOcrEscalationRead ? store : null;
      if (durable) {
        const prior = await durable.ocrEscalationReads!(state.run.id, page.documentId, page.pageNumber);
        const pending = new Set(state.usageLedger.snapshot().map((event) => event.id));
        for (const row of prior) for (const event of row.usageEvents) if (event.id && !pending.has(event.id)) state.usageLedger.enqueue(event);
        const done = prior.find((row) => row.status === "completed" && row.text !== null);
        if (done) {
          console.log(`[ocr] ${purpose} reused document=${page.documentId} page=${page.pageNumber} attempt=${done.attempt}: no new provider call`);
          const reusedMember = candidates.find((candidate) => candidate.route.model === done.model)?.memberId;
          return { text: done.text!, model: done.model, inputTokens: 0, outputTokens: 0, costCents: 0, ...(reusedMember ? { poolMemberId: reusedMember } : {}) };
        }
      }
      // A new escalation read upgrades its page from OCR to Rich: before the call, the balance must cover that upgrade plus the
      // run's charges still buffered here. Read-only: an unfunded org skips the escalation (the page keeps its OCR read) and
      // the run goes on, unpaused; a check that cannot decide throws SpendCheckUnavailableError (retryable).
      if (purpose === "ocr-escalation") await authorizeEscalationRead(state, page);
      // Unique per real call: two calls of the same page (overlapping activities) never share a usage id, so neither's cost
      // is dropped by the ledger's id dedup. Replays reuse the ids persisted with the call.
      const callId = `${purpose}:${state.run.id}:${page.documentId}:${page.pageNumber}:${randomUUID()}`;
      const persist = async (status: "completed" | "failed", text: string | null, model: string, events: Array<UsageEvent | null>) => {
        if (!durable) return;
        await durable.recordOcrEscalationRead!({
          runId: state.run.id, documentId: page.documentId, pageNumber: page.pageNumber, status, text, model,
          usageEvents: events.filter((event): event is UsageEvent => event !== null),
        });
      };
      try {
        for (const [index, candidate] of candidates.entries()) {
        const { vision, decision: marginDecision } = candidate;
        const ceiling = candidate.route.priceCeiling;
        // A route with its own timeout (a slow host) is bounded: past it the request was sent and may have been billed, so
        // the page is not read again by the next reader; it keeps its first read and is recorded as unknown-billed.
        const timeoutMs = (args.routeTimeoutMs ?? ((route: OcrEscalationRoute) => route.timeoutMs))(candidate.route);
        const routeTimeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
        const readSignal = routeTimeout ? (signal ? AbortSignal.any([signal, routeTimeout]) : routeTimeout) : signal;
        try {
        // The per-document page and attempt budgets are counted by the guard's durable attempt ledger (run, document, page),
        // so an activity retry or a worker restart cannot reset them; a retried call counts against the attempt budget.
        return await withVisionCall(state, { ...pageRef, purpose: "ocr", documentPageLimit: maxPages, documentAttemptLimit: ocrEscalationMaxAttempts(env) }, async (gate) => {
          let result: Awaited<ReturnType<typeof executeVisionRuntime>>;
          try {
            result = await execute({
              imagePath: page.imagePath, mimeType: page.mimeType, outputPath, vision, cfg: args.cfg, runner: args.runner,
              privacyMode: state.run.pipeline.privacyMode, outputSchema: null, signal: readSignal, gate,
              ...(ceiling ? { priceCeiling: { inputUsdPerMillion: ceiling.inputUsdPerMTok, outputUsdPerMillion: ceiling.outputUsdPerMTok, imageUsd: ceiling.imageUsd, hosts: ceiling.hosts } } : {}),
            });
          } catch (error) {
            // Every billed request behind a failed read is recorded on the route that billed it, and persisted with the call.
            const failed: Array<UsageEvent | null> = [];
            for (const [index, usage] of visionFailureUsages(error, vision, args.cfg, { ...pageRef, purpose }).entries()) {
              const event = usage.kind === "rejected"
                ? state.usageLedger.record(usage.input)
                : state.usageLedger.enqueue({ ...usage.input, amount: usage.input.amount ?? 1, unit: usage.input.unit ?? "attempt", costCents: usage.input.costCents ?? 0, inputTokens: usage.input.inputTokens ?? 0, outputTokens: usage.input.outputTokens ?? 0 }, { logAiUsage: true });
              // Per reader: a failed GLM read and a failed Qwen read of one page never share an id (both costs are kept).
              if (event) event.id = `${callId}:${candidate.route.optionId}:failed:${index}`;
              failed.push(event);
            }
            if (failed.some((event) => event !== null)) await persist("failed", null, candidate.route.model, failed);
            const stop = findVisionGuardStop(error);
            if (stop?.reason === "document-page-limit" || stop?.reason === "document-attempt-limit") {
              console.warn(`[ocr] ${purpose} budget spent document=${page.documentId} page=${page.pageNumber} max=${maxPages}`);
              throw new HostedOcrSkipped("budget", `${purpose} page budget spent for this document`);
            }
            if (stop) throw new HostedOcrSkipped("guard", toMessage(error));
            throw error;
          }
          const costCents = priceVisionResult(result, args.cfg);
          if (marginDecision) {
            reportAutomaticCallOutcome(marginDecision, { costUsd: result.costCents !== undefined ? result.costCents / 100 : null, inputTokens: result.inputTokens, outputTokens: result.outputTokens }, purpose);
          }
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
              ...(candidate.memberId ? { poolMemberId: candidate.memberId } : {}),
              ...(result.servedModel ? { servedModel: result.servedModel } : {}),
            },
          });
          if (read) read.id = callId;
          await persist("completed", result.text, result.model, [read]);
          recordPoolServed("ocr", candidate.memberId);
          return { text: result.text, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costCents,
            ...(candidate.memberId ? { poolMemberId: candidate.memberId } : {}) };
        });
        } catch (error) {
          // The route's own timeout fired (not the caller's abort): the request was sent and may have been billed. No
          // fall-through to the next reader (it would read and bill the page again); the page keeps its first read.
          if (routeTimeout?.aborted && !signal?.aborted) {
            console.warn(`[ocr] ${purpose} reader=${candidate.route.optionId} document=${page.documentId} page=${page.pageNumber} timed out (possibly billed)`);
            recordPoolFailover("ocr", candidate.memberId, null, "timeout");
            // The possible charge stays visible: a usage event of unknown cost, flagged, on the route that was sent.
            const unknown = state.usageLedger.enqueue({
              provider: "openrouter", model: candidate.route.model.replace(/^llm:\/\/[^/]+\//, ""), metric: purpose, amount: 1, unit: "attempt",
              costCents: 0, inputTokens: 0, outputTokens: 0,
              metadata: { documentId: page.documentId, pageNumber: page.pageNumber, purpose, outcome: "timeout", costSource: "unknown", possiblyBilled: true,
                ...(candidate.memberId ? { poolMemberId: candidate.memberId } : {}) },
            }, { logAiUsage: true });
            if (unknown) unknown.id = `${callId}:${candidate.route.optionId}:timeout`;
            await persist("failed", null, candidate.route.model, [unknown]);
            throw new HostedOcrSkipped("unknown-billed", `${purpose}: the read timed out after it was sent; it may have been billed`);
          }
          // No host could serve this reader under its price ceiling (nothing billed): the next reader, else skip. Never sent
          // to a pricier host.
          if (!findProviderRoutingExclusion(error)) throw error;
          // A refusal after an attempt of this reader was served and billed (its output rejected, then the retry refused):
          // that read happened, so the page is not read again by the next reader; it fails like any rejected read.
          if (findVisionBilledUsage(error) || findVisionOutputRejected(error)) throw error;
          console.warn(`[ocr] ${purpose} reader=${candidate.route.optionId} document=${page.documentId} page=${page.pageNumber} no host under its price ceiling`);
          // Nothing was billed: a routing refusal is a failover, never a breaker failure (the guard handed it back).
          recordPoolFailover("ocr", candidate.memberId, candidates[index + 1]?.memberId ?? null, "routing");
          if (index === candidates.length - 1) throw new HostedOcrSkipped("margin", `${purpose}: no host can serve the read under its price ceiling`);
        }
        }
        throw new HostedOcrSkipped("margin", `${purpose}: no reader left`);
      } finally {
        await rm(outputPath, { force: true }).catch(() => undefined);
      }
    },
  };
}

/**
 * The balance check before an escalation read: the page's upgrade from OCR to Rich, plus this activity's buffered charges.
 * Read-only (largestFundedCharge): it never pauses the run. Fails closed: no store to check with, no user or no organization
 * skips the escalation, as an unfunded balance does.
 */
async function authorizeEscalationRead(state: WorkflowState, page: HostedOcrPage): Promise<void> {
  const store = state.store;
  const skip = (why: string): never => {
    console.warn(`[ocr] ocr-escalation skipped run=${state.run.id} document=${page.documentId} page=${page.pageNumber} reason=${why}`);
    throw new HostedOcrSkipped("unfunded", `the escalation read is not funded (${why}); the page keeps its OCR read`);
  };
  if (!store?.largestFundedCharge || !state.run.userId || !state.run.orgId) skip("no-balance-check");
  const credits = pageUpgradeCredits("ocr", "rich") * speedBoostMultiplier(state.run.pipeline.speedBoost === true) + state.usageLedger.pendingBillableCents;
  const funded = await store!.largestFundedCharge!({ id: state.run.id, orgId: state.run.orgId ?? null, projectId: state.run.projectId }, 1, () => credits);
  if (funded < 1) skip("unfunded");
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
