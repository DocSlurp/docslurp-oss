import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrivacyModeViolationError } from "@docslurp/shared";

const mocks = vi.hoisted(() => ({
  sql: vi.fn((..._args: unknown[]) => Promise.resolve([] as unknown[])),
  generateText: vi.fn(),
  streamText: vi.fn(),
  embed: vi.fn(),
}));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: mocks.generateText,
  streamText: mocks.streamText,
  embed: mocks.embed,
}));

const { generateOpenRouterText, generateOpenRouterDocumentText, embedConfiguredText } = await import("../lib/ai.js");
const { privacyModeOf, strictestPrivacyMode, loadProjectPrivacyMode, hostedApiKeyForProject, hostedApiKeyForProjects, openRouterCall } = await import("../lib/privacy.js");
const { hydeExpand } = await import("../search/hyde.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sql.mockImplementation(() => Promise.resolve([]));
});

function auditCalls() {
  return mocks.sql.mock.calls.filter((call) => Array.isArray(call[0]) && (call[0] as string[]).join("").includes("insert into privacy_audit_log"));
}

describe("privacy mode resolution", () => {
  it("reads stored modes and fails closed on unknown values", () => {
    expect(privacyModeOf(undefined)).toBe("standard");
    expect(privacyModeOf({})).toBe("standard");
    expect(privacyModeOf({ privacyMode: "local-only" })).toBe("local-only");
    expect(privacyModeOf({ privacyMode: "typo" })).toBe("strict-privacy");
    expect(strictestPrivacyMode(["standard", "strict-privacy", "local-only"])).toBe("strict-privacy");
    expect(strictestPrivacyMode([])).toBe("standard");
  });

  it("treats a failed project lookup as local-only", async () => {
    mocks.sql.mockImplementationOnce(() => Promise.reject(new Error("db down")));
    expect(await loadProjectPrivacyMode("ws")).toBe("local-only");
  });
});

describe("app AI clients refuse hosted calls outside standard mode", () => {
  it("blocks OpenRouter text and document generation", async () => {
    await expect(generateOpenRouterText({ apiKey: "k", prompt: "secret query", maxOutputTokens: 5, privacyMode: "local-only" }))
      .rejects.toBeInstanceOf(PrivacyModeViolationError);
    await expect(generateOpenRouterDocumentText({
      apiKey: "k", prompt: "q", maxOutputTokens: 5, privacyMode: "strict-privacy",
      documents: [{ title: "a", text: "confidential" }],
    })).rejects.toBeInstanceOf(PrivacyModeViolationError);
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("blocks hosted embeddings but allows loopback-local providers", async () => {
    await expect(embedConfiguredText({ value: "q", runtime: "remote", provider: "openai", model: "text-embedding-3-small", apiKey: "k", privacyMode: "local-only" }))
      .rejects.toBeInstanceOf(PrivacyModeViolationError);
    expect(mocks.embed).not.toHaveBeenCalled();
    mocks.embed.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 1 } });
    await expect(embedConfiguredText({ value: "q", runtime: "remote", provider: "ollama", model: "nomic", baseURL: "http://127.0.0.1:11434/v1", privacyMode: "local-only" }))
      .resolves.toMatchObject({ embedding: [0.1, 0.2] });
  });

  it("search strategies degrade to the original query when the key is withheld", async () => {
    const usage = { record: vi.fn() };
    const apiKey = await hostedApiKeyForProject({
      apiKey: "k", privacyMode: "local-only", projectId: "ws", call: openRouterCall("api.search.strategies", "m"),
    });
    expect(apiKey).toBeUndefined();
    expect(await hydeExpand("what is the policy", apiKey ?? "", usage, "local-only"))
      .toEqual({ hypothesis: "", expandedQuery: "what is the policy" });
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(0);
  });
});

describe("privacy audit log", () => {
  it("records strict-privacy blocks only", async () => {
    const call = openRouterCall("api.chat", "vendor/model");
    expect(await hostedApiKeyForProject({ apiKey: "k", privacyMode: "standard", projectId: "ws", call })).toBe("k");
    expect(await hostedApiKeyForProject({ apiKey: "k", privacyMode: "strict-privacy", projectId: "ws", call })).toBeUndefined();
    expect(auditCalls()).toHaveLength(1);
    expect(mocks.sql).toHaveBeenCalledWith(
      [expect.objectContaining({ project_id: "ws", model_id: "openrouter/vendor/model", endpoint: "blocked:api.chat", privacy_mode: "strict-privacy" })],
      "document_id", "run_id", "project_id", "model_id", "endpoint", "privacy_mode",
    );
  });

  it("uses the strictest project for cross-project answers", async () => {
    mocks.sql.mockImplementation((...args: unknown[]) => {
      const text = Array.isArray(args[0]) ? (args[0] as string[]).join("") : "";
      if (text.includes("select pipeline from projects")) {
        return Promise.resolve([{ pipeline: args[1] === "private" ? { privacyMode: "strict-privacy" } : {} }]);
      }
      return Promise.resolve([]);
    });
    const result = await hostedApiKeyForProjects({ apiKey: "k", projectIds: ["public", "private", "public"], call: openRouterCall("api.aggregate-rag.answer", "m") });
    expect(result).toEqual({ apiKey: undefined, privacyMode: "strict-privacy" });
    expect(auditCalls()).toHaveLength(1);
  });
});
