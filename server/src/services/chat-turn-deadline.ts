/**
 * Time budget for one search-agent chat turn.
 *
 * A single 120 s `AbortSignal.timeout` used to bound the whole turn. On the
 * 2026-10-20 eval, 129 turns hit it and returned HTTP 500 after the model had
 * already spent provider money gathering evidence, and Cloudflare cut others off
 * at ~120 s with a 524 before the server answered. The deadline now sits below
 * the edge timeout, and the last part of it (`finalReserveMs`) is kept for an
 * answer: once the turn enters the reserve, tools are disabled and the model
 * must answer from the evidence it already has.
 *
 * - `turnDeadlineMs` (CHAT_AGENT_TURN_DEADLINE_MS, default 100 000): hard stop
 *   for the whole turn, counted from when the request reached chat.
 * - `stepTimeoutMs` (CHAT_AGENT_STEP_TIMEOUT_MS, default 45 000): longest model
 *   call for a tool-calling step. It is further capped so the call ends before
 *   the reserve. The final answer step may use all of the remaining time.
 * - `toolTimeoutMs` (CHAT_AGENT_TOOL_TIMEOUT_MS, default 30 000): longest tool
 *   call, also capped to end before the reserve. A tool over budget is cancelled
 *   and returns an error result to the model; the turn continues.
 * - `finalReserveMs` (CHAT_AGENT_FINAL_RESERVE_MS, default 20 000, at most half
 *   the deadline): time kept for the final answer.
 */
export interface ChatTurnTimeBudget {
  turnDeadlineMs: number;
  stepTimeoutMs: number;
  toolTimeoutMs: number;
  finalReserveMs: number;
}

export const CHAT_TURN_TIME_BUDGET_DEFAULTS: ChatTurnTimeBudget = {
  turnDeadlineMs: 100_000, stepTimeoutMs: 45_000, toolTimeoutMs: 30_000, finalReserveMs: 20_000,
};

function readMs(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!value?.trim() || !Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function chatTurnTimeBudget(env: NodeJS.ProcessEnv = process.env): ChatTurnTimeBudget {
  const defaults = CHAT_TURN_TIME_BUDGET_DEFAULTS;
  const turnDeadlineMs = readMs(env.CHAT_AGENT_TURN_DEADLINE_MS, defaults.turnDeadlineMs, 1_000, 900_000);
  return {
    turnDeadlineMs,
    stepTimeoutMs: readMs(env.CHAT_AGENT_STEP_TIMEOUT_MS, defaults.stepTimeoutMs, 500, turnDeadlineMs),
    toolTimeoutMs: readMs(env.CHAT_AGENT_TOOL_TIMEOUT_MS, defaults.toolTimeoutMs, 500, turnDeadlineMs),
    finalReserveMs: Math.min(readMs(env.CHAT_AGENT_FINAL_RESERVE_MS, defaults.finalReserveMs, 100, 900_000), Math.floor(turnDeadlineMs / 2)),
  };
}

/** The turn ran out of time before any answer text existed. Routes answer 504 `chat_deadline_exceeded`. */
export class ChatTurnDeadlineError extends Error {
  readonly code = "chat_deadline_exceeded";
  readonly statusCode = 504;

  constructor(readonly deadlineMs: number, options?: { cause?: unknown }) {
    super(`The chat turn reached its ${Math.round(deadlineMs / 1000)} s deadline before an answer could be produced`, options);
    this.name = "ChatTurnDeadlineError";
  }
}

export function isChatTurnDeadlineError(error: unknown): error is ChatTurnDeadlineError {
  return error instanceof ChatTurnDeadlineError;
}

/** Reason attached to aborts this module fires, so callers can tell them from a client disconnect. */
export class ChatTurnTimeoutReason extends Error {
  constructor(readonly kind: "deadline" | "step" | "tool", ms: number) {
    super(`Chat ${kind === "deadline" ? "turn deadline" : `${kind} timeout`} of ${ms} ms reached`);
    this.name = "TimeoutError";
  }
}

export function isChatTurnTimeout(reason: unknown): reason is ChatTurnTimeoutReason {
  return reason instanceof ChatTurnTimeoutReason;
}

/**
 * One turn's clock and abort signal. `signal` aborts at the deadline or when the
 * caller's signal (client disconnect) aborts; everything the turn starts (model
 * calls, tools, nested searches and their SQL) must run under it or a child of it.
 */
export class ChatTurnDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly endsAt: number;
  private readonly onParentAbort?: () => void;

  constructor(readonly budget: ChatTurnTimeBudget, readonly startedAt = Date.now(), private readonly parent?: AbortSignal) {
    this.endsAt = startedAt + budget.turnDeadlineMs;
    this.signal = this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(new ChatTurnTimeoutReason("deadline", budget.turnDeadlineMs)), Math.max(0, this.endsAt - Date.now()));
    this.timer.unref?.();
    if (parent?.aborted) this.controller.abort(parent.reason);
    else if (parent) {
      this.onParentAbort = () => this.controller.abort(parent.reason);
      parent.addEventListener("abort", this.onParentAbort, { once: true });
    }
  }

  remainingMs(now = Date.now()): number {
    return Math.max(0, this.endsAt - now);
  }

  elapsedMs(now = Date.now()): number {
    return Math.max(0, now - this.startedAt);
  }

  /** Time left is within the final-answer reserve: no more tools. */
  inFinalReserve(now = Date.now()): boolean {
    return this.remainingMs(now) <= this.budget.finalReserveMs;
  }

  /** The hard deadline fired (not a client disconnect). */
  get expired(): boolean {
    return this.signal.aborted && isChatTurnTimeout(this.signal.reason);
  }

  /** The caller's signal aborted: the client is gone. */
  get clientAborted(): boolean {
    return Boolean(this.parent?.aborted);
  }

  /** Budget for one model call: the final answer may use everything left; other steps stop before the reserve. */
  stepBudgetMs(final: boolean, now = Date.now()): number {
    const remaining = this.remainingMs(now);
    return final ? remaining : Math.max(0, Math.min(this.budget.stepTimeoutMs, remaining - this.budget.finalReserveMs));
  }

  /** Budget for one tool call; 0 means the reserve has started and the tool must not run. */
  toolBudgetMs(now = Date.now()): number {
    return Math.max(0, Math.min(this.budget.toolTimeoutMs, this.remainingMs(now) - this.budget.finalReserveMs));
  }

  /** A child of the turn signal that also aborts after `ms`, with a reason naming the budget. */
  child(kind: "step" | "tool", ms: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
    const controller = new AbortController();
    const reason = new ChatTurnTimeoutReason(kind, ms);
    const onAbort = () => controller.abort(this.signal.reason);
    if (this.signal.aborted) controller.abort(this.signal.reason);
    else this.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(reason), Math.max(0, ms));
    timer.unref?.();
    return {
      signal: controller.signal,
      timedOut: () => controller.signal.reason === reason,
      dispose: () => { clearTimeout(timer); this.signal.removeEventListener("abort", onAbort); },
    };
  }

  dispose(): void {
    clearTimeout(this.timer);
    if (this.onParentAbort) this.parent?.removeEventListener("abort", this.onParentAbort);
  }
}

/** Settles with `promise`, or rejects with the signal's reason as soon as it aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
