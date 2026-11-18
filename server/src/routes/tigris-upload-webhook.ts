import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../db.js";
import { env } from "../config.js";
import { finalizeDirectUploadFileInBackground } from "../services/direct-upload-session.js";

const notification = z.object({ events: z.array(z.object({
  eventVersion: z.literal("1"), eventSource: z.literal("tigris"),
  eventName: z.string(),
  bucket: z.string(), object: z.object({ key: z.string().min(1).max(1024) }),
})).max(1000) });

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * The only keys direct uploads mint for clients to write (`rawSourceKey`): `<userId>/<uuid>/raw/<uuid>-<name>` and, for
 * an extract, `extracts/<orgId>/<extractId>/raw/<uuid>-<name>`. Sealed copies, artifacts and anything else are refused
 * before the database is asked.
 */
const UPLOAD_KEY = new RegExp(`^(?:[A-Za-z0-9_-]{1,128}/${UUID}|extracts/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128})/raw/${UUID}-[^/]+$`, "i");

export function isDirectUploadSourceKey(key: string): boolean {
  return UPLOAD_KEY.test(key);
}

type FileRef = { fileId: string; sessionId: string; userId: string };

/**
 * Background finalization after webhooks, bounded per process. A file already queued or running is not queued twice
 * (duplicate deliveries); a full queue drops the hint, and the fallback reconciler picks the file up later.
 */
const MAX_QUEUED = 10_000;
const queued = new Map<string, FileRef>();
const active = new Set<string>();
const idle: Array<() => void> = [];

function pump(): void {
  while (active.size < env.directUploadWebhookFinalizeConcurrency && queued.size > 0) {
    const [fileId, ref] = queued.entries().next().value as [string, FileRef];
    queued.delete(fileId);
    active.add(fileId);
    void finalizeDirectUploadFileInBackground(ref).finally(() => {
      active.delete(fileId);
      pump();
      if (active.size === 0 && queued.size === 0) for (const resolve of idle.splice(0)) resolve();
    });
  }
}

function enqueue(ref: FileRef): boolean {
  if (queued.has(ref.fileId) || active.has(ref.fileId)) return true;
  if (queued.size >= MAX_QUEUED) return false;
  queued.set(ref.fileId, ref);
  pump();
  return true;
}

/** Waits until every queued webhook finalization has run (tests, shutdown). */
export async function drainUploadWebhookFinalizations(): Promise<void> {
  if (active.size === 0 && queued.size === 0) return;
  await new Promise<void>(resolve => idle.push(resolve));
}

/**
 * Storage notifies each object written. The event is only a hint: it names a key, and only the key is used. The key
 * selects exactly one open file (its session's own user and tenant prefix), which is then finalized from storage's own
 * evidence (size, etag, If-Match seal), never from event fields. Tigris retries non-2xx and may deliver an event late,
 * twice or never: duplicates are harmless (the file's lease and status), and the fallback reconciler covers lost ones.
 */
export const tigrisUploadWebhookRoutes = new Hono().post("/tigris/uploads", async c => {
  const secret = process.env.DOCSLURP_TIGRIS_UPLOAD_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "Webhook unavailable" }, 503);
  const actual = Buffer.from(c.req.header("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.json({ error: "Unauthorized" }, 401);
  const parsed = notification.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid notification" }, 400);
  const created = parsed.data.events.filter(event => event.bucket === env.s3Bucket && ["OBJECT_CREATED_PUT", "OBJECT_CREATED_MULTIPART"].includes(event.eventName));
  const keys = [...new Set(created.map(event => event.object.key).filter(isDirectUploadSourceKey))];
  if (created.length > keys.length) console.warn(`[upload-webhook] ignored=${created.length - keys.length} reason=not-an-upload-key-or-duplicate`);
  if (keys.length === 0) return c.json({ ok: true });
  // Exact key match, open file, live session, and the key inside the session's own prefix (its user, or its extract).
  const files = await sql<Array<{ id: string; session_id: string; user_id: string }>>`
    select f.id, f.session_id, s.user_id from upload_session_files f join upload_sessions s on s.id = f.session_id
    where f.source_key = any(${sql.array(keys)}) and f.status = 'pending' and not f.unknown_size
      and s.status in ('pending', 'uploading', 'ingesting') and s.expires_at > now()
      and case when s.extract_id is null then starts_with(f.source_key, s.user_id || '/')
        else starts_with(f.source_key, 'extracts/' || coalesce(s.org_id, '') || '/' || s.extract_id || '/') end`;
  let dropped = 0;
  for (const file of files) if (!enqueue({ fileId: file.id, sessionId: file.session_id, userId: file.user_id })) dropped += 1;
  if (dropped > 0) console.warn(`[upload-webhook] dropped=${dropped} reason=queue-full (left to the reconciler)`);
  return c.json({ ok: true });
});
