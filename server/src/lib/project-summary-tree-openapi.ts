import { z } from "zod";
import { projectSummaryTreeStateSchema, updateProjectSummaryTreeSchema } from "@docslurp/shared";

import { projectRefHeaders, projectRefParameter } from "./state-management-openapi.js";
import { apiErrorOpenApiResponse } from "./api-error-openapi.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ "application/json": { schema } });
const security = [{ bearerAuth: [] }, { sessionAuth: [] }];
const readAccess = "Session project access, or an organization-bound server key with any of ingest, search, artifacts, projects:manage.";
const writeAccess = "Session with edit access, or a server key with the opt-in projects:manage scope (the key owner's project role still applies).";
const errors = {
  "401": apiErrorOpenApiResponse("Authentication required"),
  "403": apiErrorOpenApiResponse("Missing scope or project edit access"),
  "404": apiErrorOpenApiResponse("Project not found"),
};

export const projectSummaryTreeSchemas = {
  ProjectSummaryTreeState: z.toJSONSchema(projectSummaryTreeStateSchema, { unrepresentable: "any" }),
  UpdateProjectSummaryTree: z.toJSONSchema(updateProjectSummaryTreeSchema, { unrepresentable: "any", io: "input" }),
};

export const projectSummaryTreePaths = {
  "/v1/projects/{projectId}/summary-tree": {
    get: {
      tags: ["projects"],
      summary: "Read the project summary tree state",
      description: `${readAccess} The summary tree is an optional index of section summaries inside each long document, searched beside the document's passages. Returns the project's stored setting (enabled), whether this deployment builds trees (buildAvailable) and lets search read them (serveAvailable), the project's stored retrieval mode (searchMode) and the mode a search runs without a per-request override (effectiveSearchMode: off unless the tree is enabled and served), the build status (off, building, partial, ready), counts of the project's current documents by tree status, the number of built nodes, and the read-only server constants. The same block is part of GET /v1/projects/{projectId}/state.`,
      security,
      parameters: [projectRefParameter],
      responses: { "200": { description: "Summary tree state", headers: projectRefHeaders, content: json(ref("ProjectSummaryTreeState")) }, ...errors },
    },
    patch: {
      tags: ["projects"],
      summary: "Turn the project summary tree on or off",
      description: `${writeAccess} The only way to change the setting: PATCH /v1/projects/{projectId} keeps the stored value whatever its pipeline says, and no template, default or upload option turns it on. Turning it on also turns document summaries on. Nothing is queued: new uploads get a tree; existing documents do not change. Refused with 400 summary_tree_unavailable while the deployment does not build trees, 400 summary_tree_requires_vectors when the project does not embed and index vectors, and 409 summary_tree_summarize_locked when the project's template keeps document summaries off. Turning it off is always allowed.`,
      security,
      parameters: [projectRefParameter],
      requestBody: { required: true, content: json(ref("UpdateProjectSummaryTree")) },
      responses: {
        "200": { description: "Updated summary tree state", headers: projectRefHeaders, content: json(ref("ProjectSummaryTreeState")) },
        "400": apiErrorOpenApiResponse("Invalid body, the deployment does not build trees, or the project does not index vectors"),
        "409": apiErrorOpenApiResponse("The project's template keeps document summaries off"),
        ...errors,
      },
    },
  },
};
