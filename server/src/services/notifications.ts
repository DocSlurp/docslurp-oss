import { instrumentFetch } from "@docslurp/shared/observability";
import { PUBLIC_ERROR_MESSAGES, publicDiagnostics } from "@docslurp/shared";
import { randomUUID } from "node:crypto";

import { sql } from "../db.js";
import { andSqlFragments, type SqlFragment } from "../lib/sql-fragments.js";

export type NotificationEvent =
  | "run.completed"
  | "run.failed"
  | "plausibility.warning"
  | "cost.alert"
  | "workspace.invite";

type NotificationPrefsRow = {
  user_id: string;
  run_completed: boolean;
  run_failed: boolean;
  quality_warning: boolean;
  cost_alert: boolean;
  workspace_invite: boolean;
  updated_at: string;
};

type UserRow = {
  id: string;
  email: string;
  name: string;
};

export interface NotificationPreferences {
  userId: string;
  runCompleted: boolean;
  runFailed: boolean;
  plausibilityWarning: boolean;
  costAlert: boolean;
  workspaceInvite: boolean;
  updatedAt: string;
}

export interface EmailDeliveryResult {
  id: string;
  delivered: boolean;
  provider: string;
}

type NotificationDeliveryRow = {
  id: string;
  user_id: string;
  org_id: string | null;
  workspace_id: string | null;
  event_type: string;
  provider: string;
  recipient: string;
  subject: string;
  delivered: boolean;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
};

export interface NotificationInboxEntry {
  id: string;
  userId: string;
  orgId: string | null;
  workspaceId: string | null;
  eventType: string;
  provider: string;
  recipient: string;
  subject: string;
  delivered: boolean;
  metadata: Record<string, unknown>;
  readAt: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface NotificationInboxPage {
  deliveries: NotificationInboxEntry[];
  unreadCount: number;
}

function prefsColumn(event: NotificationEvent): keyof Omit<NotificationPrefsRow, "user_id" | "updated_at"> {
  switch (event) {
    case "run.completed":
      return "run_completed";
    case "run.failed":
      return "run_failed";
    case "plausibility.warning":
      return "quality_warning";
    case "cost.alert":
      return "cost_alert";
    case "workspace.invite":
      return "workspace_invite";
  }
}

function mapPrefs(row: NotificationPrefsRow): NotificationPreferences {
  return {
    userId: row.user_id,
    runCompleted: row.run_completed,
    runFailed: row.run_failed,
    plausibilityWarning: row.quality_warning,
    costAlert: row.cost_alert,
    workspaceInvite: row.workspace_invite,
    updatedAt: row.updated_at
  };
}

function mapDelivery(row: NotificationDeliveryRow): NotificationInboxEntry {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    provider: row.provider,
    recipient: row.recipient,
    subject: row.subject,
    delivered: row.delivered,
    metadata: publicDiagnostics(row.metadata ?? {}) as Record<string, unknown>,
    readAt: row.read_at,
    isRead: row.read_at !== null,
    createdAt: row.created_at,
  };
}

async function getUser(userId: string): Promise<UserRow | null> {
  const [row] = await sql<UserRow[]>`
    select id, email, name
    from "user"
    where id = ${userId}
    limit 1
  `;

  return row ?? null;
}

async function deliverEmail(args: {
  deliveryId: string;
  recipient: string;
  subject: string;
  html: string;
  text: string;
  providerMetadata?: Record<string, unknown>;
}): Promise<{ delivered: boolean; provider: string; responseText?: string }> {
  const resendApiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "DocSlurp <noreply@docslurp.local>";
  const replyTo = process.env.EMAIL_REPLY_TO;

  if (!resendApiKey) {
    console.log(
      `[notification] provider=console delivery=${args.deliveryId} to=${args.recipient} subject=${JSON.stringify(args.subject)}`
    );
    return {
      delivered: true,
      provider: "console"
    };
  }

  const response = await instrumentFetch("resend", "email")("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [args.recipient],
      reply_to: replyTo ? [replyTo] : undefined,
      subject: args.subject,
      html: args.html,
      text: args.text
    })
  });

  return {
    delivered: response.ok,
    provider: "resend",
    responseText: await response.text().catch(() => "")
  };
}

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const [row] = await sql<NotificationPrefsRow[]>`
    insert into notification_prefs (user_id)
    values (${userId})
    on conflict (user_id) do update set updated_at = notification_prefs.updated_at
    returning
      user_id,
      run_completed,
      run_failed,
      quality_warning,
      cost_alert,
      workspace_invite,
      updated_at::text
  `;

  return mapPrefs(row);
}

