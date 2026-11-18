import { Hono } from "hono";
import { publicApiErrorMessage } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ env: { maxUploadBytes: 500 * 1024 * 1024 } }));

const { multipartBodyLimit, multipartTooLarge } = await import("../lib/upload-policy.js");
const { v1BodyLimit } = await import("../lib/v1-body-limit.js");
const { rejectLegacyProjectSelection } = await import("../lib/reject-legacy-project-selection.js");
const { BODY_IDLE_TIMEOUT_MS } = await import("../lib/bounded-body-limit.js");

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
    // Encoded bytes, not a live FormData stream: cancelling undici's FormData body
    // mid-stream raises an unhandled rejection inside undici (network bodies are unaffected).
    const encoded = new Request("http://localhost", { method: "POST", body: form(200 * 1024) });
    const response = await hono.request("/v1/uploads/bulk", {
      method: "POST", headers: { "content-type": encoded.headers.get("content-type")! }, body: new Uint8Array(await encoded.arrayBuffer()),
    });
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

/** The production `/v1/*` cap selection and the content-type guard, as server.ts mounts them. */
function v1App(maxMultipartUploadBytes: number) {
  const reached = vi.fn();
  const hono = new Hono();
  hono.use("/v1/*", v1BodyLimit({ maxMultipartUploadBytes }));
  hono.use("/v1/*", rejectLegacyProjectSelection);
  hono.post("/v1/uploads/bulk", async (c) => {
    reached();
    if (!c.req.raw.body) return c.json({ files: null });
    const body = await c.req.parseBody({ all: true });
    return c.json({ files: Object.keys(body).length });
  });
  return { hono, reached };
}

function streamOf(total: number, chunk = 16 * 1024) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (sent >= total) { controller.close(); return; }
    const size = Math.min(chunk, total - sent);
    controller.enqueue(new Uint8Array(size));
    sent += size;
  } });
}

