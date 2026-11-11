import { describe, expect, it } from "vitest";
import { planFirstPassBatches, type FirstPassCandidate } from "../temporal/first-pass-batches.js";
import { firstPassBatchOptions } from "../pipeline/first-pass.js";

const limits = { maxFiles: 4, maxBatchBytes: 1_000, maxBatchPages: 100 };
const doc = (id: string, pages: number, bytes = 10): FirstPassCandidate => ({ documentId: id, pages, bytes });

function check(candidates: FirstPassCandidate[], plan: string[][], l = limits) {
  const ids = plan.flat();
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(ids)).toEqual(new Set(candidates.map((c) => c.documentId)));
  const byId = new Map(candidates.map((c) => [c.documentId, c]));
  for (const batch of plan) {
    expect(batch.length).toBeGreaterThan(0);
    if (batch.length === 1) continue; // an oversize document may run alone
    expect(batch.length).toBeLessThanOrEqual(l.maxFiles);
    expect(batch.reduce((s, id) => { const p = byId.get(id)!.pages; return s + (Number.isFinite(p) && p > 0 ? Math.ceil(p) : 1); }, 0)).toBeLessThanOrEqual(l.maxBatchPages);
    expect(batch.reduce((s, id) => s + byId.get(id)!.bytes, 0)).toBeLessThanOrEqual(l.maxBatchBytes);
  }
}

describe("planFirstPassBatches", () => {
  it("plans nothing for no documents and one batch for one", () => {
    expect(planFirstPassBatches([], limits)).toEqual([]);
    expect(planFirstPassBatches([doc("a", 3)], limits)).toEqual([["a"]]);
  });

  it("respects files, pages and bytes, largest first", () => {
    const docs = [doc("a", 10), doc("b", 60), doc("c", 50), doc("d", 30), doc("e", 5), doc("f", 1), doc("g", 1), doc("h", 1)];
    const plan = planFirstPassBatches(docs, limits);
    check(docs, plan);
    expect(plan[0]![0]).toBe("b");
  });

  it("splits by bytes", () => {
    const docs = [doc("a", 1, 600), doc("b", 1, 600), doc("c", 1, 300)];
    const plan = planFirstPassBatches(docs, limits);
    check(docs, plan);
    expect(plan).toHaveLength(2);
  });

  it("gives a document over a limit a batch of its own and adds nothing to it", () => {
    const docs = [doc("big", 500), doc("fat", 1, 5_000), doc("s1", 1), doc("s2", 1)];
    const plan = planFirstPassBatches(docs, limits);
    check(docs, plan);
    expect(plan).toContainEqual(["big"]);
    expect(plan).toContainEqual(["fat"]);
  });

  it("is deterministic and counts unknown page estimates as one page", () => {
    const docs = [doc("a", 0), doc("b", Number.NaN), doc("c", -4), doc("d", 2.5)];
    expect(planFirstPassBatches(docs, limits)).toEqual(planFirstPassBatches([...docs], limits));
    check(docs, planFirstPassBatches(docs, limits));
  });

  it("lists a duplicated document id once", () => {
    expect(planFirstPassBatches([doc("a", 1), doc("a", 1)], limits)).toEqual([["a"]]);
  });

  it("packs 10,000 small documents into close to the minimum number of batches", () => {
    const docs = Array.from({ length: 10_000 }, (_, i) => doc(`d${i}`, 1 + (i % 7), 3));
    const l = { maxFiles: 512, maxBatchBytes: 256 * 1024 * 1024, maxBatchPages: 4_000 };
    const plan = planFirstPassBatches(docs, l);
    check(docs, plan, l);
    const pages = docs.reduce((s, d) => s + d.pages, 0);
    const lower = Math.max(Math.ceil(pages / l.maxBatchPages), Math.ceil(docs.length / l.maxFiles));
    expect(plan.length).toBeLessThanOrEqual(lower + 1);
  });
});

describe("firstPassBatchOptions", () => {
  const withMath = { documentExtraction: { options: { "vm-pdf": { math: true } } } } as never;
  it("reads math only when the project asks and the deploy flag allows it (default off)", () => {
    expect(firstPassBatchOptions(withMath, {}).math).toBe(false);
    expect(firstPassBatchOptions(withMath, { DOCSLURP_FIRST_PASS_MATH: "on" }).math).toBe(true);
    expect(firstPassBatchOptions({ documentExtraction: {} } as never, { DOCSLURP_FIRST_PASS_MATH: "on" }).math).toBe(false);
  });
});
