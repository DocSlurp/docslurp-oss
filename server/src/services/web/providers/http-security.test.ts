import { expect, it, vi } from "vitest";
import { providerJson } from "./http.js";

it.each([301, 302, 307, 308])("rejects API redirect %s without reading hostile bodies", async status => {
  const transport = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(init.redirect).toBe("error");
    return new Response("secret", { status, headers: { location: "http://169.254.169.254/" } });
  });
  await expect(providerJson("test", { fetch: transport as typeof fetch, signal: new AbortController().signal, apiKey: "key", deadlineMs: 1000 }, "https://api.example.com", {})).rejects.toThrow("responded");
  expect(transport).toHaveBeenCalledOnce();
});
it("bounds chunked JSON before parsing", async () => {
  let canceled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { canceled = true; } });
  await expect(providerJson("test", { fetch: vi.fn(async () => new Response(body)), signal: new AbortController().signal, apiKey: "key", deadlineMs: 1000 }, "https://api.example.com", {})).rejects.toThrow("invalid JSON");
  expect(canceled).toBe(true);
});
