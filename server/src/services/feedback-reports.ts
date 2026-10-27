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
  /** Live pages per deployment, rolling hour (FEEDBACK_PAGES_PER_HOUR). Over this, one summary page per hour. */
  highGlobalPerHour: 20,
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

export type FeedbackSuppressedReason = "duplicate" | "user_hourly_cap" | "org_hourly_cap" | "global_hourly_cap";

export type SubmitFeedbackResult =
  | { kind: "stored"; report: FeedbackReportRecord; suppressedReason: FeedbackSuppressedReason | null }
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

/** The one page sent when the deployment-wide hourly cap trips. */
export interface FeedbackSummaryAlert {
  reference: string;
  /** High-severity reports stored without a page in the last hour, this one included. */
  suppressedThisHour: number;
  capPerHour: number;
}

export type FeedbackSummarySender = (summary: FeedbackSummaryAlert) => Promise<"sent" | "failed" | "unconfigured">;

type Sql = typeof defaultSql;

export interface FeedbackDeps {
  sql?: Sql;
  sendAlert?: FeedbackAlertSender;
  sendSummary?: FeedbackSummarySender;
  env?: NodeJS.ProcessEnv;
}

/** FEEDBACK_PAGES_PER_HOUR: a positive integer, else the default. */
export function globalPageCap(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.FEEDBACK_PAGES_PER_HOUR?.trim());
  return Number.isInteger(value) && value > 0 ? value : FEEDBACK_LIMITS.highGlobalPerHour;
}

