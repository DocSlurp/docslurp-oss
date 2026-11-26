import { describe, expect, it } from "vitest";

import { NEXT_ACTIONS_MAX, SEARCH_EXPAND_MAX, SEARCH_TERMS_MAX, SEARCH_TERM_MAX_CHARS } from "./read-loop-contract.js";
import type { ReadBudget, ReadPorts, ReadSeed, ReadSource, ReadTask, Slice, SliceRef, SliceStrategy } from "./read-loop-contract.js";
import { actionKind, parseNextActions, runReadLoop, sequentialWindows, stratifiedRounds } from "./read-loop.js";

// A coarse estimator is enough for the engine tests: about one token per four characters, rounded up.
const estimateTokens = (text: string): number => (text ? Math.ceil(text.length / 4) : 0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pageSource = (last: number): ReadSource => ({ unit: "page", first: 1, last });
const BUDGET: ReadBudget = {
  maxSteps: 50,
  maxUnitsPerStep: 4,
  maxSliceTokens: 1000,
  maxStepTokens: 100000,
  maxInputTokens: 1000000,
  maxActions: 50,
  maxSearches: 10,
  maxModelDirectedShare: 0.5,
  maxWallMs: 60000,
  maxCostCents: 1000,
  concurrency: 3,
};

type State = number[];
interface Harness {
  batches: number[][];
  reads: SliceRef[][];
  task: ReadTask<State>;
  ports: ReadPorts;
}

/** A task whose state is the list of first units it has seen; `replies[i]` is the `next` of step i+1. */
function harness(opts: {
  replies?: unknown[];
  coverage?: "representative" | "exhaustive";
  allowed?: ReadTask<State>["allowedActions"];
  minSteps?: number;
  done?: ReadTask<State>["done"];
  failSteps?: number[];
  cost?: number;
  text?: (unit: number) => string;
  slices?: (refs: SliceRef[]) => Slice[];
  ports?: Partial<ReadPorts>;
}): Harness {
  const batches: number[][] = [];
  const reads: SliceRef[][] = [];
  const text = opts.text ?? ((u: number) => `page ${u} text`);
  const task: ReadTask<State> = {
    id: "test@1",
    init: [],
    coverage: opts.coverage ?? "representative",
    allowedActions: opts.allowed ?? ["read-exact", "read-relative", "read-node", "search", "stop"],
    minSteps: opts.minSteps,
    done: opts.done,
    async step({ state, slices, step }) {
      batches.push(slices.map((s) => s.ref.start));
      if (opts.failSteps?.includes(step)) throw new Error("model down");
      return { reply: { state: [...state, ...slices.map((s) => s.ref.start)], next: opts.replies?.[step - 1] }, costCents: opts.cost ?? 1 };
    },
  };
  const ports: ReadPorts = {
    estimateTokens,
    async read(refs) {
      reads.push(refs);
      if (opts.slices) return opts.slices(refs);
      return refs.flatMap((ref) =>
        Array.from({ length: ref.end - ref.start + 1 }, (_, i): Slice => ({
          ref: { unit: ref.unit, start: ref.start + i, end: ref.start + i },
          status: "ok",
          text: text(ref.start + i),
        })),
      );
    },
    ...opts.ports,
  };
  return { batches, reads, task, ports };
}

const run = (h: Harness, last: number, budget: Partial<ReadBudget> = {}, strategy: SliceStrategy = sequentialWindows(2), seed?: ReadSeed) =>
  runReadLoop({ task: h.task, source: pageSource(last), strategy, budget: { ...BUDGET, ...budget }, ports: h.ports, ...(seed ? { seed } : {}) });

describe("parseNextActions", () => {
  it("handles non-arrays", () => {
    expect(parseNextActions(undefined)).toEqual({ actions: [], dropped: 0 });
    expect(parseNextActions(null)).toEqual({ actions: [], dropped: 0 });
    expect(parseNextActions("read everything")).toEqual({ actions: [], dropped: 1 });
    expect(parseNextActions({ do: "stop" })).toEqual({ actions: [], dropped: 1 });
  });

  it("accepts the closed vocabulary", () => {
    const { actions, dropped } = parseNextActions([
      { do: "read", unit: "page", at: 3 },
      { do: "read", unit: "chunk", at: 0, to: 4 },
      { do: "read", unit: "page", relative: "around", span: 2 },
      { do: "read", node: " n1 " },
      { do: "search", terms: ["alpha", "beta"], expand: 2 },
      { do: "stop", reason: "answered" },
    ]);
    expect(dropped).toBe(0);
    expect(actions.map(actionKind)).toEqual(["read-exact", "read-exact", "read-relative", "read-node", "search", "stop"]);
    expect(actions[3]).toEqual({ do: "read", node: "n1" });
  });

  it.each([
    ["not an object", 5],
    ["array item", [1]],
    ["unknown do", { do: "delete" }],
    ["unknown unit", { do: "read", unit: "byte", at: 1 }],
    ["float at", { do: "read", unit: "page", at: 1.5 }],
    ["NaN at", { do: "read", unit: "page", at: Number.NaN }],
    ["Infinity at", { do: "read", unit: "page", at: Infinity }],
    ["string at", { do: "read", unit: "page", at: "3" }],
    ["to before at", { do: "read", unit: "page", at: 5, to: 4 }],
    ["span 0", { do: "read", unit: "page", relative: "next", span: 0 }],
    ["span float", { do: "read", unit: "page", relative: "next", span: 1.2 }],
    ["bad relative", { do: "read", unit: "page", relative: "sideways", span: 1 }],
    ["empty node", { do: "read", node: "  " }],
    ["node too long", { do: "read", node: "x".repeat(129) }],
    ["node number", { do: "read", node: 4 }],
    ["no terms", { do: "search", terms: [] }],
    ["blank terms", { do: "search", terms: ["  ", "\u0000", 5] }],
    ["terms not array", { do: "search", terms: "alpha" }],
    ["bad expand", { do: "search", terms: ["a"], expand: "2" }],
    ["bad stop reason", { do: "stop", reason: "because" }],
  ])("drops %s", (_name, item) => {
    expect(parseNextActions([item])).toEqual({ actions: [], dropped: 1 });
  });

  it("cleans search terms and clamps expand", () => {
    const long = "x".repeat(500);
    const terms = Array.from({ length: 10_000 }, (_, i) => (i === 0 ? "  a\u0007b\n " : i === 1 ? long : `t${i}`));
    const { actions, dropped } = parseNextActions([{ do: "search", terms, expand: 99 }]);
    expect(dropped).toBe(0);
    const action = actions[0]!;
    if (action.do !== "search") throw new Error("expected search");
    expect(action.terms).toHaveLength(SEARCH_TERMS_MAX);
    expect(action.terms[0]).toBe("ab");
    expect(action.terms[1]).toHaveLength(SEARCH_TERM_MAX_CHARS);
    expect(action.expand).toBe(SEARCH_EXPAND_MAX);
    const low = parseNextActions([{ do: "search", terms: ["a"], expand: -3 }]).actions[0];
    expect(low).toEqual({ do: "search", terms: ["a"], expand: 0 });
  });

  it("caps the list and counts extras, and never throws", () => {
    const item = { do: "read", unit: "page", at: 1 };
    const result = parseNextActions(Array.from({ length: NEXT_ACTIONS_MAX + 5 }, () => item));
    expect(result.actions).toHaveLength(NEXT_ACTIONS_MAX);
    expect(result.dropped).toBe(5);
    const hostile = { get do(): string { throw new Error("getter"); } };
    expect(parseNextActions([hostile, item])).toEqual({ actions: [item], dropped: 1 });
  });

  it("does not pass unknown fields through", () => {
    const { actions } = parseNextActions([{ do: "read", unit: "page", at: 2, budget: { maxSteps: 9999 }, extra: 1 }]);
    expect(actions[0]).toEqual({ do: "read", unit: "page", at: 2 });
  });
});

describe("strategies", () => {
  const drain = (strategy: SliceStrategy, last: number, room: number, firstUnit = 1) => {
    const seen = new Set<number>();
    const waves: number[][] = [];
    for (let wave = 1; wave < 1000; wave++) {
      const refs = strategy({ source: { unit: "page", first: firstUnit, last }, seen, wave, room });
      const units = refs.flatMap((r) => Array.from({ length: r.end - r.start + 1 }, (_, i) => r.start + i));
      if (units.length === 0) break;
      expect(units.length).toBeLessThanOrEqual(room);
      for (const u of units) {
        expect(seen.has(u)).toBe(false);
        expect(u).toBeGreaterThanOrEqual(firstUnit);
        expect(u).toBeLessThanOrEqual(last);
        seen.add(u);
      }
      waves.push(units);
    }
    return { waves, seen };
  };

  it.each([
    ["sequentialWindows", sequentialWindows(3)],
    ["stratifiedRounds", stratifiedRounds(3)],
  ])("%s is deterministic and covers the source exactly once", (_name, strategy) => {
    const a = drain(strategy, 50, 8);
    const b = drain(strategy, 50, 8);
    expect(a.waves).toEqual(b.waves);
    expect(a.seen.size).toBe(50);
    expect(drain(strategy, 7, 8, 0).seen.size).toBe(8);
  });

  it("sequentialWindows returns windows from the start", () => {
    const refs = sequentialWindows(3)({ source: pageSource(20), seen: new Set([2]), wave: 1, room: 7 });
    expect(refs).toEqual([
      { unit: "page", start: 1, end: 1 },
      { unit: "page", start: 3, end: 5 },
      { unit: "page", start: 6, end: 8 },
    ]);
  });

  it("stratifiedRounds wave 1 includes the first and last unit, then splits the largest gap", () => {
    const strategy = stratifiedRounds(2);
    const first = strategy({ source: pageSource(100), seen: new Set(), wave: 1, room: 6 });
    expect(first[0]).toEqual({ unit: "page", start: 1, end: 2 });
    expect(first[1]).toEqual({ unit: "page", start: 99, end: 100 });
    expect(first).toHaveLength(3);
    expect(first[2]).toEqual({ unit: "page", start: 50, end: 51 });
    const later = strategy({ source: pageSource(100), seen: new Set([1, 2, 99, 100]), wave: 2, room: 2 });
    expect(later).toEqual([{ unit: "page", start: 50, end: 51 }]);
  });

  it("stratifiedRounds handles a tiny source", () => {
    const refs = stratifiedRounds(5)({ source: pageSource(3), seen: new Set(), wave: 1, room: 10 });
    expect(refs.flatMap((r) => [r.start, r.end])).toEqual([1, 3]);
  });
});

describe("runReadLoop budgets and endings", () => {
  it("a small source is exhausted and complete after one step", async () => {
    const h = harness({});
    const result = await run(h, 3);
    expect(result).toMatchObject({ status: "complete", stoppedBy: "exhausted" });
    expect(result.usage.steps).toBe(1);
    expect(result.coverage).toMatchObject({ unitsTotal: 3, unitsRead: 3, ranges: [[1, 3]] });
    expect(result.state).toEqual([1, 2, 3]);
  });

  it("rejects a bad budget or source with a plain error", async () => {
    const h = harness({});
    await expect(run(h, 3, { maxSteps: Number.NaN })).rejects.toThrow(/budget/);
    await expect(run(h, 3, { maxCostCents: -1 })).rejects.toThrow(/budget/);
    await expect(run(h, 3, { maxModelDirectedShare: 2 })).rejects.toThrow(/budget/);
    await expect(runReadLoop({ task: h.task, source: { unit: "page", first: 5, last: 1 }, strategy: sequentialWindows(1), budget: BUDGET, ports: h.ports })).rejects.toThrow(/source/);
  });

  it("maxSteps", async () => {
    const result = await run(harness({}), 100, { maxSteps: 2 });
    expect(result).toMatchObject({ status: "partial", stoppedBy: "steps" });
    expect(result.usage.steps).toBe(2);
    expect(result.coverage.unitsRead).toBe(8);
  });

  it("maxInputTokens", async () => {
    const per = estimateTokens("page 1 text");
    const result = await run(harness({}), 100, { maxInputTokens: per * 6 });
    expect(result).toMatchObject({ status: "partial", stoppedBy: "input-tokens" });
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(per * 6);
  });

  it("uses provider token counts when given", async () => {
    const h = harness({});
    const original = h.task.step;
    h.task.step = async (a) => ({ ...(await original(a)), inputTokens: 1000 });
    const result = await run(h, 100, { maxInputTokens: 2500 });
    expect(result.stoppedBy).toBe("input-tokens");
    expect(result.usage).toMatchObject({ steps: 3, inputTokens: 3000 });
  });

  it("maxCostCents", async () => {
    const result = await run(harness({ cost: 5 }), 100, { maxCostCents: 10 });
    expect(result).toMatchObject({ status: "partial", stoppedBy: "cost" });
    expect(result.usage.steps).toBe(2);
  });

  it("shouldStop reports cost", async () => {
    let calls = 0;
    const h = harness({ ports: { shouldStop: () => ++calls > 1 } });
    const result = await run(h, 100);
    expect(result).toMatchObject({ status: "partial", stoppedBy: "cost" });
    expect(result.usage.steps).toBe(1);
  });

  it("maxWallMs uses the injected clock", async () => {
    let clock = 0;
    const h = harness({ ports: { now: () => clock } });
    const original = h.task.step;
    h.task.step = async (a) => {
      clock += 400;
      return original(a);
    };
    const result = await run(h, 100, { maxWallMs: 1000 });
    expect(result).toMatchObject({ status: "partial", stoppedBy: "wall-clock" });
    expect(result.usage.steps).toBe(3);
    expect(result.usage.wallMs).toBe(1200);
  });

  it("maxWallMs aborts a step that hangs", async () => {
    const h = harness({});
    h.task.step = ({ signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const result = await run(h, 100, { maxWallMs: 20 });
    expect(result).toMatchObject({ status: "partial", stoppedBy: "wall-clock" });
    expect(result.state).toEqual([]);
  });

  it("outer abort ends the loop as aborted", async () => {
    const ctl = new AbortController();
    const h = harness({ ports: { signal: ctl.signal } });
    const original = h.task.step;
    h.task.step = async (a) => {
      const out = await original(a);
      ctl.abort();
      return out;
    };
    const result = await run(h, 100);
    expect(result).toMatchObject({ status: "partial", stoppedBy: "aborted" });
    expect(result.usage.steps).toBe(1);
    expect(result.state).toEqual([1, 2, 3, 4]);

    const pre = new AbortController();
    pre.abort();
    const never = harness({ ports: { signal: pre.signal } });
    expect(await run(never, 100)).toMatchObject({ stoppedBy: "aborted" });
    expect(never.batches).toEqual([]);
  });

  it("an abort during a step is reported as aborted", async () => {
    const ctl = new AbortController();
    const h = harness({ ports: { signal: ctl.signal } });
    h.task.step = ({ signal }) =>
      new Promise((_r, reject) => {
        signal.addEventListener("abort", () => reject(new Error("x")));
        setTimeout(() => ctl.abort(), 5);
      });
    expect(await run(h, 100)).toMatchObject({ stoppedBy: "aborted", usage: { failedSteps: 0 } });
  });
});

describe("done and stop", () => {
  it("done fires only after minSteps", async () => {
    const h = harness({ minSteps: 3, done: () => true });
    const result = await run(h, 100);
    expect(result).toMatchObject({ status: "complete", stoppedBy: "done" });
    expect(result.usage.steps).toBe(3);
  });

  it("done never ends an exhaustive task", async () => {
    const h = harness({ coverage: "exhaustive", done: () => true });
    const result = await run(h, 10);
    expect(result.stoppedBy).toBe("exhausted");
    expect(result.coverage.unitsRead).toBe(10);
  });

  it("done sees both states and the step number", async () => {
    const seen: Array<[State, State, number]> = [];
    const h = harness({ done: (a, b, n) => (seen.push([a, b, n]), n === 2) });
    await run(h, 100);
    expect(seen).toEqual([[[], [1, 2, 3, 4], 1], [[1, 2, 3, 4], [1, 2, 3, 4, 5, 6, 7, 8], 2]]);
  });

  it("honours a model stop for a representative task", async () => {
    const h = harness({ replies: [[{ do: "stop", reason: "answered" }]] });
    const result = await run(h, 100);
    expect(result).toMatchObject({ status: "complete", stoppedBy: "model-stop" });
    expect(result.usage.steps).toBe(1);
  });

  it("ignores and counts a stop for an exhaustive task", async () => {
    const h = harness({ coverage: "exhaustive", replies: [[{ do: "stop", reason: "answered" }]] });
    const result = await run(h, 8);
    expect(result.stoppedBy).toBe("exhausted");
    expect(result.coverage.proposalsDropped).toBe(1);
  });

  it("ignores a stop before minSteps", async () => {
    const h = harness({ minSteps: 2, replies: [[{ do: "stop", reason: "answered" }], [{ do: "stop", reason: "answered" }]] });
    const result = await run(h, 100);
    expect(result).toMatchObject({ stoppedBy: "model-stop" });
    expect(result.usage.steps).toBe(2);
    expect(result.coverage.proposalsDropped).toBe(1);
  });

  it("drops stop when it is not an allowed action", async () => {
    const h = harness({ allowed: [], replies: [[{ do: "stop", reason: "answered" }]] });
    const result = await run(h, 8);
    expect(result.stoppedBy).toBe("exhausted");
    expect(result.coverage.proposalsDropped).toBe(1);
  });
});

describe("failures, withheld and missing units", () => {
  it("skips a throwing step and keeps the state", async () => {
    const h = harness({ failSteps: [2] });
    const result = await run(h, 12);
    expect(result.stoppedBy).toBe("exhausted");
    expect(result.usage).toMatchObject({ steps: 3, failedSteps: 1 });
    expect(result.state).toEqual([1, 2, 3, 4, 9, 10, 11, 12]);
    expect(result.coverage).toMatchObject({ failed: 4, unitsRead: 8, ranges: [[1, 4], [9, 12]] });
  });

  it("two failed steps in a row end as errors", async () => {
    const h = harness({ failSteps: [2, 3] });
    const result = await run(h, 100);
    expect(result).toMatchObject({ status: "partial", stoppedBy: "errors" });
    expect(result.state).toEqual([1, 2, 3, 4]);
    expect(result.usage.failedSteps).toBe(2);
  });

  it("a failed step counts against maxSteps", async () => {
    const result = await run(harness({ failSteps: [1, 3] }), 100, { maxSteps: 3 });
    expect(result.stoppedBy).toBe("steps");
    expect(result.usage).toMatchObject({ steps: 3, failedSteps: 2 });
  });

  it("counts withheld and missing units and never retries them", async () => {
    const h = harness({
      slices: (refs) =>
        refs.flatMap((ref): Slice[] => {
          const out: Slice[] = [];
          for (let u = ref.start; u <= ref.end; u++) {
            if (u === 2) out.push({ ref: { unit: "page", start: 2, end: 2 }, status: "withheld" });
            else if (u === 3) out.push({ ref: { unit: "page", start: 3, end: 3 }, status: "missing" });
            else if (u !== 4) out.push({ ref: { unit: "page", start: u, end: u }, status: "ok", text: `p${u}` });
            // unit 4 is not covered at all
          }
          return out;
        }),
    });
    const result = await run(h, 4, {}, sequentialWindows(4));
    expect(result.coverage).toMatchObject({ unitsRead: 1, withheld: 1, missing: 2, ranges: [[1, 1]] });
    expect(h.reads).toHaveLength(1);
  });

  it("a read call that throws marks its units missing but keeps its siblings", async () => {
    const h = harness({
      ports: {
        async read(refs) {
          if (refs.some((r) => r.start === 1)) throw new Error("storage down");
          return refs.map((ref): Slice => ({ ref, status: "ok", text: `p${ref.start}` }));
        },
      },
    });
    const result = await run(h, 6, { maxUnitsPerStep: 6, concurrency: 3 }, sequentialWindows(2));
    expect(result.coverage).toMatchObject({ missing: 2, unitsRead: 4, ranges: [[3, 6]] });
    expect(result.stoppedBy).toBe("exhausted");
  });

  it("ignores slices outside what was requested", async () => {
    const h = harness({
      slices: () => [
        { ref: { unit: "page", start: 1, end: 2 }, status: "ok", text: "mine" },
        { ref: { unit: "page", start: 3, end: 9 }, status: "ok", text: "stolen" },
        { ref: { unit: "page", start: 50, end: 50 }, status: "ok", text: "elsewhere" },
        { ref: { unit: "chunk", start: 1, end: 1 }, status: "ok", text: "wrong unit" },
      ],
    });
    const result = await run(h, 20, { maxUnitsPerStep: 2, maxSteps: 1 }, sequentialWindows(2));
    expect(h.batches).toEqual([[1]]);
    expect(result.coverage.unitsRead).toBe(2);
  });

  it("clips an oversize slice on a word boundary", async () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    let seenText = "";
    const h = harness({ text: () => words });
    const original = h.task.step;
    h.task.step = async (a) => {
      seenText = a.slices[0]!.text;
      return original(a);
    };
    await run(h, 1, { maxSliceTokens: 50 });
    expect(estimateTokens(seenText)).toBeLessThanOrEqual(50);
    expect(seenText.length).toBeGreaterThan(20);
    expect(words.startsWith(seenText)).toBe(true);
    expect(words[seenText.length]).toBe(" ");
  });

  it("reads slices that exceed maxStepTokens in a later wave", async () => {
    const per = estimateTokens("page 1 text");
    const h = harness({});
    const result = await run(h, 6, { maxUnitsPerStep: 4, maxStepTokens: per * 2 + 1 });
    expect(h.batches[0]).toEqual([1, 2]);
    expect(result.coverage).toMatchObject({ unitsRead: 6, ranges: [[1, 6]] });
    expect(result.stoppedBy).toBe("exhausted");
    expect(h.batches.flat().sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("admits one slice even when it alone exceeds the step budget", async () => {
    const h = harness({ text: () => "alpha beta gamma delta epsilon zeta eta theta" });
    const result = await run(h, 3, { maxStepTokens: 1 });
    expect(result.coverage.unitsRead).toBe(3);
    expect(result.usage.steps).toBe(3);
  });

  it("ends when nothing can be admitted and the loop makes no progress", async () => {
    const h = harness({ slices: () => [] });
    const result = await run(h, 40);
    expect(result.stoppedBy).toBe("exhausted");
    expect(result.coverage).toMatchObject({ unitsRead: 0, missing: 40 });
    expect(result.usage.steps).toBe(0);
  });
});

describe("model proposals", () => {
  const next = (...actions: unknown[]) => [actions];

  it("reads an exact page and a range, clamped to unseen units", async () => {
    const h = harness({ replies: next({ do: "read", unit: "page", at: 40 }, { do: "read", unit: "page", at: 60, to: 70 }) });
    const result = await run(h, 100, { maxUnitsPerStep: 4, maxModelDirectedShare: 0.75, maxSteps: 2 });
    expect(h.batches[1]).toEqual([40, 60, 61, 5].sort((a, b) => a - b));
    expect(result.usage.actions).toBe(2);
    expect(result.coverage.proposalsDropped).toBe(0);
  });

  it.each([
    ["next", [5, 6]],
    ["prev", [0, 0]],
    ["around", [5, 6]],
  ] as const)("relative %s anchors on the last step's slices", async (relative, expected) => {
    // Step 1 reads 11..14.
    const h = harness({ replies: next({ do: "read", unit: "page", relative, span: 2 }) });
    void expected;
    const strategy: SliceStrategy = ({ seen, source }) => {
      const start = seen.size === 0 ? 11 : Math.max(...seen) + 100;
      return start <= source.last ? [{ unit: "page", start, end: Math.min(start + 3, source.last) }] : [];
    };
    await run(h, 1000, { maxModelDirectedShare: 1, maxUnitsPerStep: 4, maxSteps: 2 }, strategy);
    const second = h.batches[1]!.filter((u) => u < 100);
    if (relative === "next") expect(second).toEqual([15, 16]);
    if (relative === "prev") expect(second).toEqual([9, 10]);
    if (relative === "around") expect(second).toEqual([9, 10, 15, 16]);
  });

  it("reads a node through resolveNode and drops unknown nodes", async () => {
    const h = harness({
      replies: next({ do: "read", node: "chapter-2" }, { do: "read", node: "ghost" }),
      ports: { resolveNode: (id) => (id === "chapter-2" ? { unit: "page", start: 30, end: 31 } : null) },
    });
    const result = await run(h, 100, { maxSteps: 2 });
    expect(h.batches[1]).toEqual([30, 31, 5, 6].sort((a, b) => a - b));
    expect(result.coverage.proposalsDropped).toBe(1);
  });

  it("drops node proposals when resolveNode is absent", async () => {
    const h = harness({ replies: next({ do: "read", node: "x" }) });
    const result = await run(h, 100, { maxSteps: 2 });
    expect(result.coverage.proposalsDropped).toBe(1);
    expect(h.batches[1]).toEqual([5, 6, 7, 8]);
  });

  it("runs a search and widens each hit by expand", async () => {
    const terms: string[][] = [];
    const h = harness({
      replies: next({ do: "search", terms: ["alpha"], expand: 1 }),
      ports: {
        async search(t) {
          terms.push(t);
          return [{ unit: "page", start: 50, end: 50 }];
        },
      },
    });
    const result = await run(h, 100, { maxSteps: 2, maxUnitsPerStep: 6, maxModelDirectedShare: 0.5 });
    expect(terms).toEqual([["alpha"]]);
    expect(h.batches[1]).toEqual([49, 50, 51, 7, 8, 9].sort((a, b) => a - b));
    expect(result.usage).toMatchObject({ actions: 1, searches: 1 });
  });

  it("drops searches when no search port exists and survives a throwing search", async () => {
    const none = harness({ replies: next({ do: "search", terms: ["a"] }) });
    expect((await run(none, 100, { maxSteps: 2 })).coverage.proposalsDropped).toBe(1);
    const boom = harness({
      replies: next({ do: "search", terms: ["a"] }),
      ports: { search: async () => { throw new Error("index down"); } },
    });
    const result = await run(boom, 100, { maxSteps: 2 });
    expect(result.coverage.proposalsDropped).toBe(1);
    expect(result.usage.steps).toBe(2);
  });

  it("drops disallowed kinds", async () => {
    const h = harness({ allowed: ["read-exact"], replies: next({ do: "read", node: "n" }, { do: "search", terms: ["a"] }, { do: "read", unit: "page", at: 50 }) });
    const result = await run(h, 100, { maxSteps: 2 });
    expect(result.coverage.proposalsDropped).toBe(2);
    expect(h.batches[1]).toContain(50);
  });

  it("drops out-of-range, already-seen and wrong-unit reads", async () => {
    const h = harness({
      replies: next(
        { do: "read", unit: "page", at: 500 },
        { do: "read", unit: "page", at: -5, to: 0 },
        { do: "read", unit: "page", at: 2 },
        { do: "read", unit: "chunk", at: 20 },
      ),
    });
    const result = await run(h, 100, { maxSteps: 2 });
    expect(result.coverage.proposalsDropped).toBe(4);
    expect(result.usage.actions).toBe(0);
    expect(h.batches[1]).toEqual([5, 6, 7, 8]);
  });

  it("counts more than NEXT_ACTIONS_MAX as dropped", async () => {
    const many = Array.from({ length: NEXT_ACTIONS_MAX + 4 }, () => ({ do: "read", unit: "page", at: 90 }));
    const h = harness({ replies: [many] });
    const result = await run(h, 100, { maxSteps: 2 });
    // 4 over the cap, 15 duplicates of an already-taken page.
    expect(result.coverage.proposalsDropped).toBe(4 + (NEXT_ACTIONS_MAX - 1));
    expect(h.batches[1]).toContain(90);
  });

  it("enforces maxActions and maxSearches", async () => {
    const h = harness({
      replies: next(
        { do: "read", unit: "page", at: 20 },
        { do: "read", unit: "page", at: 30 },
        { do: "read", unit: "page", at: 40 },
      ),
    });
    const result = await run(h, 100, { maxSteps: 2, maxActions: 2, maxModelDirectedShare: 1, maxUnitsPerStep: 6 });
    expect(result.usage.actions).toBe(2);
    expect(result.coverage.proposalsDropped).toBe(1);
    expect(h.batches[1]).toContain(30);
    expect(h.batches[1]).not.toContain(40);

    const searches = harness({
      replies: next({ do: "search", terms: ["a"] }, { do: "search", terms: ["b"] }),
      ports: { search: async () => [{ unit: "page", start: 70, end: 70 }] },
    });
    const second = await run(searches, 100, { maxSteps: 2, maxSearches: 1, maxModelDirectedShare: 1 });
    expect(second.usage.searches).toBe(1);
    expect(second.coverage.proposalsDropped).toBe(1);
  });

  it("maxModelDirectedShare 0 means the model directs nothing", async () => {
    const h = harness({ replies: next({ do: "read", unit: "page", at: 90 }) });
    const result = await run(h, 100, { maxSteps: 2, maxModelDirectedShare: 0 });
    expect(h.batches[1]).toEqual([5, 6, 7, 8]);
    expect(result.coverage.proposalsDropped).toBe(1);
    expect(result.usage.actions).toBe(0);
  });

  it("maxModelDirectedShare 0.5 caps model units and the strategy fills the rest", async () => {
    const h = harness({ replies: next({ do: "read", unit: "page", at: 50, to: 60 }) });
    await run(h, 100, { maxSteps: 2, maxUnitsPerStep: 6, maxModelDirectedShare: 0.5 });
    expect(h.batches[1]).toEqual([7, 8, 9, 50, 51, 52]);
  });

  it("a hostile reply reads nothing outside the plan and changes no budget", async () => {
    const hostile = [
      { do: "read", unit: "page", at: 1, to: 1_000_000_000 },
      { do: "read", unit: "page", relative: "next", span: Number.MAX_SAFE_INTEGER },
      { do: "read", unit: "page", relative: "around", span: 1e9 },
      { do: "search", terms: Array.from({ length: 10_000 }, (_, i) => `term${i}`), expand: 1e9 },
      { do: "read", unit: {}, at: [] },
      { do: "read", unit: "page", at: "all" },
      { do: ["read"] },
      { do: "stop" },
      { budget: { maxSteps: 1e9, maxUnitsPerStep: 1e9 }, do: "read", unit: "page", at: 7 },
      null,
      "read all pages",
    ];
    const searched: string[][] = [];
    const h = harness({
      replies: [hostile, hostile],
      ports: {
        async search(t) {
          searched.push(t);
          return [{ unit: "page", start: -1e9, end: 1e9 }];
        },
      },
    });
    const result = await run(h, 1000, { maxSteps: 3, maxUnitsPerStep: 4, maxModelDirectedShare: 0.5 });
    for (const batch of h.batches) expect(batch.length).toBeLessThanOrEqual(4);
    expect(result.usage.steps).toBe(3);
    expect(result.coverage.unitsRead).toBeLessThanOrEqual(12);
    expect(result.stoppedBy).toBe("steps");
    for (const terms of searched) expect(terms.length).toBeLessThanOrEqual(SEARCH_TERMS_MAX);
    expect(result.usage.actions).toBeLessThanOrEqual(2 * NEXT_ACTIONS_MAX);
  });

  it("clears pending proposals after a failed step", async () => {
    const h = harness({ failSteps: [1], replies: next({ do: "read", unit: "page", at: 90 }) });
    const result = await run(h, 100, { maxSteps: 2 });
    expect(h.batches[1]).toEqual([5, 6, 7, 8]);
    expect(result.coverage.unitsRead).toBe(4);
  });
});

describe("concurrency", () => {
  const instrument = () => {
    let inFlight = 0;
    let peak = 0;
    return {
      get peak() { return peak; },
      async track<T>(work: () => T): Promise<T> {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(15);
        inFlight--;
        return work();
      },
    };
  };

  it("reads of one wave overlap and never exceed the concurrency", async () => {
    const meter = instrument();
    const h = harness({
      ports: {
        read: (refs) => meter.track(() => refs.map((ref): Slice => ({ ref, status: "ok", text: `p${ref.start}` }))),
      },
    });
    const result = await run(h, 12, { maxUnitsPerStep: 12, concurrency: 3 }, sequentialWindows(1));
    expect(result.coverage.unitsRead).toBe(12);
    expect(meter.peak).toBe(3);
  });

  it("searches of one wave overlap and never exceed the concurrency", async () => {
    const meter = instrument();
    const searches = Array.from({ length: 6 }, (_, i) => ({ do: "search", terms: [`t${i}`] }));
    const h = harness({
      replies: [searches],
      ports: { search: (t) => meter.track(() => [{ unit: "page" as const, start: 20 + t[0]!.length * 10 + Number(t[0]!.slice(1)), end: 20 + t[0]!.length * 10 + Number(t[0]!.slice(1)) }]) },
    });
    await run(h, 100, { maxSteps: 2, concurrency: 2, maxModelDirectedShare: 1, maxUnitsPerStep: 6 });
    expect(meter.peak).toBe(2);
  });

  it("one failing read call does not lose the others", async () => {
    const h = harness({
      ports: {
        async read(refs) {
          await sleep(5);
          if (refs.some((r) => r.start === 3)) throw new Error("boom");
          return refs.map((ref): Slice => ({ ref, status: "ok", text: `p${ref.start}` }));
        },
      },
    });
    const result = await run(h, 6, { maxUnitsPerStep: 6, concurrency: 3 }, sequentialWindows(1));
    expect(result.coverage.ranges).toEqual([[1, 2], [4, 5]]);
    expect(result.coverage.missing).toBe(2);
  });
});

describe("runReadLoop seed", () => {
  const okSlice = (start: number, end = start, text = `held ${start}`): Slice => ({ ref: { unit: "page", start, end }, status: "ok", text });
  const ok = (start: number, end = start, text?: string) => okSlice(start, end, text) as Extract<Slice, { status: "ok" }>;
  const flat = (batches: number[][]) => batches.flat();

  it("never reads seeded seen units and does not count them as read", async () => {
    const h = harness({});
    const result = await run(h, 10, {}, sequentialWindows(2), { seen: [1, 2, 3] });
    expect(flat(h.batches).sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(h.reads.flat().every((r) => r.start >= 4)).toBe(true);
    expect(result.coverage.unitsRead).toBe(7);
    expect(result.coverage.ranges).toEqual([[4, 10]]);
    expect(result.stoppedBy).toBe("exhausted");
  });

  it("ignores seeded seen values outside the source or not integers", async () => {
    const h = harness({});
    const result = await run(h, 6, {}, sequentialWindows(2), { seen: [0, 99, 1.5, Number.NaN, "x" as never, -3] });
    expect(result.coverage.unitsRead).toBe(6);
    expect(result.coverage.ranges).toEqual([[1, 6]]);
  });

  it("exhausts before any step when the seed already covers the source", async () => {
    const h = harness({});
    const result = await run(h, 3, {}, sequentialWindows(2), { seen: [1, 2, 3], batch: [ok(1)] });
    expect(result.stoppedBy).toBe("exhausted");
    expect(h.batches).toEqual([]);
  });

  it("runs the seeded batch as the first step with no read call and no clipping", async () => {
    const long = "word ".repeat(2000);
    const h = harness({});
    const result = await run(h, 10, { maxSliceTokens: 10 }, sequentialWindows(2), { batch: [ok(9, 9, long)] });
    expect(h.batches[0]).toEqual([9]);
    expect(h.reads.flat().every((r) => r.start !== 9)).toBe(true);
    let seenText = "";
    const probe = harness({});
    const orig = probe.task.step;
    probe.task.step = async (a) => { seenText ||= a.slices[0]!.text; return orig(a); };
    await run(probe, 10, { maxSliceTokens: 10 }, sequentialWindows(2), { batch: [ok(9, 9, long)] });
    expect(seenText).toBe(long);
    expect(result.coverage.unitsRead).toBe(10);
    expect(result.coverage.ranges).toEqual([[1, 10]]);
  });

  it("makes no read call for a batch step even when the batch is the whole run", async () => {
    const h = harness({});
    const result = await run(h, 2, {}, sequentialWindows(2), { batch: [ok(1, 2)] });
    expect(h.reads).toEqual([]);
    expect(h.batches).toEqual([[1]]);
    expect(result.stoppedBy).toBe("exhausted");
    expect(result.usage.steps).toBe(1);
  });

  it("counts the batch's estimated tokens against the input budget and never drops it for maxStepTokens", async () => {
    const text = "word ".repeat(100);
    const per = estimateTokens(text);
    const h = harness({});
    const result = await run(h, 10, { maxStepTokens: 1 }, sequentialWindows(2), { batch: [ok(5, 5, text)] });
    expect(h.batches[0]).toEqual([5]);
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(per);

    const capped = harness({});
    const stopped = await run(capped, 10, { maxInputTokens: per }, sequentialWindows(2), { batch: [ok(5, 5, text)] });
    expect(capped.batches).toEqual([[5]]);
    expect(stopped.stoppedBy).toBe("input-tokens");
    expect(capped.reads).toEqual([]);
  });

  it("lets the reply to the batch step direct the next wave with an exact read", async () => {
    const h = harness({ replies: [[{ do: "read", unit: "page", at: 9 }]] });
    await run(h, 10, {}, sequentialWindows(2), { batch: [ok(5)] });
    expect(h.batches[1]).toContain(9);
    expect(h.reads[0]!.some((r) => r.start <= 9 && r.end >= 9)).toBe(true);
  });

  it("anchors relative reads on the batch's lowest and highest unit", async () => {
    const next = harness({ replies: [[{ do: "read", unit: "page", relative: "next", span: 2 }]] });
    await run(next, 20, {}, sequentialWindows(2), { batch: [ok(10), ok(5, 6)] });
    expect(next.batches[1]).toEqual(expect.arrayContaining([11, 12]));
    expect(next.batches[1]).not.toContain(7);
    const prev = harness({ replies: [[{ do: "read", unit: "page", relative: "prev", span: 2 }]] });
    await run(prev, 20, {}, sequentialWindows(2), { batch: [ok(10), ok(5, 6)] });
    expect(prev.batches[1]).toEqual(expect.arrayContaining([3, 4]));
  });

  it("counts a failed batch step's units as failed and continues with the normal plan", async () => {
    const h = harness({ failSteps: [1] });
    const result = await run(h, 10, {}, sequentialWindows(2), { batch: [ok(9, 10)] });
    expect(h.batches[0]).toEqual([9]);
    expect(h.batches[1]).toEqual([1, 2, 3, 4]);
    expect(result.coverage.failed).toBe(2);
    expect(result.coverage.ranges).toEqual([[1, 8]]);
    expect(result.usage.failedSteps).toBe(1);
    expect(h.batches.flat().filter((u) => u === 9 || u === 10)).toEqual([9]);
  });

  it("stops with errors when the batch step and the next step both fail", async () => {
    const h = harness({ failSteps: [1, 2] });
    const result = await run(h, 10, {}, sequentialWindows(2), { batch: [ok(9)] });
    expect(result.stoppedBy).toBe("errors");
  });

  it("runs every normal stop check before the batch", async () => {
    const stopped = harness({ ports: { shouldStop: () => true } });
    const result = await run(stopped, 10, {}, sequentialWindows(2), { batch: [ok(1)] });
    expect(result.stoppedBy).toBe("cost");
    expect(stopped.batches).toEqual([]);
    const none = harness({});
    expect((await run(none, 10, { maxSteps: 0 }, sequentialWindows(2), { batch: [ok(1)] })).stoppedBy).toBe("steps");
    expect(none.batches).toEqual([]);
  });

  it("with maxSteps 1 runs only the seeded batch step", async () => {
    const h = harness({ replies: [[{ do: "read", unit: "page", at: 9 }]] });
    const result = await run(h, 10, { maxSteps: 1 }, sequentialWindows(2), { batch: [ok(3)] });
    expect(result.stoppedBy).toBe("steps");
    expect(h.batches).toEqual([[3]]);
    expect(h.reads).toEqual([]);
  });

  it("treats an empty batch as none", async () => {
    const h = harness({});
    await run(h, 10, {}, sequentialWindows(2), { batch: [], refs: [{ unit: "page", start: 7, end: 8 }] });
    expect(h.batches[0]).toEqual([1, 2, 7, 8]);
  });

  it("uses the batch and ignores refs when both are given", async () => {
    const h = harness({});
    await run(h, 10, { maxSteps: 1 }, sequentialWindows(2), { batch: [ok(3)], refs: [{ unit: "page", start: 7, end: 8 }] });
    expect(h.batches).toEqual([[3]]);
    expect(h.reads).toEqual([]);
  });

  it("makes the first wave the seeded refs, with the strategy filling the remaining room", async () => {
    const h = harness({});
    await run(h, 10, { maxSteps: 1 }, sequentialWindows(2), { refs: [{ unit: "page", start: 7, end: 8 }] });
    expect(h.batches[0]).toEqual([1, 2, 7, 8]);
    expect(h.reads.flat()).toHaveLength(2);
  });

  it("clamps seeded refs to the source, drops seen units and caps them at maxUnitsPerStep", async () => {
    const h = harness({});
    await run(h, 10, { maxSteps: 1 }, sequentialWindows(2), { seen: [6], refs: [{ unit: "page", start: -5, end: 3 }, { unit: "page", start: 5, end: 99 }] });
    expect(h.batches[0]).toEqual([1, 2, 3, 5]);
    const full = harness({});
    await run(full, 10, { maxSteps: 1 }, () => { throw new Error("strategy must not be needed"); }, { refs: [{ unit: "page", start: 1, end: 10 }] });
    expect(full.batches[0]).toEqual([1, 2, 3, 4]);
  });

  it("does not charge seeded refs as actions and does not limit them by the model-directed share", async () => {
    const h = harness({});
    const result = await run(h, 10, { maxSteps: 1, maxActions: 0, maxModelDirectedShare: 0 }, () => [], { refs: [{ unit: "page", start: 5, end: 8 }] });
    expect(h.batches[0]).toEqual([5, 6, 7, 8]);
    expect(result.usage.actions).toBe(0);
    expect(result.coverage.proposalsDropped).toBe(0);
  });

  it("uses seeded refs for the first wave only", async () => {
    const h = harness({});
    await run(h, 12, { maxSteps: 2 }, sequentialWindows(2), { refs: [{ unit: "page", start: 11, end: 12 }] });
    expect(h.batches[0]).toEqual([1, 2, 11, 12]);
    expect(h.batches[1]).toEqual([3, 4, 5, 6]);
  });

  it("ignores a bad seed instead of throwing", async () => {
    const bad = {
      seen: "nope",
      batch: [
        { ref: { unit: "chunk", start: 1, end: 1 }, status: "ok", text: "wrong unit" },
        { ref: { unit: "page", start: 1.5, end: 2 }, status: "ok", text: "fractional" },
        { ref: { unit: "page", start: 3, end: 1 }, status: "ok", text: "inverted" },
        { ref: { unit: "page", start: 50, end: 60 }, status: "ok", text: "outside" },
        { ref: { unit: "page", start: 2, end: 2 }, status: "withheld" },
        { ref: { unit: "page", start: 2, end: 2 }, status: "ok", text: 5 },
        null,
      ],
      refs: [{ unit: "chunk", start: 1, end: 2 }, { unit: "page", start: 2.5, end: 3 }, null],
    } as unknown as ReadSeed;
    const h = harness({});
    const result = await run(h, 6, {}, sequentialWindows(2), bad);
    expect(result.coverage.unitsRead).toBe(6);
    expect(h.batches[0]).toEqual([1, 2, 3, 4]);
    await expect(run(harness({}), 4, {}, sequentialWindows(2), 7 as never)).resolves.toMatchObject({ stoppedBy: "exhausted" });
  });

  it("clamps a batch slice that overhangs the source to its in-source units", async () => {
    const h = harness({});
    const result = await run(h, 5, { maxSteps: 1 }, sequentialWindows(2), { batch: [ok(4, 9)] });
    expect(result.coverage.ranges).toEqual([[4, 5]]);
    expect(result.coverage.unitsRead).toBe(2);
  });
});