describe("bulk upload cap through the /v1 limiter (in-process entry)", () => {
  it("counts the bytes of a stream longer than its declared Content-Length", async () => {
    const { hono, reached } = v1App(64 * 1024);
    const request = new Request("http://localhost/v1/uploads/bulk", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "10" },
      body: streamOf(200 * 1024), duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBe("10");
    const response = await hono.fetch(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large", details: { maxBytes: 64 * 1024, directUpload: { createSession: "/v1/uploads/direct/sessions" } } } });
    expect(reached).not.toHaveBeenCalled();
  });

  it("refuses an over-cap declared length before reading", async () => {
    const { hono, reached } = v1App(64 * 1024);
    const pull = vi.fn();
    const response = await hono.fetch(new Request("http://localhost/v1/uploads/bulk", {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(65 * 1024) },
      body: new ReadableStream({ pull }), duplex: "half",
    } as RequestInit));
    expect(response.status).toBe(413);
    expect(reached).not.toHaveBeenCalled();
  });

  it("passes a multipart body under the cap and an empty body with no content type", async () => {
    const { hono } = v1App(64 * 1024);
    const encoded = new Request("http://localhost", { method: "POST", body: form(10_000) });
    const under = await hono.fetch(new Request("http://localhost/v1/uploads/bulk", {
      method: "POST", headers: { "content-type": encoded.headers.get("content-type")! }, body: encoded.body, duplex: "half",
    } as RequestInit));
    expect(under.status).toBe(200);
    const empty = await hono.fetch(new Request("http://localhost/v1/uploads/bulk", { method: "POST", body: streamOf(0), duplex: "half" } as RequestInit));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ files: null });
  });

  it("refuses a declared non-form body before reading any of it", async () => {
    const { hono, reached } = v1App(64 * 1024);
    // Reading this stream would hang the test; highWaterMark 0 so it is pulled only when read.
    const pull = vi.fn(() => new Promise<void>(() => {}));
    const stalled = new ReadableStream({ pull }, { highWaterMark: 0 });
    for (const headers of [{ "content-type": "text/plain", "content-length": "5" }, { "content-type": "text/plain", "transfer-encoding": "chunked" }, { "content-length": "5" }] as Array<Record<string, string>>) {
      const response = await hono.fetch(new Request("http://localhost/v1/uploads/bulk", { method: "POST", headers, body: stalled, duplex: "half" } as RequestInit));
      expect(response.status).toBe(415);
      // The bulk route names its own media type; the public envelope's reviewed copy follows it.
      const body = await response.json() as { error: { details?: { policy?: string } } };
      expect(body.error.details?.policy).toBe("request_body:multipart");
      expect(publicApiErrorMessage("unsupported_type", { policy: "request_body:multipart" })).toBe("Send the request body as multipart/form-data.");
    }
    expect(pull).not.toHaveBeenCalled();
    expect(reached).not.toHaveBeenCalled();
  });

  it("applies the multipart cap to the bulk route whatever the content-type parameters say", async () => {
    const { hono } = v1App(64 * 1024);
    for (const type of ["multipart/form-data; x=json", "Multipart/Form-Data; boundary=x", "multipart/form-data; boundary=x; charset=application/json"]) {
      const response = await hono.fetch(new Request("http://localhost/v1/uploads/bulk", {
        method: "POST", headers: { "content-type": type }, body: streamOf(65 * 1024), duplex: "half",
      } as RequestInit));
      expect({ type, status: response.status }).toEqual({ type, status: 413 });
    }
    // JSON is not a bulk media type: refused (415), never read under the multipart cap.
    const json = await hono.fetch(new Request("http://localhost/v1/uploads/bulk", {
      method: "POST", headers: { "content-type": "application/json" }, body: streamOf(1024), duplex: "half",
    } as RequestInit));
    expect(json.status).toBe(415);
  });

  it("decides emptiness from the bytes counted, not a lying Content-Length", async () => {
    const { hono, reached } = v1App(64 * 1024);
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x")); controller.close(); } });
    const response = await hono.fetch(new Request("http://localhost/v1/uploads/direct/sessions", {
      method: "POST", headers: { "content-type": "text/plain", "content-length": "0" }, body, duplex: "half",
    } as RequestInit));
    expect(response.status).toBe(415);
    expect(reached).not.toHaveBeenCalled();
  });

  it("answers 408 when a bulk body stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { hono, reached } = v1App(64 * 1024);
      let sent = false;
      const stalling = new ReadableStream<Uint8Array>({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new Uint8Array(10)); return; }
        return new Promise(() => {});
      } });
      const pending = hono.fetch(new Request("http://localhost/v1/uploads/bulk", {
        method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: stalling, duplex: "half",
      } as RequestInit));
      await vi.advanceTimersByTimeAsync(BODY_IDLE_TIMEOUT_MS + 1);
      const response = await pending;
      expect(response.status).toBe(408);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(reached).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a body the endpoint's handler would read differently (JSON labelled as a form, text/json)", async () => {
    const { hono } = v1App(64 * 1024);
    for (const type of ["application/x-www-form-urlencoded", "text/json", "application/json; garbage"]) {
      const response = await hono.fetch(new Request("http://localhost/v1/search/aggregate", {
        method: "POST", headers: { "content-type": type }, body: JSON.stringify({ workspaceId: "other", q: "x" }),
      }));
      expect({ type, status: response.status }).toEqual({ type, status: 415 });
    }
  });

  it("lets the multipart voice route and the form-posted SAML callback through", async () => {
    const { hono } = v1App(64 * 1024);
    for (const [path, type] of [["/v1/projects/p1/chat/transcribe", "multipart/form-data; boundary=x"], ["/v1/auth/saml/acme/callback", "application/x-www-form-urlencoded"]]) {
      const response = await hono.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": type, "content-length": "5" }, body: "a=b&c" }));
      // No such route in this test app: 404 means the body was accepted for that endpoint.
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  });
});
