import { z } from "zod";

// Connector types with a registered sync adapter. The API registry is typed as
// Record<ConnectorType, ConnectorAdapter>, so adding a type here without an
// adapter (or vice versa) fails typecheck. Only list types that can sync.
export const connectorTypes = ["s3", "google-drive", "notion", "confluence"] as const;
export const connectorTypeSchema = z.enum(connectorTypes);
export type ConnectorType = z.infer<typeof connectorTypeSchema>;

export const connectorStatusSchema = z.enum([
  "active",
  "paused",
  "error",
  "pending_auth",
]);
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;

// Per-type credential schemas (unencrypted at schema level, encrypted in DB)
export const s3CredentialsSchema = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  region: z.string().default("us-east-1"),
  sessionToken: z.string().optional(),
});

export const googleDriveCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
});

export const notionCredentialsSchema = z.object({
  integrationToken: z.string().min(1),
});

export const confluenceCredentialsSchema = z.object({
  baseUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
});

// Per-type config schemas (non-sensitive options)
export const s3ConfigSchema = z.object({
  bucket: z.string().min(1),
  prefix: z.string().default(""),
  fileExtensions: z.array(z.string()).default([]),
  endpoint: z.string().url().optional(),
});

export const googleDriveConfigSchema = z.object({
  folderId: z.string().optional(),
  includeSharedDrives: z.boolean().default(false),
  fileExtensions: z.array(z.string()).default([]),
});

export const notionConfigSchema = z.object({
  databaseId: z.string().optional(),
  includePages: z.boolean().default(true),
  includeDatabases: z.boolean().default(true),
});

export const confluenceConfigSchema = z.object({
  spaceKey: z.string().min(1),
  contentType: z.enum(["page", "blogpost", "all"]).default("all"),
  labelFilter: z.array(z.string()).default([]),
});

export const connectorCredentialsSchema = z.union([
  s3CredentialsSchema,
  googleDriveCredentialsSchema,
  notionCredentialsSchema,
  confluenceCredentialsSchema,
]);

export const connectorConfigSchema = z.union([
  s3ConfigSchema,
  googleDriveConfigSchema,
  notionConfigSchema,
  confluenceConfigSchema,
]);

// Main connector record schema
export const workspaceConnectorSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  type: connectorTypeSchema,
  name: z.string().min(1).max(120),
  status: connectorStatusSchema.default("active"),
  config: z.record(z.string(), z.unknown()).default({}),
  lastSyncAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceConnector = z.infer<typeof workspaceConnectorSchema>;

export const createConnectorSchema = z.object({
  type: connectorTypeSchema,
  name: z.string().min(1).max(120),
  credentials: z.record(z.string(), z.unknown()),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type CreateConnectorInput = z.infer<typeof createConnectorSchema>;

export const updateConnectorSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  status: connectorStatusSchema.optional(),
});
export type UpdateConnectorInput = z.infer<typeof updateConnectorSchema>;

// FileRef returned by connector adapters
export const fileRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  modifiedAt: z.string().optional(),
  etag: z.string().optional(),
});
export type FileRef = z.infer<typeof fileRefSchema>;
