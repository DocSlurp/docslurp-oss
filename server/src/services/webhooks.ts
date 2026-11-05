import { withBackgroundSpan } from "@docslurp/shared/observability";
import { friendlyErrorMessage, PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";
import { reportPublicError } from "../lib/public-errors.js";
import { randomUUID, createHmac } from "node:crypto";

import { workspaceAllowsWebhookEvent } from "@docslurp/shared";

import { apiPool, sql } from "../db.js";
import { assertSafeExternalUrl, safeExternalFetch } from "../lib/network-security.js";
import { findWebhookEvent } from "../lib/webhook-events.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

type WebhookRow = {
  id: string;
  user_id: string;
  org_id: string;
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
  /** Who created it. It delivers only while this user is still an owner or admin of `orgId`. */
  userId: string;
  /** The organization whose run events it receives, whoever started the run. Its owners and admins manage it. */
  orgId: string;
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
    orgId: row.org_id,
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

/** Owners and admins of a webhook's organization manage it; anyone else gets nothing back (not found). */
const ADMIN_ROLES = ["owner", "admin"];

async function getManagedWebhookRow(webhookId: string, userId: string): Promise<WebhookRow | null> {
  const [row] = await sql<WebhookRow[]>`
    select w.id, w.user_id, w.org_id, w.url, w.secret, w.events, w.active, w.created_at::text
    from webhooks w
    join org_memberships m on m.org_id = w.org_id and m.user_id = ${userId} and m.role = any(${sql.array(ADMIN_ROLES)})
    where w.id = ${webhookId}
    limit 1
  `;

  return row ?? null;
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
  if (/^v[0-9]+:/.test(storedSecret)) return true; // Never treat malformed envelopes as plaintext.
  // Previous envelope is `v1:<iv>:<tag>:<ciphertext>`; legacy rows are
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

export class WebhookScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookScopeError";
  }
}

/** The caller belongs to the organization but its role does not allow this webhook. */
export class WebhookForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookForbiddenError";
  }
}

/**
 * Webhooks send every run event of an organization to a URL the caller picks, so only its owners and admins may create,
 * list or manage them. Not a member: WebhookScopeError (404, nothing revealed); a member without the role: WebhookForbiddenError.
 */
async function requireWebhookAdmin(orgId: string, userId: string): Promise<void> {
  const [member] = await sql<{ role: string }[]>`
    select m.role
    from org_memberships m
    join organizations o on o.id = m.org_id and o.deleted_at is null
    where m.org_id = ${orgId} and m.user_id = ${userId}
  `;
  if (!member) throw new WebhookScopeError("Organization not found");
  if (!ADMIN_ROLES.includes(member.role)) throw new WebhookForbiddenError("Organization owner or admin access required to manage webhooks");
}

export async function createWebhook(args: {
  userId: string;
  /** The organization it receives events for. The creator must be one of its owners or admins. */
  orgId: string;
  url: string;
  secret: string;
  events?: string[];
}): Promise<Webhook & { secret: string }> {
  const id = randomUUID();
  const events = args.events ?? ["run.completed", "run.failed"];
  // Scope first: who may register a webhook for which tenant is decided before anything else is touched.
  await requireWebhookAdmin(args.orgId, args.userId);
  const safeUrl = await assertSafeExternalUrl(args.url);
  const encryptedSecret = encryptWebhookSecret(args.secret);

  const [row] = await sql<WebhookRow[]>`
    insert into webhooks (id, user_id, org_id, url, secret, events)
    values (${id}, ${args.userId}, ${args.orgId}, ${safeUrl}, ${encryptedSecret}, ${sql.array(events)})
    returning id, user_id, org_id, url, secret, events, active, created_at::text
  `;

  const webhook = mapWebhook(row);
  return { ...webhook, secret: args.secret };
}

export async function listWebhooks(args: { userId: string; orgId: string }): Promise<Webhook[]> {
  await requireWebhookAdmin(args.orgId, args.userId);
  const rows = await sql<WebhookRow[]>`
    select id, user_id, org_id, url, secret, events, active, created_at::text
    from webhooks
    where org_id = ${args.orgId}
    order by created_at desc
  `;

  return rows.map(mapWebhook);
}

export async function listWebhookDeliveries(args: {
  userId: string;
  orgId: string;
  webhookId?: string;
  limit?: number;
}): Promise<WebhookDelivery[]> {
  await requireWebhookAdmin(args.orgId, args.userId);
  const rows = await sql<WebhookDeliveryRow[]>`
    select
      d.id,
      d.webhook_id,
      d.user_id,
      d.event_type,
      d.target_url,
      d.payload,
      d.response_status,
      d.response_body,
      d.delivered,
      d.error,
      d.replay_of_delivery_id,
      d.created_at::text
    from webhook_deliveries d
    join webhooks w on w.id = d.webhook_id
    where w.org_id = ${args.orgId}
      and (${args.webhookId ?? null}::text is null or d.webhook_id = ${args.webhookId ?? null})
    order by d.created_at desc
    limit ${args.limit ?? 50}
  `;

  return rows.map(mapWebhookDelivery);
}

