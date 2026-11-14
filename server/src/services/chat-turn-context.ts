import type { PipelineFeatures, PrivacyMode, ProjectSearchSettings } from "@docslurp/shared";

import type { SearchAccessScope } from "../search/access-scope.js";
import { loadSearchProjectContext } from "../search/session-setup.js";

/**
 * What one chat turn needs to know about its project, read once: the access
 * decision (user access, held to the explicit search scope's org and
 * allowlist), the project's name, system prompt and pipeline, and its search
 * settings. One query (search/session-setup.ts loadSearchProjectContext), in
 * place of the dashboard-sized project record (corpus, run and activity
 * counts) and the two or three separate settings reads a turn used to make.
 * Read-only: no name refinement or other write happens here.
 */
export interface ChatTurnContext {
  projectId: string;
  orgId: string;
  name: string;
  systemPrompt: string | null;
  /** The normalized stored pipeline, as the project record carries it (an unreadable one fails closed to local-only). */
  pipeline: PipelineFeatures;
  privacyMode: PrivacyMode;
  /** Project defaults; the thread's and the request's retrieval overrides apply on top. */
  settings: ProjectSearchSettings;
}

/** Throws ProjectNotFoundError when the project is missing or outside the scope. */
export async function loadChatTurnContext(projectId: string, userId: string, scope: SearchAccessScope): Promise<ChatTurnContext> {
  const context = await loadSearchProjectContext(projectId, userId, scope, { strictSettings: true });
  return {
    projectId: context.scope.projectId,
    orgId: context.scope.orgId,
    name: context.project.name,
    systemPrompt: context.project.systemPrompt,
    pipeline: context.indexing.pipeline,
    privacyMode: context.indexing.pipeline.privacyMode,
    settings: context.settings,
  };
}
