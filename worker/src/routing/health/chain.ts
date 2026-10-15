/**
 * Decision-model fallback chain.
 *
 * Tries an ordered list of decision models for one document. A model is used only
 * if (1) the policy pack has calibrations for it (uncalibrated probabilities must
 * not drive routing), (2) it is healthy (known-answer canary, cached per process)
 * and (3) its answers are not degenerate on the real batch. Anything else falls
 * through to the next model, and when none qualifies the no-model baseline router
 * plans the document. A generative LLM is never a fallback.
 */

import type { DecisionModel, DecisionModelCall, PageInput, PolicyPack, RoutePlan, Router, RoutingBudget, RoutingObjective, RoutingTarget } from "@docslurp/shared";

import { DecisionRequestError, DecisionUnavailableError, type DecisionClient } from "../decision-client.js";
import { DecisionModelRouter, RouterTriageError, type DecisionModelRouterOptions } from "../routers/decision-model.js";
import type { InsetGate } from "../inset-gate.js";
import type { PlannerConfig } from "../planner.js";
import type { TriageOptions } from "../triage.js";
import { runCanary, type CanaryThresholds } from "./canary.js";
import { DecisionDegenerateError } from "./degenerate.js";
import { DecisionModelUnhealthyError, type DecisionModelHealthRegistry } from "./registry.js";

export interface ChainModel {
  model: DecisionModel;
  /** Client that records triage usage. */
  client: DecisionClient;
  triageOptions?: Omit<TriageOptions, "onCall">;
  /** Inset gate served by this model; null for text-only models, undefined to leave the gate off. */
  insetGate?: InsetGate | null;
}

export type ChainOutcome = "served" | "skipped" | "failed";

export interface ChainTraceEntry {
  model: string;
  outcome: ChainOutcome;
  reason: string;
}

export interface DecisionChainOptions {
  pack: PolicyPack;
  /** Resolved chain entries in preference order. */
  models: ChainModel[];
  /** Requested model ids that could not be resolved (not in the catalog / env missing), traced as skipped. */
  unresolved?: string[];
  health: DecisionModelHealthRegistry;
  /** Client that records canary usage (metric page-route-decision-canary). */
  canaryClient: DecisionClient;
  canaryThresholds?: CanaryThresholds;
  /** Optional embedding pre-filter shared by every chain model. */
  prefilter?: DecisionModelRouterOptions["prefilter"];
  /** Builds the no-model baseline router, folding in spend already incurred. */
  baseline: (carry: { calls: DecisionModelCall[]; costUsd: number; skippedReason: string }) => Router;
  documentId?: string;
  runId?: string;
  config?: Partial<PlannerConfig>;
  signal?: AbortSignal;
}

export function packHasCalibrations(pack: PolicyPack, modelId: string): boolean {
  return pack.calibrations.some((c) => c.decisionModel === modelId);
}

function isHealthFailure(error: unknown): boolean {
  if (error instanceof DecisionDegenerateError || error instanceof DecisionModelUnhealthyError) return true;
  if (error instanceof DecisionUnavailableError) return false;
  if (error instanceof DecisionRequestError) {
    // 4xx other than timeout / rate limit blames our request, not the model's health.
    return error.status === null || error.status >= 500 || error.status === 408 || error.status === 429;
  }
  const name = error instanceof Error ? error.name : "";
  // Privacy-guard refusals are policy, not health.
  return !/privacy|provider.?not.?allowed/i.test(name);
}

function reasonOf(error: unknown): string {
  if (error instanceof DecisionModelUnhealthyError) return `${error.reason}${error.cached ? " (cached)" : ""}`.slice(0, 240);
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

export class DecisionModelChainRouter implements Router {
  readonly kind = "decision-model" as const;
  readonly id = "decision-model:chain";
  /** Per-document trace of the last plan() call. */
  trace: ChainTraceEntry[] = [];
  /** Model that produced the triage answers of the last plan(); null when the baseline (or no model call) served it. */
  servedBy: string | null = null;

  constructor(private readonly o: DecisionChainOptions) {}

  async plan(
    pages: PageInput[],
    catalog: RoutingTarget[],
    budget: RoutingBudget,
    objective: RoutingObjective,
  ): Promise<RoutePlan> {
    this.trace = [];
    this.servedBy = null;
    for (const id of this.o.unresolved ?? []) {
      this.trace.push({ model: id, outcome: "skipped", reason: "not-available (not in catalog or credentials missing)" });
    }
    const carry = { calls: [] as DecisionModelCall[], costUsd: 0 };

    for (const entry of this.o.models) {
      const { model } = entry;
      if (!packHasCalibrations(this.o.pack, model.id)) {
        this.trace.push({ model: model.id, outcome: "skipped", reason: `no calibrations in policy pack ${this.o.pack.metadata.policyVersion}` });
        continue;
      }
      const router = new DecisionModelRouter({
        pack: this.o.pack,
        model,
        client: entry.client,
        documentId: this.o.documentId,
        runId: this.o.runId,
        config: this.o.config,
        triageOptions: { ...entry.triageOptions, signal: this.o.signal },
        failOnTriageError: true,
        ...(entry.insetGate !== undefined ? { insetGate: entry.insetGate } : {}),
        ...(this.o.prefilter ? { prefilter: this.o.prefilter } : {}),
        carry: { calls: [...carry.calls], costUsd: carry.costUsd },
        beforeTriage: () =>
          this.o.health.ensureHealthy(model, () =>
            runCanary(this.o.canaryClient, model, { signal: this.o.signal, thresholds: this.o.canaryThresholds })),
      });
      try {
        const plan = await router.plan(pages, catalog, budget, objective);
        if (plan.triage.ran) {
          this.servedBy = model.id;
          this.trace.push({ model: model.id, outcome: "served", reason: this.fallbackNote() });
        } else {
          this.trace.push({
            model: model.id,
            outcome: "served",
            reason: `no triage call needed (${plan.triage.skippedReason ?? "free features sufficed"})`,
          });
        }
        return plan;
      } catch (error) {
        if (this.o.signal?.aborted) throw error;
        const cause = error instanceof RouterTriageError ? error.cause : error;
        if (error instanceof RouterTriageError) {
          carry.calls.push(...error.calls);
          carry.costUsd += error.costUsd;
        }
        const reason = reasonOf(cause);
        if (isHealthFailure(cause) && !(cause instanceof DecisionModelUnhealthyError)) {
          this.o.health.markUnhealthy(model.id, reason);
        }
        this.trace.push({ model: model.id, outcome: "failed", reason });
      }
    }

    const summary = this.trace.map((t) => `${t.model}:${t.outcome}(${t.reason})`).join("; ");
    return this.o.baseline({
      ...carry,
      skippedReason: `decision-chain-exhausted: ${summary || "no decision models configured"}`,
    }).plan(pages, catalog, budget, objective);
  }

  private fallbackNote(): string {
    const earlier = this.trace.filter((t) => t.outcome !== "served");
    return earlier.length === 0 ? "primary" : `fallback after ${earlier.map((t) => `${t.model} ${t.outcome}`).join(", ")}`;
  }
}