/** Deletes a webhook the caller administers; returns its organization, or null when there is none to delete. */
export async function deleteWebhook(webhookId: string, userId: string): Promise<string | null> {
  const [row] = await sql<{ org_id: string }[]>`
    delete from webhooks
    where id = ${webhookId} and exists (select 1 from org_memberships m where m.org_id = webhooks.org_id and m.user_id = ${userId} and m.role = any(${sql.array(ADMIN_ROLES)}))
    returning org_id
  `;

  return row?.org_id ?? null;
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
    where id = ${args.webhookId} and exists (select 1 from org_memberships m where m.org_id = webhooks.org_id and m.user_id = ${args.userId} and m.role = any(${sql.array(ADMIN_ROLES)}))
    returning id, user_id, org_id, url, secret, events, active, created_at::text
  `;

  return row ? mapWebhook(row) : null;
}

export async function rotateWebhookSecret(webhookId: string, userId: string): Promise<{ webhook: Webhook; secret: string } | null> {
  const secret = `whsec_${randomUUID().replaceAll("-", "")}`;
  const encryptedSecret = encryptWebhookSecret(secret);
  const [row] = await sql<WebhookRow[]>`
    update webhooks
    set secret = ${encryptedSecret}
    where id = ${webhookId} and exists (select 1 from org_memberships m where m.org_id = webhooks.org_id and m.user_id = ${userId} and m.role = any(${sql.array(ADMIN_ROLES)}))
    returning id, user_id, org_id, url, secret, events, active, created_at::text
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
  const webhook = await getManagedWebhookRow(webhookId, userId);

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
      d.id,
      d.webhook_id,
      d.user_id,
      d.event_type,
      d.target_url,
      d.payload,
      d.response_status,
      d.response_body,
      d.delivered,
      d.error,
      d.replay_of_delivery_id,
      d.created_at::text
    from webhook_deliveries d
    join webhooks w on w.id = d.webhook_id
    join org_memberships m on m.org_id = w.org_id and m.user_id = ${userId} and m.role = any(${sql.array(ADMIN_ROLES)})
    where d.id = ${deliveryId}
    limit 1
  `;

  if (!delivery) {
    return null;
  }

  const webhook = await getManagedWebhookRow(delivery.webhook_id, userId);
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

/** A webhook delivers only while its creator is still an owner or admin of its organization (leaving or demotion stops it). */
const creatorAdministers = () => sql`exists (
  select 1 from org_memberships m
  where m.org_id = webhooks.org_id and m.user_id = webhooks.user_id and m.role = any(${sql.array(ADMIN_ROLES)})
)`;

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
    const skip = async (reason: string) => {
      await sql`
        update webhook_outbox
        set dispatched_at = now(), last_error = ${reason}
        where id = ${event.id}
      `;
    };
    // Webhooks belong to an organization, not to the user who started the run (the outbox row's user_id is attribution
    // only and never routes). The event's run decides the organization; its payload must name that run's own workspace,
    // and an event that names no run has no tenant and is never delivered.
    const runId = typeof event.payload?.runId === "string" ? event.payload.runId : null;
    if (!runId) {
      await skip("Skipped: event has no run, so no organization to deliver it to");
      continue;
    }
    const [run] = await sql<{ org_id: string | null; workspace_id: string; workspace_org_id: string | null; pipeline: Record<string, unknown> | null }[]>`
      select r.org_id, r.workspace_id, ws.org_id as workspace_org_id, ws.pipeline
      from workspace_runs r
      join workspaces ws on ws.id = r.workspace_id
      where r.id = ${runId}
    `;
    if (!run || !run.org_id) {
      await skip("Skipped: the event's run no longer exists or has no organization");
      continue;
    }
    if (event.payload?.workspaceId !== run.workspace_id || run.workspace_org_id !== run.org_id) {
      await skip("Skipped: the event's workspace does not match its run");
      continue;
    }
    // Workspaces can switch off (or narrow) the webhook events they emit.
    if (!workspaceAllowsWebhookEvent(run.pipeline as Parameters<typeof workspaceAllowsWebhookEvent>[0], event.event_type)) {
      await skip("Skipped: webhook notifications are off for this workspace");
      continue;
    }
    const webhooks = await sql<(WebhookRow & { can_deliver: boolean })[]>`
      select id, user_id, org_id, url, secret, events, active, created_at::text,
        ${creatorAdministers()} as can_deliver
      from webhooks
      where org_id = ${run.org_id}
        and active = true
        and ${event.event_type} = any(events)
    `;
    const deliverable = webhooks.filter((webhook) => webhook.can_deliver);
    if (webhooks.length > 0 && deliverable.length === 0) {
      await skip("Skipped: no subscribed webhook's creator is still an owner or admin of the organization");
      continue;
    }
    const errors: string[] = [];
    for (const webhook of deliverable) {
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
  const drain = () => { void withBackgroundSpan("api.webhook-outbox-drain", () => requestWebhookOutboxDrain()); };
  // The listener is rebuilt after a suspend/resume; draining on every (re)subscribe catches up notifications missed while it was dead.
  outboxListener = await apiPool.listen("webhook_outbox", drain, drain);
  void requestWebhookOutboxDrain();
}

export async function stopWebhookOutboxListener(): Promise<void> {
  const listener = outboxListener;
  outboxListener = null;
  await listener?.unlisten();
}

/**
 * Preserve document results verbatim; only operational error fields are rewritten: reviewed public copy passes, anything else
 * (a raw worker error queued before the worker stopped sending them) becomes the generic processing message.
 */
function publicWebhookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, ...(payload.error ? { error: friendlyErrorMessage(payload.error, PUBLIC_ERROR_MESSAGES.processing) } : {}) };
}