export async function updateNotificationPreferences(
  userId: string,
  updates: Partial<Omit<NotificationPreferences, "userId" | "updatedAt">>
): Promise<NotificationPreferences> {
  const current = await getNotificationPreferences(userId);
  const [row] = await sql<NotificationPrefsRow[]>`
    insert into notification_prefs (
      user_id,
      run_completed,
      run_failed,
      quality_warning,
      cost_alert,
      workspace_invite,
      updated_at
    )
    values (
      ${userId},
      ${updates.runCompleted ?? current.runCompleted},
      ${updates.runFailed ?? current.runFailed},
      ${updates.plausibilityWarning ?? current.plausibilityWarning},
      ${updates.costAlert ?? current.costAlert},
      ${updates.workspaceInvite ?? current.workspaceInvite},
      now()
    )
    on conflict (user_id) do update
    set
      run_completed = excluded.run_completed,
      run_failed = excluded.run_failed,
      quality_warning = excluded.quality_warning,
      cost_alert = excluded.cost_alert,
      workspace_invite = excluded.workspace_invite,
      updated_at = now()
    returning
      user_id,
      run_completed,
      run_failed,
      quality_warning,
      cost_alert,
      workspace_invite,
      updated_at::text
  `;

  return mapPrefs(row);
}

export async function listNotificationInbox(args: {
  userId: string;
  workspaceId?: string;
  event?: NotificationEvent;
  limit?: number;
}): Promise<NotificationInboxPage> {
  const conditions: SqlFragment[] = [sql`user_id = ${args.userId}`];

  if (args.workspaceId) {
    conditions.push(sql`workspace_id = ${args.workspaceId}`);
  }

  if (args.event) {
    conditions.push(sql`event_type = ${args.event}`);
  }

  const whereClause = andSqlFragments(conditions);
  const limit = Math.max(1, Math.min(args.limit ?? 25, 200));

  const rows = await sql<NotificationDeliveryRow[]>`
     select
       id,
       user_id,
       org_id,
       workspace_id,
       event_type,
       provider,
       recipient,
       subject,
       delivered,
       metadata,
       read_at::text,
       created_at::text
     from notification_deliveries
     where ${whereClause}
     order by created_at desc
     limit ${limit}
  `;

  const [counts] = await sql<Array<{ unread_count: number }>>`
     select coalesce(count(*), 0)::int as unread_count
     from notification_deliveries
     where ${whereClause}
       and read_at is null
  `;

  return {
    deliveries: rows.map(mapDelivery),
    unreadCount: counts?.unread_count ?? 0
  };
}

export async function markNotificationRead(args: {
  id: string;
  userId: string;
}): Promise<NotificationInboxEntry | null> {
  const [row] = await sql<NotificationDeliveryRow[]>`
    update notification_deliveries
    set read_at = coalesce(read_at, now())
    where id = ${args.id}
      and user_id = ${args.userId}
    returning
      id,
      user_id,
      org_id,
      workspace_id,
      event_type,
      provider,
      recipient,
      subject,
      delivered,
      metadata,
      read_at::text,
      created_at::text
  `;

  return row ? mapDelivery(row) : null;
}

export async function markAllNotificationsRead(args: {
  userId: string;
  workspaceId?: string;
}): Promise<number> {
  if (args.workspaceId) {
    const result = await sql`
      update notification_deliveries
      set read_at = now()
      where user_id = ${args.userId}
        and workspace_id = ${args.workspaceId}
        and read_at is null
    `;

    return result.count;
  }

  const result = await sql`
    update notification_deliveries
    set read_at = now()
    where user_id = ${args.userId}
      and read_at is null
  `;

  return result.count;
}

