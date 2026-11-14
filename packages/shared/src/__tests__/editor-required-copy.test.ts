import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_ERROR_PUBLIC_MESSAGES, EDITOR_REQUIRED_MESSAGE } from "../api-error.js";

/**
 * One wording for `editor_required` everywhere. The SDK and CLI are published without dependencies, so they cannot import
 * this package at runtime; each keeps a literal copy, and this test fails when a copy drifts from the shared constant.
 */
const copyIn = (relative: string) => {
  const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  const match = /const EDITOR_REQUIRED_MESSAGE = "([^"]+)";/.exec(source);
  return match?.[1];
};

describe("editor_required copy", () => {
  it("the API's public message is the shared constant", () => {
    expect(API_ERROR_PUBLIC_MESSAGES.editor_required).toBe(EDITOR_REQUIRED_MESSAGE);
  });
  it("the SDK and CLI copies match it", () => {
    expect(copyIn("../../../sdk/src/http-failure.ts")).toBe(EDITOR_REQUIRED_MESSAGE);
    expect(copyIn("../../../cli/src/http-failure.ts")).toBe(EDITOR_REQUIRED_MESSAGE);
  });
});
