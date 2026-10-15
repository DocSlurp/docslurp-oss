import { describe, expect, it } from "vitest";

import {
  artifactUri,
  keyFromArtifactUri,
  parseArtifactUri,
} from "../artifacts.js";

describe("artifact URI helpers", () => {
  it("round-trips S3 artifact URIs", () => {
    const uri = artifactUri("docslurp-artifacts", "runs/run-1/manifest.json");

    expect(uri).toBe("s3://docslurp-artifacts/runs/run-1/manifest.json");
    expect(parseArtifactUri(uri)).toEqual({
      bucket: "docslurp-artifacts",
      key: "runs/run-1/manifest.json",
    });
  });

  it("extracts keys only for the expected bucket", () => {
    expect(
      keyFromArtifactUri(
        "s3://docslurp-artifacts/runs/run-1/manifest.json",
        "docslurp-artifacts",
      ),
    ).toBe("runs/run-1/manifest.json");
    expect(
      keyFromArtifactUri(
        "s3://other-bucket/runs/run-1/manifest.json",
        "docslurp-artifacts",
      ),
    ).toBeNull();
  });

  it("passes raw keys through while rejecting malformed S3 URIs", () => {
    expect(keyFromArtifactUri("runs/run-1/manifest.json", "docslurp-artifacts")).toBe(
      "runs/run-1/manifest.json",
    );
    expect(keyFromArtifactUri("s3://", "docslurp-artifacts")).toBeNull();
  });
});
