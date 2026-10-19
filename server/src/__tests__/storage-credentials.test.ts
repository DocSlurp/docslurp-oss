import { describe, expect, it } from "vitest";

import { storageAccessKeyIdProblem } from "../lib/storage-credentials.js";

// Synthetic keys that only mimic each provider's shape.
describe("storageAccessKeyIdProblem", () => {
  it.each([
    ["AWS IAM user (20 chars)", "AKIAZ7Q3XM4K9TB2WN5R"],
    ["AWS STS temporary (20 chars)", "ASIAQ8R2VD6L1HC4YJ7P"],
    ["Cloudflare R2 (32 hex)", "3f9a1c7e5b2d8046af19c3e7b5d20814"],
    ["Backblaze B2 (25 chars)", "0035a1b9c7d3e2f4000000007"],
    ["Tigris (tid_ prefix)", "tid_xKqWmZ_aBcDeFgHiJkLmNoPqRsT"],
  ])("accepts %s", (_name, key) => {
    expect(storageAccessKeyIdProblem(key)).toBeNull();
  });

  it.each([undefined, "", "   "])("rejects empty value %j", (key) => {
    expect(storageAccessKeyIdProblem(key)).toMatch(/required/);
  });

  it.each(["minioadmin", "MinioAdmin", "docslurp", "password", "changeme", "testtest"])(
    "rejects placeholder %s",
    (key) => {
      expect(storageAccessKeyIdProblem(key)).toMatch(/placeholder/);
    },
  );

  it("rejects the documented AWS example key", () => {
    expect(storageAccessKeyIdProblem("AKIAIOSFODNN7EXAMPLE")).toMatch(/placeholder|example/);
  });

  it("rejects short and low-variety keys", () => {
    expect(storageAccessKeyIdProblem("AKIA1234")).toMatch(/at least/);
    expect(storageAccessKeyIdProblem("AAAAAAAAAAAAAAAAAAAA")).toMatch(/variety/);
  });
});
