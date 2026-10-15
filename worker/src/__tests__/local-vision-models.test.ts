import { describe, expect, it } from "vitest";

import {
  localVisionModelProfilesById,
  verifyProfileAgainstMetadata,
  type HuggingFaceModelMetadata,
} from "../benchmarks/local-vision-models.js";

describe("verifyProfileAgainstMetadata", () => {
  it("passes when expected files match pinned hashes and sizes", () => {
    const profile = localVisionModelProfilesById["mineru25-pro-q4-k-m"];
    const metadata: HuggingFaceModelMetadata = {
      id: profile.repo,
      private: false,
      gated: false,
      disabled: false,
      sha: profile.expectedRepoSha,
      cardData: { license: profile.license },
      siblings: profile.expectedFiles.map((file) => ({
        rfilename: file.path,
        size: file.size,
        lfs: {
          sha256: file.sha256,
          size: file.size,
        },
      })),
    };

    const result = verifyProfileAgainstMetadata(profile, metadata);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.files.every((file) => file.verified)).toBe(true);
  });

  it("fails closed when a pinned file hash changes", () => {
    const profile = localVisionModelProfilesById["infinity-parser2-flash-q6-k"];
    const metadata: HuggingFaceModelMetadata = {
      id: profile.repo,
      sha: profile.expectedRepoSha,
      cardData: { license: profile.license },
      siblings: profile.expectedFiles.map((file, index) => ({
        rfilename: file.path,
        size: file.size,
        lfs: {
          sha256: index === 0 ? "0".repeat(64) : file.sha256,
          size: file.size,
        },
      })),
    };

    const result = verifyProfileAgainstMetadata(profile, metadata);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`sha256 mismatch for ${profile.expectedFiles[0].path}`);
  });

  it("warns but does not fail when the repo head changed and target files still match", () => {
    const profile = localVisionModelProfilesById["unlimited-ocr-q4-k-m"];
    const metadata: HuggingFaceModelMetadata = {
      id: profile.repo,
      sha: "1".repeat(40),
      cardData: { license: profile.license },
      siblings: profile.expectedFiles.map((file) => ({
        rfilename: file.path,
        size: file.size,
        lfs: {
          sha256: file.sha256,
          size: file.size,
        },
      })),
    };

    const result = verifyProfileAgainstMetadata(profile, metadata);

    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain("repository HEAD changed");
  });

  it("fails closed for gated repositories", () => {
    const profile = localVisionModelProfilesById["surya-ocr2-mlx-8bit-g64"];
    const metadata: HuggingFaceModelMetadata = {
      id: profile.repo,
      gated: "manual",
      cardData: { license: profile.license },
      siblings: profile.expectedFiles.map((file) => ({
        rfilename: file.path,
        size: file.size,
        lfs: {
          sha256: file.sha256,
          size: file.size,
        },
      })),
    };

    const result = verifyProfileAgainstMetadata(profile, metadata);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("repository is gated");
  });

  it("allows unknown-license eval profiles when pinned artifacts match", () => {
    const profile = localVisionModelProfilesById["glm-ocr-q8-0"];
    const metadata: HuggingFaceModelMetadata = {
      id: profile.repo,
      sha: profile.expectedRepoSha,
      siblings: profile.expectedFiles.map((file) => ({
        rfilename: file.path,
        size: file.size,
        lfs: {
          sha256: file.sha256,
          size: file.size,
        },
      })),
    };

    const result = verifyProfileAgainstMetadata(profile, metadata);

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("repository does not expose license metadata");
  });
});
