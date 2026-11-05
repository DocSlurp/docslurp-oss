import { pageCredits, speedBoostMultiplier } from "@docslurp/shared";

import type { Document } from "../models.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { RunPolicyError } from "./document-failure.js";

/** The page count admission priced for a document: durable (migration 0130), never the count a measurement wrote. */
export function intakePagesOf(document: Pick<Document, "pageCount" | "intakePageCount">): number {
  const intake = document.intakePageCount ?? document.pageCount;
  return Math.max(1, Math.trunc(Number(intake)) || 1);
}

/**
 * Authorization of measured pages, separate from measuring them and run on every attempt (a retry included): when this
 * document measured above what admission priced, check the balance for every Fast page the run measured above its intake
 * counts (store.measuredPagesAboveIntake, from durable billing state), none of which is charged before completion. Never
 * inferred from page_count or page_count_source: a retry after a failed check finds the measurement persisted and must
 * still be authorized. Fails closed: an unfunded run is paused and the document stopped (RunPolicyError); a check that
 * cannot decide throws SpendCheckUnavailableError (retryable).
 */
export async function authorizeMeasuredPages(state: WorkflowState, document: Document): Promise<{ checkedPages: number } | null> {
  const measured = Math.max(Number(document.billingPages) || 0, Math.trunc(Number(document.pageCount)) || 0);
  if (!(measured > intakePagesOf(document))) return null;
  const store = state.store;
  if (!store?.enforceSpendForCharge || !state.run.userId) return null;
  if (!store.measuredPagesAboveIntake) throw new Error("measured pages need a store that reads them durably");
  const pages = await store.measuredPagesAboveIntake(state.run.id);
  if (!(pages > 0)) return { checkedPages: 0 };
  const credits = pageCredits("fast", pages) * speedBoostMultiplier(state.run.pipeline.speedBoost === true);
  const outcome = await store.enforceSpendForCharge({ id: state.run.id, orgId: state.run.orgId ?? null, workspaceId: state.run.workspaceId, userId: state.run.userId }, credits);
  if (outcome.paused || outcome.blocked) {
    console.warn(`[page-auth] run=${state.run.id} document=${document.id} stopped: ${pages} measured pages above intake owe ${credits.toFixed(2)} credits more than the balance holds (paused=${outcome.paused})`);
    throw new RunPolicyError(`Credits do not cover the measured pages of document ${document.id}; run ${outcome.paused ? "paused" : "stopped"}`);
  }
  return { checkedPages: pages };
}
