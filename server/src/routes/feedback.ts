import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { apiErrorResponse, nativeBodyLimit } from "../lib/api-error.js";
import { getRequestActor, loadActorScopedWorkspace } from "../lib/request-actor.js";
import { requestUserAgent, setCurrentRequestOrgId } from "../lib/request-context.js";
import { validationHook } from "../lib/validation.js";
import { ensurePersonalOrganization, getOrganization } from "../services/organizations.js";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_LIMITS,
  FEEDBACK_SEVERITIES,
  listOwnFeedbackReports,
  serverAppVersion,
  submitFeedbackReport,
  type FeedbackDeps,
} from "../services/feedback-reports.js";

/** Optional single-line metadata: trimmed, empty becomes null. */
const optionalLine = (max: number) => z.string().max(max * 4).optional().nullable()
  .transform((value) => {
    const line = value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
    return line ? line : null;
  });

const optionalPattern = (pattern: RegExp) => z.string().max(256).optional().nullable()
  .transform((value) => (value && pattern.test(value.trim()) ? value.trim() : null));

export const feedbackReportSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  severity: z.enum(FEEDBACK_SEVERITIES).default("normal"),
  message: z.string().transform((value) => value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim())
    .pipe(z.string().min(1).max(FEEDBACK_LIMITS.messageMaxChars)),
  /** Path only; query strings and fragments are dropped (they can carry tokens). */
  route: optionalLine(300).transform((value) => (value ? value.split(/[?#]/, 1)[0]!.slice(0, 300) || null : null)),
  screen: optionalLine(120),
  workspaceId: optionalLine(256),
  orgId: optionalLine(128),
  /** W3C trace id (32 lowercase hex, not all zeros). */
  traceId: optionalPattern(/^(?!0{32})[0-9a-f]{32}$/),
  requestId: optionalPattern(/^[A-Za-z0-9._:-]{1,128}$/),
  errorCode: optionalPattern(/^[a-z0-9_:.-]{1,80}$/i),
  occurredAt: z.string().max(64).optional().nullable()
    .transform((value) => {
      const time = value ? Date.parse(value) : Number.NaN;
      // A client clock can be off; anything implausible is dropped rather than stored.
      return Number.isFinite(time) && Math.abs(time - Date.now()) < 7 * 24 * 3600 * 1000 ? new Date(time).toISOString() : null;
    }),
  timezone: optionalPattern(/^[A-Za-z0-9_+\-/]{1,64}$/),
});

/** What each alert outcome tells the reporter. */
export const FEEDBACK_ALERT_COPY = Object.freeze({
  none: "Thanks. Your report went straight to the support team.",
  sent: "The team has been alerted and will look at this now.",
  already_reported: "The team already has your high-priority report. This one is attached to it.",
  capped: "Saved to the support queue; no new live alert because several were sent this hour.",
  queued: "Your report is with the support team. The live alert didn't go through, so they'll pick it up from the support queue.",
});

/**
 * `/v1/feedback`: signed-in app sessions only (the default route auth mode).
 * API keys cannot file reports, so a leaked or automated key cannot page the team.
 */
export function createFeedbackRoutes(deps: FeedbackDeps = {}) {
  return new Hono()
    .post("/", nativeBodyLimit(16 * 1024), zValidator("json", feedbackReportSchema, validationHook), async (c) => {
      const actor = getRequestActor(c);
      if (actor.type !== "session" || !actor.userId) return apiErrorResponse(c, 401, "unauthorized", "Sign in to send feedback");
      const body = c.req.valid("json");

      // Tenant scope: a named workspace counts only when this user can reach it;
      // a named org only when they are a member. Otherwise the personal org.
      // The response is identical either way, so the fields are no access oracle.
      const workspace = body.workspaceId ? await loadActorScopedWorkspace(body.workspaceId, actor).catch(() => null) : null;
      const org = workspace
        ? { id: workspace.orgId }
        : (body.orgId ? await getOrganization(body.orgId, actor.userId) : null) ?? await ensurePersonalOrganization(actor.userId);
      setCurrentRequestOrgId(org.id);

      const result = await submitFeedbackReport({
        orgId: org.id,
        workspaceId: workspace?.id ?? null,
        userId: actor.userId,
        userEmail: actor.user.email,
        category: body.category,
        severity: body.severity,
        message: body.message,
        route: body.route,
        screen: body.screen,
        traceId: body.traceId,
        requestId: body.requestId,
        errorCode: body.errorCode,
        occurredAt: body.occurredAt,
        clientTimezone: body.timezone,
        userAgent: requestUserAgent(c)?.slice(0, 400) ?? null,
        appVersion: serverAppVersion(),
      }, deps);

      if (result.kind === "rate_limited") {
        c.header("Retry-After", String(result.retryAfterSeconds));
        return apiErrorResponse(c, 429, "rate_limited", "Too many reports", { retryAfterSeconds: result.retryAfterSeconds, category: "feedback" });
      }
      const { report, suppressedReason } = result;
      // Honest copy: "already reported" only for a duplicate of this user's own page.
      const alert = report.severity !== "high" ? "none"
        : report.alertStatus === "sent" ? "sent"
          : suppressedReason === "duplicate" ? "already_reported"
            : suppressedReason ? "capped"
              : "queued";
      return c.json({
        report: { id: report.id, reference: report.reference, category: report.category, severity: report.severity, createdAt: report.createdAt },
        alert,
        message: FEEDBACK_ALERT_COPY[alert],
      }, 201);
    })
    .get("/", async (c) => {
      const actor = getRequestActor(c);
      if (actor.type !== "session" || !actor.userId) return apiErrorResponse(c, 401, "unauthorized", "Sign in to view your reports");
      return c.json({ reports: await listOwnFeedbackReports(actor.userId, deps) });
    });
}

export const feedbackRoutes = createFeedbackRoutes();
