/*
 * Whether a run bills OCR reads in the OCR page class (ingest-page-ocr), or as before, as Rich reads.
 *
 * Rollout safety: the OCR class is settled by the database (migration 0185) and by completion code that knows it. A worker
 * from before the OCR class would bill a run's OCR pages Fast as well at completion. So a run uses the OCR class only when,
 * at its start, every live worker advertised `billing.ocr-page-class` (the capability handshake, migration 0055) and the
 * operator has not turned it off (DOCSLURP_OCR_PAGE_CLASS=off). The decision is pinned on the run (`run:page-billing-ocr`)
 * so every activity, shard and page task agrees. While an older worker is live, new runs keep billing OCR reads as Rich:
 * no OCR charge is written that an older worker could settle.
 */

/** Run artifact slot holding the run's OCR page class decision: "1" (OCR class) or "0" (OCR reads bill Rich). */
export const OCR_PAGE_CLASS_SLOT = "run:page-billing-ocr";
/** Run artifact slot of the per-read page rule (db/page-base-fee.ts); present on every run started since that rule. */
const PAGE_BILLING_RULES_SLOT = "run:page-billing-rules";

type ArtifactReader = { read(key: string): string | undefined | null };
type ArtifactLedger = ArtifactReader & { record(key: string, value: string): void };

/** DOCSLURP_OCR_PAGE_CLASS: `off` (or `0`, `false`) keeps OCR reads billing Rich for new runs. Default on. */
export function ocrPageClassConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DOCSLURP_OCR_PAGE_CLASS?.trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false");
}

/**
 * Pin the run's decision unless it already has one (a retried start keeps the first value). `fleetSupports` answers
 * whether every live worker advertises the capability; it is asked only when the operator has the class on, and an error
 * reads as no (the old behaviour).
 */
export async function pinRunOcrPageClass(
  state: { artifactLedger: ArtifactLedger },
  fleetSupports: () => Promise<boolean>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const stored = state.artifactLedger.read(OCR_PAGE_CLASS_SLOT);
  if (stored === "1" || stored === "0") return stored === "1";
  const on = ocrPageClassConfigured(env) && await fleetSupports().catch(() => false);
  state.artifactLedger.record(OCR_PAGE_CLASS_SLOT, on ? "1" : "0");
  return on;
}

/**
 * The run's decision: its pin when it has one. A run with the per-read pin but no OCR decision was started by a release
 * before the OCR class and keeps that release's rule (Rich). A state with neither (a run being loaded outside startRun,
 * such as a materialization, or a test) uses the OCR class; the database settles its charges either way.
 */
export function runUsesOcrPageClass(ledger: ArtifactReader): boolean {
  const stored = ledger.read(OCR_PAGE_CLASS_SLOT);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return !ledger.read(PAGE_BILLING_RULES_SLOT);
}
