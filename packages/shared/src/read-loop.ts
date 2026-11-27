/**
 * Read loop engine. See `read-loop-contract.ts` for the types and the trust rules.
 *
 * The engine is pure: it touches only the task, strategy and ports it is given. Every limit is checked before the work
 * it bounds, and nothing a model writes can change a budget, the source or the allowed actions.
 */

import {
  NEXT_ACTIONS_MAX,
  NODE_ID_MAX_CHARS,
  SEARCH_EXPAND_MAX,
  SEARCH_TERMS_MAX,
  SEARCH_TERM_MAX_CHARS,
  type ActionKind,
  type NextAction,
  type ReadBudget,
  type ReadPorts,
  type ReadResult,
  type ReadSeed,
  type ReadSource,
  type ReadStoppedBy,
  type ReadTask,
  type ReadUnit,
  type Slice,
  type SliceRef,
  type SliceStrategy,
} from "./read-loop-contract.js";

type OkSlice = Extract<Slice, { status: "ok" }>;

/**
 * Run `task(0..count-1)` with at most `concurrency` in flight and return the results in index order. Every job is
 * settled: a rejected job never cancels or starves its siblings, and its slot holds `undefined`. Callers that need to
 * tell failure apart catch inside the job.
 */
async function settleBounded<T>(count: number, concurrency: number, task: (index: number) => Promise<T>): Promise<Array<T | undefined>> {
  const results: Array<T | undefined> = new Array(count).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      try {
        results[index] = await task(index);
      } catch {
        results[index] = undefined;
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, count));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isUnit = (value: unknown): value is ReadUnit => value === "page" || value === "chunk";
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_TERMS_SCANNED = SEARCH_TERMS_MAX * 8;
const MAX_HITS_SCANNED = 1000;

function parseAction(raw: unknown): NextAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.do === "stop") {
    return r.reason === "answered" || r.reason === "nothing-relevant" ? { do: "stop", reason: r.reason } : null;
  }
  if (r.do === "search") {
    if (!Array.isArray(r.terms)) return null;
    const terms: string[] = [];
    for (let i = 0; i < Math.min(r.terms.length, MAX_TERMS_SCANNED) && terms.length < SEARCH_TERMS_MAX; i++) {
      const term = r.terms[i];
      if (typeof term !== "string") continue;
      const clean = term.slice(0, SEARCH_TERM_MAX_CHARS * 4).replace(CONTROL_CHARS, "").trim();
      const clipped = Array.from(clean).slice(0, SEARCH_TERM_MAX_CHARS).join("").trim();
      if (clipped) terms.push(clipped);
    }
    if (terms.length === 0) return null;
    if (r.expand === undefined || r.expand === null) return { do: "search", terms };
    if (!isInt(r.expand)) return null;
    return { do: "search", terms, expand: Math.min(SEARCH_EXPAND_MAX, Math.max(0, r.expand)) };
  }
  if (r.do !== "read") return null;
  if (r.node !== undefined && r.node !== null) {
    if (typeof r.node !== "string") return null;
    const node = r.node.trim();
    return node && node.length <= NODE_ID_MAX_CHARS ? { do: "read", node } : null;
  }
  if (!isUnit(r.unit)) return null;
  if (r.relative !== undefined && r.relative !== null) {
    if (r.relative !== "next" && r.relative !== "prev" && r.relative !== "around") return null;
    return isInt(r.span) && r.span >= 1 ? { do: "read", unit: r.unit, relative: r.relative, span: r.span } : null;
  }
  if (!isInt(r.at)) return null;
  if (r.to === undefined || r.to === null) return { do: "read", unit: r.unit, at: r.at };
  return isInt(r.to) && r.to >= r.at ? { do: "read", unit: r.unit, at: r.at, to: r.to } : null;
}

/** Validate untrusted JSON into proposals. Never throws; counts what it refuses. */
export function parseNextActions(input: unknown): { actions: NextAction[]; dropped: number } {
  let value = input;
  if (value === undefined || value === null) return { actions: [], dropped: 0 };
  // One action written as a bare object, not a one-item list, is the same proposal.
  if (typeof value === "object" && !Array.isArray(value)) value = [value];
  if (!Array.isArray(value)) return { actions: [], dropped: 1 };
  const actions: NextAction[] = [];
  let dropped = Math.max(0, value.length - NEXT_ACTIONS_MAX);
  for (let i = 0; i < Math.min(value.length, NEXT_ACTIONS_MAX); i++) {
    let parsed: NextAction | null = null;
    try {
      parsed = parseAction(value[i]);
    } catch {
      parsed = null;
    }
    if (parsed) actions.push(parsed);
    else dropped++;
  }
  return { actions, dropped };
}

