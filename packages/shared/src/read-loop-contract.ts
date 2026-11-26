/**
 * Read loop contract: one bounded way to read an input that is larger than a model's context.
 *
 * A loop is a task, a slice strategy, a loop condition and budgets. Code drives it: every step is one fresh model call
 * over a batch of slices (no tools, no message history), and the reply is the task's whole new state plus an optional
 * list of proposed next actions. Proposals are the loop's form of parallel tool calls: a reply may carry several, and
 * the engine runs every admitted read and search of one wave concurrently. The engine, never the model, decides what is
 * read: it validates each proposal against a closed vocabulary, clamps it to the source's own unread units, charges it
 * against the budgets and only then executes it.
 *
 * Trust: slice text, file names, metadata and everything a model writes after reading them are untrusted. Nothing in a
 * reply can change a budget, the source, the task or the allowed actions. A proposed stop is advice.
 *
 * This file is types, constants and the `ReadStepError` class only. The engine is `read-loop.ts`.
 */

/** What a loop addresses: pages (1-based) or chunks (0-based index) of already-extracted text. Never source bytes. */
export type ReadUnit = "page" | "chunk";

/** The addressable range of one loop, inclusive at both ends. Set by the caller from values it measured itself. */
export interface ReadSource {
  unit: ReadUnit;
  first: number;
  last: number;
}

/** A contiguous run of units, inclusive at both ends. */
export interface SliceRef {
  unit: ReadUnit;
  start: number;
  end: number;
}

/**
 * What the slice port returns. It may answer one requested ref with several slices (for example around a withheld
 * page). Units of a requested ref that no returned slice covers count as missing. Only `ok` slices carry text.
 */
export type Slice =
  | { ref: SliceRef; status: "ok"; text: string }
  | { ref: SliceRef; status: "withheld" | "missing" };

/** The closed vocabulary a model may propose from. Parsed from untrusted JSON by `parseNextActions`. */
export type NextAction =
  /** Exact unit, or the inclusive range `at..to`. */
  | { do: "read"; unit: ReadUnit; at: number; to?: number }
  /** Relative to the units read in the step that produced this reply: the `span` units after, before or on both sides. */
  | { do: "read"; unit: ReadUnit; relative: "next" | "prev" | "around"; span: number }
  /** An outline or tree node the model was shown. Resolved by the `resolveNode` port. */
  | { do: "read"; node: string }
  /** Keyword search inside this loop's source; each hit is widened by `expand` units on both sides. */
  | { do: "search"; terms: string[]; expand?: number }
  | { do: "stop"; reason: "answered" | "nothing-relevant" };

