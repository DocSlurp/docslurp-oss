import { appendFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Opt-in statement trace for round-trip diagnostics. With DOCSLURP_DB_TRACE_FILE
 * set, every statement the worker's stage Store sends is appended as one JSON
 * line `{label, sql}`, where `label` names the activity/stage that issued it
 * (propagated through async context). Disabled, it adds no work.
 */
const labels = new AsyncLocalStorage<string>();
const file = process.env.DOCSLURP_DB_TRACE_FILE?.trim();

export const dbTraceEnabled = Boolean(file);

/** Runs `fn` with `label` attached to every statement it issues. */
export function withDbTraceLabel<T>(label: string, fn: () => T): T {
  return file ? labels.run(label, fn) : fn();
}

/** Appends `suffix` to the current label (e.g. activity -> activity/stage). */
export function extendDbTraceLabel<T>(suffix: string, fn: () => T): T {
  if (!file) return fn();
  const current = labels.getStore();
  return labels.run(current ? `${current}/${suffix}` : suffix, fn);
}

export function dbTraceStatementHook(): ((fingerprint: string) => void) | undefined {
  if (!file) return undefined;
  return (sql) => appendFileSync(file, `${JSON.stringify({ t: Date.now(), label: labels.getStore() ?? "-", sql })}\n`);
}
