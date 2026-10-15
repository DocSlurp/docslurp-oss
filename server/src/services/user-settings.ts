import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { sql } from "../db.js";
import { getRequiredEncryptionKey } from "../lib/encryption.js";

const generalSettingsSchema = z.object({
  enableGraphRag: z.boolean().default(false),
  enableSummarization: z.boolean().default(false),
  contextualChunking: z.boolean().default(true),
  piiReviewMode: z.boolean().default(false),
  defaultAnswerStyle: z.enum(["concise", "balanced", "detailed"]).default("balanced"),
});

export const updateGeneralSettingsSchema = generalSettingsSchema.partial();

export const mcpAuthTypeSchema = z.enum(["anonymous", "header-token", "oauth2.1"]);
export const mcpTransportSchema = z.enum(["streamable-http", "sse"]);
export const mcpStatusSchema = z.enum(["connected", "disabled", "needs_auth", "error", "refreshing"]);

const httpsUrlSchema = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" || parsed.protocol === "http:";
}, "Only HTTP and HTTPS MCP servers are supported.");

export const createMcpServiceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  url: httpsUrlSchema,
  transport: mcpTransportSchema.default("streamable-http"),
  authType: mcpAuthTypeSchema.default("anonymous"),
  headerName: z.string().trim().min(1).max(80).default("Authorization"),
  token: z.string().trim().max(4096).optional(),
  oauthIssuer: z.string().url().optional(),
  oauthClientId: z.string().trim().max(240).optional(),
  scopes: z.array(z.string().trim().min(1).max(120)).max(24).default([]),
});

export const updateMcpServiceSchema = createMcpServiceSchema.partial().extend({
  status: mcpStatusSchema.optional(),
});

export type UserGeneralSettings = z.infer<typeof generalSettingsSchema>;
export type CreateMcpServiceInput = z.infer<typeof createMcpServiceSchema>;
export type UpdateMcpServiceInput = z.infer<typeof updateMcpServiceSchema>;

export interface UserSettings {
  userId: string;
  general: UserGeneralSettings;
  updatedAt: string;
}

