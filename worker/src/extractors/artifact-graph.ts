import type { ExtractionArtifactRef } from "@docslurp/shared";
import { planArtifactGraph } from "./graph.js";

export interface ArtifactGraphAdapter {
  id: string;
  accepts: readonly string[];
  emits: readonly string[];
  /** Document runs once; page runs once per page; aggregate consumes an ordered page set once. */
  scope: "document" | "page" | "aggregate";
  /** Document transforms may emit placed page artifacts or both scopes. */
  outputScope?: "document" | "page" | "mixed";
  /** `many` allows multiple artifacts of an accepted kind in the same page context. */
  inputCardinality?: "single" | "many";
  cost?: number;
  run(inputs: readonly ExtractionArtifactRef[], ctx: { sourceDocumentId: string; pageNumber?: number; pageNumbers?: readonly number[]; signal?: AbortSignal }): Promise<ExtractionArtifactRef[]>;
}

export interface ArtifactGraphInput {
  sourceDocumentId: string;
  initial: readonly ExtractionArtifactRef[];
  target: readonly string[];
  adapters: readonly ArtifactGraphAdapter[];
  pageNumbers?: readonly number[];
  signal?: AbortSignal;
  maxSteps?: number;
  maxStates?: number;
  maxOutputs?: number;
}

export type ArtifactGraphResult =
  | { ok: true; artifacts: readonly ExtractionArtifactRef[]; targets: readonly ExtractionArtifactRef[]; steps: readonly string[] }
  | { ok: false; reason: "unreachable" | "limit" | "unsatisfied" | "ambiguous"; missing: readonly string[]; artifacts: readonly ExtractionArtifactRef[]; steps: readonly string[] };

const pagesOf = (ref: ExtractionArtifactRef): number[] => [...new Set(ref.placements.map((p) => p.pageNumber))].sort((a, b) => a - b);

function frozen(ref: ExtractionArtifactRef): ExtractionArtifactRef {
  return Object.freeze({ ...ref, derivedFrom: Object.freeze([...ref.derivedFrom]), placements: Object.freeze(ref.placements.map((p) => Object.freeze({ ...p, bbox: p.bbox && Object.freeze([...p.bbox]) }))), producer: Object.freeze({ ...ref.producer }) }) as ExtractionArtifactRef;
}

function validatePlacement(ref: ExtractionArtifactRef): void {
  if (ref.placements.some((p) => !Number.isSafeInteger(p.pageNumber) || p.pageNumber < 1)) throw new Error(`Artifact ${ref.id} has invalid page placement`);
}

