import { z } from "zod";
import {
  createOrganizationInviteSchema, createOrganizationSchema, defaultPipelineFeatures, organizationInviteSchema,
  organizationAccessSchema, organizationDetailsSchema, organizationMemberSchema,
  organizationMembershipSchema, organizationRoleSchema, organizationSchema,
  updateOrganizationSchema, workspaceRunProgressSnapshotSchema, workspaceStateSchema,
  applyIngestRecommendationSchema, ingestReportSchema,
} from "@docslurp/shared";
import { apiErrorOpenApiResponse } from "./api-error-openapi.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object, example?: unknown) => ({ "application/json": { schema, ...(example === undefined ? {} : { example }) } });
const response = (description: string, schema: object, example?: unknown) => ({ description, content: json(schema, example) });
const request = (schema: object, example?: unknown) => ({ required: true, content: json(schema, example) });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { unrepresentable: "any" });
const inputSchema = (value: z.ZodType) => z.toJSONSchema(value, { unrepresentable: "any", io: "input" });
const serviceSecurity = [{ bearerAuth: [] }, { sessionAuth: [] }];
const parameter = (name: string) => ({ in: "path", name, required: true, schema: { type: "string", minLength: 1 } });
/** `/v1/workspaces/{workspaceId}` takes any workspace reference; see docs/api-sdk.md#workspaces. */
export const workspaceRefDescription = 'Workspace UUID, current slug (e.g. "legal-contracts"), former slug (renamed workspaces keep resolving), or "default" for the organization default workspace. Session callers may add ?orgId= to pick the default workspace of another organization; API keys use their organization.';
export const workspaceRefParameter = { in: "path", name: "workspaceId", required: true, description: workspaceRefDescription, schema: { type: "string", minLength: 1, examples: ["default", "legal-contracts", "6f1c2a7e-0d4b-4c39-9a51-2f0e8b7d3c11"] } };
/** Sent when the path used a slug, former slug or "default". */
export const workspaceRefHeaders = {
  "X-DocSlurp-Workspace-Id": { description: "Resolved workspace UUID", schema: { type: "string" } },
  "X-DocSlurp-Workspace-Slug": { description: "Current workspace slug; prefer it in stored links", schema: { type: "string" } },
  "X-DocSlurp-Workspace-Renamed-From": { description: "Present when the path used a former slug; update stored links to X-DocSlurp-Workspace-Slug", schema: { type: "string" } },
};
const object = (properties: Record<string, object>) => ({ type: "object", required: Object.keys(properties), properties });
const array = (name: string) => ({ type: "array", items: ref(name) });
const ok = object({ ok: { const: true } });
const authErrors = {
  "401": apiErrorOpenApiResponse("Authentication required"),
  "403": apiErrorOpenApiResponse("Key scope/type or actor role does not authorize this operation"),
  "404": apiErrorOpenApiResponse("Resource not found or not accessible in the actor's organization"),
  "429": apiErrorOpenApiResponse(
    "Request rate limit exceeded. Polling consumes one read request per snapshot; an SSE connection consumes a read request when opened.",
    { "Retry-After": { description: "Seconds before retrying", schema: { type: "integer", minimum: 0 } } },
  ),
};
const mutationErrors = {
  ...authErrors,
  "400": apiErrorOpenApiResponse("Invalid JSON or request fields"),
  "409": apiErrorOpenApiResponse("Duplicate membership/slug, last-owner protection, or immutable personal membership. `error.code` is one of organization_conflict, membership_exists, last_owner, personal_organization."),
};
const orgRead = "Session membership or a server API key with organizations:read or organizations:manage, bound to this organization. Key scopes never grant more than the user's role.";
const orgManage = "Session authentication or an organization-bound server key with organizations:manage. Owners manage owner/admin roles; admins manage member/billing roles. Membership changes serialize authorization and last-owner checks. Personal memberships cannot be changed.";
const readScopes = "Session workspace access or an organization-bound key with any of ingest, search, artifacts.";

