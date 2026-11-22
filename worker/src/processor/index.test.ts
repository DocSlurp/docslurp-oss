import { describe, expect, it, vi } from "vitest";

import { createArtifactProcessor, type ArtifactGraphAdapter, type ArtifactRequest, type ExtractionArtifactRef } from "./index.js";

const source: ExtractionArtifactRef = {
  id: "source",
  kind: "document/text",
  uri: "memory:source",
  mediaType: "text/plain",
  sha256: "source-digest",
  sourceDocumentId: "document",
  derivedFrom: [],
  placements: [],
  producer: { id: "source", optionsDigest: "source-options" },
};

const request: ArtifactRequest = {
  sourceDocumentId: "document",
  initial: [source],
  target: ["document/markdown"],
};

function adapter(): ArtifactGraphAdapter {
  return {
    id: "format-text",
    accepts: ["document/text"],
    emits: ["document/markdown"],
    scope: "document",
    run: vi.fn(async ([input]) => [{
      ...input!,
      id: "markdown",
      kind: "document/markdown",
      uri: "memory:markdown",
      mediaType: "text/markdown",
      derivedFrom: [input!.id],
      producer: { id: "format-text", optionsDigest: "format-options" },
    }]),
  };
}

describe("standalone artifact processor", () => {
  it("executes the configured adapter and returns a manifest", async () => {
    const transform = adapter();
    const result = await createArtifactProcessor([transform]).execute(request);

    expect(transform.run).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      targets: [{ uri: "memory:markdown", derivedFrom: ["source"] }],
      steps: ["format-text"],
    });
  });

  it("refuses foreign artifacts, exceeds no output limit, and honors cancellation", async () => {
    const transform = adapter();
    const processor = createArtifactProcessor([transform]);
    await expect(processor.execute({ ...request, sourceDocumentId: "other" })).rejects.toThrow("belongs to another document");
    const signal = AbortSignal.abort();
    await expect(processor.execute(request, signal)).rejects.toThrow();
    expect(transform.run).not.toHaveBeenCalled();
    await expect(processor.execute({ ...request, maxOutputs: 1 })).resolves.toMatchObject({ ok: false, reason: "limit" });
  });
});
