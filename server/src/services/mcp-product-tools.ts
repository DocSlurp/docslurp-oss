import { z } from "zod";

export const workspaceRef = z.string().min(1).max(256).optional().describe('Workspace slug or UUID. Omit or use "default" for the organization default workspace.');
export const listWorkspacesInput = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
}).strict();
export const uploadInput = z.object({
  workspaceId: workspaceRef,
  workspaceName: z.string().trim().min(1).max(120).optional().describe("Create a new workspace with this name only when the user asks for one."),
  urls: z.array(z.url().refine(url => /^https?:\/\//i.test(url), "Use HTTP or HTTPS URLs")).min(1).max(20).optional(),
  files: z.array(z.object({
    filename: z.string().min(1).max(512),
    sizeBytes: z.number().int().positive().max(5 * 1024 ** 3),
    mimeType: z.string().min(1).max(256).describe("Content-Type to send with the signed PUT request."),
  }).strict()).min(1).max(10).optional(),
  idempotencyKey: z.string().min(1).max(200).optional().describe("For URL ingestion only: reuse the same key when retrying this exact request to avoid duplicate ingestion."),
}).strict().refine(value => Boolean(value.urls) !== Boolean(value.files), "Supply either urls or files, not both")
  .refine(value => !(value.workspaceId && value.workspaceName), "Choose an existing workspaceId or a new workspaceName");

export const completeUploadInput = z.object({
  sessionId: z.string().uuid(),
  fileIds: z.array(z.string().uuid()).min(1).max(10).refine(ids => new Set(ids).size === ids.length, "File IDs must be unique").describe("IDs returned by upload, after every corresponding PUT succeeds."),
}).strict();

export const productToolAliases: Record<string, string> = {
  search: "workspace.search",
  chat: "workspace.chat",
  getUploadStatus: "workspace.ingest-report",
  suggestQueries: "workspace.suggest",
};

export function productToolDefinitions(baseUrl: string) {
  return [
    { id: "listWorkspaces", title: "List workspaces", description: "List workspaces you can access, including their IDs, slugs, default workspace, document/page counts and latest processing status. Use a returned slug as workspaceId in upload, search or chat. Does not call AI.", inputSchema: z.toJSONSchema(listWorkspacesInput, { io: "input" }) },
    { id: "upload", title: "Upload documents", description: "Upload documents using either fetchable HTTP(S) urls or files metadata. For files, generate one presigned PUT URL per file, up to 10 files (5 GiB each, subject to account limits). PUT the raw bytes to each putUrl with the declared Content-Type, then call completeUpload with sessionId and file IDs. Never send file bytes or local paths as tool arguments. URLs start ingestion immediately; files start only on completion. Omit workspaceId for the default workspace; workspaceName explicitly creates a new one. Ingestion can incur cost. idempotencyKey applies to URL ingestion retries.", inputSchema: {
      ...z.toJSONSchema(uploadInput, { io: "input" }),
      oneOf: [{ required: ["urls"], not: { required: ["files"] } }, { required: ["files"], not: { required: ["urls"] } }],
      not: { required: ["workspaceId", "workspaceName"] },
    } },
    { id: "completeUpload", title: "Complete upload", description: "After all presigned PUT requests succeed, verify uploaded files and start ingestion. Pass sessionId and fileIds from upload. Returns workspace and run IDs for getUploadStatus. File size is verified before ingestion; do not call before uploading the bytes.", inputSchema: z.toJSONSchema(completeUploadInput) },
  ].map(tool => ({ ...tool, category: "tool", endpoint: `${baseUrl}/v1/mcp/tools/${tool.id}` }));
}
