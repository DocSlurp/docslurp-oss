import { randomUUID } from "node:crypto";

import { DOCUMENT_FAILURE_MARKERS, PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";
import { emitEventLog } from "@docslurp/shared/error-reporting";
import postgres, { type Sql } from "postgres";

import type { WorkflowState } from "../pipeline/pipeline.js";
import { insertProjectRunEvents } from "./run-event-store.js";
import { appendAuditLog } from "./audit-log.js";
import { sqlJson } from "./sql-helpers.js";

/** A newer canonical version took over these documents in search (document.replaced). */
export type CanonicalReplacement = {
  documentId: string;
  canonicalId: string;
  previousVersionId: string | null;
  replacedDocumentIds: string[];
};

/**
 * Run notifications: the webhook outbox rows and in-app notification deliveries a run's transitions owe. Workers never
 * call subscriber URLs or send email; every method writes rows (in the caller's transaction when it passes one) that the
 * API delivers.
 */
export class RunNotifications {
  constructor(
    private readonly sql: Sql<Record<string, unknown>>,
    private readonly plausibilityWarningThreshold: number,
  ) {}

  /** Emits document.replaced once a newer canonical version has taken over in search. */
  async announceReplacements(state: WorkflowState, replacements: CanonicalReplacement[], client: Sql<Record<string, unknown>> = this.sql, logicalId?: string): Promise<void> {
    for (const replacement of replacements) {
      await insertProjectRunEvents({ sql: client, events: [{
        id: logicalId ? `${logicalId}:replacement:${replacement.documentId}` : randomUUID(),
        userId: state.run.userId,
        runId: state.run.id,
        documentId: replacement.documentId,
        eventType: "document.replaced",
        status: "completed",
        message: `Replaced ${replacement.replacedDocumentIds.length} previous version(s) of ${replacement.canonicalId}`,
        // progress travels on the live NOTIFY channel; payload is stored only.
        progress: {
          canonicalId: replacement.canonicalId,
          replacedDocumentIds: replacement.replacedDocumentIds,
        },
        payload: { ...replacement },
      }] });
    }
    await this.triggerDocumentWebhooks(state, replacements, client, logicalId);
  }

  /**
   * Records run webhook events in the outbox. The API delivers them with its
   * signed, SSRF-checked dispatcher; the worker never calls subscriber URLs.
   */
  async triggerWebhooks(runId: string, event: string, client: Sql<Record<string, unknown>> = this.sql, logicalId?: string): Promise<void> {
    // One statement: the run is read inside the outbox insert. Subscribers include teammates and external systems, so the
    // raw worker error (stack frames, hosts, provider text) stays in the run record and telemetry; the payload carries its
    // public copy, the same mapping as publicDocumentError (reviewed copy for known markers, else the generic message).
    await this.enqueueWebhookEvent(event, client`
      select r.user_id, jsonb_build_object(
        'event', ${event}::text,
        'runId', r.id,
        'projectId', r.project_id,
        'status', r.status,
        'stage', r.stage,
        'processedDocuments', r.processed_documents,
        'pagesProcessed', r.pages_processed,
        'failedDocuments', coalesce((r.stats->>'failedDocuments')::int, 0),
        'error', ${publicErrorSql(client, "r.error")}
      ) as payload
      from project_runs r
      where r.id = ${runId}
    `, client, logicalId);
  }

  private async triggerDocumentWebhooks(
    state: WorkflowState,
    replacements: CanonicalReplacement[],
    client: Sql<Record<string, unknown>> = this.sql,
    logicalId?: string,
  ): Promise<void> {
    for (const replacement of replacements) {
      const payload = {
        event: "document.replaced",
        runId: state.run.id,
        projectId: state.run.projectId,
        ...replacement,
      };
      await this.enqueueWebhookEvent("document.replaced", client`
        select ${state.run.userId}::text as user_id, ${this.toJson(payload)}::jsonb as payload
      `, client, logicalId ? `${logicalId}:replacement:${replacement.documentId}` : undefined);
    }
  }

  /** Inserts one outbox row per source row, only when its run's organization has a webhook subscribed to the event, and wakes the API. */
  private async enqueueWebhookEvent(
    event: string,
    source: postgres.PendingQuery<postgres.Row[]>,
    client: Sql<Record<string, unknown>> = this.sql,
    logicalId?: string,
  ): Promise<void> {
    await client`
      with source as (${source}),
      queued as (
        insert into webhook_outbox (id, user_id, event_type, payload)
        select coalesce(${logicalId ?? null}::text, gen_random_uuid()::text), source.user_id, ${event}, source.payload
        from source
        where exists (
          -- Webhooks belong to the run's organization, not to the user who started the run, so a
          -- teammate's run reaches the team's webhook. user_id is attribution only; the API routes
          -- each event by its run and checks the webhook's creator still administers the organization.
          select 1 from webhooks w
          join project_runs r on r.org_id = w.org_id
          where r.id = source.payload->>'runId'
            and w.active = true and ${event} = any(w.events)
        )
        returning id
      )
      select pg_notify('webhook_outbox', id) from queued
    `;
  }

  async triggerRunEmails(
    runId: string,
    event: "run.completed" | "run.failed",
  ): Promise<void> {
    const rows = await this.sql.unsafe<
      Array<{
        user_id: string;
        org_id: string | null;
        project_id: string;
        project_name: string;
        stage: string;
        error: string | null;
        email: string;
        run_completed: boolean | null;
        run_failed: boolean | null;
      }>
    >(
      `
      select
        r.user_id,
        r.org_id,
        r.project_id,
        w.name as project_name,
        r.stage,
        r.error,
        u.email,
        np.run_completed,
        np.run_failed
      from project_runs r
      join projects w on w.id = r.project_id
      join "user" u on u.id = r.user_id
      left join notification_prefs np on np.user_id = r.user_id
      -- Extract runs send their own completion email with the download (server services/extracts.ts).
      where r.id = $1 and r.extract_id is null
      limit 1
      `,
      [runId],
    );
    const row = rows[0];

    if (!row) {
      return;
    }

    const enabled =
      event === "run.completed"
        ? (row.run_completed ?? true)
        : (row.run_failed ?? true);
    if (!enabled) {
      return;
    }

    const subject =
      event === "run.completed"
        ? `Run completed: ${row.project_name}`
        : `Run failed: ${row.project_name}`;
    const lines = [
      `Project: ${row.project_name}`,
      `Run ID: ${runId}`,
      `Status: ${event === "run.completed" ? "completed" : "failed"}`,
      `Stage: ${row.stage}`,
    ];
    if (row.error) {
      lines.push(PUBLIC_ERROR_MESSAGES.processing);
    }

    await recordNotificationEvent(this.sql, {
      deliveryId: randomUUID(),
      userId: row.user_id,
      orgId: row.org_id,
      projectId: row.project_id,
      runId,
      event,
      recipient: row.email,
      subject,
      text: lines.join("\n"),
      html: `<p>${lines.map((line) => escapeHtml(line)).join("<br />")}</p>`,
      metadata: {
        runId,
        stage: row.stage,
        error: row.error,
      },
    });
  }

  async triggerPlausibilityWarningEmail(
    runId: string,
    documentId: string,
    plausibilityScore: number,
    stage: string,
  ): Promise<void> {
    const rows = await this.sql.unsafe<
      Array<{
        user_id: string;
        org_id: string | null;
        project_id: string;
        project_name: string;
        filename: string;
        email: string;
        quality_warning: boolean | null;
      }>
    >(
      `
      select
        r.user_id,
        r.org_id,
        r.project_id,
        w.name as project_name,
        d.filename,
        u.email,
        np.quality_warning
      from project_runs r
      join projects w on w.id = r.project_id
      join documents d on d.id = $2 and d.run_id = r.id
      join "user" u on u.id = r.user_id
      left join notification_prefs np on np.user_id = r.user_id
      where r.id = $1
      limit 1
      `,
      [runId, documentId],
    );
    const row = rows[0];

    if (!row || row.quality_warning === false) {
      return;
    }

    const subject = `Extraction plausibility warning: ${row.filename}`;
    const lines = [
      `Project: ${row.project_name}`,
      `Run ID: ${runId}`,
      `Document: ${row.filename}`,
      `Stage: ${stage}`,
      `Plausibility score: ${plausibilityScore.toFixed(3)}`,
      `Threshold: ${this.plausibilityWarningThreshold.toFixed(3)}`,
    ];

    await recordNotificationEvent(this.sql, {
      deliveryId: randomUUID(),
      userId: row.user_id,
      orgId: row.org_id,
      projectId: row.project_id,
      runId,
      documentId,
      event: "plausibility.warning",
      recipient: row.email,
      subject,
      text: lines.join("\n"),
      html: `<p>${lines.map((line) => escapeHtml(line)).join("<br />")}</p>`,
      metadata: {
        runId,
        documentId,
        filename: row.filename,
        plausibilityScore,
        threshold: this.plausibilityWarningThreshold,
        stage,
      },
    });
  }


  private toJson(value: unknown) {
    return sqlJson(this.sql, value);
  }
}

/**
 * SQL for publicDocumentError over a text column: null stays null, a known failure marker maps to its reviewed public
 * copy, anything else to the generic processing message. Built from the same tables, so the two cannot drift.
 */
export function publicErrorSql(client: Sql<Record<string, unknown>>, column: "r.error"): postgres.PendingQuery<postgres.Row[]> {
  const value = client.unsafe(column);
  let expression = client`case when ${value} is null or ${value} = '' then null::text`;
  for (const [key, marker] of Object.entries(DOCUMENT_FAILURE_MARKERS)) {
    const message = PUBLIC_ERROR_MESSAGES[key as keyof typeof DOCUMENT_FAILURE_MARKERS];
    expression = client`${expression} when strpos(${value}, ${marker}::text) > 0 then ${message}::text`;
  }
  return client`${expression} else ${PUBLIC_ERROR_MESSAGES.processing}::text end`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Workers never send email. Each notification event goes to SigNoz as a
 * structured log and to the in-app inbox (notification_deliveries).
 */
export async function recordNotificationEvent(sql: Sql<Record<string, unknown>>, args: {
  deliveryId: string;
  userId: string;
  orgId?: string | null;
  projectId?: string | null;
  runId?: string | null;
  documentId?: string | null;
  event:
    | "run.completed"
    | "run.failed"
    | "plausibility.warning"
    | "cost.alert"
    | "project.invite";
  recipient: string;
  subject: string;
  text: string;
  html: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const provider = "log";
  emitEventLog(`notification.${args.event}`, {
    "notification.id": args.deliveryId,
    "notification.event": args.event,
    "notification.subject": args.subject,
    "notification.text": args.text,
    "enduser.id": args.userId,
    "docslurp.org_id": args.orgId,
    "docslurp.project_id": args.projectId,
    "docslurp.run_id": args.runId,
    "docslurp.document_id": args.documentId,
    "notification.metadata": args.metadata,
  });

  await sql`
    insert into notification_deliveries (
      id,
      user_id,
      org_id,
      project_id,
      event_type,
      provider,
      recipient,
      subject,
      delivered,
      metadata,
      created_at
    )
    values (
      ${args.deliveryId},
      ${args.userId},
      ${args.orgId ?? null},
      ${args.projectId ?? null},
      ${args.event},
      ${provider},
      ${args.recipient},
      ${args.subject},
      true,
      ${sqlJson(sql, {
        ...(args.metadata ?? {}),
        runId: args.runId ?? null,
        documentId: args.documentId ?? null,
      })}::jsonb,
      now()
    )
  `;

  await appendAuditLog(sql, {
    orgId: args.orgId ?? null,
    userId: args.userId,
    projectId: args.projectId ?? null,
    runId: args.runId ?? null,
    documentId: args.documentId ?? null,
    action: "notification.logged",
    resourceType: "notification",
    resourceId: args.deliveryId,
    metadata: {
      event: args.event,
      provider,
      subject: args.subject,
      ...(args.metadata ?? {}),
    },
  });
}
