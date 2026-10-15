import { describe, expect, it } from "vitest";

import { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";

describe("DocumentArtifactLedger", () => {
  it("records artifacts into the state and run maps together", () => {
    const artifacts: Record<string, string> = {};
    const runArtifacts: Record<string, string> = {};
    const ledger = DocumentArtifactLedger.create(artifacts, runArtifacts);

    ledger.recordDocument("doc-1", "markdown", "s3://bucket/doc-1.md");

    expect(ledger.read("doc-1:markdown")).toBe("s3://bucket/doc-1.md");
    expect(artifacts["doc-1:markdown"]).toBe("s3://bucket/doc-1.md");
    expect(runArtifacts["doc-1:markdown"]).toBe("s3://bucket/doc-1.md");
  });

  it("can retarget a hydrated artifact map", () => {
    const original: Record<string, string> = {};
    const hydrated = { "doc-1:markdown": "s3://bucket/checkpoint.md" };
    const ledger = DocumentArtifactLedger.create(original);

    ledger.replace(hydrated);
    ledger.recordDocument("doc-1", "html", "s3://bucket/doc-1.html");

    expect(original).toEqual({});
    expect(hydrated).toMatchObject({
      "doc-1:markdown": "s3://bucket/checkpoint.md",
      "doc-1:html": "s3://bucket/doc-1.html",
    });
  });

  it("returns artifacts changed since a previous snapshot", () => {
    const ledger = DocumentArtifactLedger.create({
      "doc-1:markdown": "s3://bucket/old.md",
      "doc-1:html": "s3://bucket/new.html",
    });

    expect(
      ledger.changedSince({
        "doc-1:markdown": "s3://bucket/old.md",
      }),
    ).toEqual({
      "doc-1:html": "s3://bucket/new.html",
    });
  });
});