export async function isNotificationEnabled(userId: string, event: NotificationEvent): Promise<boolean> {
  const prefs = await getNotificationPreferences(userId);
  switch (event) {
    case "run.completed":
      return prefs.runCompleted;
    case "run.failed":
      return prefs.runFailed;
    case "plausibility.warning":
      return prefs.plausibilityWarning;
    case "cost.alert":
      return prefs.costAlert;
    case "workspace.invite":
      return prefs.workspaceInvite;
  }
}

export async function sendNotificationEmail(args: {
  userId: string;
  event: NotificationEvent;
  subject: string;
  html: string;
  text: string;
  metadata?: Record<string, unknown>;
}): Promise<EmailDeliveryResult | null> {
  const enabled = await isNotificationEnabled(args.userId, args.event);
  if (!enabled) {
    return null;
  }

  const user = await getUser(args.userId);
  if (!user) {
    return null;
  }

  const deliveryId = randomUUID();
  const delivery = await deliverEmail({
    deliveryId,
    recipient: user.email,
    subject: args.subject,
    html: args.html,
    text: args.text
  });
  await logDelivery({
    id: deliveryId,
    userId: args.userId,
    orgId: null,
    workspaceId: null,
    event: args.event,
    provider: delivery.provider,
    recipient: user.email,
    subject: args.subject,
    delivered: delivery.delivered,
    metadata: {
      ...(args.metadata ?? {}),
      response: delivery.responseText ?? null
    }
  });

  if (!delivery.delivered) {
    throw new Error(`email delivery failed: ${delivery.responseText ?? "unknown error"}`);
  }

  return {
    id: deliveryId,
    delivered: delivery.delivered,
    provider: delivery.provider
  };
}

export async function sendRunStatusEmail(args: {
  userId: string;
  workspaceName: string;
  runId: string;
  status: "completed" | "failed";
  stage?: string | null;
  error?: string | null;
}): Promise<EmailDeliveryResult | null> {
  const subject =
    args.status === "completed"
      ? `Run completed: ${args.workspaceName}`
      : `Run failed: ${args.workspaceName}`;

  const lines = [
    `Workspace: ${args.workspaceName}`,
    `Run ID: ${args.runId}`,
    `Status: ${args.status}`
  ];

  if (args.stage) {
    lines.push(`Stage: ${args.stage}`);
  }
  if (args.error) {
    lines.push(PUBLIC_ERROR_MESSAGES.processing);
  }

  const bodyText = lines.join("\n");
  const html = `<p>${lines.map((line) => escapeHtml(line)).join("<br />")}</p>`;

  return await sendNotificationEmail({
    userId: args.userId,
    event: args.status === "completed" ? "run.completed" : "run.failed",
    subject,
    html,
    text: bodyText,
    metadata: {
      runId: args.runId,
      workspaceName: args.workspaceName,
      stage: args.stage ?? null
    }
  });
}

export async function sendWorkspaceInviteEmail(args: {
  actorUserId: string;
  recipientEmail: string;
  orgId?: string | null;
  workspaceId?: string | null;
  workspaceName: string;
  inviterName: string;
  inviteToken: string;
}): Promise<EmailDeliveryResult | null> {
  const inviteUrl = inviteAcceptUrl(args.inviteToken, "workspace");
  const deliveryId = randomUUID();
  const subject = `Workspace invite: ${args.workspaceName}`;
  const html = `<p>${escapeHtml(args.inviterName)} invited you to <strong>${escapeHtml(args.workspaceName)}</strong>.</p><p><a href="${escapeAttribute(inviteUrl)}">Accept invite</a></p>`;
  const text = `${args.inviterName} invited you to ${args.workspaceName}.\nAccept: ${inviteUrl}`;

  const delivery = await deliverEmail({
    deliveryId,
    recipient: args.recipientEmail,
    subject,
    html,
    text
  });

  await logDelivery({
    id: deliveryId,
    userId: args.actorUserId,
    orgId: args.orgId ?? null,
    workspaceId: args.workspaceId ?? null,
    event: "workspace.invite",
    provider: delivery.provider,
    recipient: args.recipientEmail,
    subject,
    delivered: delivery.delivered,
    metadata: {
      orgId: args.orgId ?? null,
      workspaceId: args.workspaceId ?? null,
      inviteToken: args.inviteToken,
      response: delivery.responseText ?? null
    }
  }).catch(() => undefined);

  return {
    id: deliveryId,
    delivered: delivery.delivered,
    provider: delivery.provider
  };
}