export interface McpServiceConnection {
  id: string;
  userId: string;
  name: string;
  url: string;
  transport: z.infer<typeof mcpTransportSchema>;
  authType: z.infer<typeof mcpAuthTypeSchema>;
  status: z.infer<typeof mcpStatusSchema>;
  headerName: string | null;
  oauthIssuer: string | null;
  oauthClientId: string | null;
  scopes: string[];
  tokenConfigured: boolean;
  oauthVersion: "2.1";
  lastCheckedAt: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type UserSettingsRow = {
  user_id: string;
  general: Record<string, unknown> | null;
  updated_at: string;
};

type McpServiceRow = {
  id: string;
  user_id: string;
  name: string;
  url: string;
  transport: string;
  auth_type: string;
  status: string;
  credentials_encrypted: string;
  config: Record<string, unknown> | null;
  last_checked_at: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

function getEncryptionKey(): Buffer {
  return getRequiredEncryptionKey("CREDENTIALS_ENCRYPTION_KEY");
}

function encryptCredentials(credentials: Record<string, unknown>): string {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptCredentials(value: string): Record<string, unknown> {
  if (!value) return {};

  const [ivHex, tagHex, ciphertextHex] = value.split(":");
  if (!ivHex || !tagHex || !ciphertextHex) return {};

  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as Record<string, unknown>;
}

function normalizeGeneral(value: unknown): UserGeneralSettings {
  return generalSettingsSchema.parse(value ?? {});
}

function mapSettings(row: UserSettingsRow): UserSettings {
  return {
    userId: row.user_id,
    general: normalizeGeneral(row.general),
    updatedAt: row.updated_at,
  };
}

function mapMcpService(row: McpServiceRow): McpServiceConnection {
  const config = row.config ?? {};
  let tokenConfigured = Boolean(config.tokenConfigured);
  if (!tokenConfigured && row.credentials_encrypted) {
    try {
      tokenConfigured = Boolean(decryptCredentials(row.credentials_encrypted).token);
    } catch {
      tokenConfigured = true;
    }
  }

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    url: row.url,
    transport: mcpTransportSchema.parse(row.transport),
    authType: mcpAuthTypeSchema.parse(row.auth_type),
    status: mcpStatusSchema.parse(row.status),
    headerName: typeof config.headerName === "string" ? config.headerName : null,
    oauthIssuer: typeof config.oauthIssuer === "string" ? config.oauthIssuer : null,
    oauthClientId: typeof config.oauthClientId === "string" ? config.oauthClientId : null,
    scopes: Array.isArray(config.scopes) ? config.scopes.filter((scope): scope is string => typeof scope === "string") : [],
    tokenConfigured,
    oauthVersion: "2.1",
    lastCheckedAt: row.last_checked_at,
    tokenExpiresAt: row.token_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serviceConfig(input: Pick<CreateMcpServiceInput, "authType" | "headerName" | "oauthIssuer" | "oauthClientId" | "scopes">) {
  return {
    headerName: input.authType === "header-token" ? input.headerName : null,
    oauthIssuer: input.authType === "oauth2.1" ? input.oauthIssuer ?? null : null,
    oauthClientId: input.authType === "oauth2.1" ? input.oauthClientId ?? null : null,
    scopes: input.scopes,
    tokenConfigured: input.authType === "header-token",
    oauthVersion: "2.1",
  };
}

export async function getUserSettings(userId: string): Promise<UserSettings> {
  const [row] = await sql<UserSettingsRow[]>`
    insert into user_settings (user_id)
    values (${userId})
    on conflict (user_id) do update set updated_at = user_settings.updated_at
    returning user_id, general, updated_at::text
  `;

  return mapSettings(row);
}

export async function updateUserSettings(
  userId: string,
  generalUpdates: Partial<UserGeneralSettings>,
): Promise<UserSettings> {
  const current = await getUserSettings(userId);
  const nextGeneral = normalizeGeneral({
    ...current.general,
    ...generalUpdates,
  });

  const [row] = await sql<UserSettingsRow[]>`
    insert into user_settings (user_id, general, updated_at)
    values (${userId}, ${sql.json(nextGeneral)}, now())
    on conflict (user_id) do update
    set general = excluded.general, updated_at = now()
    returning user_id, general, updated_at::text
  `;

  return mapSettings(row);
}

export async function listMcpServiceConnections(userId: string): Promise<McpServiceConnection[]> {
  const rows = await sql<McpServiceRow[]>`
    select
      id,
      user_id,
      name,
      url,
      transport,
      auth_type,
      status,
      credentials_encrypted,
      config,
      last_checked_at::text,
      token_expires_at::text,
      created_at::text,
      updated_at::text
    from mcp_service_connections
    where user_id = ${userId}
    order by created_at asc
  `;

  return rows.map(mapMcpService);
}

export async function createMcpServiceConnection(
  userId: string,
  input: CreateMcpServiceInput,
): Promise<McpServiceConnection> {
  const credentialsEncrypted =
    input.authType === "header-token" && input.token
      ? encryptCredentials({ token: input.token })
      : "";
  const status = input.authType === "oauth2.1" ? "needs_auth" : "connected";
  const [row] = await sql<McpServiceRow[]>`
    insert into mcp_service_connections (
      id,
      user_id,
      name,
      url,
      transport,
      auth_type,
      status,
      credentials_encrypted,
      config,
      last_checked_at
    )
    values (
      ${randomUUID()},
      ${userId},
      ${input.name},
      ${input.url},
      ${input.transport},
      ${input.authType},
      ${status},
      ${credentialsEncrypted},
      ${sql.json(serviceConfig(input))},
      now()
    )
    returning
      id,
      user_id,
      name,
      url,
      transport,
      auth_type,
      status,
      credentials_encrypted,
      config,
      last_checked_at::text,
      token_expires_at::text,
      created_at::text,
      updated_at::text
  `;

  return mapMcpService(row);
}

export async function updateMcpServiceConnection(
  userId: string,
  serviceId: string,
  input: UpdateMcpServiceInput,
): Promise<McpServiceConnection | null> {
  const [current] = await sql<McpServiceRow[]>`
    select
      id,
      user_id,
      name,
      url,
      transport,
      auth_type,
      status,
      credentials_encrypted,
      config,
      last_checked_at::text,
      token_expires_at::text,
      created_at::text,
      updated_at::text
    from mcp_service_connections
    where id = ${serviceId} and user_id = ${userId}
    limit 1
  `;
  if (!current) return null;

  const currentMapped = mapMcpService(current);
  const nextAuthType = input.authType ?? currentMapped.authType;
  const nextConfigInput = {
    authType: nextAuthType,
    headerName: input.headerName ?? currentMapped.headerName ?? "Authorization",
    oauthIssuer: input.oauthIssuer ?? currentMapped.oauthIssuer ?? undefined,
    oauthClientId: input.oauthClientId ?? currentMapped.oauthClientId ?? undefined,
    scopes: input.scopes ?? currentMapped.scopes,
  };
  const credentialsEncrypted =
    nextAuthType === "header-token" && input.token
      ? encryptCredentials({ token: input.token })
      : current.credentials_encrypted;

  const [row] = await sql<McpServiceRow[]>`
    update mcp_service_connections
    set
      name = ${input.name ?? current.name},
      url = ${input.url ?? current.url},
      transport = ${input.transport ?? current.transport},
      auth_type = ${nextAuthType},
      status = ${input.status ?? (nextAuthType === "oauth2.1" ? current.status : "connected")},
      credentials_encrypted = ${credentialsEncrypted},
      config = ${sql.json(serviceConfig(nextConfigInput))},
      updated_at = now()
    where id = ${serviceId} and user_id = ${userId}
    returning
      id,
      user_id,
      name,
      url,
      transport,
      auth_type,
      status,
      credentials_encrypted,
      config,
      last_checked_at::text,
      token_expires_at::text,
      created_at::text,
      updated_at::text
  `;

  return row ? mapMcpService(row) : null;
}

export async function deleteMcpServiceConnection(userId: string, serviceId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    delete from mcp_service_connections
    where id = ${serviceId} and user_id = ${userId}
    returning id
  `;
  return rows.length > 0;
}

export async function refreshMcpServiceConnection(
  userId: string,
  serviceId: string,
): Promise<McpServiceConnection | null> {
  const [row] = await sql<McpServiceRow[]>`
    update mcp_service_connections
    set
      status = case
        when auth_type = 'oauth2.1' and token_expires_at is null then 'needs_auth'
        when status = 'disabled' then 'disabled'
        else 'connected'
      end,
      last_checked_at = now(),
      updated_at = now()
    where id = ${serviceId} and user_id = ${userId}
    returning
      id,
      user_id,
      name,
      url,
      transport,
      auth_type,
      status,
      credentials_encrypted,
      config,
      last_checked_at::text,
      token_expires_at::text,
      created_at::text,
      updated_at::text
  `;

  return row ? mapMcpService(row) : null;
}