/** Executes a kind-level plan only when artifact scope and parentage are explicit. */
export async function executeArtifactGraph(input: ArtifactGraphInput): Promise<ArtifactGraphResult> {
  const maxOutputs = input.maxOutputs ?? 256;
  if (!Number.isSafeInteger(maxOutputs) || maxOutputs < 1) throw new Error("maxOutputs must be a positive safe integer");
  const artifacts = input.initial.map(frozen);
  const ids = new Set<string>();
  for (const ref of artifacts) {
    if (ref.sourceDocumentId !== input.sourceDocumentId) throw new Error("Initial artifact belongs to another document");
    if (!ref.id || ids.has(ref.id)) throw new Error(`Duplicate or empty artifact id: ${ref.id}`);
    validatePlacement(ref);
    ids.add(ref.id);
  }
  if (artifacts.length > maxOutputs) throw new Error("Initial artifacts exceed maxOutputs");
  const plan = planArtifactGraph({ initial: artifacts.map((a) => a.kind), target: input.target, adapters: input.adapters, maxSteps: input.maxSteps, maxStates: input.maxStates });
  const steps: string[] = [];
  const result = (reason: "unreachable" | "limit" | "unsatisfied" | "ambiguous", missing: readonly string[]): ArtifactGraphResult => ({ ok: false, reason, missing, artifacts, steps });
  if (!plan.ok) return result(plan.reason, plan.missing);
  const requestedPages = input.pageNumbers && [...new Set(input.pageNumbers)].sort((a, b) => a - b);
  if (requestedPages?.some((p) => !Number.isSafeInteger(p) || p < 1)) throw new Error("Invalid page number");
  for (const step of plan.steps) {
    input.signal?.throwIfAborted();
    const adapter = input.adapters.find((a) => a.id === step.id)!;
    const knownPages = [...new Set(artifacts.flatMap((a) => step.accepts.includes(a.kind) ? pagesOf(a) : []))].sort((a, b) => a - b);
    const pageCandidates = adapter.scope === "page" ? requestedPages ?? knownPages : [undefined];
    if (pageCandidates.length === 0) return result("unsatisfied", step.accepts);
    for (const pageNumber of pageCandidates) {
      input.signal?.throwIfAborted();
      const selected: ExtractionArtifactRef[] = [];
      const aggregatePages = adapter.scope === "aggregate" ? requestedPages ?? knownPages : undefined;
      if (adapter.scope === "aggregate" && aggregatePages?.length === 0) return result("unsatisfied", step.accepts);
      for (const kind of step.accepts) {
        const all = artifacts.filter((a) => a.kind === kind);
        const documentRefs = all.filter((a) => pagesOf(a).length === 0);
        const pageRefs = all.filter((a) => pagesOf(a).length > 0);
        let matches: ExtractionArtifactRef[];
        if (adapter.scope === "document") matches = documentRefs;
        else if (adapter.scope === "page") matches = all.filter((a) => pagesOf(a).length === 0 || pagesOf(a).includes(pageNumber!));
        else {
          // An aggregate consumes every page-scoped input in page order. Each accepted
          // page kind must cover the same requested set; document inputs are shared.
          if (pageRefs.length && aggregatePages!.some((p) => !pageRefs.some((a) => pagesOf(a).includes(p)))) return result("unsatisfied", [kind]);
          matches = pageRefs.length
            ? pageRefs.filter((a) => pagesOf(a).some((p) => aggregatePages!.includes(p))).sort((a, b) => pagesOf(a)[0] - pagesOf(b)[0] || a.id.localeCompare(b.id))
            : documentRefs;
        }
        if (matches.length === 0) return result("unsatisfied", [kind]);
        if (adapter.scope !== "aggregate" && adapter.inputCardinality !== "many" && matches.length > 1) return result("ambiguous", [kind]);
        selected.push(...matches);
      }
      const produced = await adapter.run(Object.freeze([...selected]), { sourceDocumentId: input.sourceDocumentId, pageNumber, pageNumbers: aggregatePages, signal: input.signal });
      input.signal?.throwIfAborted();
      if (!Array.isArray(produced) || artifacts.length + produced.length > maxOutputs) return result("limit", input.target);
      const expectedParents = new Set(selected.map((a) => a.id));
      const outputScope = adapter.outputScope ?? (adapter.scope === "page" ? "page" : "document");
      for (const raw of produced) {
        if (!raw.id || ids.has(raw.id)) throw new Error(`Duplicate or empty artifact id: ${raw.id}`);
        if (raw.sourceDocumentId !== input.sourceDocumentId) throw new Error(`Artifact ${raw.id} belongs to another document`);
        if (!step.emits.includes(raw.kind)) throw new Error(`Adapter ${step.id} emitted undeclared kind ${raw.kind}`);
        if (raw.producer.id !== step.id) throw new Error(`Artifact ${raw.id} has wrong producer`);
        if (raw.derivedFrom.length !== expectedParents.size || raw.derivedFrom.some((id) => !expectedParents.has(id))) throw new Error(`Artifact ${raw.id} has invalid parents`);
        validatePlacement(raw);
        const outputPages = pagesOf(raw);
        if (outputScope === "page" && outputPages.length === 0) throw new Error(`Artifact ${raw.id} lacks page placement`);
        if (outputScope === "document" && outputPages.length > 0) throw new Error(`Artifact ${raw.id} has unexpected page placement`);
        if (adapter.scope === "page" && (outputPages.length !== 1 || outputPages[0] !== pageNumber)) throw new Error(`Artifact ${raw.id} has wrong page placement`);
        if (adapter.scope === "aggregate" && outputPages.length > 0) throw new Error(`Aggregate ${step.id} emitted page-scoped artifact`);
        ids.add(raw.id);
        artifacts.push(frozen(raw));
      }
      steps.push(`${step.id}${pageNumber === undefined ? "" : `@${pageNumber}`}`);
    }
  }
  const targets = artifacts.filter((a) => input.target.includes(a.kind));
  const missing = input.target.filter((kind) => !targets.some((a) => a.kind === kind));
  return missing.length ? result("unsatisfied", missing) : { ok: true, artifacts, targets, steps };
}
