import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { rejectNulBytes } from "../lib/reject-nul.js";

function app() {
  const hono = new Hono();
  hono.use("*", rejectNulBytes);
  hono.post("/echo", async (c) => c.json({ body: await c.req.json() }));
  hono.get("/search", (c) => c.json({ q: c.req.query("q") }));
  return hono;
}

const post = (body: string, type = "application/json") => app().request("/echo", { method: "POST", headers: { "content-type": type }, body });

describe("rejectNulBytes", () => {
  it("rejects a JSON string carrying a NUL escape in any field with a 400 and a stable code", async () => {
    for (const body of ['{"q":"a\\u0000b"}', '{"filters":{"tags":"x\\u0000"}}', '{"name":"bad\\u0000"}', '{"q":"\\U0000"}']) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_characters" });
    }
  });

  it("rejects a NUL in the query string", async () => {
    expect((await app().request("/search?q=%00")).status).toBe(400);
    expect((await app().request("/search?q=a%00b")).status).toBe(400);
  });

  it("passes clean JSON through and leaves the body readable by the handler", async () => {
    const response = await post('{"q":"tls handshake"}');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { q: "tls handshake" } });
  });

  it("does not mistake an escaped backslash followed by text for a NUL escape", async () => {
    const response = await post('{"q":"literal \\\\u0000 text"}');
    expect(response.status).toBe(200);
  });

  it("does not inspect non-JSON bodies", async () => {
    expect((await post("raw \\u0000 text", "text/plain")).status).not.toBe(400);
  });
});
