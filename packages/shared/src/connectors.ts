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
  accessKeyId: z.string().min(1).max(8192),
  secretAccessKey: z.string().min(1).max(8192),
  region: z.string().default("us-east-1"),
  sessionToken: z.string().optional(),
});

export const googleDriveCredentialsSchema = z.object({
  clientId: z.string().min(1).max(8192),
  clientSecret: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192),
});

export const notionCredentialsSchema = z.object({
  integrationToken: z.string().min(1).max(8192),
});

export const confluenceCredentialsSchema = z.object({
  baseUrl: z.string().max(2048).url(),
  email: z.string().email(),
  apiToken: z.string().min(1).max(8192),
});

// Per-type config schemas (non-sensitive options)
export const s3ConfigSchema = z.object({
  bucket: z.string().min(1).max(8192),
  prefix: z.string().default(""),
  fileExtensions: z.array(z.string().max(256)).max(100).default([]),
  endpoint: z.string().max(2048).url().optional(),
});

export const googleDriveConfigSchema = z.object({
  folderId: z.string().optional(),
  includeSharedDrives: z.boolean().default(false),
  fileExtensions: z.array(z.string().max(256)).max(100).default([]),
});

export const notionConfigSchema = z.object({
  databaseId: z.string().optional(),
  includePages: z.boolean().default(true),
  includeDatabases: z.boolean().default(true),
});

export const confluenceConfigSchema = z.object({
  spaceKey: z.string().min(1).max(8192),
  contentType: z.enum(["page", "blogpost", "all"]).default("all"),
  labelFilter: z.array(z.string().max(256)).max(100).default([]),
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
  name: z.string().min(1).max(8192).max(120),
  status: connectorStatusSchema.default("active"),
  config: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 16384, "Connector settings must not exceed 16 KB").default({}),
  lastSyncAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceConnector = z.infer<typeof workspaceConnectorSchema>;

export const createConnectorSchema = z.object({
  type: connectorTypeSchema,
  name: z.string().min(1).max(8192).max(120),
  credentials: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 16384, "Connector settings must not exceed 16 KB"),
  config: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 16384, "Connector settings must not exceed 16 KB").default({}),
});
export type CreateConnectorInput = z.infer<typeof createConnectorSchema>;

export const updateConnectorSchema = z.object({
  name: z.string().min(1).max(8192).max(120).optional(),
  credentials: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 16384, "Connector settings must not exceed 16 KB").optional(),
  config: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 16384, "Connector settings must not exceed 16 KB").optional(),
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