export function actionKind(action: NextAction): ActionKind {
  if (action.do === "search" || action.do === "stop") return action.do;
  if ("node" in action) return "read-node";
  return "relative" in action ? "read-relative" : "read-exact";
}

/** Unseen units from the start of the source, as runs of at most `windowSize`, until `room` is filled. */
export function sequentialWindows(windowSize: number): SliceStrategy {
  const size = Math.max(1, Math.floor(windowSize) || 1);
  return ({ source, seen, room }) => {
    const refs: SliceRef[] = [];
    let used = 0;
    let runStart = -1;
    let lastTaken = -1;
    const close = (end: number) => {
      if (runStart >= 0) refs.push({ unit: source.unit, start: runStart, end });
      runStart = -1;
    };
    for (let u = source.first; u <= source.last && used < room; u++) {
      if (seen.has(u)) {
        close(u - 1);
        continue;
      }
      if (runStart < 0) runStart = u;
      used++;
      lastTaken = u;
      if (u - runStart + 1 >= size) close(u);
    }
    close(lastTaken);
    return refs;
  };
}

/**
 * Divide until stable. Wave 1 takes a head and a tail window; then each window is centred on the midpoint of the
 * largest remaining unseen gap (lowest start wins a tie) until `room` is filled.
 */
export function stratifiedRounds(windowSize: number): SliceStrategy {
  const size = Math.max(1, Math.floor(windowSize) || 1);
  return ({ source, seen, wave, room }) => {
    const taken = new Set<number>();
    const refs: SliceRef[] = [];
    const gaps = (): Array<[number, number]> => {
      const out: Array<[number, number]> = [];
      let start = -1;
      for (let u = source.first; u <= source.last + 1; u++) {
        const open = u <= source.last && !seen.has(u) && !taken.has(u);
        if (open && start < 0) start = u;
        if (!open && start >= 0) {
          out.push([start, u - 1]);
          start = -1;
        }
      }
      return out;
    };
    const add = (start: number, end: number) => {
      refs.push({ unit: source.unit, start, end });
      for (let u = start; u <= end; u++) taken.add(u);
    };
    if (wave === 1) {
      const head = gaps()[0];
      if (head) add(head[0], Math.min(head[1], head[0] + Math.min(size, room) - 1));
      const left = room - taken.size;
      const tail = gaps().at(-1);
      if (left > 0 && tail) add(Math.max(tail[0], tail[1] - Math.min(size, left) + 1), tail[1]);
    }
    while (taken.size < room) {
      let best: [number, number] | undefined;
      for (const gap of gaps()) if (!best || gap[1] - gap[0] > best[1] - best[0]) best = gap;
      if (!best) break;
      const width = Math.min(size, room - taken.size, best[1] - best[0] + 1);
      const start = best[0] + Math.floor((best[1] - best[0] + 1 - width) / 2);
      add(start, start + width - 1);
    }
    return refs;
  };
}

function validateInputs(source: ReadSource, budget: ReadBudget): void {
  if (!isUnit(source.unit) || !isInt(source.first) || !isInt(source.last) || source.first > source.last) {
    throw new Error("read loop: invalid source");
  }
  if (typeof budget.maxEmptyWaves !== "number") throw new Error("read loop: invalid budget maxEmptyWaves");
  for (const [key, value] of Object.entries(budget)) {
    if (key === "minStepWallMs" && value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`read loop: invalid budget ${key}`);
    }
  }
  if (budget.maxModelDirectedShare > 1) throw new Error("read loop: invalid budget maxModelDirectedShare");
}

/** Clip text to at most `max` estimated tokens on a word boundary. */
function clipToTokens(text: string, max: number, estimateTokens: (text: string) => number): { text: string; tokens: number } {
  const full = estimateTokens(text);
  if (full <= max) return { text, tokens: full };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(text.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  if (cut > 0 && cut < text.length && !/\s/.test(text[cut]!)) {
    const boundary = /\s\S*$/.exec(text.slice(0, cut));
    if (boundary && boundary.index > 0) cut = boundary.index;
  }
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut--;
  const clipped = text.slice(0, cut).trimEnd();
  return { text: clipped, tokens: estimateTokens(clipped) };
}

function mergeRanges(units: Set<number>): Array<[number, number]> {
  const sorted = [...units].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const u of sorted) {
    const last = out.at(-1);
    if (last && u === last[1] + 1) last[1] = u;
    else out.push([u, u]);
  }
  return out;
}

