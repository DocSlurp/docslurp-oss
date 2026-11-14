/*
 * Sizes and versions for the summary tree. Every function in this folder takes its limits as a parameter and
 * falls back to these, so a caller that owns shared constants passes them in and nothing here has to change.
 */

export interface SummaryTreeLimits {
  /** Smallest side a similarity cut may leave inside an over-size section, in leaves. */
  minLeavesPerGroup: number;
  /** Largest leaf group, in leaves. A section at or under it is one group however small. */
  maxLeavesPerGroup: number;
  /** Smallest side a similarity cut may leave among sibling nodes. */
  minFanIn: number;
  /** Largest number of children under one upper-level node. */
  maxFanIn: number;
  /** Documents with fewer summarizable leaves are skipped. */
  minDocumentLeaves: number;
  /** Documents whose leaves are tables in a larger share than this are skipped. */
  maxTableLeafShare: number;
  /** Length target of one summary, in words. A target, not a cap. */
  summaryLengthWords: number;
}

export const DEFAULT_SUMMARY_TREE_LIMITS: SummaryTreeLimits = {
  minLeavesPerGroup: 4,
  maxLeavesPerGroup: 16,
  minFanIn: 3,
  maxFanIn: 10,
  minDocumentLeaves: 24,
  maxTableLeafShare: 0.5,
  summaryLengthWords: 150,
};

/** Bump when the grouping or hashing rules change in a way that must not reuse older summaries. */
export const SUMMARY_TREE_KEY_VERSION = 1;
/** Bump whenever the instruction, the output contract or the way source text is laid out in the prompt changes. */
export const SUMMARY_TREE_PROMPT_VERSION = "summary-tree-prompt@1";
/** Name of the text operation the stage records its model calls under. */
export const SUMMARY_TREE_TEXT_OPERATION = "summary-tree";
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
  integer("minFanIn", 1);
  integer("maxFanIn", 2);
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
