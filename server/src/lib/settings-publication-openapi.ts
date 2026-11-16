import { z } from "zod";
import { publishProjectSettingsSchema } from "@docslurp/shared";
import { apiErrorOpenApiResponse } from "./api-error-openapi.js";
import { projectRefHeaders, projectRefParameter } from "./state-management-openapi.js";
const security = [{ bearerAuth: [] }, { sessionAuth: [] }];
const snapshot = { type: "object", required: ["project", "settings", "revision"], properties: {
  project: { type: "object", description: "Public project view; managed model bindings omitted" },
  settings: { type: "object", description: "Public search/chat view; reranker is keyword or model" },
  revision: { type: "object", required: ["project", "search"], properties: { project: { type: "string" }, search: { type: "string", description: "Opaque revision, or absent before the first stored search row" } } },
  explanations: { type: "array", items: { type: "object" }, description: "Safe resolved values, origins, locks, availability and effects; never permission grants or proof of corpus migration" },
  legacyIndexes: { type: "object", properties: { documents: { type: "integer", maximum: 101 }, documentIds: { type: "array", maxItems: 100, items: { type: "string" } } }, description: "Bounded rebuild-required coverage: 101 means at least 101; IDs contain the first 100" },
} };
export const settingsPublicationSchemas = { PublishProjectSettings: z.toJSONSchema(publishProjectSettingsSchema, { io: "input", unrepresentable: "any" }) };
const errors = {
  "400": apiErrorOpenApiResponse("Invalid or unsupported settings; managed fields refused"),
  "401": apiErrorOpenApiResponse("Authentication required"),
  "403": apiErrorOpenApiResponse("Editor access and projects:manage server-key scope required; browser and OAuth keys refused"),
  "404": apiErrorOpenApiResponse("Project unavailable in caller's organization or key allowlist"),
};
const access = "Requires project edit access. API keys must be live server keys with projects:manage, in the project's organization and allowlist. Browser keys and delegated OAuth tokens are refused.";
export const settingsPublicationPaths = {
  "/v1/projects/{projectId}/settings-publication": {
    get: { tags: ["projects"], summary: "Read a coherent project settings snapshot", description: `${access} Returns project/search revisions under the same config lock used for publication. Resolved origins do not reconstruct historical explicit-versus-default choices.`, security, parameters: [projectRefParameter], responses: { "200": { description: "Coherent public snapshot", headers: projectRefHeaders, content: { "application/json": { schema: snapshot } } }, ...errors } },
    post: { tags: ["projects"], summary: "Publish pipeline and search/chat settings atomically", description: `${access} Maximum body 128 KiB. Send the opaque revisions from GET and an actor-scoped UUID requestId. Omission preserves values, false is explicit, supported null resets are retained, arrays replace, clearOutputSchema explicitly clears a schema, and unknown keys are rejected. The existing planner, policy and billing checks remain authoritative. Pipeline, search/chat, admitted jobs/reservations, audit and retry receipt commit together or roll back. Repeating the same requestId/body does not queue twice; changed-body reuse is refused. Mode changes that queue work require project.apply=reindex. Tightening privacy/PII over retained documents is refused until artifact fencing exists. First-party chat proposals remain a separate session-only interface.`, security, parameters: [projectRefParameter], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PublishProjectSettings" } } } }, responses: { "200": { description: "Publication receipt and snapshot; replayed distinguishes retries", headers: projectRefHeaders, content: { "application/json": { schema: { type: "object", properties: { requestId: { type: "string" }, replayed: { type: "boolean" }, snapshot, job: { type: ["object", "null"] }, queuedRunIds: { type: "array", items: { type: "string" } } } } } } }, "409": apiErrorOpenApiResponse("Stale project/search revision, changed request-ID reuse, missing work consent or unsupported safe policy withdrawal"), "413": apiErrorOpenApiResponse("Settings body exceeds 128 KiB"), "402": apiErrorOpenApiResponse("Work admission refused by existing credit/budget policy"), ...errors } },
  },
};