/**
 * A finished (or failed) zip export the user was promised an email for.
 * Throws when the provider refuses, so the export sweep can retry.
 */
export async function sendExportReadyEmail(args: {
  userId: string;
  recipientEmail: string;
  orgId: string;
  workspaceId: string;
  filename: string;
  ready: boolean;
  sizeLabel: string | null;
  expiresAt: Date;
  url: string;
}): Promise<void> {
  const deliveryId = randomUUID();
  const until = args.expiresAt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  // A fixed subject: the filename comes from user-named documents and workspaces, so it stays in the escaped body.
  const subject = args.ready ? "Your DocSlurp export is ready" : "Your DocSlurp export didn't finish";
  const size = args.sizeLabel ? ` (${args.sizeLabel})` : "";
  const html = args.ready
    ? `<p>Your DocSlurp export <strong>${escapeHtml(args.filename)}</strong>${escapeHtml(size)} is ready.</p><p><a href="${escapeAttribute(args.url)}">Download the export</a></p><p>The link works for 7 days, until ${escapeHtml(until)} (UTC). After that the file is deleted; export again from DocSlurp if you need it later. Sign in with this email address to download.</p>`
    : `<p>Your DocSlurp export <strong>${escapeHtml(args.filename)}</strong> couldn't be built.</p><p><a href="${escapeAttribute(args.url)}">Open DocSlurp</a> to try again, or export Markdown only for a smaller file.</p>`;
  const text = args.ready
    ? `Your DocSlurp export ${args.filename}${size} is ready.\n\nDownload: ${args.url}\n\nThe link works for 7 days, until ${until} (UTC). After that the file is deleted; export again from DocSlurp if you need it later.\n`
    : `Your DocSlurp export ${args.filename} couldn't be built.\n\nOpen DocSlurp to try again, or export Markdown only for a smaller file: ${args.url}\n`;

  const delivery = await deliverEmail({ deliveryId, recipient: args.recipientEmail, subject, html, text });
  await logDelivery({
    id: deliveryId,
    userId: args.userId,
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    event: args.ready ? "export.ready" : "export.failed",
    provider: delivery.provider,
    recipient: args.recipientEmail,
    subject,
    delivered: delivery.delivered,
    metadata: { orgId: args.orgId, workspaceId: args.workspaceId, response: delivery.responseText ?? null }
  }).catch(() => undefined);
  if (!delivery.delivered) throw new Error(`email provider ${delivery.provider} refused the export email`);
}

/**
 * An extract finished: its download is ready (or could not be built). The
 * link is the app's signed-in download page, never a credential; the
 * retention end is stated because everything is deleted then.
 */