const organizationApiKeySchema = z.object({
  id: z.string(), userId: z.string(), orgId: z.string().nullable(), name: z.string(),
  keyType: z.enum(["server", "client"]), allowedDomains: z.array(z.string()), scopes: z.array(z.string()),
  rateLimitRpm: z.number(), rateLimitPpd: z.number(), lastUsedAt: z.string().nullable(),
  createdAt: z.string(), revokedAt: z.string().nullable(), requestsLastMinute: z.number().optional(), pagesToday: z.number().optional(),
});
export const stateManagementSchemas = {
  RunProgressSnapshot: schema(workspaceRunProgressSnapshotSchema),
  WorkspaceState: schema(workspaceStateSchema),
  IngestReport: schema(ingestReportSchema),
  IngestRecommendationAction: inputSchema(applyIngestRecommendationSchema),
  Organization: schema(organizationSchema),
  OrganizationAccess: schema(organizationAccessSchema),
  OrganizationDetails: schema(organizationDetailsSchema),
  OrganizationMember: schema(organizationMemberSchema),
  OrganizationMembership: schema(organizationMembershipSchema),
  CreateOrganization: inputSchema(createOrganizationSchema.omit({ userId: true })),
  UpdateOrganization: { ...inputSchema(updateOrganizationSchema), minProperties: 1 },
  CreateOrganizationInvite: inputSchema(createOrganizationInviteSchema),
  OrganizationInvite: schema(organizationInviteSchema),
  UpdateOrganizationMember: inputSchema(z.object({ role: organizationRoleSchema }).strict()),
  OrganizationApiKey: schema(organizationApiKeySchema),
};

export const runProgressExample = workspaceRunProgressSnapshotSchema.parse({
  run: { id: "run-123", userId: "user-123", orgId: "org-123", workspaceId: "workspace-123", workspaceName: "Research", kind: "bulk-upload",
    status: "queued", stage: "queued", totalDocuments: 1, processedDocuments: 0, pagesTotal: 3, pagesProcessed: 0,
    costCents: 0, pipeline: defaultPipelineFeatures, error: null,
    createdAt: "2026-10-06T12:00:00Z", updatedAt: "2026-10-06T12:00:00Z" },
  stages: [], recentEvents: [],
});
export const workspaceStateExample = workspaceStateSchema.parse({
  workspaceId: "workspace-123", orgId: "org-123", observedAt: "2026-10-06T12:00:00Z",
  recentWindow: { from: "2026-10-05T12:00:00Z", to: "2026-10-06T12:00:00Z", hours: 24 },
  documents: { total: 1, queued: 1, processing: 0, completed: 1, failed: 0, unknownPageCount: 0 },
  pages: { total: 3, indexed: 2, notIndexed: 1, basis: "text-searchable-unique-pages" },
  storage: { sourceBytes: 2_000_000, sourceMb: 2, textBytes: 1_500, textMb: 0.0015, documentsWithUnknownSize: 0, vectorBytes: null, artifactBytes: null, mbDivisor: 1_000_000 },
  runs: { total: 2, queued: 1, processing: 0, completed: 1, failed: 0 },
  searches: { total: 0, recentCount: 0, recentZeroResultCount: 0, latencyMs: { sampleCount: 0, p50: null, p95: null, max: null } },
  performance: { completedRuns: 1, failedRuns: 0, completedPages: 3, durationMs: { sampleCount: 1, p50: 60_000, p95: 60_000, max: 60_000 }, pagesPerMinute: 3, minutesPer100Pages: 100 / 3, basis: "run-wall-time-including-queue" },
  usage: { inputTokens: 100, outputTokens: 20, costCents: 0.005 },
});
const orgGet = (summary: string, name: string, description = orgRead) => ({
  tags: ["organizations"], summary, description, security: serviceSecurity, parameters: [parameter("orgId")],
  responses: { "200": response(summary, ref(name)), ...authErrors },
});

