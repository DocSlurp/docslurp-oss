import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ env: { maxUploadBytes: 500 * 1024 * 1024 } }));

const { multipartBodyLimit, multipartTooLarge } = await import("../lib/upload-policy.js");

function app(maxBytes: number) {
  const reached = vi.fn();
  const hono = new Hono();
  hono.use("/v1/uploads/bulk", multipartBodyLimit(maxBytes));
  hono.post("/v1/uploads/bulk", async (c) => {
    await c.req.parseBody({ all: true });
    reached();
    return c.json({ ok: true });
  });
  return { hono, reached };
}

function form(bytes: number): FormData {
  const body = new FormData();
  body.append("files", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), "a.pdf");
  return body;
}

describe("multipart upload cap", () => {
  it("accepts a small multipart upload", async () => {
    const { hono, reached } = app(1024 * 1024);
    const response = await hono.request("/v1/uploads/bulk", { method: "POST", body: form(10_000) });
    expect(response.status).toBe(200);
    expect(reached).toHaveBeenCalled();
  });

  it("rejects an oversized body with 413 and points at direct upload sessions, before the handler buffers it", async () => {
    const { hono, reached } = app(64 * 1024);
    const response = await hono.request("/v1/uploads/bulk", { method: "POST", body: form(200 * 1024) });
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "payload_too_large", details: { maxBytes: 64 * 1024, directUpload: { createSession: "/v1/uploads/direct/sessions" } } } });
    expect(body.error.message).toContain("/v1/uploads/direct/sessions");
    expect(reached).not.toHaveBeenCalled();
  });

  it("rejects multipart streamed without Content-Length before parsing", async () => {
    const { hono, reached } = app(64 * 1024);
    const encoded = new Request("http://localhost", { method: "POST", body: form(200 * 1024) });
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    let offset = 0;
    const body = new ReadableStream({ pull(controller) {
      if (offset === bytes.byteLength) { controller.close(); return; }
      const next = Math.min(offset + 16 * 1024, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, next));
      offset = next;
    } });
    const request = new Request("http://localhost/v1/uploads/bulk", {
      method: "POST", headers: { "content-type": encoded.headers.get("content-type")! }, body, duplex: "half",
    } as RequestInit);
    expect(request.headers.has("content-length")).toBe(false);
    const response = await hono.request(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large", details: { maxBytes: 64 * 1024 } } });
    expect(reached).not.toHaveBeenCalled();
  });

  it("reports the limit in MB", () => {
    expect(multipartTooLarge(25 * 1024 * 1024).message).toContain("25 MB");
  });
});