export async function sendExtractReadyEmail(args: {
  userId: string;
  recipientEmail: string;
  orgId: string;
  workspaceId: string;
  extractId: string;
  ready: boolean;
  pages: number;
  expiresAt: Date;
  url: string;
}): Promise<void> {
  const deliveryId = randomUUID();
  const until = args.expiresAt.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const subject = args.ready ? "Your DocSlurp extract is ready" : "Your DocSlurp extract didn't finish";
  const pages = `${args.pages.toLocaleString("en-US")} page${args.pages === 1 ? "" : "s"}`;
  const html = args.ready
    ? `<p>Your DocSlurp extract (${escapeHtml(pages)}) is ready.</p><p><a href="${escapeAttribute(args.url)}">Download the results</a></p><p>Sign in with this email address to download. The files and results are deleted on ${escapeHtml(until)} (UTC).</p>`
    : `<p>Your DocSlurp extract couldn't produce a download.</p><p><a href="${escapeAttribute(args.url)}">Open DocSlurp</a> to check it. Its files are deleted on ${escapeHtml(until)} (UTC).</p>`;
  const text = args.ready
    ? `Your DocSlurp extract (${pages}) is ready.\n\nDownload: ${args.url}\n\nSign in with this email address to download. The files and results are deleted on ${until} (UTC).\n`
    : `Your DocSlurp extract couldn't produce a download.\n\nOpen DocSlurp to check it: ${args.url}\n\nIts files are deleted on ${until} (UTC).\n`;

  const delivery = await deliverEmail({ deliveryId, recipient: args.recipientEmail, subject, html, text });
  await logDelivery({
    id: deliveryId,
    userId: args.userId,
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    event: args.ready ? "extract.ready" : "extract.failed",
    provider: delivery.provider,
    recipient: args.recipientEmail,
    subject,
    delivered: delivery.delivered,
    metadata: { orgId: args.orgId, workspaceId: args.workspaceId, extractId: args.extractId, response: delivery.responseText ?? null }
  }).catch(() => undefined);
  if (!delivery.delivered) throw new Error(`email provider ${delivery.provider} refused the extract email`);
}

/** The signed-in accept page (dashboard). */
export function inviteAcceptUrl(token: string, kind: "organization" | "workspace"): string {
  const base = (process.env.APP_URL ?? "http://localhost:4321").replace(/\/$/, "");
  return `${base}/app/invites/${encodeURIComponent(token)}?kind=${kind}`;
}

export async function sendOrganizationInviteEmail(args: {
  actorUserId: string;
  recipientEmail: string;
  orgId: string;
  organizationName: string;
  inviterName: string;
  inviteToken: string;
}): Promise<EmailDeliveryResult | null> {
  const inviteUrl = inviteAcceptUrl(args.inviteToken, "organization");
  const deliveryId = randomUUID();
  const subject = `Organization invite: ${args.organizationName}`;
  const html = `<p>${escapeHtml(args.inviterName)} invited you to join <strong>${escapeHtml(args.organizationName)}</strong> on DocSlurp.</p><p><a href="${escapeAttribute(inviteUrl)}">Review and accept</a></p><p>Sign in with this email address to accept. Ignore this email if you weren't expecting it.</p>`;
  const text = `${args.inviterName} invited you to join ${args.organizationName} on DocSlurp.\nReview and accept: ${inviteUrl}\nSign in with this email address to accept.`;

  const delivery = await deliverEmail({ deliveryId, recipient: args.recipientEmail, subject, html, text });

  // The token is a credential: it is not logged.
  await logDelivery({
    id: deliveryId,
    userId: args.actorUserId,
    orgId: args.orgId,
    workspaceId: null,
    event: "workspace.invite",
    provider: delivery.provider,
    recipient: args.recipientEmail,
    subject,
    delivered: delivery.delivered,
    metadata: { kind: "organization", orgId: args.orgId, response: delivery.responseText ?? null }
  }).catch(() => undefined);

  return { id: deliveryId, delivered: delivery.delivered, provider: delivery.provider };
}

async function logDelivery(args: {
  id: string;
  userId: string;
  orgId?: string | null;
  workspaceId?: string | null;
  /** Transactional emails the user asked for (exports) are not preference-gated events. */
  event: NotificationEvent | "export.ready" | "export.failed" | "extract.ready" | "extract.failed";
  provider: string;
  recipient: string;
  subject: string;
  delivered: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    insert into notification_deliveries (
      id,
      user_id,
      org_id,
      workspace_id,
      event_type,
      provider,
      recipient,
      subject,
      delivered,
      metadata,
      created_at
    )
    values (
      ${args.id},
      ${args.userId},
      ${args.orgId ?? null},
      ${args.workspaceId ?? null},
      ${args.event},
      ${args.provider},
      ${args.recipient},
      ${args.subject},
      ${args.delivered},
      ${JSON.stringify(args.metadata ?? {})}::text::jsonb,
      now()
    )
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
