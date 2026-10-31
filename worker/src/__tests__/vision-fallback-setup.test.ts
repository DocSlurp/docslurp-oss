import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema, type ProviderCallDescriptor } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import { guardedVisionCall } from "../lib/guarded-vision-call.js";
import { MemoryVisionAttemptBackend } from "../lib/vision-attempt-guard.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { resetStreamingSupportForTest } from "../tools/vision-stream.js";

const FALLBACK = "llm://openai/gpt-4.1-mini";

// The fallback's own privacy check throws during fallback setup (after the primary was billed). In practice this
// setup cannot fail once the earlier checks pass; the mock stands in for any setup error there.
vi.mock("@docslurp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@docslurp/shared")>();
  return {
    ...actual,
    assertProviderAllowed: (mode: string, call: ProviderCallDescriptor) => {
      if (call.modelUri === FALLBACK) throw new Error("fallback setup failed");
      return actual.assertProviderAllowed(mode, call);
    },
  };
});

const cfg = {
  openRouterApiKey: "or-key", openAiApiKey: "sk-test", openAiBaseUrl: "https://api.openai.com/v1",
  costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03, visionStreaming: false,
} as Config;

beforeEach(() => {
  resetStreamingSupportForTest();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fallback setup failure", () => {
  it("keeps the primary's billed rejection on the error, so it is recorded", async () => {
    const sends: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      sends.push(new URL(url).host);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Total: 42" }, finish_reason: "length" }], usage: { prompt_tokens: 1_200, completion_tokens: 300 } }),
        { headers: { "content-type": "application/json" } });
    }));
    const dir = await mkdtemp(join(tmpdir(), "vision-fallback-setup-"));
    const imagePath = join(dir, "page.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const vision = visionConfigSchema.parse({ modelUri: "llm://openrouter/google/gemini-3.1-flash-lite", remoteFallbackModelUri: FALLBACK });
    const recorded: WorkerAiUsageInput[] = [];
    const error = await guardedVisionCall({
      host: { run: { id: "run-1", orgId: "org-1" }, visionAttempts: new MemoryVisionAttemptBackend() },
      vision, cfg, target: { documentId: "doc", pageNumber: 1, purpose: "region" },
      record: (input) => {
        recorded.push(input);
        return null;
      },
      call: (gate) => executeVisionRuntime({
        imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate,
      }),
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("fallback setup failed");
    expect(sends.every((host) => host === "openrouter.ai")).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ provider: "openrouter", model: "google/gemini-3.1-flash-lite", metadata: { outcome: "rejected", fallbackPrimary: true } });
    expect(recorded[0]!.costCents!).toBeGreaterThan(0);
  });
});
