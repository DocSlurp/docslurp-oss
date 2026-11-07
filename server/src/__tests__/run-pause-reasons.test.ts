import { expect, it } from "vitest";
import { mapProjectRun, type ProjectRunRow } from "../services/run-records.js";
const base = {
  id: "run", user_id: "user", org_id: "org", project_id: "project", project_name: "Project",
  kind: "bulk-upload", status: "processing", control_state: "paused", stage: "queued",
  total_documents: 1, processed_documents: 0, pages_total: 1, pages_processed: 0,
  created_at: new Date(), updated_at: new Date(), error: null,
} as ProjectRunRow;
it("exposes closed spend reason codes and suppresses arbitrary stored pause text", () => {
  expect(mapProjectRun({ ...base, pause_reason: "credit_exhausted" }).pauseReason).toBe("credit_exhausted");
  expect(mapProjectRun({ ...base, pause_reason: "project_budget_paused" }).pauseReason).toBe("project_budget_paused");
  expect(mapProjectRun({ ...base, pause_reason: "secret-provider-error" }).pauseReason).toBeNull();
});
