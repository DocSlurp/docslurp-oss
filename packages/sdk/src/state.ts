import type { JsonObject, WorkspaceRun } from "./index.js";

export type RunLifecycleStatus = "queued" | "processing" | "paused" | "completed" | "failed";
export type RunProgressTone = "queued" | "processing" | "completed" | "failed";
export type RunUsage = { inputTokens: number; outputTokens: number; costCents: number };
export type RunStageState = {
  runId: string; documentId: string | null; stage: string; status: RunProgressTone;
  attempts: number; artifactUri: string | null; stats: JsonObject; error: string | null;
  startedAt: string | null; completedAt: string | null; updatedAt: string;
};
export type RunEvent = {
  id: string; userId: string; runId: string; documentId: string | null; stage: string | null;
  type: string; status: RunProgressTone | null; message: string | null;
  progress: JsonObject; stats: JsonObject; payload: JsonObject; createdAt: string;
};
export type RunTemporalState = {
  workflowId: string; workflowRunId: string | null; workflowStatus: string | null;
  stage: string | null; stageIndex: number | null; totalStages: number | null;
  historyLength: number | null; historySizeBytes: number | null; startTime: string | null;
  executionTime: string | null; closeTime: string | null; elapsedMs: number | null;
  usage: RunUsage; queriedAt: string;
};
export type RunProgress = {
  lifecycleStatus: RunLifecycleStatus; currentStage: string; currentStageLabel: string;
  currentStageIndex: number | null; currentStagePosition: number | null; expectedStages: string[];
  completedStages: number; totalStages: number; percentComplete: number;
  phases: Array<{ key: string; label: string; stages: string[]; status: RunProgressTone; completedStages: number; totalStages: number }>;
  stageRollups: Array<RunUsage & {
    stage: string; label: string; status: RunProgressTone; completedPages: number; totalPages: number;
    pageRatio: number; documents: { completed: number; processing: number; failed: number; queued: number; total: number };
    durationMs: number; latencyMs: number;
  }>;
  pageRollup: { completed: number; total: number; byStage: Record<string, number>; byDocument: Record<string, Record<string, number>> };
  usageTotals: RunUsage;
  resourceTotals: { elapsedMs: number; cpuUserMs: number; cpuSystemMs: number; cpuTotalMs: number; rssDeltaBytes: number; peakRssBytes: number };
};
/** An authoritative full snapshot, also returned by the polling fallback. */
export type RunProgressSnapshot = {
  run: WorkspaceRun & { workspaceId: string; orgId: string; stage: string; totalDocuments: number; processedDocuments: number; pagesTotal: number; pagesProcessed: number; costCents: number; computeEstimated: boolean; /** Billed spend the run cost cap is enforced against (costCents without the compute estimate). */ billedCostCents?: number }; stages: RunStageState[]; recentEvents: RunEvent[];
  temporal: RunTemporalState | null; progress?: RunProgress; stats: JsonObject; artifacts: Record<string, string>;
};
export type WorkspaceRunProgressSnapshot = RunProgressSnapshot;
export type DistributionStats = { sampleCount: number; p50: number | null; p95: number | null; max: number | null };
export type WorkspaceState = {
  workspaceId: string; orgId: string; observedAt: string;
  recentWindow: { from: string; to: string; hours: number };
  /**
   * total/completed are the current corpus (completed documents not superseded by a
   * newer version); queued/processing are in-flight ingest; failed counts failed documents.
   */
  documents: { total: number; queued: number; processing: number; completed: number; failed: number; unknownPageCount: number };
  /** Current corpus pages; a re-ingest never double counts. */
  pages: { total: number; indexed: number; notIndexed: number; basis: "text-searchable-unique-pages" };
  storage: { sourceBytes: number; sourceMb: number; textBytes: number; textMb: number; documentsWithUnknownSize: number; vectorBytes: null; artifactBytes: null; mbDivisor: 1000000 };
  runs: { total: number; queued: number; processing: number; completed: number; failed: number };
  searches: { total: number; recentCount: number; recentZeroResultCount: number; latencyMs: DistributionStats };
  performance: { completedRuns: number; failedRuns: number; completedPages: number; durationMs: DistributionStats; pagesPerMinute: number | null; minutesPer100Pages: number | null; basis: "run-wall-time-including-queue" };
  usage: RunUsage;
};
export type OrganizationRole = "owner" | "admin" | "member" | "billing";
export type OrganizationRecord = {
  id: string; name: string; slug: string | null; isPersonal: boolean; personalOwnerUserId: string | null;
  createdByUserId: string; creditBalanceCents: number; memberRole: OrganizationRole; createdAt: string; updatedAt: string;
};
export type OrganizationAccess = {
  orgId: string; userId: string; role: OrganizationRole;
  capabilities: { read: boolean; update: boolean; manageMembers: boolean; manageOwners: boolean; manageApiKeys: boolean; leave: boolean };
};
export type OrganizationDetails = { organization: OrganizationRecord; access: OrganizationAccess; counts: { members: number; workspaces: number } };
export type OrganizationMembership = { orgId: string; userId: string; role: OrganizationRole; createdAt: string };
export type OrganizationMember = OrganizationMembership & { email: string; name: string };
export type OrganizationInviteStatus = "pending" | "accepted" | "revoked" | "expired";
export type OrganizationInvite = {
  id: string; orgId: string; email: string; role: OrganizationRole; status: OrganizationInviteStatus;
  invitedByUserId: string; acceptedByUserId: string | null; expiresAt: string; acceptedAt: string | null; createdAt: string;
};
export type CreateOrganizationInviteInput = { email: string; role?: OrganizationRole; expiresInDays?: number };
export type CreateOrganizationInput = { name: string; slug?: string };
export type UpdateOrganizationInput = { name?: string; slug?: string | null };
export type OrganizationApiKey = {
  id: string; userId: string; orgId: string | null; name: string; keyType: "server" | "client";
  allowedDomains: string[]; scopes: string[];
  /** Optional requests-per-minute cap; null means the plan's per-category limits apply. */
  rateLimitRpm: number | null; rateLimitPpd: number;
  /** Workspaces the key may use; empty means every workspace in its organization. */
  workspaceIds?: string[];
  lastUsedAt: string | null; createdAt: string; revokedAt: string | null; requestsLastMinute?: number; pagesToday?: number;
};
