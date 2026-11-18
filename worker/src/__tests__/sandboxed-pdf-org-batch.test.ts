import { describe, expect, it } from "vitest";

import {
  apportionBatchUsage, assertDemuxTarget, assertSingleOrgBatch, OrgBatchScopeError, type OrgBatchRoute, type SandboxedPdfOrgBatchJob,
} from "../extractors/sandboxed-pdf-org-batch.js";
import type { UsageEvent } from "../models.js";

const file = (index: number, runId: string, documentId: string) => ({
  index, runId, documentId, input: `/b/${index}/source.pdf`, output: `/b/${index}/output.md`, bytes: 10, estimatedPages: 1,
});
const job = (): SandboxedPdfOrgBatchJob => ({
  scope: { orgId: "o1", runIds: ["ra", "rb"] },
  files: [file(0, "ra", "da0"), file(1, "rb", "db0")],
  options: { math: false, figures: false },
});
const owners = new Map<string, { orgId: string | null; runId: string }>([
  ["da0", { orgId: "o1", runId: "ra" }],
  ["db0", { orgId: "o1", runId: "rb" }],
  ["dx0", { orgId: "o2", runId: "rx" }],
]);
const routes = (): OrgBatchRoute[] => [
  { runId: "ra", localIndex: 0, documentId: "da0", root: "/runs/ra/0", output: "/runs/ra/0/output.md" },
  { runId: "rb", localIndex: 0, documentId: "db0", root: "/runs/rb/0", output: "/runs/rb/0/output.md" },
];

describe("assertSingleOrgBatch", () => {
  it("accepts runs of one organization, as the database says", () => {
    expect(() => assertSingleOrgBatch(job(), owners)).not.toThrow();
  });

  it("refuses a document of another organization", () => {
    const j = job();
    j.scope.runIds.push("rx");
    j.files.push(file(2, "rx", "dx0"));
    expect(() => assertSingleOrgBatch(j, owners)).toThrow(OrgBatchScopeError);
  });

  it("refuses a file tagged with a run that does not own its document, even within the organization", () => {
    const j = job();
    j.files[1] = { ...j.files[1]!, runId: "ra" };
    expect(() => assertSingleOrgBatch(j, owners)).toThrow(/does not own|with no file/);
  });

  it("refuses unknown owners, a null organization, duplicate paths and runs outside the scope", () => {
    expect(() => assertSingleOrgBatch(job(), new Map([["da0", owners.get("da0")!]]))).toThrow(OrgBatchScopeError);
    expect(() => assertSingleOrgBatch(job(), new Map([...owners, ["db0", { orgId: null, runId: "rb" }]]))).toThrow(OrgBatchScopeError);
    const dup = job();
    dup.files[1] = { ...dup.files[1]!, output: dup.files[0]!.output };
    expect(() => assertSingleOrgBatch(dup, owners)).toThrow(/distinct/);
    const outside = job();
    outside.scope.runIds = ["ra"];
    expect(() => assertSingleOrgBatch(outside, owners)).toThrow(/outside the scope/);
  });
});

describe("assertDemuxTarget", () => {
  it("routes an event to the run that owns the file's document", () => {
    expect(assertDemuxTarget(job(), routes(), owners, 1).runId).toBe("rb");
  });

  it("refuses a route to the wrong run (a corrupted table never hands one run's result to another)", () => {
    const r = routes();
    r[1] = { ...r[1]!, runId: "ra", root: "/runs/ra/0", output: "/runs/ra/0/output.md" };
    expect(() => assertDemuxTarget(job(), r, owners, 1)).toThrow(/another run/);
  });

  it("refuses when the database no longer says the route's run owns the document", () => {
    expect(() => assertDemuxTarget(job(), routes(), new Map([...owners, ["db0", { orgId: "o1", runId: "ra" }]]), 1)).toThrow(OrgBatchScopeError);
    expect(() => assertDemuxTarget(job(), routes(), new Map([...owners, ["db0", { orgId: "o2", runId: "rb" }]]), 1)).toThrow(OrgBatchScopeError);
  });

  it("refuses a destination outside the run's own folder, and unknown indexes", () => {
    const r = routes();
    r[1] = { ...r[1]!, output: "/runs/ra/0/output.md" };
    expect(() => assertDemuxTarget(job(), r, owners, 1)).toThrow(/outside/);
    const sibling = routes();
    sibling[1] = { ...sibling[1]!, root: "/runs/rb/0", output: "/runs/rb/0-evil/output.md" };
    expect(() => assertDemuxTarget(job(), sibling, owners, 1)).toThrow(/outside/);
    for (const index of [-1, 2, 1.5, "1", undefined]) expect(() => assertDemuxTarget(job(), routes(), owners, index)).toThrow(/unknown file index/);
  });
});

describe("apportionBatchUsage", () => {
  const vm = (costCents: number): UsageEvent => ({ provider: "modal", model: "vm", metric: "sandbox_compute", amount: costCents, unit: "cent", costCents });

  it("splits every event by weight, and the shares sum exactly to the whole", () => {
    const shares = apportionBatchUsage([vm(1), vm(0.333333)], new Map([["ra", 1], ["rb", 1], ["rc", 1]]));
    for (const index of [0, 1]) {
      const parts = [...shares.values()].map((events) => events[index]!);
      const total = index === 0 ? 1 : 0.333333;
      expect(Math.round(parts.reduce((sum, e) => sum + e.costCents, 0) * 1e6)).toBe(Math.round(total * 1e6));
      expect(Math.round(parts.reduce((sum, e) => sum + e.amount, 0) * 1e4)).toBe(Math.round(total * 1e4));
    }
    expect(shares.get("ra")![0]!.metadata).toMatchObject({ sharedBatch: { runs: 3, weight: 1, totalWeight: 3 } });
  });

  it("weights by pages; a zero weight gets nothing; no weight at all bills the first run", () => {
    const byPages = apportionBatchUsage([vm(10)], new Map([["ra", 3], ["rb", 1], ["rc", 0]]));
    expect(byPages.get("ra")![0]!.costCents).toBe(7.5);
    expect(byPages.get("rb")![0]!.costCents).toBe(2.5);
    expect(byPages.get("rc")).toEqual([]);
    const none = apportionBatchUsage([vm(10)], new Map([["ra", 0], ["rb", 0]]));
    expect(none.get("ra")![0]!.costCents).toBe(10);
    expect(none.get("rb")).toEqual([]);
  });
});
