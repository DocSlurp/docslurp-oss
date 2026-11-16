import { projectTemplateLockedSettings, type ProjectRecord, type ProjectSearchSettings } from "./project.js";
import { privacyModeAllowsHosted } from "./privacy.js";
import { PIPELINE_FIELD_IMPACT } from "./config-change.js";

export type SettingsExplanation = {
  field: string; requested: unknown; effective: unknown;
  origin: "template" | "project-resolved" | "project-search-resolved" | "search-default" | "request-key" | "organization";
  status: "active" | "locked" | "unavailable" | "inactive";
  reason?: string; effect: string;
};
/** Explains current resolution only. This projection grants no permissions and launches no work. */
export function projectSettingsProjection(input: {
  project: Pick<ProjectRecord, "pipeline" | "templateKey" | "allowChinaProviders" | "monthlyBudgetCents">;
  settings: ProjectSearchSettings; searchStored: boolean;
  keyCeiling?: { searchMode: "keyword" | "hybrid" | "deep" | null; maxOutputTokens: number | null };
  organizationMonthlyBudgetCents?: number | null;
  capabilities: { webEnabled: boolean; webChatEnabled: boolean; organizationAllowsChina: boolean };
}): SettingsExplanation[] {
  const { project, settings, capabilities } = input;
  const locks = new Set<string>(projectTemplateLockedSettings(project.templateKey));
  const rows: SettingsExplanation[] = [];
  const walk = (value: Record<string, unknown>, prefix: string, origin: SettingsExplanation["origin"]) => {
    for (const [key, requested] of Object.entries(value)) {
      const field = `${prefix}.${key}`;
      if (requested && typeof requested === "object" && !Array.isArray(requested) && key !== "outputSchema") { walk(requested as Record<string, unknown>, field, origin); continue; }
      // Do not project managed model bindings, endpoint references, free-form schemas or prompts.
      if (/model|provider|target|route|prompt|instruction|schema|baseurl|decision|options/i.test(field)) continue;
      const path = field.replace(/^pipeline\./, "");
      const locked = locks.has(path) || [...locks].some(lock => path.startsWith(`${lock}.`));
      const effect = prefix.startsWith("pipeline") ? PIPELINE_FIELD_IMPACT[path.split(".")[0] as keyof typeof PIPELINE_FIELD_IMPACT] : "search-only";
      rows.push({ field, requested, effective: requested, origin: locked ? "template" : origin, status: locked ? "locked" : "active", effect: typeof effect === "string" ? effect : "Depends on change direction; estimate before saving" });
    }
  };
  walk(project.pipeline as unknown as Record<string, unknown>, "pipeline", "project-resolved");
  walk({ retrieval: settings.retrievalDefaults, chat: settings.chat }, "search", input.searchStored ? "project-search-resolved" : "search-default");
  const constrain = (field: string, effective: unknown, status: SettingsExplanation["status"], reason: string) => {
    const row = rows.find(row => row.field === field); if (row) Object.assign(row, { effective, status, reason });
  };
  if (!capabilities.webEnabled || !capabilities.webChatEnabled) constrain("pipeline.webTools", false, "unavailable", "Deployment disables web tools for chat");
  else if (!privacyModeAllowsHosted(project.pipeline.privacyMode)) constrain("pipeline.webTools", false, "unavailable", "Privacy policy prevents hosted web calls");
  constrain("pipeline.embedding.task", project.pipeline.embedding.task, "inactive", "Task labels are metadata; current embedding adapters do not consume them to alter vectors");
  if (!project.pipeline.embed) for (const row of rows.filter(row => row.field.startsWith("pipeline.embedding."))) Object.assign(row, { status: "inactive", reason: "Embedding is disabled for new uploads" });
  if (!settings.chat.enabled) for (const row of rows.filter(row => row.field.startsWith("search.chat.") && row.field !== "search.chat.enabled")) Object.assign(row, { status: "inactive", reason: "Project chat is disabled" });
  rows.push({ field: "allowChinaProviders", requested: project.allowChinaProviders, effective: project.allowChinaProviders && capabilities.organizationAllowsChina, origin: "project-resolved", status: capabilities.organizationAllowsChina ? "active" : "locked", ...(capabilities.organizationAllowsChina ? {} : { reason: "Organization policy is a ceiling" }), effect: "Future provider calls; does not rewrite retained artifacts" });
  rows.push({ field: "monthlyBudgetCents", requested: project.monthlyBudgetCents, effective: project.monthlyBudgetCents, origin: "project-resolved", status: "active", reason: "Project cap only; organization credits, reservations and request/key limits are checked independently at admission", effect: "Admission of later operations" });
  if (input.organizationMonthlyBudgetCents !== undefined) rows.push({ field: "organization.monthlyBudgetCents", requested: null, effective: input.organizationMonthlyBudgetCents, origin: "organization", status: "locked", reason: "Independent organization ceiling; admission also accounts for usage and reservations", effect: "Admission of later operations" });
  if (input.keyCeiling) {
    rows.push({ field: "request.searchModeCeiling", requested: null, effective: input.keyCeiling.searchMode, origin: "request-key", status: "locked", reason: "Request preferences cannot widen this credential's search scope", effect: "Each request is authorized independently" });
    rows.push({ field: "request.maxOutputTokens", requested: null, effective: input.keyCeiling.maxOutputTokens, origin: "request-key", status: "locked", reason: "Request values cannot increase the key's output-token ceiling", effect: "Later answer requests" });
  }
  return rows;
}
