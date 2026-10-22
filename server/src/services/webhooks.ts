import { withBackgroundSpan } from "@docslurp/shared/observability";
import { PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";
import { reportPublicError } from "../lib/public-errors.js";
import { randomUUID, createHmac } from "node:crypto";

import { workspaceAllowsWebhookEvent } from "@docslurp/shared";

import { sql } from "../db.js";
import { assertSafeExternalUrl, safeExternalFetch } from "../lib/network-security.js";
import { findWebhookEvent } from "../lib/webhook-events.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { getWorkspaceAccess } from "./organizations.js";

type WebhookRow = {
  id: string;
  user_id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  created_at: string;
};

type WebhookDeliveryRow = {
  id: string;
  webhook_id: string;
  user_id: string;
  event_type: string;
  target_url: string;
  payload: Record<string, unknown>;
  response_status: number | null;
  response_body: string | null;
  delivered: boolean;
  error: string | null;
  replay_of_delivery_id: string | null;
  created_at: string;
};

export interface Webhook {
  id: string;
  userId: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  userId: string;
  eventType: string;
  targetUrl: string;
  payload: Record<string, unknown>;
  responseStatus: number | null;
  responseBody: string | null;
  delivered: boolean;
  error: string | null;
  replayOfDeliveryId: string | null;
  createdAt: string;
}

function mapWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    userId: row.user_id,
    url: row.url,
    events: row.events,
    active: row.active,
    createdAt: row.created_at
  };
}

function mapWebhookDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    userId: row.user_id,
    eventType: row.event_type,
    targetUrl: row.target_url,
    payload: publicWebhookPayload(row.payload ?? {}),
    responseStatus: row.response_status,
    responseBody: null,
    delivered: row.delivered,
    error: row.error ? "We couldn’t deliver this notification. Check the destination and try again." : null,
    replayOfDeliveryId: row.replay_of_delivery_id,
    createdAt: row.created_at
  };
}

async function getWebhookRow(webhookId: string, userId: string): Promise<WebhookRow | null> {
  const [row] = await sql<WebhookRow[]>`
    select id, user_id, url, secret, events, active, created_at::text
    from webhooks
    where id = ${webhookId} and user_id = ${userId}
    limit 1
  `;

  return row ?? null;
}

