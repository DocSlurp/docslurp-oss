import { describe, expect, it } from "vitest";

import { buildSemanticDocumentChangelog } from "../services/documents.js";

function buildDocument(id: string, versionNumber: number) {
  return {
    id,
    userId: "user-1",
    orgId: "org-1",
    workspaceId: "ws-1",
    runId: "run-1",
    filename: "master-service-agreement.md",
    mimeType: "text/markdown",
    sourceKey: `${id}.md`,
    status: "completed",
    extractionMode: "balanced",
    pageCount: 3,
    sourceSha256: null,
    dedupedFromDocumentId: null,
    dedupScope: null,
    tags: [],
    versionNumber,
    previousVersionId: versionNumber > 1 ? `doc-v${versionNumber - 1}` : null,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z"
  };
}

describe("buildSemanticDocumentChangelog", () => {
  it("captures additions, deletions, rewrites, and contradictions", () => {
    const changelog = buildSemanticDocumentChangelog({
      current: {
        document: buildDocument("doc-v2", 2),
        source: "markdown",
        text: `
# Service Terms

Acme will ship 45 units within 7 days after payment clears.

Support is included for enterprise plans.

New compliance appendix applies to all renewals.
        `
      },
      baseline: {
        document: buildDocument("doc-v1", 1),
        source: "markdown",
        text: `
# Service Terms

Acme will ship 30 units within 10 days after payment clears.

Support is not included.

Legacy renewal clause remains in effect.
        `
      }
    });

    expect(changelog.available).toBe(true);
    expect(changelog.stats.additions).toBeGreaterThanOrEqual(1);
    expect(changelog.stats.deletions).toBeGreaterThanOrEqual(1);
    expect(changelog.stats.rewrites).toBeGreaterThanOrEqual(1);
    expect(changelog.stats.contradictions).toBeGreaterThanOrEqual(1);
    expect(changelog.additions.some((entry) => entry.currentExcerpt?.includes("compliance appendix"))).toBe(true);
    expect(changelog.deletions.some((entry) => entry.previousExcerpt?.includes("Legacy renewal clause"))).toBe(true);
    expect(changelog.rewrites.some((entry) => entry.previousExcerpt?.includes("30 units"))).toBe(true);
    expect(
      changelog.contradictions.some((entry) =>
        entry.reasons.some((reason) => reason.includes("numeric values changed") || reason.includes("negation flipped"))
      )
    ).toBe(true);
  });

  it("returns an unavailable changelog when there is no baseline version", () => {
    const changelog = buildSemanticDocumentChangelog({
      current: {
        document: buildDocument("doc-v1", 1),
        source: "page-text",
        text: "Only one version exists."
      },
      baseline: null
    });

    expect(changelog.available).toBe(false);
    expect(changelog.summary[0]).toContain("No earlier version");
    expect(changelog.stats.baselineBlocks).toBe(0);
  });
});


describe("buildSemanticDocumentChangelog on long documents", () => {
  const section = (n: number, body = `clause ${n} covers topic${n} with unique${n} wording about subject${n}`) => `## Section ${n}\n\n${body} and shared filler words appear here`;
  const document = (count: number, edit?: (n: number) => string | undefined) =>
    Array.from({ length: count }, (_, i) => section(i, edit?.(i))).join("\n\n");
  const snapshot = (text: string) => ({ source: "markdown" as const, text, document: { id: "d", filename: "f.md", versionNumber: 1, updatedAt: "2026-01-01T00:00:00Z" } });

  it("compares blocks past the old 120-block cut-off and finds an edit near the end", () => {
    const baseline = document(900);
    const current = document(900, (n) => (n === 850 ? `clause 850 now covers topic850 with unique850 wording and a changed deposit of 4500 dollars` : undefined));
    const started = performance.now();
    const changelog = buildSemanticDocumentChangelog({ current: snapshot(current) as never, baseline: snapshot(baseline) as never });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(changelog.stats.currentBlocks).toBe(900);
    expect(changelog.rewrites.some((entry) => entry.currentExcerpt?.includes("4500"))).toBe(true);
  });

  it("says when a version was longer than the comparison limit", () => {
    const long = document(2100);
    const changelog = buildSemanticDocumentChangelog({ current: snapshot(long) as never, baseline: snapshot(long) as never });
    expect(changelog.summary.join(" ")).toContain("Only the first 2000 blocks");
  });
});
