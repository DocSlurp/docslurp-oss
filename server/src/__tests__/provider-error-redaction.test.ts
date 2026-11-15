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

const secret = "sentinel-private-diagnostic";
function chunked(raw: string, width: number, contentType = "text/event-stream") {
  const bytes = new TextEncoder().encode(raw);
  let offset = 0;
  return new Response(new ReadableStream({ pull(c) {
    if (offset >= bytes.length) { c.close(); return; }
    c.enqueue(bytes.slice(offset, offset += width));
  } }), {headers: {"content-type": contentType}});
}
it("normalizes protocol errors through the real OpenAI SDK, including named events and CR framing", async () => {
  const {default: OpenAI} = await import("openai");
  for (const ending of ["\n", "\r", "\r\n"]) for (const width of [1, 7, 65536]) {
    for (const payload of [
      `event: error${ending}data: {"message":"${secret}"}`,
      `data: {"type":"response.failed","response":{"error":{"message":"${secret}"}}}`,
      `data: {"type":"response.error","error":"${secret}"}`,
      `data: {"error":{"message":"${secret}"}}`,
      `data: {"error":"${secret}"}`,
    ]) {
      for (const suffix of ["", ending + ending]) {
        const http = instrumentFetch("test", "negative", async () => chunked(payload + suffix, width));
        const client = new OpenAI({apiKey: "unused", baseURL: "https://example.test", fetch: http, maxRetries: 0});
        let observed = "";
        try { for await (const item of await client.chat.completions.create({model: "test", messages: [], stream: true})) observed += JSON.stringify(item); }
        catch (error) { observed += String(error); }
        expect(observed).not.toContain(secret);
        expect(observed).toContain("Provider request failed");
      }
    }
    const content = {choices: [{index: 0, delta: {content: "valid ☃ error prose", tool_calls: [{index: 0, id: "tool", type: "function", function: {name: "f", arguments: "{}"}}]}}], usage: {prompt_tokens: 5, completion_tokens: 2}};
    const client = new OpenAI({apiKey: "unused", baseURL: "https://example.test", maxRetries: 0,
      fetch: instrumentFetch("test", "success", async () => chunked(`data: ${JSON.stringify(content)}${ending}${ending}data: [DONE]${ending}${ending}`, width))});
    const items = [];
    for await (const item of await client.chat.completions.create({model: "test", messages: [], stream: true})) items.push(item);
    expect(items).toEqual([content]);
  }
});

it("keeps transport and reader diagnostics out of actual SDK public errors", async () => {
  for (const http of [async () => { throw new Error(secret); }, async () => new Response(new ReadableStream({pull(c) {c.error(new Error(secret));}}), {headers: {"content-type": "text/event-stream"}})]) {
    const client = new OpenAI({apiKey: "unused", baseURL: "https://example.test", maxRetries: 0, fetch: instrumentFetch("test", "broken", http)});
    let caught;
    try { for await (const item of await client.chat.completions.create({model: "test", messages: [], stream: true})) void item; }
    catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect(String(caught)).not.toContain(secret);
  }
});

it("normalizes non-SSE Responses failure equivalents before actual SDK consumption", async () => {
  for (const payload of [{type: "response.failed", response: {error: {message: secret}}}, {type: "response.error", error: secret}, {error: secret}]) {
    const client = new OpenAI({apiKey: "unused", baseURL: "https://example.test", maxRetries: 0,
      fetch: instrumentFetch("test", "json-failure", async () => chunked(JSON.stringify(payload), 1, "application/json"))});
    const result = await client.chat.completions.create({model: "test", messages: []});
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("Provider request failed");
  }
});

it.each(["application/problem+json", "text/plain", "application/octet-stream", "", "application/json; charset=utf-8"])("validates provider bytes independently of MIME %s", async (mime) => {
  for (const payload of [{error:{message:secret}}, {type:"response.failed", response:{error:{message:secret}}}]) {
    const client = new OpenAI({apiKey:"unused", maxRetries:0, fetch:instrumentFetch("test", "mime", async () => chunked(JSON.stringify(payload), 1, mime))});
    const result = await client.chat.completions.create({model:"test", messages:[]});
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("Provider request failed");
  }
  const content = {choices:[{message:{content:"legitimate error prose ☃"}}], usage:{total_tokens:2}};
  const http = instrumentFetch("test", "valid", async () => chunked(JSON.stringify(content), 1, mime));
  expect(await (await http("https://example.test")).json()).toEqual(content);
  for (const raw of [secret, `<html>${secret}</html>`, "x".repeat(17 * 1024 * 1024)]) {
    const fetcher = instrumentFetch("test", "unsafe", async () => new Response(raw, {headers:{"content-type":mime}}));
    await expect((await fetcher("https://example.test")).text()).rejects.toThrow(/Invalid provider response/);
  }
});

it.each(["text/plain", "application/problem+json", "application/octet-stream", ""])("refuses mislabeled SSE before SDK error consumption: %s", async (mime) => {
  const client = new OpenAI({apiKey:"unused", maxRetries:0, fetch:instrumentFetch("test", "mislabeled-stream", async () => chunked(`data: {"error":{"message":"${secret}"}}\n\n`, 1, mime))});
  let caught;
  try { for await (const item of await client.chat.completions.create({model:"test", messages:[], stream:true})) void item; }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).not.toContain(secret);
  expect(JSON.stringify(caught)).not.toContain(secret);
});