export async function dispatchUserWebhookById(args: {
  webhookId: string;
  userId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<WebhookDelivery | null> {
  const webhook = await getWebhookRow(args.webhookId, args.userId);
  if (!webhook || !webhook.active) {
    return null;
  }

  return await dispatchWebhook({
    webhook,
    eventType: args.eventType,
    payload: args.payload
  });
}

async function recordWebhookDelivery(args: {
  deliveryId?: string;
  webhook: WebhookRow;
  eventType: string;
  payload: Record<string, unknown>;
  responseStatus: number | null;
  responseBody: string | null;
  delivered: boolean;
  error: string | null;
  replayOfDeliveryId?: string | null;
}): Promise<WebhookDelivery> {
  const [row] = await sql<WebhookDeliveryRow[]>`
    insert into webhook_deliveries (
      id,
      webhook_id,
      user_id,
      event_type,
      target_url,
      payload,
      response_status,
      response_body,
      delivered,
      error,
      replay_of_delivery_id
    )
    values (
      ${args.deliveryId ?? randomUUID()},
      ${args.webhook.id},
      ${args.webhook.user_id},
      ${args.eventType},
      ${args.webhook.url},
      ${JSON.stringify(args.payload)}::text::jsonb,
      ${args.responseStatus},
      ${args.responseBody},
      ${args.delivered},
      ${args.error},
      ${args.replayOfDeliveryId ?? null}
    )
    returning
      id,
      webhook_id,
      user_id,
      event_type,
      target_url,
      payload,
      response_status,
      response_body,
      delivered,
      error,
      replay_of_delivery_id,
      created_at::text
  `;

  return mapWebhookDelivery(row);
}

export function buildWebhookPayload(args: {
  webhookId: string;
  eventType: string;
  test?: boolean;
  runId?: string | null;
}): Record<string, unknown> {
  const event = findWebhookEvent(args.eventType);

  return {
    ...(event?.examplePayload ?? {}),
    event: event?.type ?? args.eventType,
    webhookId: args.webhookId,
    runId: args.runId ?? ((event?.examplePayload?.runId as string | undefined) ?? null),
    test: args.test ?? false,
    deliveredAt: new Date().toISOString()
  };
}

export function encryptWebhookSecret(secret: string): string {
  return encryptSecret(secret);
}

export function decryptWebhookSecret(storedSecret: string): string {
  if (!isEncryptedWebhookSecret(storedSecret)) {
    return storedSecret;
  }
  return decryptSecret(storedSecret);
}

export function isEncryptedWebhookSecret(storedSecret: string): boolean {
  // Current envelope is `v1:<iv>:<tag>:<ciphertext>`; legacy rows are
  // `iv:tag:ciphertext`. Anything else is a pre-encryption plaintext secret.
  if (/^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(storedSecret)) return true;
  return /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(storedSecret);
}

export async function dispatchWebhook(args: {
  webhook: WebhookRow;
  eventType: string;
  payload: Record<string, unknown>;
  replayOfDeliveryId?: string | null;
  test?: boolean;
}): Promise<WebhookDelivery> {
  const deliveryId = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const serializedPayload = JSON.stringify(publicWebhookPayload(args.payload));
  const signature = createHmac("sha256", decryptWebhookSecret(args.webhook.secret))
    .update(`${timestamp}.${deliveryId}.${serializedPayload}`)
    .digest("hex");

  let responseStatus: number | null = null;
  let delivered = false;
  let error: string | null = null;

  try {
    const safeUrl = await assertSafeExternalUrl(args.webhook.url);
    const response = await safeExternalFetch(safeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DocSlurp-Delivery": deliveryId,
        "X-DocSlurp-Timestamp": String(timestamp),
        "X-DocSlurp-Signature": `t=${timestamp},id=${deliveryId},v1=${signature}`,
        ...(args.test ? { "X-DocSlurp-Test-Event": "true" } : {})
      },
      body: serializedPayload,
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    responseStatus = response.status;
    delivered = response.ok;
    if (!response.ok) {
      error = `HTTP ${response.status}`;
    }
  } catch (caught) {
    reportPublicError(caught, { operation: "webhook-delivery", deliveryId });
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return await recordWebhookDelivery({
    deliveryId,
    webhook: args.webhook,
    eventType: args.eventType,
    payload: args.payload,
    responseStatus,
    responseBody: null,
    delivered,
    error,
    replayOfDeliveryId: args.replayOfDeliveryId
  });
}

export async function createWebhook(args: {
  userId: string;
  url: string;
  secret: string;
  events?: string[];
}): Promise<Webhook & { secret: string }> {
  const id = randomUUID();
  const events = args.events ?? ["run.completed", "run.failed"];
  const safeUrl = await assertSafeExternalUrl(args.url);
  const encryptedSecret = encryptWebhookSecret(args.secret);

  const [row] = await sql<WebhookRow[]>`
    insert into webhooks (id, user_id, url, secret, events)
    values (${id}, ${args.userId}, ${safeUrl}, ${encryptedSecret}, ${sql.array(events)})
    returning id, user_id, url, secret, events, active, created_at::text
  `;

  const webhook = mapWebhook(row);
  return { ...webhook, secret: args.secret };
}

export async function listWebhooks(userId: string): Promise<Webhook[]> {
  const rows = await sql<WebhookRow[]>`
    select id, user_id, url, secret, events, active, created_at::text
    from webhooks
    where user_id = ${userId}
    order by created_at desc
  `;

  return rows.map(mapWebhook);
}

export async function listWebhookDeliveries(args: {
  userId: string;
  webhookId?: string;
  limit?: number;
}): Promise<WebhookDelivery[]> {
  const rows = await sql<WebhookDeliveryRow[]>`
    select
      id,
      webhook_id,
      user_id,
      event_type,
      target_url,
      payload,
      response_status,
      response_body,
      delivered,
      error,
      replay_of_delivery_id,
      created_at::text
    from webhook_deliveries
    where user_id = ${args.userId}
      and (${args.webhookId ?? null}::text is null or webhook_id = ${args.webhookId ?? null})
    order by created_at desc
    limit ${args.limit ?? 50}
  `;

  return rows.map(mapWebhookDelivery);
}

export async function deleteWebhook(webhookId: string, userId: string): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    delete from webhooks
    where id = ${webhookId} and user_id = ${userId}
    returning id
  `;

  return !!row;
}

export async function updateWebhook(args: {
  webhookId: string;
  userId: string;
  url?: string;
  events?: string[];
  active?: boolean;
}): Promise<Webhook | null> {
  const safeUrl = args.url ? await assertSafeExternalUrl(args.url) : null;
  const [row] = await sql<WebhookRow[]>`
    update webhooks
    set
      url = coalesce(${safeUrl}, url),
      events = coalesce(${args.events ? sql.array(args.events) : null}, events),
      active = coalesce(${args.active ?? null}, active)
    where id = ${args.webhookId} and user_id = ${args.userId}
    returning id, user_id, url, secret, events, active, created_at::text
  `;

  return row ? mapWebhook(row) : null;
}

export async function rotateWebhookSecret(webhookId: string, userId: string): Promise<{ webhook: Webhook; secret: string } | null> {
  const secret = `whsec_${randomUUID().replaceAll("-", "")}`;
  const encryptedSecret = encryptWebhookSecret(secret);
  const [row] = await sql<WebhookRow[]>`
    update webhooks
    set secret = ${encryptedSecret}
    where id = ${webhookId} and user_id = ${userId}
    returning id, user_id, url, secret, events, active, created_at::text
  `;

  if (!row) {
    return null;
  }

  return {
    webhook: mapWebhook(row),
    secret
  };
}

export async function sendTestWebhook(webhookId: string, userId: string, eventType: string): Promise<WebhookDelivery | null> {
  const webhook = await getWebhookRow(webhookId, userId);

  if (!webhook) {
    return null;
  }

  return await dispatchWebhook({
    webhook,
    eventType,
    payload: buildWebhookPayload({
      webhookId,
      eventType,
      test: true
    }),
    test: true
  });
}

export async function replayWebhookDelivery(deliveryId: string, userId: string): Promise<WebhookDelivery | null> {
  const [delivery] = await sql<WebhookDeliveryRow[]>`
    select
      id,
      webhook_id,
      user_id,
      event_type,
      target_url,
      payload,
      response_status,
      response_body,
      delivered,
      error,
      replay_of_delivery_id,
      created_at::text
    from webhook_deliveries
    where id = ${deliveryId} and user_id = ${userId}
    limit 1
  `;

  if (!delivery) {
    return null;
  }

  const webhook = await getWebhookRow(delivery.webhook_id, userId);
  if (!webhook) {
    return null;
  }

  return await dispatchWebhook({
    webhook,
    eventType: delivery.event_type,
    payload: delivery.payload,
    replayOfDeliveryId: delivery.id
  });
}

export async function deliverWebhook(runId: string, eventType: string): Promise<void> {
  const rows = await sql<(WebhookRow & { run_id: string; workspace_id: string })[]>`
    select
      r.workspace_id,
      w.id,
      w.user_id,
      w.url,
      w.secret,
      w.events,
      w.active,
      w.created_at::text,
      r.id as run_id
    from webhooks w
    join workspace_runs r on r.user_id = w.user_id
    where r.id = ${runId}
      and w.active = true
      and ${eventType} = any(w.events)
  `;

  for (const row of rows) {
    // Only while the subscriber can still read the run's workspace (G-06).
    if (!(await getWorkspaceAccess(row.workspace_id, row.user_id))) continue;
    await dispatchWebhook({
      webhook: row,
      eventType,
      payload: buildWebhookPayload({
        webhookId: row.id,
        eventType,
        runId
      })
    }).catch((error) => {
      console.error(
        `webhook delivery failed for ${row.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    });
  }
}

