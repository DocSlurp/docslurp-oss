import { z } from "zod";

/**
 * Estimate tools: one per work-creating operation, each forwarding the same body
 * its mutation takes to the matching `POST …/estimate` route. They never start
 * work or spend credits, so an agent can price a change before asking for approval.
 */

const WORKSPACE_REF = 'Optional workspace ID, slug or name (names match by slug). Omit for the organization default workspace.';
const workspace = { type: "string", minLength: 1, maxLength: 256, description: WORKSPACE_REF };
const freeObject = { type: "object", additionalProperties: true };

export const ESTIMATE_TOOL_NAMES = [
  "updateEstimate",
  "searchSettingsEstimate",
  "reprocessEstimate",
  "fullIndexEstimate",
  "indexingModeEstimate",
  "graphRebuildEstimate",
  "uploadEstimate",
] as const;
export type EstimateToolName = (typeof ESTIMATE_TOOL_NAMES)[number];

/**
 * Who may use each estimate tool: exactly the callers that may perform the mutation it prices. Session-only
 * means the mutation (and its estimate route) accepts no API key, so key-authenticated MCP never offers the tool.
 */
type EstimateAccess = { sessionOnly: true } | { scopes: readonly string[]; server?: boolean };
export const ESTIMATE_TOOL_ACCESS: Record<EstimateToolName, EstimateAccess> = {
  "updateEstimate": { scopes: ["workspaces:manage"], server: true },
  "searchSettingsEstimate": { sessionOnly: true },
  "reprocessEstimate": { scopes: ["ingest"], server: true },
  "fullIndexEstimate": { scopes: ["ingest"] },
  "indexingModeEstimate": { scopes: ["workspaces:manage"], server: true },
  "graphRebuildEstimate": { scopes: ["workspaces:manage"], server: true },
  "uploadEstimate": { scopes: ["ingest"] },
};

/** Whether an API key (scopes and type) may use the estimate tool. */
export function apiKeyMayUseEstimateTool(name: EstimateToolName, key: { scopes: readonly string[]; keyType?: string }): boolean {
  const access = ESTIMATE_TOOL_ACCESS[name];
  if ("sessionOnly" in access) return false;
  if (access.server && key.keyType !== "server") return false;
  return access.scopes.some((scope) => key.scopes.includes(scope));
}

export const estimateToolDefinitions: Array<{ name: EstimateToolName; title: string; description: string; inputSchema: Record<string, unknown> }> = [
  { name: "updateEstimate", title: "Estimate workspace settings cost", description: "Impact kind and cost of PATCHing workspace settings (pipeline, embedding, chat...), including the re-index it would queue. Read-only; nothing is applied.", inputSchema: {
    type: "object", properties: { workspace, changes: { ...freeObject, description: "The PATCH body you intend to send, for example { pipeline: {...}, apply: \"reindex\" }." } }, required: ["changes"] } },
  { name: "searchSettingsEstimate", title: "Estimate search settings cost", description: "Impact and cost of changing a workspace's search settings. Read-only.", inputSchema: {
    type: "object", properties: { workspace, changes: { ...freeObject, description: "The search-settings PATCH body." } }, required: ["changes"] } },
  { name: "reprocessEstimate", title: "Estimate reprocessing cost", description: "Cost of re-running a run, optionally from a stage. Read-only.", inputSchema: {
    type: "object", properties: { runId: { type: "string", minLength: 1 }, stages: { type: "array", items: { type: "string" } }, stageFrom: { type: "string" } }, required: ["runId"] } },
  { name: "fullIndexEstimate", title: "Estimate full indexing cost", description: "Cost of fully indexing a deferred workspace, listed documents, or one document (documentId). Read-only.", inputSchema: {
    type: "object", properties: { workspace, documentId: { type: "string", minLength: 1 }, documentIds: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 500 } } } },
  { name: "indexingModeEstimate", title: "Estimate indexing mode cost", description: "Cost of switching a workspace to full, map or visual indexing. Read-only.", inputSchema: {
    type: "object", properties: { workspace, mode: { type: "string", enum: ["full", "map", "visual"] } }, required: ["mode"] } },
  { name: "graphRebuildEstimate", title: "Estimate graph rebuild cost", description: "Cost of rebuilding the workspace knowledge graph. Read-only.", inputSchema: {
    type: "object", properties: { workspace } } },
  { name: "uploadEstimate", title: "Estimate upload cost", description: "Cost of ingesting files before any bytes are sent. Pass page counts when known; otherwise pages are estimated from size. Audio and video are priced by duration: pass durationSeconds (or the MIME type) and read `media` for their credits and the cheaper audio-track-only option.", inputSchema: {
    type: "object", properties: { workspace, files: { type: "array", minItems: 1, maxItems: 500, items: {
      type: "object", properties: { name: { type: "string", minLength: 1 }, size: { type: "integer", minimum: 0 }, pages: { type: "integer", minimum: 0 }, type: { type: "string" }, durationSeconds: { type: "number", exclusiveMinimum: 0 } }, required: ["name", "size"] } } }, required: ["files"] } },
];

