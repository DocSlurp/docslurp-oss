import { expect, it } from "vitest";
import { mapWorkspaceRun, type WorkspaceRunRow } from "../services/run-records.js";
const base = {
  id: "run", user_id: "user", org_id: "org", workspace_id: "workspace", workspace_name: "Workspace",
  kind: "bulk-upload", status: "processing", control_state: "paused", stage: "queued",
  total_documents: 1, processed_documents: 0, pages_total: 1, pages_processed: 0,
  created_at: new Date(), updated_at: new Date(), error: null,
} as WorkspaceRunRow;
it("exposes closed spend reason codes and suppresses arbitrary stored pause text", () => {
  expect(mapWorkspaceRun({ ...base, pause_reason: "credit_exhausted" }).pauseReason).toBe("credit_exhausted");
  expect(mapWorkspaceRun({ ...base, pause_reason: "workspace_budget_paused" }).pauseReason).toBe("workspace_budget_paused");
  expect(mapWorkspaceRun({ ...base, pause_reason: "secret-provider-error" }).pauseReason).toBeNull();
});
