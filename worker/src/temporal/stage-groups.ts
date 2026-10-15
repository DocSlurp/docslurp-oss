/**
 * Which adjacent stages share one activity.
 *
 * Workflow-safe: pure and deterministic, no I/O and no Temporal imports.
 *
 * Every stage boundary costs a Temporal round trip plus a run reload (~3 s in
 * production), which dominates small documents. Stages run one after another
 * either way, and each keeps its own run and document checkpoints inside a
 * group, so grouping only removes boundaries. A stage with work the workflow
 * dispatches before its stage pass (document shards, the vision page fan-out)
 * can lead a group, but never join one in the middle: that work has to start
 * after the previous stage finished.
 */
export function planStageGroupEnd(args: {
  stageOrder: readonly string[];
  /** Position of the group's first stage. */
  start: number;
  /** Stages allowed to share an activity (recorded in workflow input). */
  groupable: ReadonlySet<string>;
  /** True when the workflow dispatches work for the stage before its stage pass. */
  needsPreWork: (stageName: string) => boolean;
}): number {
  const { stageOrder, start, groupable, needsPreWork } = args;
  if (!groupable.has(stageOrder[start]!)) return start + 1;
  let end = start + 1;
  while (end < stageOrder.length && groupable.has(stageOrder[end]!) && !needsPreWork(stageOrder[end]!)) end++;
  return end;
}