export const ACTION_KINDS = ["read-exact", "read-relative", "read-node", "search", "stop"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Bounds on a proposal list, applied while parsing. Anything beyond them is dropped and counted. */
export const NEXT_ACTIONS_MAX = 16;
export const SEARCH_TERMS_MAX = 8;
export const SEARCH_TERM_MAX_CHARS = 60;
export const SEARCH_EXPAND_MAX = 5;
export const NODE_ID_MAX_CHARS = 128;

/** One model reply. `next` is untrusted and unparsed: the engine validates it. */
export interface StepReply<S> {
  state: S;
  next?: unknown;
}

export interface ReadTask<S> {
  /** Stable id with a prompt version, for example `document-labels@1`. */
  id: string;
  init: S;
  /**
   * `representative`: a sample can answer, so `done` and an advisory stop may end the loop.
   * `exhaustive`: every unit matters, so only exhaustion or a budget ends it.
   */
  coverage: "representative" | "exhaustive";
  /** Proposals of any other kind are dropped and counted. An empty list makes the loop strategy-only. */
  allowedActions: readonly ActionKind[];
  /** Steps that must complete before `done` or a proposed stop is honoured. Default 1. */
  minSteps?: number;
  /**
   * One model read over a batch. Returns the whole new state (small, bounded, validated by the task) and what the call
   * cost. Throwing fails this step only: the state is kept and the batch's units are counted as failed.
   *
   * A failed call may still have spent money. If the thrown value is an object with a finite, non-negative number
   * `costCents` and/or `inputTokens`, the engine adds them to usage before handling the failure, so `maxCostCents` and
   * `maxInputTokens` see them. Throw a `ReadStepError` to do this. Nothing else on a thrown value is read or trusted.
   */
  step(args: { state: S; slices: Array<Extract<Slice, { status: "ok" }>>; step: number; signal: AbortSignal }): Promise<{
    reply: StepReply<S>;
    costCents: number;
    /** Provider-reported input tokens when known; the engine's estimate is used otherwise. */
    inputTokens?: number;
  }>;
  /** The loop condition, evaluated in code on two consecutive states. */
  done?(previous: S, next: S, step: number): boolean;
}

/**
 * The default plan. Called once per wave for the units the model's proposals did not fill. Must be deterministic and
 * return only unseen units inside `source`; the engine clamps what it returns anyway. `[]` means nothing is left.
 */
export type SliceStrategy = (ctx: {
  source: ReadSource;
  /** Units already requested in any earlier wave, read or not. */
  seen: ReadonlySet<number>;
  /** 1-based wave number. */
  wave: number;
  /** Most units this call may return. */
  room: number;
}) => SliceRef[];

/** Throw from `ReadTask.step` to report what a failed call spent. The engine reads only these two numbers. */
export class ReadStepError extends Error {
  readonly costCents?: number;
  readonly inputTokens?: number;
  constructor(message: string, spent: { costCents?: number; inputTokens?: number } = {}, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReadStepError";
    this.costCents = spent.costCents;
    this.inputTokens = spent.inputTokens;
  }
}

/** Every limit is enforced by the engine before the work it bounds. */
export interface ReadBudget {
  /** Model calls. */
  maxSteps: number;
  /** Units requested per wave (model proposals plus strategy). */
  maxUnitsPerStep: number;
  /** One slice is clipped to this many estimated tokens. */
  maxSliceTokens: number;
  /** Estimated tokens of slice text in one call; slices that do not fit go back to unread. */
  maxStepTokens: number;
  /** Slice tokens across the whole loop. */
  maxInputTokens: number;
  /** Proposals executed across the whole loop (reads and searches). */
  maxActions: number;
  maxSearches: number;
  /** Share of a wave's units the model's proposals may take, 0 to 1. The strategy fills the rest. */
  maxModelDirectedShare: number;
  maxWallMs: number;
  maxCostCents: number;
  /** Reads and searches of one wave in flight at once. */
  concurrency: number;
  /**
   * Consecutive waves that produced no step (every requested unit came back missing or withheld) before the loop stops
   * with `unreadable`. A wave that produces a step resets the count. Required: callers must choose it. Each step-less
   * wave also yields to the macrotask queue once, so a port that stops answering cannot spin the event loop. A source
   * small enough to be consumed within this many waves still ends `exhausted`.
   */
  maxEmptyWaves: number;
  /** Optional, default 0. Do not start a step (or plan a wave) when less wall time than this remains: stop `wall-clock`. */
  minStepWallMs?: number;
}

/**
 * Where a loop starts when its caller already holds text or already chose what to read first: a pipeline stage that has
 * sampled pages, or a chat tool starting from search hits. Set by the caller, so it is trusted and not charged as
 * model actions. Still clamped to the source.
 */
export interface ReadSeed {
  /** Units read elsewhere. Never planned and not counted as read by this loop. */
  seen?: readonly number[];
  /**
   * Text the caller already holds. It is the first step's batch: no port read, no clipping. Its units count as seen and,
   * after a successful step, as read; its estimated tokens count against the token budgets. Wins over `refs`.
   */
  batch?: ReadonlyArray<Extract<Slice, { status: "ok" }>>;
  /** The first wave, when there is no `batch`: at most `maxUnitsPerStep` units, the strategy fills any room left. */
  refs?: readonly SliceRef[];
}

export interface ReadPorts {
  /** Token estimate used to clip slices and enforce the token budgets. Should over-count rather than under-count. */
  estimateTokens(text: string): number;
  /** Read extracted text for these refs. Scoping to the caller's organization and document is the port's job. */
  read(refs: SliceRef[], signal: AbortSignal): Promise<Slice[]>;
  /** Keyword search inside the same source. Absent: search proposals are dropped. */
  search?(terms: string[], signal: AbortSignal): Promise<SliceRef[]>;
  /** Resolve a node id the model was shown. Absent or null: the proposal is dropped. */
  resolveNode?(nodeId: string): SliceRef | null;
  /** External stop, checked before every step (for example the run's cost cap). */
  shouldStop?(): boolean;
  now?(): number;
  signal?: AbortSignal;
}

export type ReadStoppedBy =
  | "done" | "exhausted" | "model-stop"
  | "steps" | "input-tokens" | "wall-clock" | "cost" | "errors" | "aborted"
  /** `maxEmptyWaves` consecutive waves produced no readable text. */
  | "unreadable";

export interface ReadResult<S> {
  /** `complete` for done, exhausted and model-stop; `partial` for every budget, error, unreadable or abort stop. */
  status: "complete" | "partial";
  stoppedBy: ReadStoppedBy;
  /** The best state so far. Always present: a budget stop is a result, never an exception. */
  state: S;
  coverage: {
    unitsTotal: number;
    /** Units whose text reached a successful step. */
    unitsRead: number;
    withheld: number;
    missing: number;
    /** Units in batches whose step threw. */
    failed: number;
    /** Sorted, merged ranges of the units read. */
    ranges: Array<[number, number]>;
    /** Proposals refused: malformed, not allowed, out of range, already seen, or over a budget. */
    proposalsDropped: number;
  };
  usage: {
    steps: number;
    failedSteps: number;
    actions: number;
    searches: number;
    inputTokens: number;
    costCents: number;
    wallMs: number;
  };
}
