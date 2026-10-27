import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { serviceCors } from "../middleware/widget-cors.js";
const trusted = "https://docslurp.io";
function app() {
  const app = new Hono().use("*", serviceCors([trusted]));
  app.post("/v1/search", (c) => c.json({ results: [] }));
  app.post("/v1/chat", (c) => c.json({ answer: "answer" }));
  app.post("/compat/algolia/1/indexes/test/query", (c) => c.json({ hits: [] }));
  app.get("/v1/api-keys", (c) => c.json({ keys: [] }));
  return app;
}
describe("widget CORS", () => {
  it("does not reflect origins when a keyed widget request is rejected downstream", async () => {
    const rejected = new Hono().use("*", serviceCors([trusted]));
    rejected.post("/v1/search", c => c.json({ error: "Rejected key" }, 403));
    const response = await rejected.request("/v1/search", { method: "POST", headers: { Origin: "https://customer.example", Authorization: "Bearer dslp_pub_rejected" } });
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
  it("treats the app's own origin as first-party on hostnames outside the allowlist", async () => {
    const own = new Hono().use("*", serviceCors([trusted]));
    own.post("/v1/ingest/bulk", (c) => c.json({ ok: true }));
    const response = await own.request("http://dev.example.ts.net:4321/v1/ingest/bulk", {
      method: "POST", headers: { Origin: "http://dev.example.ts.net:4321", Cookie: "session=fixture" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    const foreign = await own.request("http://dev.example.ts.net:4321/v1/ingest/bulk", {
      method: "POST", headers: { Origin: "https://customer.example", Cookie: "session=fixture" },
    });
    expect(foreign.status).toBe(403);
  });

  it("permits canonical chat from a keyed external widget without cookies", async () => {
    const origin = "https://customer.example";
    const preflight = await app().request("/v1/chat", { method: "OPTIONS", headers: {
      Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type",
    } });
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const actual = await app().request("/v1/chat", { method: "POST", headers: { Origin: origin, Authorization: "Bearer client-key" } });
    expect(actual.status).toBe(200);
    expect(actual.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(actual.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const missing = await app().request("/v1/chat", { method: "POST", headers: { Origin: origin, Cookie: "session=fixture" } });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: { code: "forbidden", message: "Browser integrations require an API key" } });
    const unrelated = await app().request("/v1/chat/admin", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
    expect(unrelated.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("permits native compatibility search preflights and Algolia-key headers without cookies", async () => {
    const response = await app().request("/compat/algolia/1/indexes/test/query", {
      method: "OPTIONS", headers: { Origin: "https://customer.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-algolia-api-key,content-type" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://customer.example");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-Algolia-API-Key");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const actual = await app().request("/compat/algolia/1/indexes/test/query", {
      method: "POST", headers: { Origin: "https://customer.example", "X-Algolia-API-Key": "client-key" },
    });
    expect(actual.status).toBe(200);
    const missing = await app().request("/compat/algolia/1/indexes/test/query", {
      method: "POST", headers: { Origin: "https://customer.example", Cookie: "session=secret" },
    });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: "Browser integrations require an API key", code: "forbidden" });
  });
  it("permits key-authenticated widget preflight without cross-site cookies", async () => {
    const response = await app().request("/v1/search", { method: "OPTIONS", headers: { Origin: "https://customer.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://customer.example");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
  it("requires a bearer key on actual cross-site widget requests", async () => {
    const response = await app().request("/v1/search", { method: "POST", headers: { Origin: "https://customer.example", Cookie: "session=secret" } });
    expect(response.status).toBe(403);
  });
  it("guards the chat stream like the rest of chat: keyed widgets get CORS, cross-site cookies get 403", async () => {
    const stream = new Hono().use("*", serviceCors([trusted]));
    stream.get("/v1/chat/stream", (c) => c.text("data: {}\n\n"));
    const cookie = await stream.request("/v1/chat/stream?q=hi", { headers: { Origin: "https://sibling.docslurp.io", Cookie: "session=fixture" } });
    expect(cookie.status).toBe(403);
    const keyed = await stream.request("/v1/chat/stream?q=hi", { headers: { Origin: "https://customer.example", Authorization: "Bearer dslp_pub_widget" } });
    expect(keyed.status).toBe(200);
    expect(keyed.headers.get("Access-Control-Allow-Origin")).toBe("https://customer.example");
    expect(keyed.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
  it("keeps credential management restricted to trusted origins", async () => {
    const response = await app().request("/v1/api-keys", { headers: { Origin: "https://customer.example" } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
  it("retains credentialed CORS for trusted dashboard origins", async () => {
    const response = await app().request("/v1/api-keys", { headers: { Origin: trusted } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(trusted);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });
  it("permits MCP protocol headers and exposes OAuth discovery challenges to trusted clients", async () => {
    const response = await app().request("/v1/mcp", {
      method: "OPTIONS",
      headers: { Origin: trusted, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,mcp-protocol-version" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("MCP-Protocol-Version");
  });
  it("handles invalid origins without throwing", async () => {
    const response = await app().request("/v1/search", { method: "POST", headers: { Origin: "https://%" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
