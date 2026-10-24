import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../db.js";
import { env } from "../config.js";

const notification = z.object({ events: z.array(z.object({
  eventVersion: z.literal("1"), eventSource: z.literal("tigris"),
  eventName: z.string(),
  bucket: z.string(), object: z.object({ key: z.string().min(1) }),
})).max(1000) });

/** Tigris retries non-2xx and may deliver duplicates. Only durably nudge here. */
export const tigrisUploadWebhookRoutes = new Hono().post("/tigris/uploads", async c => {
  const secret = process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "Webhook unavailable" }, 503);
  const actual = Buffer.from(c.req.header("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.json({ error: "Unauthorized" }, 401);
  const parsed = notification.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid notification" }, 400);
  const keys = parsed.data.events.filter(event => event.bucket === env.s3Bucket && ["OBJECT_CREATED_PUT", "OBJECT_CREATED_MULTIPART"].includes(event.eventName)).map(event => event.object.key);
  if (keys.length) await sql`update upload_sessions set next_reconcile_at = now()
    where status in ('pending', 'uploading', 'ingesting') and id in
    (select session_id from upload_session_files where source_key = any(${sql.array(keys)}))`;
  return c.json({ ok: true });
});