type WebhookOutboxRow = {
  id: string;
  user_id: string;
  event_type: string;
  payload: Record<string, unknown>;
};

/**
 * Delivers worker-recorded webhook events (run.completed, run.failed,
 * document.replaced, ...) with the standard signed dispatcher. Claims rows with
 * SKIP LOCKED so several API instances never send the same event twice; a
 * claim that dies mid-delivery is retried after five minutes, up to five times.
 */
export async function drainWebhookOutbox(limit = 25): Promise<number> {
  const claimed = await sql<WebhookOutboxRow[]>`
    update webhook_outbox
    set claimed_at = now(), attempts = attempts + 1
    where id in (
      select id from webhook_outbox
      where dispatched_at is null
        and attempts < 5
        and (claimed_at is null or claimed_at < now() - interval '5 minutes')
      order by created_at
      limit ${limit}
      for update skip locked
    )
    returning id, user_id, event_type, payload
  `;

  for (const event of claimed) {
    // Webhooks belong to a user, not an org. Deliver a workspace's events only
    // while the subscriber can still read that workspace, so leaving or being
    // removed from an organization (G-06) stops its events.
    const payloadWorkspaceId = typeof (event.payload as { workspaceId?: unknown } | null)?.workspaceId === "string"
      ? (event.payload as { workspaceId: string }).workspaceId
      : null;
    if (payloadWorkspaceId && !(await getWorkspaceAccess(payloadWorkspaceId, event.user_id))) {
      await sql`
        update webhook_outbox
        set dispatched_at = now(), last_error = ${"Skipped: subscriber no longer has access to this workspace"}
        where id = ${event.id}
      `;
      continue;
    }
    // Workspaces can switch off (or narrow) the webhook events they emit.
    const workspaceId = typeof event.payload?.workspaceId === "string" ? event.payload.workspaceId : null;
    if (workspaceId) {
      const [workspace] = await sql<{ pipeline: Record<string, unknown> | null }[]>`
        select pipeline from workspaces where id = ${workspaceId}
      `;
      if (workspace && !workspaceAllowsWebhookEvent(workspace.pipeline as Parameters<typeof workspaceAllowsWebhookEvent>[0], event.event_type)) {
        await sql`
          update webhook_outbox
          set dispatched_at = now(), last_error = ${"Skipped: webhook notifications are off for this workspace"}
          where id = ${event.id}
        `;
        continue;
      }
    }
    const webhooks = await sql<WebhookRow[]>`
      select id, user_id, url, secret, events, active, created_at::text
      from webhooks
      where user_id = ${event.user_id}
        and active = true
        and ${event.event_type} = any(events)
    `;
    const errors: string[] = [];
    for (const webhook of webhooks) {
      const delivery = await dispatchWebhook({
        webhook,
        eventType: event.event_type,
        payload: { ...event.payload, event: event.event_type, deliveredAt: new Date().toISOString() },
      }).catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
        return null;
      });
      if (delivery && !delivery.delivered && delivery.error) errors.push(delivery.error);
    }
    // Failed deliveries are recorded per webhook and can be replayed from there.
    await sql`
      update webhook_outbox
      set dispatched_at = now(), last_error = ${errors.length ? errors.join("; ").slice(0, 2000) : null}
      where id = ${event.id}
    `;
  }
  return claimed.length;
}

