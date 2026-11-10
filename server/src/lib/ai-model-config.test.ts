import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_CHAT_MODEL, PROJECT_CHAT_MODELS } from "@docslurp/shared/project-chat-models";
import { resolveApiTextModelDefault } from "./ai-model-config.js";

afterEach(() => vi.unstubAllEnvs());

it("uses the configured approved model rather than the built-in default", () => {
  for (const { id } of PROJECT_CHAT_MODELS) {
    vi.stubEnv("DOCSLURP_SEARCH_MODEL", ` ${id} `);
    expect(resolveApiTextModelDefault()).toBe(id);
  }
});

it("inherits the catalog default for absent settings and rejects unsupported choices", () => {
  vi.stubEnv("DOCSLURP_SEARCH_MODEL", "");
  expect(resolveApiTextModelDefault()).toBe(DEFAULT_PROJECT_CHAT_MODEL);
  vi.stubEnv("DOCSLURP_SEARCH_MODEL", "unlisted/model");
  expect(resolveApiTextModelDefault).toThrow("DOCSLURP_SEARCH_MODEL");
});
