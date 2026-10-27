import { randomBytes, randomUUID, createHash } from "node:crypto";

import { emitTelemetryLog } from "@docslurp/shared/observability";

import { sql as defaultSql } from "../db.js";
import { resolveAlertDeliveryConfig, type AlertDeliveryConfig } from "./alerts/alert-delivery.js";

/**
 * In-app feedback and bug reports (POST /v1/feedback).
 *
 * Every report is stored against the organization the reporter acted in.
 * High-severity reports page the team live through the operational alert
 * channel (Telegram and/or ALERT_WEBHOOK_URL), capped per user and per org with
 * duplicate suppression; a suppressed report is still stored. The alert text is
 * plain text built from escaped, single-line fields, so a report cannot inject
 * Telegram or Slack formatting, mentions or fake fields.
 */

export const FEEDBACK_CATEGORIES = ["bug", "feedback", "question", "billing", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export const FEEDBACK_SEVERITIES = ["normal", "high"] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

export const FEEDBACK_LIMITS = Object.freeze({
  messageMaxChars: 4000,
  /** Reports of any severity per user (across orgs) and per org, rolling hour. */
  userPerHour: 20,
  orgPerHour: 100,
  /** Live pages per user and per org, rolling hour. Over this, reports are stored without paging. */
  highUserPerHour: 3,
  highOrgPerHour: 10,
  /** The same user filing the same high-severity text inside this window does not page again. */
  duplicateWindowHours: 24,
  alertExcerptChars: 280,
});

export type FeedbackAlertStatus = "not_applicable" | "pending" | "sent" | "suppressed" | "failed" | "unconfigured";

export interface FeedbackReportInput {
  orgId: string;
  workspaceId: string | null;
  userId: string;
  userEmail: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  message: string;
  route: string | null;
  screen: string | null;
  traceId: string | null;
  requestId: string | null;
  errorCode: string | null;
  occurredAt: string | null;
  clientTimezone: string | null;
  userAgent: string | null;
  appVersion: string | null;
}

export interface FeedbackReportRecord {
  id: string;
  reference: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  alertStatus: FeedbackAlertStatus;
  createdAt: string;
}

export type SubmitFeedbackResult =
  | { kind: "stored"; report: FeedbackReportRecord; suppressedReason: "user_hourly_cap" | "org_hourly_cap" | "duplicate" | null }
  | { kind: "rate_limited"; scope: "user" | "org"; retryAfterSeconds: number };

export interface FeedbackAlert {
  reference: string;
  category: FeedbackCategory;
  orgId: string;
  orgName: string | null;
  workspaceId: string | null;
  userEmail: string;
  message: string;
  route: string | null;
  screen: string | null;
  traceId: string | null;
  requestId: string | null;
  errorCode: string | null;
}

export type FeedbackAlertSender = (alert: FeedbackAlert) => Promise<"sent" | "failed" | "unconfigured">;

type Sql = typeof defaultSql;

export interface FeedbackDeps {
  sql?: Sql;
  sendAlert?: FeedbackAlertSender;
}

/** Normalized text hash for duplicate detection (case, whitespace and the prefilled timestamp line ignored). */
export function feedbackMessageHash(message: string): string {
  const normalized = message
    .split("\n")
    .filter((line) => !/^\s*(when|time)\s*:/i.test(line))
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Short, unambiguous reference users can quote: FB-XXXX-XXXX. */
export function newFeedbackReference(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((byte) => REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]).join("");
  return `FB-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function retryAfter(oldest: Date | string | null, now: number): number {
  if (!oldest) return 60;
  const expires = new Date(oldest).getTime() + 60 * 60 * 1000;
  return Math.max(1, Math.ceil((expires - now) / 1000));
}

interface CountRow {
  total: number;
  pages: number;
  oldest: Date | string | null;
}

/**
 * Stores a report under the per-user/per-org limits and, for an allowed
 * high-severity report, pages the team. Counting and inserting happen under
 * transaction-scoped advisory locks on the user and the org, so concurrent
 * submissions cannot slip past a cap or page twice for one duplicate.
 */
export async function submitFeedbackReport(input: FeedbackReportInput, deps: FeedbackDeps = {}): Promise<SubmitFeedbackResult> {
  const sql = deps.sql ?? defaultSql;
  const sendAlert = deps.sendAlert ?? deliverFeedbackAlert;
  const messageHash = feedbackMessageHash(input.message);
  const now = Date.now();

  const outcome = await sql.begin(async (tx) => {
    // Always user then org, so two locks never deadlock.
    await tx`select pg_advisory_xact_lock(hashtextextended(${`feedback-reports:user:${input.userId}`}, 0))`;
    await tx`select pg_advisory_xact_lock(hashtextextended(${`feedback-reports:org:${input.orgId}`}, 0))`;
    const [user] = await tx<CountRow[]>`
      select count(*)::int as total,
        count(*) filter (where severity = 'high' and alert_status in ('pending', 'sent', 'failed'))::int as pages,
        min(created_at) as oldest
      from feedback_reports
      where user_id = ${input.userId} and created_at > now() - interval '1 hour'
    `;
    const [org] = await tx<CountRow[]>`
      select count(*)::int as total,
        count(*) filter (where severity = 'high' and alert_status in ('pending', 'sent', 'failed'))::int as pages,
        min(created_at) as oldest
      from feedback_reports
      where org_id = ${input.orgId} and created_at > now() - interval '1 hour'
    `;
    if ((user?.total ?? 0) >= FEEDBACK_LIMITS.userPerHour) {
      return { kind: "rate_limited" as const, scope: "user" as const, retryAfterSeconds: retryAfter(user!.oldest, now) };
    }
    if ((org?.total ?? 0) >= FEEDBACK_LIMITS.orgPerHour) {
      return { kind: "rate_limited" as const, scope: "org" as const, retryAfterSeconds: retryAfter(org!.oldest, now) };
    }

    let suppressedReason: "user_hourly_cap" | "org_hourly_cap" | "duplicate" | null = null;
    if (input.severity === "high") {
      const [duplicate] = await tx<{ id: string }[]>`
        select id from feedback_reports
        where user_id = ${input.userId} and severity = 'high' and message_hash = ${messageHash}
          and alert_status in ('pending', 'sent', 'failed')
          and created_at > now() - make_interval(hours => ${FEEDBACK_LIMITS.duplicateWindowHours})
        limit 1
      `;
      if (duplicate) suppressedReason = "duplicate";
      else if ((user?.pages ?? 0) >= FEEDBACK_LIMITS.highUserPerHour) suppressedReason = "user_hourly_cap";
      else if ((org?.pages ?? 0) >= FEEDBACK_LIMITS.highOrgPerHour) suppressedReason = "org_hourly_cap";
    }
    const alertStatus: FeedbackAlertStatus = input.severity !== "high" ? "not_applicable" : suppressedReason ? "suppressed" : "pending";

    const id = randomUUID();
    const reference = newFeedbackReference();
    const [row] = await tx<{ created_at: Date | string }[]>`
      insert into feedback_reports (
        id, reference, org_id, workspace_id, user_id, category, severity, message, message_hash,
        route, screen, trace_id, request_id, error_code, occurred_at, client_timezone,
        user_agent, app_version, alert_status, alert_suppressed_reason
      ) values (
        ${id}, ${reference}, ${input.orgId}, ${input.workspaceId}, ${input.userId}, ${input.category},
        ${input.severity}, ${input.message}, ${messageHash}, ${input.route}, ${input.screen},
        ${input.traceId}, ${input.requestId}, ${input.errorCode}, ${input.occurredAt},
        ${input.clientTimezone}, ${input.userAgent}, ${input.appVersion}, ${alertStatus}, ${suppressedReason}
      )
      returning created_at
    `;
    const [org_] = await tx<{ name: string | null }[]>`select name from organizations where id = ${input.orgId}`;
    return {
      kind: "stored" as const,
      suppressedReason,
      orgName: org_?.name ?? null,
      report: { id, reference, category: input.category, severity: input.severity, alertStatus, createdAt: new Date(row!.created_at).toISOString() } as FeedbackReportRecord,
    };
  });

  if (outcome.kind === "rate_limited") {
    logFeedback("warn", `[feedback] rate limited scope=${outcome.scope} org=${input.orgId} user=${input.userId}`, {
      "docslurp.feedback.outcome": "rate_limited", "docslurp.feedback.limit_scope": outcome.scope,
      "docslurp.orgId": input.orgId, "enduser.id": input.userId,
    });
    return outcome;
  }

  const { report, suppressedReason } = outcome;
  if (report.alertStatus === "pending") {
    let status: "sent" | "failed" | "unconfigured";
    try {
      status = await sendAlert({
        reference: report.reference, category: input.category, orgId: input.orgId, orgName: outcome.orgName,
        workspaceId: input.workspaceId, userEmail: input.userEmail, message: input.message, route: input.route,
        screen: input.screen, traceId: input.traceId, requestId: input.requestId, errorCode: input.errorCode,
      });
    } catch {
      status = "failed";
    }
    await sql`update feedback_reports set alert_status = ${status} where id = ${report.id}`;
    report.alertStatus = status;
    if (status === "unconfigured") console.error(`[feedback] high-severity report ${report.reference} stored but no alert channel is configured (TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID or ALERT_WEBHOOK_URL)`);
  }

  logFeedback(input.severity === "high" ? "warn" : "info",
    `[feedback] stored reference=${report.reference} severity=${report.severity} category=${report.category} org=${input.orgId} alert=${report.alertStatus}${suppressedReason ? ` suppressed=${suppressedReason}` : ""}${input.traceId ? ` trace_id=${input.traceId}` : ""}`,
    {
      "docslurp.feedback.reference": report.reference, "docslurp.feedback.severity": report.severity,
      "docslurp.feedback.category": report.category, "docslurp.feedback.alert": report.alertStatus,
      "docslurp.orgId": input.orgId, "enduser.id": input.userId,
      ...(input.workspaceId ? { "docslurp.workspaceId": input.workspaceId } : {}),
      ...(input.traceId ? { "docslurp.feedback.trace_id": input.traceId } : {}),
      ...(input.requestId ? { "docslurp.feedback.request_id": input.requestId } : {}),
      ...(input.errorCode ? { "docslurp.feedback.error_code": input.errorCode } : {}),
      ...(suppressedReason ? { "docslurp.feedback.suppressed": suppressedReason } : {}),
    });
  return { kind: "stored", report, suppressedReason };
}

/** A reporter's own reports, newest first (never another user's, never message bodies of others). */
export async function listOwnFeedbackReports(userId: string, deps: { sql?: Sql } = {}): Promise<Array<FeedbackReportRecord & { messageExcerpt: string }>> {
  const sql = deps.sql ?? defaultSql;
  const rows = await sql<Array<{ id: string; reference: string; category: FeedbackCategory; severity: FeedbackSeverity; alert_status: FeedbackAlertStatus; created_at: Date | string; message: string }>>`
    select id, reference, category, severity, alert_status, created_at, message
    from feedback_reports where user_id = ${userId}
    order by created_at desc limit 20
  `;
  return rows.map((row) => ({
    id: row.id, reference: row.reference, category: row.category, severity: row.severity, alertStatus: row.alert_status,
    createdAt: new Date(row.created_at).toISOString(), messageExcerpt: row.message.slice(0, 160),
  }));
}

function logFeedback(level: "info" | "warn", line: string, attributes: Record<string, string>): void {
  (level === "warn" ? console.warn : console.log)(line);
  emitTelemetryLog({ severityText: level, body: line, eventName: "docslurp.feedback.report", attributes });
}

// ---------------------------------------------------------------------------
// Alert text. Telegram receives it as plain text (no parse_mode), Slack-style
// webhooks as `{ text }` with &, < and > entity-escaped. Every user-controlled
// value is flattened to one line, stripped of control and bidi characters and
// has its URLs defanged, so it cannot add fake fields, mentions or live links.
// ---------------------------------------------------------------------------

// C0/C1 controls, zero-width and bidi override/isolate characters.
// Built from code points so the source stays ASCII.
const UNSAFE_CHARS = new RegExp(`[${([[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]] as const).map(([from, to]) => `\\u${from.toString(16).padStart(4, "0")}-\\u${to.toString(16).padStart(4, "0")}`).join("")}]`, "g");

/** One-line, length-capped, control-free text with URLs defanged (hxxps[://]example[.]com). */
export function sanitizeAlertField(value: string | null | undefined, maxChars: number, options: { defang?: boolean } = {}): string {
  if (!value) return "";
  const flat = value.replace(/\r\n|\r|\n/g, " ⏎ ").replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim();
  const defanged = options.defang === false ? flat : flat
    .replace(/\bhttp(s?):\/\//gi, "hxxp$1[://]")
    .replace(/\b([a-z][a-z0-9+.-]{1,15}):\/\//gi, "$1[://]")
    .replace(/([a-z0-9-])\.([a-z]{2,})(?=[/:?#\s]|$)/gi, "$1[.]$2");
  return defanged.length > maxChars ? `${defanged.slice(0, maxChars - 1)}…` : defanged;
}

/** Slack mrkdwn escaping (https://api.slack.com/reference/surfaces/formatting#escaping). */
export function escapeSlackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TRACE_ID = /^[0-9a-f]{32}$/;

/** SigNoz trace detail URL (`<SIGNOZ_UI_URL>/trace/<traceId>`), when the base is an https URL. */
export function signozTraceUrl(traceId: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env.SIGNOZ_UI_URL?.trim();
  if (!base || !traceId || !TRACE_ID.test(traceId)) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/trace/${traceId}`;
  } catch {
    return null;
  }
}

