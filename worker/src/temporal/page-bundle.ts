import type { UsageSummary, VisionPageTask } from "./shared.js";

/** Each page keeps its own durable lease and charge, including across bundle retries. */
export async function runPageBundle(
  tasks: VisionPageTask[],
  runPage: (task: VisionPageTask) => Promise<UsageSummary>,
): Promise<UsageSummary> {
  if (tasks.length > 8) throw new Error("Page bundles are limited to eight pages");
  const total: UsageSummary = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  let cursor = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(2, tasks.length) }, async () => {
    while (cursor < tasks.length && !failure) {
      try {
        const usage = await runPage(tasks[cursor++]!);
        total.inputTokens += usage.inputTokens;
        total.outputTokens += usage.outputTokens;
        total.costCents += usage.costCents;
      } catch (error) {
        failure = error;
      }
    }
  }));
  // No retry can overlap an unfinished sibling page from this attempt.
  if (failure) throw failure;
  return total;
}