let outboxListener: { unlisten: () => Promise<void> } | null = null;
let draining: Promise<void> | null = null;
let drainAgain = false;

/** Drains immediately on NOTIFY, coalescing bursts into one follow-up pass. */
export function requestWebhookOutboxDrain(): Promise<void> {
  if (draining) {
    drainAgain = true;
    return draining;
  }
  draining = (async () => {
    do {
      drainAgain = false;
      try {
        while ((await drainWebhookOutbox()) > 0) {
          // keep draining until the backlog is empty
        }
      } catch (error) {
        console.error(`[webhook-outbox] drain failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } while (drainAgain);
  })().finally(() => {
    draining = null;
  });
  return draining;
}

export async function startWebhookOutboxListener(): Promise<void> {
  if (outboxListener) return;
  outboxListener = await sql.listen("webhook_outbox", () => {
    void withBackgroundSpan("api.webhook-outbox-drain", () => requestWebhookOutboxDrain());
  });
  void requestWebhookOutboxDrain();
}

export async function stopWebhookOutboxListener(): Promise<void> {
  const listener = outboxListener;
  outboxListener = null;
  await listener?.unlisten();
}

/** Preserve document results verbatim; only operational error fields are rewritten. */
function publicWebhookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, ...(payload.error ? { error: PUBLIC_ERROR_MESSAGES.processing } : {}) };
}
