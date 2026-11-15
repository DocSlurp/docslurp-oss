import { afterEach, expect, it, vi } from "vitest";
import { assertOpenAiEmbeddingDestination, embedConfiguredText, embedConfiguredTexts } from "../lib/ai.js";

afterEach(() => vi.unstubAllEnvs());
it.each(["http://127.0.0.1/v1", "http://10.0.0.1/v1", "https://tenant.example.test/v1", "https://api.openai.com.evil.test/v1"])("refuses embedding credential destination %s before transport", async (baseURL) => {
  vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
  expect(() => assertOpenAiEmbeddingDestination(baseURL)).toThrow("not operator configured");
  const args = { runtime: "remote", provider: "openai", apiKey: "sentinel-secret", model: "text-embedding-3-small", baseURL, privacyMode: "standard" as const };
  await expect(embedConfiguredText({ ...args, value: "query" })).rejects.toThrow("not operator configured");
  await expect(embedConfiguredTexts({ ...args, values: ["query"] })).rejects.toThrow("not operator configured");
});
