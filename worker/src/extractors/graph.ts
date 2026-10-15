/** Plans kind reachability, not page placement or artifact provenance. */
export interface GraphAdapter {
  id: string;
  accepts: readonly string[];
  emits: readonly string[];
  cost?: number;
}

export type GraphPlan =
  | { ok: true; steps: GraphAdapter[]; available: string[]; cost: number }
  | { ok: false; reason: "unreachable" | "limit"; missing: string[] };

export interface GraphPlanInput {
  initial: readonly string[];
  target: readonly string[];
  adapters: readonly GraphAdapter[];
  maxSteps?: number;
  maxStates?: number;
}

function assertKinds(kinds: readonly string[]): void {
  if (kinds.some((kind) => !kind.trim())) throw new Error("Artifact kinds must be nonempty");
}

/** Dijkstra over monotone sets of artifact kinds. Every transition must add a kind. */
export function planArtifactGraph(input: GraphPlanInput): GraphPlan {
  const maxSteps = input.maxSteps ?? 12;
  const maxStates = input.maxStates ?? 4096;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0 || !Number.isSafeInteger(maxStates) || maxStates < 1) {
    throw new Error("Graph limits must be nonnegative safe integers (maxStates >= 1)");
  }
  assertKinds(input.initial);
  assertKinds(input.target);
  const ids = new Set<string>();
  for (const adapter of input.adapters) {
    if (!adapter.id.trim() || ids.has(adapter.id)) throw new Error(`Invalid or duplicate adapter id: ${adapter.id}`);
    ids.add(adapter.id);
    assertKinds(adapter.accepts);
    assertKinds(adapter.emits);
    if (adapter.emits.length === 0) throw new Error(`Adapter ${adapter.id} emits no kinds`);
    if (adapter.cost !== undefined && (!Number.isFinite(adapter.cost) || adapter.cost < 0)) {
      throw new Error(`Adapter ${adapter.id} has invalid cost`);
    }
  }

  const kinds = [...new Set([...input.initial, ...input.target, ...input.adapters.flatMap((a) => [...a.accepts, ...a.emits])])];
  if (kinds.length > 60) throw new Error("Graph has more than 60 artifact kinds");
  const bit = new Map(kinds.map((kind, i) => [kind, 1n << BigInt(i)]));
  const mask = (values: readonly string[]) => values.reduce((bits, kind) => bits | bit.get(kind)!, 0n);
  const start = mask(input.initial);
  const target = mask(input.target);
  const edges = input.adapters.map((adapter) => ({ adapter, needs: mask(adapter.accepts), gives: mask(adapter.emits) }));
  const missing = (bits: bigint) => input.target.filter((kind) => (bits & bit.get(kind)!) === 0n);
  type State = { bits: bigint; cost: number; steps: GraphAdapter[] };
  const queue: State[] = [{ bits: start, cost: 0, steps: [] }];
  const best = new Map<bigint, { cost: number; depth: number }>([[start, { cost: 0, depth: 0 }]]);
  let limited = false;
  let furthest = start;
  let visited = 0;
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || a.steps.length - b.steps.length);
    const state = queue.shift()!;
    const prior = best.get(state.bits)!;
    if (state.cost !== prior.cost || state.steps.length !== prior.depth) continue;
    if ((state.bits & target) === target) {
      return { ok: true, steps: state.steps, available: kinds.filter((kind) => (state.bits & bit.get(kind)!) !== 0n), cost: state.cost };
    }
    if (++visited > maxStates) return { ok: false, reason: "limit", missing: missing(furthest) };
    if (state.steps.length >= maxSteps) {
      limited = true;
      continue;
    }
    for (const edge of edges) {
      if ((state.bits & edge.needs) !== edge.needs) continue;
      const next = state.bits | edge.gives;
      if (next === state.bits) continue; // prevents cycles and duplicate execution
      if (missing(next).length < missing(furthest).length) furthest = next;
      const cost = state.cost + (edge.adapter.cost ?? 1);
      const depth = state.steps.length + 1;
      const existing = best.get(next);
      if (existing && (existing.cost < cost || (existing.cost === cost && existing.depth <= depth))) continue;
      best.set(next, { cost, depth });
      queue.push({ bits: next, cost, steps: [...state.steps, edge.adapter] });
    }
  }
  return { ok: false, reason: limited ? "limit" : "unreachable", missing: missing(furthest) };
}