/** Normalized text hash for duplicate detection (case, whitespace and the prefilled When/Trace ID/Request ID lines ignored). */
export function feedbackMessageHash(message: string): string {
  const normalized = message
    .split("\n")
    .filter((line) => !/^\s*(when|time|trace id|request id)\s*:/i.test(line))
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
  const sendSummary = deps.sendSummary ?? deliverFeedbackSummaryAlert;
  const globalCap = globalPageCap(deps.env);
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

    let suppressedReason: FeedbackSuppressedReason | null = null;
    let summary: { suppressedThisHour: number } | null = null;
    if (input.severity === "high") {
      // A page that failed does not count as delivered: the same text may page again (within the caps).
      const [duplicate] = await tx<{ id: string }[]>`
        select id from feedback_reports
        where user_id = ${input.userId} and severity = 'high' and message_hash = ${messageHash}
          and alert_status in ('pending', 'sent')
          and created_at > now() - make_interval(hours => ${FEEDBACK_LIMITS.duplicateWindowHours})
        limit 1
      `;
      if (duplicate) suppressedReason = "duplicate";
      else if ((user?.pages ?? 0) >= FEEDBACK_LIMITS.highUserPerHour) suppressedReason = "user_hourly_cap";
      else if ((org?.pages ?? 0) >= FEEDBACK_LIMITS.highOrgPerHour) suppressedReason = "org_hourly_cap";
      else {
        // Deployment-wide cap, so many users or orgs together cannot flood the team's phones.
        await tx`select pg_advisory_xact_lock(hashtextextended('feedback-reports:global', 0))`;
        const [global] = await tx<{ pages: number; summarized: number; suppressed: number }[]>`
          select count(*) filter (where alert_status in ('pending', 'sent', 'failed'))::int as pages,
            count(*) filter (where summary_paged)::int as summarized,
            count(*) filter (where alert_suppressed_reason = 'global_hourly_cap')::int as suppressed
          from feedback_reports
          where severity = 'high' and created_at > now() - interval '1 hour'
        `;
        if ((global?.pages ?? 0) >= globalCap) {
          suppressedReason = "global_hourly_cap";
          // The first capped report of the hour sends one summary page instead of going silent.
          if ((global?.summarized ?? 0) === 0) summary = { suppressedThisHour: (global?.suppressed ?? 0) + 1 };
        }
      }
    }
    const alertStatus: FeedbackAlertStatus = input.severity !== "high" ? "not_applicable" : suppressedReason ? "suppressed" : "pending";

    const id = randomUUID();
    const reference = newFeedbackReference();
    const [row] = await tx<{ created_at: Date | string }[]>`
      insert into feedback_reports (
        id, reference, org_id, workspace_id, user_id, category, severity, message, message_hash,
        route, screen, trace_id, request_id, error_code, occurred_at, client_timezone,
        user_agent, app_version, alert_status, alert_suppressed_reason, summary_paged
      ) values (
        ${id}, ${reference}, ${input.orgId}, ${input.workspaceId}, ${input.userId}, ${input.category},
        ${input.severity}, ${input.message}, ${messageHash}, ${input.route}, ${input.screen},
        ${input.traceId}, ${input.requestId}, ${input.errorCode}, ${input.occurredAt},
        ${input.clientTimezone}, ${input.userAgent}, ${input.appVersion}, ${alertStatus}, ${suppressedReason}, ${summary !== null}
      )
      returning created_at
    `;
    const [org_] = await tx<{ name: string | null }[]>`select name from organizations where id = ${input.orgId}`;
    return {
      kind: "stored" as const,
      suppressedReason,
      summary,
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
  if (outcome.summary) {
    const status = await sendSummary({ reference: report.reference, suppressedThisHour: outcome.summary.suppressedThisHour, capPerHour: globalCap }).catch(() => "failed" as const);
    console.error(`[feedback] deployment-wide page cap reached (${globalCap}/hour); summary page ${status} reference=${report.reference}`);
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

/**
 * Invisible and formatting characters: C0/C1 controls, every Unicode format
 * character (\p{Cf}: zero-width, bidi overrides and isolates, soft hyphen,
 * Arabic letter mark, Mongolian vowel separator, word joiners, BOM, tag
 * characters), variation selectors and line/paragraph separators.
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\u{AD}\u{61C}\u{180E}\u{2028}\u{2029}\u{FE00}-\u{FE0F}\u{E0000}-\u{E007F}]/gu;
/** ASCII full stop plus the ideographic, full-width and half-width ideographic full stops. */
const DOT_LIKE = /[\u{3002}\u{FF0E}\u{FF61}]/gu;
/** A dot (after full-width normalization) with a letter, digit, underscore or hyphen on both sides: domains, IDNs and IPs. */
const INNER_DOT = /(?<=[\p{L}\p{N}\p{M}_-])\.(?=[\p{L}\p{N}\p{M}_-])/gu;

/** Linkable patterns made inert: schemes, every inner dot, IP addresses, @mentions and /commands. */
export function defangAlertText(value: string): string {
  return value
    .replace(DOT_LIKE, ".")
    .replace(/\bhttp(s?):\/\//giu, "hxxp$1[://]")
    .replace(/\b([a-z][a-z0-9+.-]{1,15}):\/\//giu, "$1[://]")
    .replace(INNER_DOT, "[.]")
    // Telegram links @username and /command when they start a word.
    .replace(/(^|[^\p{L}\p{N}_])@(?=[\p{L}\p{N}_])/gu, "$1[at]")
    .replace(/(^|\s)\/(?=[\p{L}\p{N}_])/gu, "$1[/]");
}

/** One-line, length-capped, invisible-free text, defanged unless `defang: false` (server-issued values only). */
export function sanitizeAlertField(value: string | null | undefined, maxChars: number, options: { defang?: boolean } = {}): string {
  if (!value) return "";
  const flat = value.replace(/\r\n|\r|\n/g, " \u{23CE} ").replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim();
  const defanged = options.defang === false ? flat : defangAlertText(flat);
  return defanged.length > maxChars ? `${defanged.slice(0, maxChars - 1)}\u{2026}` : defanged;
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
    // Both IDs come from the client: labelled as such, and the request ID is defanged
    // (a value such as "signoz-docslurp.io" would otherwise render as a link).
    `Trace (client-reported): ${field(alert.traceId, 64, false)}${alert.requestId ? ` · Request (client-reported): ${field(alert.requestId, 128)}` : ""}`,
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

/** The summary page text: server-made numbers and the reference only, no user-controlled fields. */
export function formatFeedbackSummaryLines(summary: FeedbackSummaryAlert, environment: string): string[] {
  const more = summary.suppressedThisHour;
  return [
    `HIGH-PRIORITY REPORTS: PAGE CAP REACHED (${sanitizeAlertField(environment, 60, { defang: false }) || "\u{2014}"})`,
    `${summary.capPerHour} reports paged in the last hour. ${more} more high-severity report${more === 1 ? "" : "s"} suppressed this hour (latest ${summary.reference}).`,
    "Further ones this hour are stored in the support queue without paging. Review feedback_reports where alert_suppressed_reason = 'global_hourly_cap'.",
  ];
}

export function createFeedbackSummarySender(config: FeedbackAlertConfig = resolveFeedbackAlertConfig(), fetchImpl: typeof fetch = fetch): FeedbackSummarySender {
  return async (summary) => {
    if (config.disabled || (!config.telegram && !config.webhookUrl)) return "unconfigured";
    const lines = formatFeedbackSummaryLines(summary, config.environment);
    const attempts: Promise<boolean>[] = [];
    if (config.telegram) {
      attempts.push(postJson(fetchImpl, `https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
        chat_id: config.telegram.chatId, text: lines.join("\n"), disable_web_page_preview: true,
      }, config.timeoutMs, "telegram", summary.reference, true));
    }
    if (config.webhookUrl) {
      const payload = config.format === "json"
        ? { source: "docslurp", kind: "feedback_page_cap", environment: config.environment, reference: summary.reference,
            suppressedThisHour: summary.suppressedThisHour, capPerHour: summary.capPerHour }
        : { text: lines.map(escapeSlackText).join("\n") };
      attempts.push(postJson(fetchImpl, config.webhookUrl, payload, config.timeoutMs, "webhook", summary.reference, false));
    }
    return (await Promise.all(attempts)).some(Boolean) ? "sent" : "failed";
  };
}

export const deliverFeedbackSummaryAlert: FeedbackSummarySender = (summary) => createFeedbackSummarySender()(summary);

/** Build identity recorded with each report: the deployed commit or image, never client-supplied. */
export function serverAppVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.DOCSLURP_GIT_SHA?.trim() || env.FLY_IMAGE_REF?.trim() || env.FLY_MACHINE_VERSION?.trim() || null;
  return value ? value.slice(0, 200) : null;
}

// ---------------------------------------------------------------------------
// Retention: reports older than FEEDBACK_RETENTION_DAYS (default 180) are
// deleted, and each org keeps at most FEEDBACK_MAX_REPORTS_PER_ORG (default
// 5,000), newest first. Batched and run at most hourly per process.
// ---------------------------------------------------------------------------

export const FEEDBACK_RETENTION_DEFAULTS = Object.freeze({ days: 180, perOrg: 5_000, batch: 1_000, intervalMs: 60 * 60 * 1000 });

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function purgeFeedbackReports(deps: { sql?: Sql; env?: NodeJS.ProcessEnv } = {}): Promise<{ expired: number; overCap: number }> {
  const sql = deps.sql ?? defaultSql;
  const env = deps.env ?? process.env;
  const days = positiveInt(env.FEEDBACK_RETENTION_DAYS, FEEDBACK_RETENTION_DEFAULTS.days);
  const perOrg = positiveInt(env.FEEDBACK_MAX_REPORTS_PER_ORG, FEEDBACK_RETENTION_DEFAULTS.perOrg);
  const batch = FEEDBACK_RETENTION_DEFAULTS.batch;
  const expired = await sql`
    delete from feedback_reports where id in (
      select id from feedback_reports where created_at < now() - make_interval(days => ${days}) limit ${batch}
    )
  `;
  const overCap = await sql`
    delete from feedback_reports where id in (
      select id from (
        select id, row_number() over (partition by org_id order by created_at desc, id desc) as rank
        from feedback_reports
        where org_id in (select org_id from feedback_reports group by org_id having count(*) > ${perOrg})
      ) ranked where rank > ${perOrg} limit ${batch}
    )
  `;
  const result = { expired: expired.count, overCap: overCap.count };
  if (result.expired || result.overCap) console.log(`[feedback] retention purge expired=${result.expired} over_cap=${result.overCap} days=${days} per_org=${perOrg}`);
  return result;
}

let lastPurgeAt = 0;

/** Maintenance-sweep entry: purges at most once an hour per process. */
export async function sweepFeedbackReports(now = Date.now()): Promise<void> {
  if (now - lastPurgeAt < FEEDBACK_RETENTION_DEFAULTS.intervalMs) return;
  lastPurgeAt = now;
  await purgeFeedbackReports();
}