export const stateManagementPaths = {
  "/v1/runs/{runId}/progress": { get: {
    tags: ["runs"], summary: "Read full run progress", description: `${readScopes} Authoritative snapshot includes run/document/page counts, stage progress, usage, runtime, events, and artifacts. Stage progress may infer completion; it is not current workspace searchable-page coverage.`,
    security: serviceSecurity, parameters: [parameter("runId")],
    responses: { "200": response("Full run snapshot; non-streaming fallback for live progress", ref("RunProgressSnapshot"), runProgressExample), ...authErrors },
  } },
  "/v1/runs/{runId}/progress/stream": { get: {
    tags: ["runs"], summary: "Stream live run progress snapshots",
    description: `${readScopes} Emits an initial snapshot, coalesces notification bursts to at most one snapshot/second, reconciles at least every ten seconds, and sends heartbeat frames about every four seconds. Completed/failed/cancelled/dead-letter runs send a final snapshot and close; paused runs stay observable. Access is revalidated before each snapshot. No durable replay or Last-Event-ID contract. On unsupported/interrupted SSE, clients can poll GET /v1/runs/{runId}/progress with one overall deadline; the Node SDK transport:auto does this automatically. Recent events are omitted from progress-stream snapshots (recentEvents: []).`,
    security: serviceSecurity, parameters: [parameter("runId")],
    responses: { "200": { description: "SSE frames: snapshot = RunProgressSnapshot JSON, heartbeat = {}, error = {code:'access_revoked',error:string}, then close. Ingestion failure is a terminal snapshot, not an HTTP error.",
      headers: { "Cache-Control": { schema: { type: "string" }, example: "no-cache, no-transform" }, "X-Accel-Buffering": { schema: { type: "string" }, example: "no" } },
      content: { "text/event-stream": { schema: { type: "string" }, example: `event: snapshot\ndata: ${JSON.stringify(runProgressExample)}\n\nevent: heartbeat\ndata: {}\n\n` } },
      "x-sse-events": { snapshot: ref("RunProgressSnapshot"), heartbeat: object({}), error: object({ code: { const: "access_revoked" }, error: { type: "string" } }) },
    }, ...authErrors },
  } },
  "/v1/workspaces/{workspaceId}/state": { get: {
    tags: ["workspaces"], summary: "Read current workspace corpus and recent performance",
    description: `${readScopes} Requires a server key for bearer access. documents.total/completed, pages.total, and storage cover the current corpus: completed documents not superseded by a newer version, so a re-ingest never double counts. documents.queued/processing count in-flight documents in any non-terminal status; documents.failed counts failed documents. Pages indexed are unique nonempty text-searchable pages in completed current documents; notIndexed = known total minus indexed. Unknown page counts are counted separately. Source bytes are measured logical document bytes; documentsWithUnknownSize makes missing measurements explicit, so sourceMb can be a lower bound. Text bytes cover persisted page/chunk text, not physical object or index storage. MB = bytes/1,000,000; vector/artifact bytes are unknown (null). Searches include scalar and multi-workspace sessions. Recent search latency and completed-run wall-time distributions use the selected window. Run throughput includes queue time and reruns; corpus coverage never sums run history. Empty latency/throughput samples yield null. Usage is all-time attributed recorded usage, not a complete economic-price estimate.`,
    security: serviceSecurity, parameters: [workspaceRefParameter, { in: "query", name: "recentWindowHours", schema: { type: "integer", minimum: 1, maximum: 720, default: 24 } }],
    responses: { "200": { ...response("Current counts and storage, recent search/runtime distributions, and all-time usage", ref("WorkspaceState"), workspaceStateExample), headers: workspaceRefHeaders }, "400": apiErrorOpenApiResponse("recentWindowHours must be an integer from 1 to 720"), ...authErrors },
  } },
  "/v1/workspaces/{workspaceId}/ingest-report": { get: {
    tags: ["workspaces"], summary: "Read the ingest report: observed content, relevant settings and recommendations",
    description: `${readScopes} Requires a server key for bearer access. No model call. Covers the current corpus (completed or in-flight documents not superseded), or one run (runId) or up to 100 documents (documentIds, comma-separated), newest first and capped at ${500} files and 20,000 pages read page by page (scope.truncated). Reports files and pages by type and status; bytes per file and per page with a file-size histogram; plain-text bytes of each page's native text layer and of its indexed chunks (histograms with p50/p95, zero and near-zero text pages); images per page and scanned-looking pages (images with almost no text layer); vision outcome per page (extracted, not selected by page triage, past the per-file page limit, failed, stopped by the cost cap); searchable pages (a page with chunks) and a reason for each unsearchable page; skipped and failed stages; detected languages; audio/video counts; table-heavy pages; cost, pages per minute and pages per $1 (run wall time including queueing). Per-page text and image facts exist for files processed from ${"2026-10-14"}; older files report them as not recorded (coverage.note). config lists the pipeline settings that shaped the result; recommendations are deterministic rules with the evidence, the expected effect, an estimated cost per 100 future pages and to reprocess the affected files, and the pipeline patch a workspace editor can apply. permissions.canEdit is false for API keys.`,
    security: serviceSecurity,
    parameters: [workspaceRefParameter,
      { in: "query", name: "runId", schema: { type: "string", maxLength: 128 }, description: "Only documents of this run (in this workspace)." },
      { in: "query", name: "documentIds", schema: { type: "string" }, description: "Comma-separated document IDs (at most 100) in this workspace." }],
    responses: { "200": { ...response("Ingest report", ref("IngestReport")), headers: workspaceRefHeaders }, "400": apiErrorOpenApiResponse("More than 100 document IDs or an invalid runId"), ...authErrors },
  } },
  "/v1/workspaces/{workspaceId}/ingest-report/apply": { post: {
    tags: ["workspaces"], summary: "Apply an ingest report recommendation's setting change",
    description: "Dashboard session only; the caller must be able to edit the workspace (owner, org owner/admin, workspace admin/editor, or any member on the org default workspace). The server recomputes the report and merges the recommendation's own patch onto the stored pipeline through the regular workspace update (audit log workspace.updated with source ingest-report). The request names a recommendation; it cannot carry settings. 409 when the recommendation no longer applies or a workspace template locks the setting.",
    security: [{ sessionAuth: [] }], parameters: [workspaceRefParameter], requestBody: request(ref("IngestRecommendationAction"), { recommendationId: "vision-all-pages" }),
    responses: { "200": response("Applied patch and the resulting pipeline", object({ recommendationId: { type: "string" }, patch: { type: ["object", "null"] }, pipeline: { type: "object" } })), "400": apiErrorOpenApiResponse("Invalid request fields"), "409": apiErrorOpenApiResponse("Recommendation no longer applies or the setting is locked"), ...authErrors },
  } },
  "/v1/workspaces/{workspaceId}/ingest-report/reprocess": { post: {
    tags: ["workspaces"], summary: "Reprocess the files an ingest report recommendation affects",
    description: "Dashboard session only; workspace editors. Re-runs up to 100 of the recommendation's affected files as new versions with the workspace's current settings (budget caps apply). The report shows the estimated cost first (cost.reprocessCents).",
    security: [{ sessionAuth: [] }], parameters: [workspaceRefParameter], requestBody: request(ref("IngestRecommendationAction"), { recommendationId: "vision-all-pages" }),
    responses: { "201": response("Created runs", object({ runs: { type: "array", items: object({ id: { type: "string" } }) }, documentIds: { type: "array", items: { type: "string" } }, skippedDocuments: { type: "integer" }, estimatedCents: { type: ["number", "null"] } })), "400": apiErrorOpenApiResponse("Invalid request fields"), "409": apiErrorOpenApiResponse("Recommendation no longer applies or has no files to reprocess"), ...authErrors },
  } },
  "/v1/workspaces/{workspaceId}": {
    get: { tags: ["workspaces"], summary: "Read a workspace", description: `${readScopes} The record includes its slug and isDefault. Bearer keys are limited to their organization.`, security: serviceSecurity, parameters: [workspaceRefParameter],
      responses: { "200": { description: "Workspace record", headers: workspaceRefHeaders }, ...authErrors } },
    patch: { tags: ["workspaces"], summary: "Update a workspace, including renaming its slug", description: "Dashboard session, or a server API key with the opt-in workspaces:manage scope bound to the workspace organization (the key owner's workspace role still applies). slug must be 3-63 characters of lowercase letters, digits and single hyphens, must not look like a UUID, and must not be a reserved word (default, board, templates, invites, new, settings, api, app, admin, workspaces, search, docs). The previous slug keeps resolving to this workspace and can never be claimed by another workspace.", security: serviceSecurity, parameters: [workspaceRefParameter],
      requestBody: request({ type: "object", minProperties: 1, properties: { name: { type: "string", minLength: 1, maxLength: 120 }, slug: { type: "string", minLength: 3, maxLength: 63, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }, systemPrompt: { type: ["string", "null"], maxLength: 2000 }, monthlyBudgetCents: { type: ["integer", "null"], minimum: 0 } } }, { slug: "legal-contracts" }),
      responses: { "200": { description: "Updated workspace record", headers: workspaceRefHeaders }, "400": apiErrorOpenApiResponse("Invalid fields, malformed slug, or reserved slug"), "409": apiErrorOpenApiResponse("Slug is a current or former slug of another workspace"), ...authErrors } },
  },
  "/v1/organizations": {
    get: { tags: ["organizations"], summary: "List accessible organizations", description: `${orgRead} Session reads list memberships; a server key returns only its own organization.`, security: serviceSecurity,
      responses: { "200": response("Organizations", object({ organizations: array("Organization") })), ...authErrors } },
    post: { tags: ["organizations"], summary: "Create organization", description: "Session authentication only. Creates the organization and initial owner membership atomically. userId is derived from the authenticated session.", security: [{ sessionAuth: [] }], requestBody: request(ref("CreateOrganization"), { name: "Research", slug: "research" }),
      responses: { "201": response("Created organization", ref("Organization")), ...mutationErrors } },
  },
  "/v1/organizations/{orgId}": {
    get: orgGet("Read organization", "Organization"),
    patch: { tags: ["organizations"], summary: "Update organization name or slug", description: `${orgManage} Requires owner/admin role. Supply at least name or slug; null slug clears it. Identity, ownership, credits, and membership cannot be changed here.`, security: serviceSecurity,
      parameters: [parameter("orgId")], requestBody: request(ref("UpdateOrganization"), { name: "Research library", slug: null }), responses: { "200": response("Updated organization details", ref("OrganizationDetails")), ...mutationErrors } },
  },
  "/v1/organizations/{orgId}/details": { get: orgGet("Read organization details and counts", "OrganizationDetails", `${orgRead} Member count is organization-wide. Workspace count includes all organization workspaces for owners/admins; other roles see only owned or explicitly shared workspaces.`) },
  "/v1/organizations/{orgId}/access": { get: orgGet("Read current organization role and capabilities", "OrganizationAccess", `${orgRead} Capabilities reflect role, personal/last-owner invariants, and the current key scopes. A read-only organization key receives false mutation capabilities. Read permissions do not authorize member/key mutations.`) },
  "/v1/organizations/{orgId}/members": {
    get: { ...orgGet("List organization members", "OrganizationMember"), responses: { "200": response("Members with identity and role", object({ memberships: array("OrganizationMember") })), ...authErrors } },
  },
  "/v1/organizations/{orgId}/invites": {
    get: { ...orgGet("List organization invites", "OrganizationInvite", `${orgRead} Owner/admin role required. Never returns invite tokens.`), responses: { "200": response("Invites", object({ invites: array("OrganizationInvite") })), ...authErrors } },
    post: { tags: ["organizations"], summary: "Invite an email address to the organization", description: `${orgManage} Membership starts when a signed-in user with this verified email accepts the invite link; there is no way to add a user by ID. Admins can invite members and billing; only owners can invite owners and admins. An email that already belongs to a member returns 409. inviteUrl is returned once.`, security: serviceSecurity, parameters: [parameter("orgId")], requestBody: request(ref("CreateOrganizationInvite"), { email: "teammate@example.com", role: "member" }),
      responses: { "201": response("Pending invite and its one-time accept link", object({ invite: ref("OrganizationInvite"), inviteUrl: { type: "string", format: "uri" } })), ...mutationErrors } },
  },
  "/v1/organizations/{orgId}/invites/{inviteId}": {
    delete: { tags: ["organizations"], summary: "Revoke a pending organization invite", description: orgManage, security: serviceSecurity, parameters: [parameter("orgId"), parameter("inviteId")],
      responses: { "200": response("Revoked invite", ref("OrganizationInvite")), ...mutationErrors } },
  },
  "/v1/organizations/{orgId}/members/{memberUserId}": {
    patch: { tags: ["organizations"], summary: "Change organization member role", description: orgManage, security: serviceSecurity, parameters: [parameter("orgId"), parameter("memberUserId")], requestBody: request(ref("UpdateOrganizationMember"), { role: "admin" }),
      responses: { "200": response("Updated membership", ref("OrganizationMembership")), ...mutationErrors } },
    delete: { tags: ["organizations"], summary: "Remove organization membership", description: `${orgManage} Users may remove themselves unless personal or last owner. Removal revokes the user's organization-bound keys and MCP grants, transfers their workspaces to an organization owner, removes their workspace shares in the organization, and stops webhook deliveries for its workspaces.`, security: serviceSecurity, parameters: [parameter("orgId"), parameter("memberUserId")],
      responses: { "200": response("Membership removed", ok), ...mutationErrors } },
  },
  "/v1/organizations/{orgId}/leave": { post: {
    tags: ["organizations"], summary: "Leave organization", description: `${orgManage} Any member can leave, except personal memberships and the last owner. Revokes the user's organization-bound keys and MCP grants, hands their workspaces to an organization owner and removes their workspace shares in the organization.`, security: serviceSecurity, parameters: [parameter("orgId")],
    responses: { "200": response("Membership removed", ok), ...mutationErrors },
  } },
  "/v1/organizations/{orgId}/api-keys": {
    get: { ...orgGet("List organization API key metadata", "OrganizationApiKey", `${orgRead} Owner/admin role required. Includes active/revoked key metadata and usage counters; never returns token secrets.`), responses: { "200": response("Organization key metadata", object({ keys: array("OrganizationApiKey") })), ...authErrors } },
    delete: { tags: ["organizations"], summary: "Revoke all active organization API keys", description: `${orgManage} Owner/admin role required. Also revokes the caller's key if it belongs to this organization. No key secrets are returned.`, security: serviceSecurity, parameters: [parameter("orgId")],
      responses: { "200": response("Revoked key metadata and count", object({ keys: array("OrganizationApiKey"), revokedCount: { type: "integer", minimum: 0 } })), ...mutationErrors } },
  },
};
