import type { SearchChunk } from "../services/search.js";
import { tokenize } from "./rerank.js";

export function splitCompoundQuestion(query: string): [string, string] | null {
  const parts = query.trim().replace(/\?$/, "")
    .split(/\?\s*|,?\s+and\s+(?=(?:what|which|who|whom|where|when|why|how)\b)/i);
  return parts.length === 2 && parts.every((part) => tokenize(part).length >= 3)
    ? [parts[0]!, parts[1]!]
    : null;
}

export function distinctEvidence(a: SearchChunk, b: SearchChunk): boolean {
  if (a.id === b.id) return false;
  if (a.documentId !== b.documentId) return true;
  const pages = (hit: SearchChunk) => hit.pageNumbers.length ? hit.pageNumbers : hit.pageNumber == null ? [] : [hit.pageNumber];
  const left = pages(a);
  const right = pages(b);
  return left.length > 0 && right.length > 0 && !left.some((page) => right.includes(page));
}

function termCoverage(parts: [string, string], baseline: SearchChunk[]) {
  const terms = parts.map((part) => [...new Set(tokenize(part))]);
  const documents = baseline.map((hit) => new Set(tokenize(hit.text)));
  const weighted = terms.map((branch) => branch.map((term) => ({
    term,
    weight: Math.log(1 + baseline.length / Math.max(1, documents.filter((tokens) => tokens.has(term)).length)),
  })));
  return (branch: number, tokens: Set<string>) => {
    const weights = weighted[branch]!;
    return weights.reduce((sum, { term, weight }) => sum + (tokens.has(term) ? weight : 0), 0)
      / weights.reduce((sum, { weight }) => sum + weight, 0);
  };
}

export function weakerSubquestion(parts: [string, string], baseline: SearchChunk[]): string {
  const score = termCoverage(parts, baseline);
  const best = parts.map((_, i) => Math.max(...baseline.map((hit) => score(i, new Set(tokenize(hit.text))))));
  return parts[best[0]! <= best[1]! ? 0 : 1];
}

export function preserveCompoundEvidence(
  parts: [string, string], baseline: SearchChunk[], candidate: SearchChunk,
): SearchChunk[] | null {
  if (!baseline.every((hit) => distinctEvidence(hit, candidate))) return null;
  const score = termCoverage(parts, baseline);
  const windows = (text: string) => {
    const units = text.replace(/^(?:Document|Context|Heading|Pages?):.*$/gmi, "")
      .split(/(?<=[.!?;])\s+|\n+/).map(tokenize).filter((tokens) => tokens.length >= 3);
    return units.map((tokens, i) => new Set([...tokens, ...(units[i + 1] ?? [])]));
  };
  const evidence = parts.map((_, branch) => new Map([...baseline, candidate].map((hit) =>
    [hit, Math.max(0, ...windows(hit.text).map((tokens) => score(branch, tokens)))])));
  const coverage = (hits: SearchChunk[], scores: Map<SearchChunk, number>) => {
    const ordered = [...hits].sort((a, b) => scores.get(b)! - scores.get(a)!);
    const first = ordered[0]!;
    const second = ordered.find((hit) => distinctEvidence(first, hit));
    return scores.get(first)! + (second ? scores.get(second)! / 2 : 0);
  };
  const before = evidence.map((scores) => coverage(baseline, scores));
  for (let i = baseline.length - 1; i >= 0; i--) {
    const proposed = [...baseline.slice(0, i), ...baseline.slice(i + 1), candidate];
    const deltas = evidence.map((scores, branch) => coverage(proposed, scores) - before[branch]!);
    if (deltas.every((delta) => delta >= -1e-10) && deltas.some((delta) => delta > 1e-10)) {
      return proposed.map((hit, rank) => ({ ...hit, score: 1 / (rank + 1) }));
    }
  }
  return null;
}
