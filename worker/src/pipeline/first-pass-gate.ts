/*
 * The first pass's publish gate: nothing it extracts becomes searchable before the document's malware verdict is clean.
 *
 * The first pass runs after the quarantine stage today, so the default gate only checks that verdict is recorded: the
 * document's quarantine checkpoint completed (a clean scan) and no stage failed it. Quarantine work that changes when the
 * verdict arrives (a scan that runs beside extraction) replaces the gate with `setFirstPassPublishGate`, never weakens it:
 *  - `awaitClean` resolves true only for a clean verdict, false for anything else (infected, failed, unknown);
 *  - the first pass calls it for every document before the step that marks it keyword searchable (embed), and a document
 *    whose gate does not pass is left to the stage loop, which applies the same rules.
 * With quarantine disabled by configuration (config.quarantineEnabled false) there is no verdict to wait for, exactly as
 * for every other stage.
 */
import type { WorkflowState } from "./pipeline.js";

export interface FirstPassPublishGate {
  /** True only when the document's malware verdict is recorded clean. Never throws for a verdict; throws for infrastructure. */
  awaitClean(args: { state: WorkflowState; documentId: string; quarantineEnabled: boolean; signal?: AbortSignal }): Promise<boolean>;
}

export const recordedVerdictGate: FirstPassPublishGate = {
  async awaitClean({ state, documentId, quarantineEnabled }) {
    const stages = state.documentStages.get(documentId);
    if (stages && [...stages.values()].some((stage) => stage.status === "failed")) return false;
    if (!quarantineEnabled) return true;
    return stages?.get("quarantine")?.status === "completed";
  },
};

let gate: FirstPassPublishGate = recordedVerdictGate;

export function firstPassPublishGate(): FirstPassPublishGate {
  return gate;
}

/** Replace the gate (a concurrent quarantine verdict). Tests reset it with `recordedVerdictGate`. */
export function setFirstPassPublishGate(next: FirstPassPublishGate): void {
  gate = next;
}