export const jobsGetToolDefinition = {
  id: "getJob", title: "Check background job",
  description: "Read a background job (re-index, full-index, graph rebuild, reprocess) by ID: status (queued, blocked, processing, completed, failed, cancelled), blocked reason, queue position, runs and estimate. Poll on a later turn if unfinished.",
  inputSchema: { type: "object", properties: { jobId: { type: "string", minLength: 1 } }, required: ["jobId"] },
};
export const jobsGetInputSchema = z.object({ jobId: z.string().min(1).max(256) });

const common = { workspace: z.string().min(1).max(256).optional() };
const inputSchemas: Record<EstimateToolName, z.ZodType<Record<string, unknown>>> = {
  "updateEstimate": z.object({ ...common, changes: z.record(z.string(), z.unknown()) }),
  "searchSettingsEstimate": z.object({ ...common, changes: z.record(z.string(), z.unknown()) }),
  "reprocessEstimate": z.object({ runId: z.string().min(1), stages: z.array(z.string()).min(1).optional(), stageFrom: z.string().optional() }),
  "fullIndexEstimate": z.object({ ...common, documentId: z.string().min(1).optional(), documentIds: z.array(z.string().min(1)).max(500).optional() }),
  "indexingModeEstimate": z.object({ ...common, mode: z.enum(["full", "map", "visual"]) }),
  "graphRebuildEstimate": z.object({ ...common }),
  "uploadEstimate": z.object({ ...common, files: z.array(z.object({ name: z.string().min(1), size: z.number().int().min(0), pages: z.number().int().min(0).optional(), type: z.string().max(255).optional(), durationSeconds: z.number().positive().max(24 * 3600).optional() })).min(1).max(500) }),
};

export function isEstimateToolName(name: string): name is EstimateToolName {
  return (ESTIMATE_TOOL_NAMES as readonly string[]).includes(name);
}

export type EstimatePlan = { path: string; body: Record<string, unknown>; workspaceRef?: string };

/** Validates tool input and maps it to the estimate route and its mutation-identical body. `workspace` is the already-resolved workspace id. */
export function planEstimateTool(
  name: EstimateToolName,
  input: unknown,
  workspace: string,
): { ok: true; plan: EstimatePlan } | { ok: false; issues: z.core.$ZodIssue[] } {
  const parsed = inputSchemas[name].safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues };
  const data = parsed.data;
  const ws = `/v1/workspaces/${encodeURIComponent(workspace)}`;
  switch (name) {
    case "updateEstimate": return { ok: true, plan: { path: `${ws}/estimate`, body: data.changes as Record<string, unknown> } };
    case "searchSettingsEstimate": return { ok: true, plan: { path: `${ws}/search-settings/estimate`, body: data.changes as Record<string, unknown> } };
    case "reprocessEstimate": {
      const { runId, ...body } = data;
      return { ok: true, plan: { path: `/v1/runs/${encodeURIComponent(String(runId))}/reprocess/estimate`, body } };
    }
    case "fullIndexEstimate":
      return typeof data.documentId === "string"
        ? { ok: true, plan: { path: `/v1/documents/${encodeURIComponent(data.documentId)}/full-index/estimate`, body: {} } }
        : { ok: true, plan: { path: `${ws}/full-index/estimate`, body: data.documentIds ? { documentIds: data.documentIds } : {} } };
    case "indexingModeEstimate": return { ok: true, plan: { path: `${ws}/indexing-mode/estimate`, body: { mode: data.mode } } };
    case "graphRebuildEstimate": return { ok: true, plan: { path: `${ws}/graph/jobs/estimate`, body: {} } };
    case "uploadEstimate": return { ok: true, plan: { path: "/v1/uploads/estimate", body: { files: data.files, workspace } } };
  }
}

/** Whether the tool takes a workspace (so the caller resolves the default/slug first). */
export function estimateToolUsesWorkspace(name: EstimateToolName, input: unknown): boolean {
  if (name === "reprocessEstimate") return false;
  if (name === "fullIndexEstimate" && input && typeof input === "object" && typeof (input as { documentId?: unknown }).documentId === "string") return false;
  return true;
}
