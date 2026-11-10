import type { BackgroundTask } from "@mastra/core/background-tasks";

export const MAX_OPERATION_ATTEMPTS = 3;
// Output is capped at 262,144 bytes per logical operation. Even empty JSON
// payloads consume bytes, so a retained attempt cannot exhaust this range.
export const ATTEMPT_CURSOR_STRIDE = 1_000_000;

/** Native task rows own attempts; metadata describes their application identity. */
export function operationAttempts(tasks: BackgroundTask[]) {
  if (tasks.length > MAX_OPERATION_ATTEMPTS) throw new Error("operation_attempt_limit");
  const ordered = [...tasks].sort((a, b) => attemptOrdinal(a) - attemptOrdinal(b));
  for (const [index, task] of ordered.entries()) {
    if (attemptOrdinal(task) !== index || task.maxRetries !== 0 || task.retryCount !== 0 ||
        index > 0 && (task.metadata?.retryOf !== ordered[index - 1]!.id ||
          typeof task.metadata?.retryKey !== "string") ||
        index < ordered.length - 1 && !["failed", "timed_out"].includes(task.status)) {
      throw new Error("operation_attempt_conflict");
    }
  }
  return ordered;
}

export function attemptOrdinal(task: BackgroundTask): number {
  const value = task.metadata?.attemptOrdinal ?? 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= MAX_OPERATION_ATTEMPTS) {
    throw new Error("operation_attempt_conflict");
  }
  return Number(value);
}

/** Dispatch arguments identify the invocation, not merely the latest row. */
export function executionAttempt(tasks:BackgroundTask[],args:Record<string,unknown>,ownerId:string) {
  const task=operationAttempts(tasks).at(-1);
  if(!task||task.status!=="running"||task.ownerId!==ownerId||
    task.args.attemptNonce!==args.attemptNonce||attemptOrdinal(task)!==(args.attemptOrdinal??0)) {
    throw new Error("native_execution_fence");
  }
  return task;
}
