import { sql } from "../db.js";

/**
 * Off-hot-path bookkeeping for API key requests.
 *
 * Authentication used to do three extra database round trips per request
 * (touch `last_used_at`, upsert the minute's `api_key_usage` row, sum today's
 * pages). Rate limiting itself runs on Redis, so these are only dashboard
 * statistics and the daily page cap: request counts are buffered in memory and
 * flushed in one batched upsert, and today's page total is cached briefly.
 */

const FLUSH_INTERVAL_MS = 5_000;
const PAGES_CACHE_TTL_MS = 15_000;

/** keyId → minute bucket (epoch ms) → requests not yet written. */
const pendingRequests = new Map<string, Map<number, number>>();
const pagesToday = new Map<string, { pages: number; dayStart: number; expiresAt: number; pending?: Promise<number> }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;

export function recordApiKeyRequest(keyId: string, now = Date.now()): void {
  const minute = now - (now % 60_000);
  const buckets = pendingRequests.get(keyId) ?? new Map<number, number>();
  buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
  pendingRequests.set(keyId, buckets);
  if (!flushTimer) {
    flushTimer = setTimeout(() => { void flushApiKeyUsage(); }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

/** Writes buffered request counts and `last_used_at` in two statements. */
export async function flushApiKeyUsage(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (flushing) await flushing;
  if (pendingRequests.size === 0) return;

  const rows: { key_id: string; minute_bucket: string; request_count: number }[] = [];
  for (const [keyId, buckets] of pendingRequests) {
    for (const [minute, count] of buckets) rows.push({ key_id: keyId, minute_bucket: new Date(minute).toISOString(), request_count: count });
  }
  pendingRequests.clear();

  flushing = (async () => {
    try {
      await sql`
        insert into api_key_usage (key_id, minute_bucket, request_count, page_count)
        select r.key_id, r.minute_bucket, r.request_count, 0
        from jsonb_to_recordset(${sql.json(rows as never)}::jsonb) as r(key_id text, minute_bucket timestamptz, request_count integer)
        where exists (select 1 from api_keys k where k.id = r.key_id)
        on conflict (key_id, minute_bucket) do update
        set request_count = api_key_usage.request_count + excluded.request_count`;
      await sql`
        update api_keys set last_used_at = now()
        where id = any(${sql.array([...new Set(rows.map((row) => row.key_id))])})`;
    } catch (error) {
      // Statistics only; the limiter's counters are authoritative and unaffected.
      console.error("[api-keys] usage flush failed:", error instanceof Error ? error.message : String(error));
    } finally {
      flushing = null;
    }
  })();
  await flushing;
}

/** Today's ingested pages for a key, cached for a few seconds per process. */
export async function apiKeyPagesToday(keyId: string, now = Date.now()): Promise<number> {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const cached = pagesToday.get(keyId);
  if (cached && cached.dayStart === dayStart.getTime()) {
    if (cached.expiresAt > now) return cached.pages;
    if (cached.pending) return await cached.pending;
  }

  const pending = sql<{ page_count: number }[]>`
    select coalesce(sum(page_count), 0)::int as page_count
    from api_key_usage
    where key_id = ${keyId} and minute_bucket >= ${dayStart}`
    .then(([row]) => Number(row?.page_count ?? 0));
  pagesToday.set(keyId, { pages: cached?.pages ?? 0, dayStart: dayStart.getTime(), expiresAt: 0, pending });
  try {
    const pages = await pending;
    pagesToday.set(keyId, { pages, dayStart: dayStart.getTime(), expiresAt: now + PAGES_CACHE_TTL_MS });
    return pages;
  } catch (error) {
    pagesToday.delete(keyId);
    throw error;
  }
}

export function resetApiKeyUsageBuffers(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pendingRequests.clear();
  pagesToday.clear();
}
