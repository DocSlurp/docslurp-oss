import { PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";
import { reportPublicError } from "../lib/public-errors.js";
import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import {
  createConnectorSchema,
  defaultPipelineFeatures,
  updateConnectorSchema,
  type PipelineFeatures,
  type WorkspaceConnector,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { env } from "../config.js";
import { openSecret, sealSecret } from "../lib/encryption.js";
import { validationErrorResponse, type ValidationErrorSource } from "../lib/validation.js";
import { getConnectorAdapter } from "../services/connectors/index.js";
import { canManageWorkspace, getWorkspaceAccess } from "../services/organizations.js";
import {
  intakeIntoWorkspace,
  screenIntakeFile,
  type IntakeFileVerdict,
  type WorkspaceIntakeItem,
} from "../services/workspace-intake.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";

function encryptCredentials(credentials: Record<string, unknown>): string {
  return sealSecret("CREDENTIALS_ENCRYPTION_KEY", JSON.stringify(credentials));
}

function decryptCredentials(encryptedStr: string): Record<string, unknown> {
  return JSON.parse(openSecret("CREDENTIALS_ENCRYPTION_KEY", encryptedStr)) as Record<string, unknown>;
}

// Unknown or unimplemented connector types fail the shared enum here, so they
// are rejected at creation instead of failing every later sync.
const connectorValidationHook = (result: { success: boolean; error?: ValidationErrorSource }, c: Context) => {
  if (result.success) {
    return;
  }
  return validationErrorResponse(c, result.error ?? new z.ZodError([]), "Invalid connector payload");
};

type ConnectorRow = {
  id: string;
  workspace_id: string;
  type: string;
  name: string;
  credentials_encrypted: string;
  config: Record<string, unknown>;
  status: string;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
};

function toSqlJson(value: unknown): Parameters<typeof sql.json>[0] {
  return JSON.parse(JSON.stringify(value ?? {})) as Parameters<typeof sql.json>[0];
}

function rowToConnector(row: ConnectorRow): WorkspaceConnector {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type as WorkspaceConnector["type"],
    name: row.name,
    status: row.status as WorkspaceConnector["status"],
    config: row.config ?? {},
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireConnectorAccess(workspaceId: string, userId: string): Promise<
  | { ok: true }
  | { ok: false; status: 403 | 404; code: "forbidden" | "workspace_not_found"; message: string }
> {
  const access = await getWorkspaceAccess(workspaceId, userId);
  if (!access) {
    return { ok: false, status: 404, code: "workspace_not_found", message: "Workspace not found" };
  }
  if (!canManageWorkspace(access, userId)) {
    return { ok: false, status: 403, code: "forbidden", message: "Forbidden" };
  }
  return { ok: true };
}

/**
 * Run a connector sync: list files, download new/changed ones, create document records.
 */
export async function runConnectorSync(row: ConnectorRow, syncLogId: string): Promise<void> {
  let filesAdded = 0;
  let filesUpdated = 0;
  let filesSkipped = 0;
  const skippedReasons = new Set<string>();

  // Everything, including adapter and credential setup, runs inside the try so
  // the sync log always reaches a terminal state.
  try {
    const adapter = getConnectorAdapter(row.type);
    const credentials = decryptCredentials(row.credentials_encrypted);
    const config = row.config ?? {};
    const files = await adapter.listFiles(config, credentials);
    const workspaceRows = await sql<Array<{ org_id: string; user_id: string; pipeline: PipelineFeatures | null }>>`
      select org_id, user_id, pipeline from workspaces where id = ${row.workspace_id} limit 1
    `;
    const wsInfo = workspaceRows[0];
    if (!wsInfo) {
      throw new Error("Workspace not found");
    }
    // Connectors skip files the intake policy rejects instead of failing the sync.
    const skip = (verdict: Extract<IntakeFileVerdict, { ok: false }>) => {
      filesSkipped++;
      skippedReasons.add(verdict.reason === "parser-surface" ? verdict.message : verdict.reason);
    };

    async function* connectorItems(): AsyncGenerator<WorkspaceIntakeItem> {
      for (const file of files) {
        const declared = screenIntakeFile(
          { filename: file.name, mimeType: file.mimeType, sizeBytes: file.size },
          "connector-sync",
        );
        if (!declared.ok) {
          skip(declared);
          continue;
        }

        // Check if we already have this file (by connector file id or path)
        const existing = await sql`
          select id, metadata->>'connectorEtag' as etag from documents
          where workspace_id = ${row.workspace_id}
            and (metadata->>'connectorFileId' = ${file.id} or metadata->>'connectorPath' = ${file.path})
          limit 1
        `;

        if (existing.length > 0) {
          const existingDoc = existing[0] as { id: string; etag: string | null };
          if (existingDoc.etag && existingDoc.etag === file.etag) {
            continue; // unchanged
          }
          filesUpdated++;
        } else {
          filesAdded++;
        }

        const bytes = await adapter.downloadFile(config, credentials, file);
        const downloaded = screenIntakeFile(
          { filename: file.name, mimeType: file.mimeType, sizeBytes: bytes.length },
          "connector-sync",
        );
        if (!downloaded.ok) {
          skip(downloaded);
          continue;
        }

        yield {
          filename: downloaded.filename,
          mimeType: downloaded.mimeType,
          content: { bytes },
          metadata: {
            connectorId: row.id,
            connectorType: row.type,
            connectorFileId: file.id,
            connectorPath: file.path,
            connectorEtag: file.etag ?? null,
            remoteFetchedAt: new Date().toISOString(),
          },
        };
      }
    }

    await intakeIntoWorkspace({
      userId: wsInfo.user_id,
      orgId: wsInfo.org_id,
      workspaceId: row.workspace_id,
      pipeline: wsInfo.pipeline ?? defaultPipelineFeatures,
      kind: "connector-sync",
      items: connectorItems(),
      mayBeEmpty: true,
      audit: {
        metadata: {
          connectorId: row.id,
          connectorType: row.type,
          syncLogId,
        },
      },
    });

    await sql`
      update connector_sync_log
      set
        status = 'completed',
        finished_at = now(),
        files_added = ${filesAdded},
        files_updated = ${filesUpdated},
        error_message = ${filesSkipped > 0 ? `${filesSkipped} file(s) skipped: ${[...skippedReasons].join(" ")}` : null}
      where id = ${syncLogId}
    `;
    await sql`
      update workspace_connectors set last_sync_at = now(), status = 'active', updated_at = now()
      where id = ${row.id}
    `;
  } catch (error) {
    reportPublicError(error);
    await sql`
      update connector_sync_log
      set status = 'failed', finished_at = now(), files_added = ${filesAdded}, files_updated = ${filesUpdated},
          error_message = ${error instanceof Error ? error.message : String(error)}
      where id = ${syncLogId}
    `;
    await sql`
      update workspace_connectors set status = 'error', updated_at = now() where id = ${row.id}
    `;
    throw error;
  }
}

export const connectorsRoutes = new Hono()
  // List connectors for a workspace
  .get("/:workspaceId/connectors", async (c) => {
    const userId = c.get("sessionUser").id;
    const workspaceId = c.req.param("workspaceId");
    const access = await requireConnectorAccess(workspaceId, userId);
    if (!access.ok) {
      return apiErrorResponse(c, access.status, access.code, access.message);
    }

    const rows = await sql<ConnectorRow[]>`
      select id, workspace_id, type, name, credentials_encrypted, config, status, last_sync_at, created_at, updated_at
      from workspace_connectors
      where workspace_id = ${workspaceId}
      order by created_at asc
    `;

    return c.json({ connectors: rows.map(rowToConnector) });
  })

  // Get health status for all connectors in a workspace
  .get("/:workspaceId/connectors/health", async (c) => {
    const userId = c.get("sessionUser").id;
    const workspaceId = c.req.param("workspaceId");
    const access = await requireConnectorAccess(workspaceId, userId);
    if (!access.ok) {
      return apiErrorResponse(c, access.status, access.code, access.message);
    }

    const health = await sql`
      select
        wc.id,
        wc.name,
        wc.type,
        wc.status,
        wc.last_sync_at,
        extract(epoch from (now() - wc.last_sync_at))::int as lag_seconds,
        count(case when csl.status = 'failed' and csl.started_at > now() - interval '7 days' then 1 end)::int as consecutive_failures,
        count(case when csl.status = 'running' then 1 end)::int as active_syncs
      from workspace_connectors wc
      left join connector_sync_log csl on csl.connector_id = wc.id
      where wc.workspace_id = ${workspaceId}
      group by wc.id, wc.name, wc.type, wc.status, wc.last_sync_at
      order by wc.created_at asc
    `;

    return c.json({ health });
  })

  // Get a single connector
  .get("/:workspaceId/connectors/:connectorId", async (c) => {
    const userId = c.get("sessionUser").id;
    const { workspaceId, connectorId } = c.req.param();
    const access = await requireConnectorAccess(workspaceId, userId);
    if (!access.ok) {
      return apiErrorResponse(c, access.status, access.code, access.message);
    }

    const rows = await sql<ConnectorRow[]>`
      select id, workspace_id, type, name, credentials_encrypted, config, status, last_sync_at, created_at, updated_at
      from workspace_connectors
      where id = ${connectorId} and workspace_id = ${workspaceId}
    `;

    if (rows.length === 0) return apiStatusError(c, 404, "Connector not found");
    return c.json({ connector: rowToConnector(rows[0]!) });
  })

  // Create a connector
  .post("/:workspaceId/connectors", zValidator("json", createConnectorSchema, connectorValidationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const workspaceId = c.req.param("workspaceId");
    const body = c.req.valid("json");
    const access = await requireConnectorAccess(workspaceId, userId);
    if (!access.ok) {
      return apiErrorResponse(c, access.status, access.code, access.message);
    }

    const credentialsEncrypted = encryptCredentials(body.credentials);

    const rows = await sql<ConnectorRow[]>`
      insert into workspace_connectors (id, workspace_id, type, name, credentials_encrypted, config, status)
      values (${randomUUID()}, ${workspaceId}, ${body.type}, ${body.name}, ${credentialsEncrypted}, ${sql.json(toSqlJson(body.config))}, 'active')
      returning id, workspace_id, type, name, credentials_encrypted, config, status, last_sync_at, created_at, updated_at
    `;

    return c.json({ connector: rowToConnector(rows[0]!) }, 201);
  })

  // Update a connector
  .patch("/:workspaceId/connectors/:connectorId", zValidator("json", updateConnectorSchema, connectorValidationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const { workspaceId, connectorId } = c.req.param();
    const body = c.req.valid("json");
    const access = await requireConnectorAccess(workspaceId, userId);
    if (!access.ok) {
      return apiErrorResponse(c, access.status, access.code, access.message);
    }

    const now = new Date().toISOString();
    if (body.name !== undefined) {
      await sql`update workspace_connectors set name = ${body.name}, updated_at = ${now} where id = ${connectorId} and workspace_id = ${workspaceId}`;
    }
    if (body.credentials !== undefined) {
      const enc = encryptCredentials(body.credentials);
      await sql`update workspace_connectors set credentials_encrypted = ${enc}, updated_at = ${now} where id = ${connectorId} and workspace_id = ${workspaceId}`;
    }
    if (body.config !== undefined) {
      await sql`update workspace_connectors set config = ${sql.json(toSqlJson(body.config))}, updated_at = ${now} where id = ${connectorId} and workspace_id = ${workspaceId}`;
    }
    if (body.status !== undefined) {
      await sql`update workspace_connectors set status = ${body.status}, updated_at = ${now} where id = ${connectorId} and workspace_id = ${workspaceId}`;
    }

    const rows = await sql<ConnectorRow[]>`
      select id, workspace_id, type, name, credentials_encrypted, config, status, last_sync_at, created_at, updated_at
      from workspace_connectors
      where id = ${connectorId} and workspace_id = ${workspaceId}
    `;

    if (rows.length === 0) return apiStatusError(c, 404, "Connector not found");
    return c.json({ connector: rowToConnector(rows[0]!) });
  })

  // Delete a connector
  .delete("/:workspaceId/connectors/:connectorId", async (c) => {
    const userId = c.get("sessionUser").id;
    const { workspaceId, connectorId } = c.req.param();
    const access = await requireConnectorAccess(workspaceId, userId);
    if (!access.ok) {
      return apiErrorResponse(c, access.status, access.code, access.message);
    }

    await sql`delete from workspace_connectors where id = ${connectorId} and workspace_id = ${workspaceId}`;
    return c.json({ deleted: true });
  })

  // Trigger a sync for a connector
  .post("/:workspaceId/connectors/:connectorId/sync", async (c) => {
    const userId = c.get("sessionUser").id;
    const { workspaceId, connectorId } = c.req.param();
    const access = await requireConnectorAccess(workspaceId, userId);
    if (!access.ok) {
      return apiErrorResponse(c, access.status, access.code, access.message);
    }

    const rows = await sql<ConnectorRow[]>`
      select id, workspace_id, type, name, credentials_encrypted, config, status, last_sync_at, created_at, updated_at
      from workspace_connectors
      where id = ${connectorId} and workspace_id = ${workspaceId}
    `;

    if (rows.length === 0) return apiStatusError(c, 404, "Connector not found");
    const row = rows[0]!;
    if (row.status === "paused") return apiStatusError(c, 400, "Connector is paused");

    const syncLogId = randomUUID();
    const inserted = await sql`
      insert into connector_sync_log (id, connector_id, started_at, status)
      select ${syncLogId}, ${connectorId}, now(), 'running'
      where not exists (
        select 1 from connector_sync_log
        where connector_id = ${connectorId} and status = 'running'
      )
      returning id
    `;
    if (inserted.length === 0) {
      return apiStatusError(c, 409, "A sync is already running for this connector");
    }

    // Kick off sync asynchronously
    void runConnectorSync(row, syncLogId).catch(async (err) => {
      console.error(`[connector-sync] connector=${connectorId} error=${err instanceof Error ? err.message : String(err)}`);
    });

    return c.json({ syncLogId, status: "running" }, 202);
  })

  // Get sync history for a connector
  .get("/:workspaceId/connectors/:connectorId/history", async (c) => {
    const userId = c.get("sessionUser").id;
    const { workspaceId, connectorId } = c.req.param();
    const access = await requireConnectorAccess(workspaceId, userId);
    if (!access.ok) {
      return apiErrorResponse(c, access.status, access.code, access.message);
    }

    const limit = Math.min(100, parseInt(c.req.query("limit") ?? "20", 10));
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    const logs = await sql`
      select csl.id, csl.connector_id, csl.started_at, csl.finished_at, csl.status,
             csl.files_added, csl.files_updated, csl.files_deleted, csl.error_message, csl.cost_cents
      from connector_sync_log csl
      join workspace_connectors wc on wc.id = csl.connector_id
      where csl.connector_id = ${connectorId}
        and wc.workspace_id = ${workspaceId}
      order by csl.started_at desc
      limit ${limit} offset ${offset}
    `;

    return c.json({ history: logs.map(log => ({ ...log, error_message: log.error_message ? PUBLIC_ERROR_MESSAGES.processing : null })) });
  });