function runsOf(units: number[]): number[][] {
  const runs: number[][] = [];
  for (const u of units) {
    const run = runs.at(-1);
    if (run && u === run[run.length - 1]! + 1) run.push(u);
    else runs.push([u]);
  }
  return runs;
}

export async function runReadLoop<S>(args: {
  task: ReadTask<S>;
  source: ReadSource;
  strategy: SliceStrategy;
  budget: ReadBudget;
  ports: ReadPorts;
  /** Where the loop starts, when the caller already holds text or chose the first reads. Never throws on a bad seed. */
  seed?: ReadSeed;
}): Promise<ReadResult<S>> {
  const { task, source, strategy, budget, ports } = args;
  validateInputs(source, budget);
  const now = ports.now ?? Date.now;
  const startedAt = now();
  const total = source.last - source.first + 1;
  const room = Math.floor(budget.maxUnitsPerStep);
  const concurrency = Math.max(1, Math.floor(budget.concurrency));
  const minSteps = task.minSteps ?? 1;
  const allowed = new Set<ActionKind>(task.allowedActions);
  const inSource = (u: number) => u >= source.first && u <= source.last;
  // A broken estimator must not break the loop: fall back to one token per four characters, rounded up.
  const estimate = (text: string): number => {
    try {
      const n = ports.estimateTokens(text);
      if (Number.isFinite(n) && n >= 0) return n;
    } catch {
      // fall through
    }
    return Math.ceil(text.length / 4);
  };

  const seen = new Set<number>();
  const readUnits = new Set<number>();
  const withheld = new Set<number>();
  const missing = new Set<number>();
  const failedUnits = new Set<number>();
  let state = task.init;
  let pending: NextAction[] = [];
  let anchor: { min: number; max: number } | null = null;
  let steps = 0;
  let failedSteps = 0;
  let consecutiveFailures = 0;
  let actions = 0;
  let searches = 0;
  let inputTokens = 0;
  let costCents = 0;
  let proposalsDropped = 0;
  let wave = 0;
  let emptyWaves = 0;
  const minStepWallMs = typeof budget.minStepWallMs === "number" ? budget.minStepWallMs : 0;

  // The seed is trusted but still validated: a bad value is ignored, never an error.
  const seedInput: ReadSeed | undefined = args.seed && typeof args.seed === "object" ? args.seed : undefined;
  if (Array.isArray(seedInput?.seen)) for (const u of seedInput.seen) if (isInt(u) && inSource(u)) seen.add(u);
  const goodRef = (ref: unknown): ref is SliceRef => {
    const r = ref as SliceRef | null;
    return !!r && typeof r === "object" && r.unit === source.unit && isInt(r.start) && isInt(r.end) && r.start <= r.end;
  };
  /** Units a slice covers inside the source. */
  const unitsInSource = (ref: SliceRef): number[] => {
    const out: number[] = [];
    for (let u = Math.max(ref.start, source.first); u <= Math.min(ref.end, source.last); u++) out.push(u);
    return out;
  };
  let seedBatch: { slices: OkSlice[]; units: number[]; tokens: number } | null = null;
  if (Array.isArray(seedInput?.batch)) {
    const slices: OkSlice[] = [];
    const unitSet = new Set<number>();
    for (const slice of seedInput.batch) {
      if (!slice || typeof slice !== "object" || slice.status !== "ok" || typeof slice.text !== "string" || !goodRef(slice.ref)) continue;
      const inside = unitsInSource(slice.ref);
      if (inside.length === 0) continue;
      slices.push(slice);
      for (const u of inside) unitSet.add(u);
    }
    if (slices.length > 0) {
      slices.sort((a, b) => a.ref.start - b.ref.start);
      const units = [...unitSet].sort((a, b) => a - b);
      seedBatch = { slices, units, tokens: slices.reduce((sum, slice) => sum + estimate(slice.text), 0) };
    }
  }
  const seedRefs: SliceRef[] = !seedBatch && Array.isArray(seedInput?.refs) ? seedInput.refs.filter(goodRef) : [];

  let seedRefsPending = seedRefs.length > 0;

  // One controller for the run: the outer signal and the wall-clock budget both abort it.
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort();
  if (ports.signal?.aborted) ctl.abort();
  ports.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, Math.min(budget.maxWallMs, 2 ** 31 - 1));
  const deadlinePassed = () => timedOut || now() - startedAt >= budget.maxWallMs;

  const finish = (stoppedBy: ReadStoppedBy): ReadResult<S> => ({
    status: stoppedBy === "done" || stoppedBy === "exhausted" || stoppedBy === "model-stop" ? "complete" : "partial",
    stoppedBy,
    state,
    coverage: {
      unitsTotal: total,
      unitsRead: readUnits.size,
      withheld: withheld.size,
      missing: missing.size,
      failed: failedUnits.size,
      ranges: mergeRanges(readUnits),
      proposalsDropped,
    },
    usage: { steps, failedSteps, actions, searches, inputTokens, costCents, wallMs: Math.max(0, now() - startedAt) },
  });

  /** Unseen, in-source units of the given refs that this wave has not taken yet, at most `cap`. */
  const collect = (refs: SliceRef[], taken: Set<number>, cap: number): number[] => {
    const out: number[] = [];
    const picked = new Set<number>();
    for (const ref of refs) {
      const end = Math.min(ref.end, source.last);
      for (let u = Math.max(ref.start, source.first); u <= end && out.length < cap; u++) {
        if (!seen.has(u) && !taken.has(u) && !picked.has(u)) {
          picked.add(u);
          out.push(u);
        }
      }
    }
    return out;
  };

  const validRef = (ref: unknown): ref is SliceRef => {
    const r = ref as SliceRef | null;
    return !!r && typeof r === "object" && r.unit === source.unit && isInt(r.start) && isInt(r.end) && r.start <= r.end;
  };

  const resolveRead = (action: Extract<NextAction, { do: "read" }>): SliceRef | null => {
    if ("node" in action) {
      try {
        const ref = ports.resolveNode?.(action.node);
        return validRef(ref) ? ref : null;
      } catch {
        return null;
      }
    }
    if (action.unit !== source.unit) return null;
    if ("relative" in action) {
      if (!anchor) return null;
      const after = { unit: source.unit, start: anchor.max + 1, end: anchor.max + action.span };
      const before = { unit: source.unit, start: anchor.min - action.span, end: anchor.min - 1 };
      if (action.relative === "next") return after;
      if (action.relative === "prev") return before;
      return { unit: source.unit, start: before.start, end: after.end };
    }
    return { unit: source.unit, start: action.at, end: action.to ?? action.at };
  };

  /** Resolve the model's pending proposals into units, charging budgets. Returns the pieces to read. */
  const planModel = async (taken: Set<number>): Promise<number[][]> => {
    const proposals = pending;
    pending = [];
    const allowance = budget.maxModelDirectedShare > 0 && room >= 1 ? Math.max(1, Math.floor(room * budget.maxModelDirectedShare)) : 0;
    if (allowance === 0) {
      proposalsDropped += proposals.length;
      return [];
    }
    type Candidate = { refs: SliceRef[] } | { terms: string[]; expand: number; index: number };
    const candidates: Candidate[] = [];
    const searchJobs: string[][] = [];
    for (const action of proposals) {
      if (action.do === "stop") continue;
      if (actions >= budget.maxActions) {
        proposalsDropped++;
      } else if (action.do === "search") {
        if (!ports.search || searches >= budget.maxSearches) {
          proposalsDropped++;
          continue;
        }
        actions++;
        searches++;
        candidates.push({ terms: action.terms, expand: action.expand ?? 0, index: searchJobs.length });
        searchJobs.push(action.terms);
      } else {
        const ref = resolveRead(action);
        if (!ref || collect([ref], taken, 1).length === 0) {
          proposalsDropped++;
          continue;
        }
        actions++;
        candidates.push({ refs: [ref] });
      }
    }
    // One failing search never loses the others: each job catches its own error.
    const hits = await settleBounded(searchJobs.length, concurrency, async (i) => {
      try {
        const found = await ports.search!(searchJobs[i]!, ctl.signal);
        return Array.isArray(found) ? found.slice(0, MAX_HITS_SCANNED) : null;
      } catch {
        return null;
      }
    });
    const pieces: number[][] = [];
    let remaining = allowance;
    for (const candidate of candidates) {
      let refs: SliceRef[];
      if ("refs" in candidate) {
        refs = candidate.refs;
      } else {
        const found = hits[candidate.index];
        refs = (found ?? []).filter(validRef).map((r) => ({ ...r, start: r.start - candidate.expand, end: r.end + candidate.expand }));
      }
      const available = collect(refs, taken, Math.max(remaining, 1));
      if (available.length === 0) {
        proposalsDropped++;
        continue;
      }
      const units = available.slice(0, remaining);
      for (const u of units) taken.add(u);
      remaining -= units.length;
      pieces.push(...runsOf(units));
    }
    return pieces;
  };

  try {
    for (;;) {
      // 1. Stop checks, before any work.
      if (ports.signal?.aborted) return finish("aborted");
      if (seen.size >= total) return finish("exhausted");
      try {
        if (ports.shouldStop?.()) return finish("cost");
      } catch {
        // A throwing external check is not a reason to stop.
      }
      if (steps >= budget.maxSteps) return finish("steps");
      if (inputTokens >= budget.maxInputTokens) return finish("input-tokens");
      if (costCents >= budget.maxCostCents) return finish("cost");
      if (now() - startedAt >= budget.maxWallMs || budget.maxWallMs - (now() - startedAt) < minStepWallMs) return finish("wall-clock");

      let batch: OkSlice[];
      let batchTokens = 0;
      let batchUnits: number[] = [];
      if (seedBatch) {
        // The caller's own text is the first step: nothing is read or clipped, and it is never dropped for its size.
        ({ slices: batch, tokens: batchTokens, units: batchUnits } = seedBatch);
        seedBatch = null;
        for (const u of batchUnits) seen.add(u);
      } else {
        // 2. Plan the wave: the seed's refs (first wave only) and the model's proposals first, then the strategy fills the rest.
        wave++;
        const seenBefore = seen.size;
        const taken = new Set<number>();
        const pieces: SliceRef[] = (await planModel(taken)).map((run) => ({ unit: source.unit, start: run[0]!, end: run[run.length - 1]! }));
        if (seedRefsPending) {
          // The caller's chosen first reads: trusted, so neither charged as actions nor held to the model-directed share.
          seedRefsPending = false;
          for (const run of runsOf(collect(seedRefs, taken, room))) {
            for (const u of run) taken.add(u);
            pieces.push({ unit: source.unit, start: run[0]!, end: run[run.length - 1]! });
          }
        }
        const left = room - taken.size;
        if (left > 0) {
          let planned: SliceRef[] = [];
          try {
            planned = strategy({ source, seen: new Set([...seen, ...taken]), wave, room: left });
          } catch {
            planned = [];
          }
          let budgetLeft = left;
          for (const ref of Array.isArray(planned) ? planned : []) {
            if (!validRef(ref) || budgetLeft <= 0) continue;
            const units = collect([ref], taken, budgetLeft);
            for (const u of units) taken.add(u);
            budgetLeft -= units.length;
            for (const run of runsOf(units)) pieces.push({ unit: source.unit, start: run[0]!, end: run[run.length - 1]! });
          }
        }
        if (taken.size === 0) return finish("exhausted");
        for (const u of taken) seen.add(u);

        // 4. Read the wave in up to `concurrency` parallel calls.
        const groupCount = Math.min(concurrency, pieces.length);
        const groups: SliceRef[][] = Array.from({ length: groupCount }, () => []);
        pieces.forEach((piece, i) => groups[i % groupCount]!.push(piece));
        const outcomes = await settleBounded(groups.length, concurrency, async (g) => {
          try {
            const out = await ports.read(groups[g]!, ctl.signal);
            return Array.isArray(out) ? out : null;
          } catch {
            return null;
          }
        });
        const oks: OkSlice[] = [];
        groups.forEach((group, g) => {
          const requested = new Set<number>();
          for (const ref of group) for (let u = ref.start; u <= ref.end; u++) requested.add(u);
          const covered = new Set<number>();
          for (const slice of outcomes[g] ?? []) {
            if (!slice || !validRef(slice.ref)) continue;
            const { start, end } = slice.ref;
            if (slice.status === "ok") {
              if (typeof slice.text !== "string" || start < source.first || end > source.last) continue;
              let inside = true;
              for (let u = start; u <= end && inside; u++) inside = requested.has(u) && !covered.has(u);
              if (!inside) continue;
              for (let u = start; u <= end; u++) covered.add(u);
              oks.push(slice);
            } else if (slice.status === "withheld" || slice.status === "missing") {
              for (let u = Math.max(start, source.first); u <= Math.min(end, source.last); u++) {
                if (!requested.has(u) || covered.has(u)) continue;
                covered.add(u);
                (slice.status === "withheld" ? withheld : missing).add(u);
              }
            }
          }
          for (const u of requested) if (!covered.has(u)) missing.add(u);
        });

        // 5. Fit: clip each slice, then admit in unit order while the batch fits.
        oks.sort((a, b) => a.ref.start - b.ref.start);
        const remainingInput = budget.maxInputTokens - inputTokens;
        batch = [];
        for (const slice of oks) {
          const clipped = clipToTokens(slice.text, budget.maxSliceTokens, estimate);
          const fits = batchTokens + clipped.tokens <= budget.maxStepTokens && batchTokens + clipped.tokens <= remainingInput;
          if ((fits || (batch.length === 0 && remainingInput > 0))) {
            batch.push({ ref: slice.ref, status: "ok", text: clipped.text });
            batchTokens += clipped.tokens;
          } else {
            for (let u = slice.ref.start; u <= slice.ref.end; u++) seen.delete(u);
          }
        }
        if (batch.length === 0) {
          if (seen.size <= seenBefore) return finish("exhausted");
          // A wave with no step: bound the run of them and let timers and other requests run between waves.
          emptyWaves++;
          if (emptyWaves >= budget.maxEmptyWaves) return finish("unreadable");
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (ports.signal?.aborted) return finish("aborted");
          if (deadlinePassed()) return finish("wall-clock");
          continue;
        }
        for (const slice of batch) for (let u = slice.ref.start; u <= slice.ref.end; u++) batchUnits.push(u);
      }

      // 6. Step.
      if (ports.signal?.aborted) return finish("aborted");
      if (deadlinePassed() || budget.maxWallMs - (now() - startedAt) < minStepWallMs) return finish("wall-clock");
      emptyWaves = 0;
      steps++;
      let out: Awaited<ReturnType<ReadTask<S>["step"]>>;
      try {
        out = await task.step({ state, slices: batch, step: steps, signal: ctl.signal });
        void out.reply.state;
      } catch (error) {
        // A failed call may have spent money: read only two numeric fields, defensively, and charge them.
        try {
          const spent = error as { costCents?: unknown; inputTokens?: unknown } | null;
          if (spent && typeof spent === "object") {
            const c = spent.costCents;
            const t = spent.inputTokens;
            if (typeof c === "number" && Number.isFinite(c) && c >= 0) costCents += c;
            if (typeof t === "number" && Number.isFinite(t) && t >= 0) inputTokens += t;
          }
        } catch {
          // A hostile getter reports nothing.
        }
        if (ports.signal?.aborted) return finish("aborted");
        if (deadlinePassed()) return finish("wall-clock");
        failedSteps++;
        consecutiveFailures++;
        for (const u of batchUnits) failedUnits.add(u);
        pending = [];
        if (consecutiveFailures >= 2) return finish("errors");
        continue;
      }

      // 7. Success.
      consecutiveFailures = 0;
      const providerTokens = out.inputTokens;
      inputTokens += typeof providerTokens === "number" && Number.isFinite(providerTokens) && providerTokens >= 0 ? providerTokens : batchTokens;
      if (Number.isFinite(out.costCents) && out.costCents > 0) costCents += out.costCents;
      for (const u of batchUnits) readUnits.add(u);
      const previous = state;
      state = out.reply.state;
      anchor = { min: batchUnits[0]!, max: batchUnits[batchUnits.length - 1]! };
      const parsed = parseNextActions(out.reply.next);
      proposalsDropped += parsed.dropped;
      pending = [];
      let stopAdvice = false;
      for (const action of parsed.actions) {
        if (!allowed.has(actionKind(action))) proposalsDropped++;
        else if (action.do === "stop") stopAdvice = true;
        else pending.push(action);
      }
      const completed = steps - failedSteps;
      if (stopAdvice) {
        if (task.coverage === "representative" && completed >= minSteps) return finish("model-stop");
        proposalsDropped++;
      }
      if (task.done && task.coverage === "representative" && completed >= minSteps) {
        let done = false;
        try {
          done = task.done(previous, state, steps);
        } catch {
          done = false;
        }
        if (done) return finish("done");
      }
    }
  } finally {
    clearTimeout(timer);
    ports.signal?.removeEventListener("abort", onAbort);
  }
}