/** The plain-text alert lines. Field values are sanitized; labels and server-made links are not user-controlled. */
export function formatFeedbackAlertLines(alert: FeedbackAlert, environment: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const field = (value: string | null | undefined, max = 200, defang = true) => sanitizeAlertField(value, max, { defang }) || "—";
  const traceUrl = signozTraceUrl(alert.traceId, env);
  return [
    `HIGH-PRIORITY ${alert.category.toUpperCase()} REPORT ${alert.reference} (${field(environment, 60)})`,
    `Org: ${field(alert.orgName, 120)} (${field(alert.orgId, 80, false)})`,
    `User: ${field(alert.userEmail, 320, false)}`,
    `Screen: ${field(alert.screen, 120)} · Route: ${field(alert.route, 200)}`,
    ...(alert.errorCode ? [`Error code: ${field(alert.errorCode, 80)}`] : []),
    `Trace: ${field(alert.traceId, 64, false)}${alert.requestId ? ` · Request: ${field(alert.requestId, 128, false)}` : ""}`,
    ...(traceUrl ? [`SigNoz: ${traceUrl}`] : []),
    `Message: ${field(alert.message, FEEDBACK_LIMITS.alertExcerptChars)}`,
  ];
}

export interface FeedbackAlertConfig extends AlertDeliveryConfig {
  disabled: boolean;
}

