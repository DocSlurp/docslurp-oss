import { afterEach, describe, expect, it, vi } from "vitest";
const sql = vi.hoisted(() => Object.assign(vi.fn(async (..._args: unknown[]) => []), { array: (value: unknown) => value }));
vi.mock("../db.js", () => ({ sql }));
vi.mock("../config.js", () => ({ env: { s3Bucket: "uploads" } }));
import { tigrisUploadWebhookRoutes } from "../routes/tigris-upload-webhook.js";
const previous = process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET;
afterEach(() => { if (previous === undefined) delete process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET; else process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET = previous; vi.clearAllMocks(); });
const event = { eventVersion:"1",eventSource:"tigris",eventName:"OBJECT_CREATED_PUT",bucket:"uploads",object:{key:"raw/file"} };
function send(body: unknown, token = "test-secret") { return tigrisUploadWebhookRoutes.request("/tigris/uploads", {method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(body)}); }
describe("Tigris upload notification", () => {
  it("authenticates before doing database work", async () => {
    process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET = "test-secret";
    expect((await send({events:[event]},"wrong")).status).toBe(401);
    expect(sql).not.toHaveBeenCalled();
  });
  it("durably nudges duplicate notifications without synchronous ingestion", async () => {
    process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET = "test-secret";
    expect((await send({events:[event,event]})).status).toBe(200);
    expect(sql).toHaveBeenCalledOnce();
    expect(sql.mock.calls[0]?.some(value => Array.isArray(value) && value[0] === "raw/file")).toBe(true);
  });
  it("acknowledges other buckets/events and rejects malformed payloads", async () => {
    process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET = "test-secret";
    expect((await send({events:[{...event,bucket:"other"},{...event,eventName:"OBJECT_DELETED"}]})).status).toBe(200);
    expect(sql).not.toHaveBeenCalled();
    expect((await send({key:"raw/file"})).status).toBe(400);
  });
});
