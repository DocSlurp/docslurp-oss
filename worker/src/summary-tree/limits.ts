import {
  SUMMARY_TREE_KEY_VERSION,
  SUMMARY_TREE_MAX_FAN_IN,
  SUMMARY_TREE_MAX_GROUP_SIZE,
  SUMMARY_TREE_MAX_LEVELS,
  SUMMARY_TREE_MAX_NODES_PER_DOCUMENT,
  SUMMARY_TREE_MAX_TABLE_LEAF_SHARE,
  SUMMARY_TREE_MIN_DOCUMENT_LEAVES,
  SUMMARY_TREE_MIN_FAN_IN,
  SUMMARY_TREE_MIN_GROUP_SIZE,
  SUMMARY_TREE_SUMMARY_TARGET_WORDS,
  type PipelineTextOperation,
} from "@docslurp/shared";

/*
 * Sizes and versions for the summary tree. The values are the server constants in @docslurp/shared
 * (summary-tree.ts): this file only names them for the functions in this folder, each of which takes its limits
 * as a parameter so a test or an eval can pass others.
 */

export interface SummaryTreeLimits {
  /** A leaf group under this size is "small": it merges with a neighbour when one fits. Also the smallest side of a similarity cut. */
  minLeavesPerGroup: number;
  /** Largest leaf group, in leaves. */
  maxLeavesPerGroup: number;
  /** Fewest siblings that get a parent of their own (the root excepted). Also the smallest side of a similarity cut among siblings. */
  minFanIn: number;
  /** Largest number of children under one upper-level node. */
  maxFanIn: number;
  /** Levels above the leaves, root included. */
  maxLevels: number;
  /**
   * Hard ceiling of nodes one document may have. The cap a build applies scales with the document's leaves
   * (`summaryTreeNodeCap`, at most this); the caller refuses a document over it before any model call.
   */
  maxNodes: number;
  /** Documents with fewer summarizable leaves are skipped. */
  minDocumentLeaves: number;
  /** Documents whose leaves are tables in a larger share than this are skipped. */
  maxTableLeafShare: number;
  /** Length target of one summary, in words. A target, not a cap. */
  summaryLengthWords: number;
}

export const DEFAULT_SUMMARY_TREE_LIMITS: SummaryTreeLimits = {
  minLeavesPerGroup: SUMMARY_TREE_MIN_GROUP_SIZE,
  maxLeavesPerGroup: SUMMARY_TREE_MAX_GROUP_SIZE,
  minFanIn: SUMMARY_TREE_MIN_FAN_IN,
  maxFanIn: SUMMARY_TREE_MAX_FAN_IN,
  maxLevels: SUMMARY_TREE_MAX_LEVELS,
  maxNodes: SUMMARY_TREE_MAX_NODES_PER_DOCUMENT,
  minDocumentLeaves: SUMMARY_TREE_MIN_DOCUMENT_LEAVES,
  maxTableLeafShare: SUMMARY_TREE_MAX_TABLE_LEAF_SHARE,
  summaryLengthWords: SUMMARY_TREE_SUMMARY_TARGET_WORDS,
};

/** Part of every node hash; owned by @docslurp/shared so the server reports the same number. */
export { SUMMARY_TREE_KEY_VERSION };
/** Bump whenever the instruction, the output contract or the way source text is laid out in the prompt changes. */
export const SUMMARY_TREE_PROMPT_VERSION = "summary-tree-prompt@3";
/** Name of the text operation the stage records its model calls under. */
export const SUMMARY_TREE_TEXT_OPERATION = "summary-tree" satisfies PipelineTextOperation;
/** Summaries are written at the reasoning floor; a cut-off answer gets more output tokens, never more reasoning. */
export const SUMMARY_TREE_REASONING_EFFORT = "none";

export class SummaryTreeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryTreeInputError";
  }
}

export function resolveSummaryTreeLimits(overrides?: Partial<SummaryTreeLimits>): SummaryTreeLimits {
  const limits = { ...DEFAULT_SUMMARY_TREE_LIMITS, ...overrides };
  const integer = (name: keyof SummaryTreeLimits, floor: number) => {
    if (!Number.isInteger(limits[name]) || limits[name] < floor) {
      throw new SummaryTreeInputError(`summary tree limit ${name} must be an integer of at least ${floor}`);
    }
  };
  integer("minLeavesPerGroup", 1);
  integer("maxLeavesPerGroup", 1);
  integer("minFanIn", 2);
  integer("maxFanIn", 2);
  integer("maxLevels", 2);
  integer("maxNodes", 1);
  integer("minDocumentLeaves", 1);
  integer("summaryLengthWords", 1);
  // A section one over the maximum must still have a cut that leaves both sides at the minimum.
  if (limits.maxLeavesPerGroup < 2 * limits.minLeavesPerGroup - 1) {
    throw new SummaryTreeInputError("summary tree limit maxLeavesPerGroup must be at least 2 * minLeavesPerGroup - 1");
  }
  if (limits.maxFanIn < 2 * limits.minFanIn - 1) {
    throw new SummaryTreeInputError("summary tree limit maxFanIn must be at least 2 * minFanIn - 1");
  }
  if (!(limits.maxTableLeafShare >= 0 && limits.maxTableLeafShare <= 1)) {
    throw new SummaryTreeInputError("summary tree limit maxTableLeafShare must be between 0 and 1");
  }
  return limits;
}