export function resolveFeedbackAlertConfig(env: NodeJS.ProcessEnv = process.env): FeedbackAlertConfig {
  const disabled = ["0", "false", "off", "no"].includes(env.FEEDBACK_ALERTS?.trim().toLowerCase() ?? "");
  return { ...resolveAlertDeliveryConfig(env, "feedback"), disabled };
}

/**
 * Sends one high-severity report to every configured channel. "sent" when at
 * least one channel accepted it. Failures are logged without the URL (the
 * Telegram URL carries the bot token; webhook URLs are secrets too).
 */
export function createFeedbackAlertSender(config: FeedbackAlertConfig = resolveFeedbackAlertConfig(), fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): FeedbackAlertSender {
  return async (alert) => {
    if (config.disabled || (!config.telegram && !config.webhookUrl)) return "unconfigured";
    const lines = formatFeedbackAlertLines(alert, config.environment, env);
    const attempts: Promise<boolean>[] = [];
    if (config.telegram) {
      const { token, chatId } = config.telegram;
      attempts.push(postJson(fetchImpl, `https://api.telegram.org/bot${token}/sendMessage`, {
        // No parse_mode: Telegram renders the text verbatim, so nothing in it is markup.
        chat_id: chatId, text: lines.join("\n").slice(0, 4096), disable_web_page_preview: true,
      }, config.timeoutMs, "telegram", alert.reference, true));
    }
    if (config.webhookUrl) {
      const payload = config.format === "json"
        ? { source: "docslurp", kind: "feedback_report", environment: config.environment, severity: "high", reference: alert.reference,
            category: alert.category, orgId: alert.orgId, orgName: alert.orgName, userEmail: alert.userEmail, route: alert.route,
            screen: alert.screen, traceId: alert.traceId, requestId: alert.requestId, errorCode: alert.errorCode,
            traceUrl: signozTraceUrl(alert.traceId, env), excerpt: sanitizeAlertField(alert.message, FEEDBACK_LIMITS.alertExcerptChars) }
        : { text: lines.map(escapeSlackText).join("\n") };
      attempts.push(postJson(fetchImpl, config.webhookUrl, payload, config.timeoutMs, "webhook", alert.reference, false));
    }
    const results = await Promise.all(attempts);
    return results.some(Boolean) ? "sent" : "failed";
  };
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, timeoutMs: number, channel: string, reference: string, telegram: boolean): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ok = telegram ? response.ok && ((await response.json().catch(() => null)) as { ok?: boolean } | null)?.ok === true : response.ok;
    if (!ok) console.error(`[feedback] ${channel} alert delivery failed reference=${reference} status=${response.status}`);
    return ok;
  } catch {
    // Never log the error: it can carry the token-bearing URL.
    console.error(`[feedback] ${channel} alert delivery failed reference=${reference}`);
    return false;
  }
}

export const deliverFeedbackAlert: FeedbackAlertSender = (alert) => createFeedbackAlertSender()(alert);

/** Build identity recorded with each report: the deployed commit or image, never client-supplied. */
export function serverAppVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.DOCSLURP_GIT_SHA?.trim() || env.FLY_IMAGE_REF?.trim() || env.FLY_MACHINE_VERSION?.trim() || null;
  return value ? value.slice(0, 200) : null;
}
