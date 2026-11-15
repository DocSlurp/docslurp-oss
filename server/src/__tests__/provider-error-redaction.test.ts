import OpenAI from "openai";
import { expect, it } from "vitest";
import { instrumentFetch } from "@docslurp/shared/observability";

it.each([false, true])("keeps provider secrets out of SDK errors with stream=%s", async (stream) => {
  const payload = JSON.stringify({ error: { message: "sentinel-provider-secret", type: "provider_error" }, debug: "sentinel-provider-secret" });
  const client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: instrumentFetch("test", "chat", async () => new Response(
    stream ? `data: ${payload}\n\n` : payload,
    { headers: { "content-type": stream ? "text/event-stream" : "application/json" } },
  )) });
  let caught: unknown;
  try {
    if (stream) {
      const result = await client.chat.completions.create({ model: "test", messages: [], stream: true });
      for await (const chunk of result) void chunk;
    } else {
      const result = await client.chat.completions.create({ model: "test", messages: [] });
      expect(JSON.stringify(result)).not.toContain("sentinel-provider-secret");
      expect(JSON.stringify(result)).toContain("Provider request failed");
      return;
    }
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).toContain("Provider request failed");
  expect(String(caught)).not.toContain("sentinel-provider-secret");
  expect(JSON.stringify(caught)).not.toContain("sentinel-provider-secret");
});
