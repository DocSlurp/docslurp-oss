import { describe, expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({ sql: vi.fn() }));
const { creditAlertChecks } = await import("../services/alerts/credit-alerts.js");
const { AlertTracker } = await import("../services/alerts/alert-tracker.js");
const { deliverAlert, resolveAlertDeliveryConfig } = await import("../services/alerts/alert-delivery.js");
const row = { orgId: "org", funded: false, available: 180, leased: 0, pausedRuns: 0 };
it("deduplicates warning, escalates exhaustion immediately, then reports one funding recovery", () => {
  const tracker = new AlertTracker({ pendingEvaluations: 2, repeatIntervalMs: 3600000 });
  expect(tracker.update(creditAlertChecks([row]), 1000)).toEqual([]);
  expect(tracker.update(creditAlertChecks([row]), 2000)[0]).toMatchObject({ status: "firing", severity: "warning" });
  expect(tracker.update(creditAlertChecks([row]), 3000)).toEqual([]);
  const exhausted = { ...row, available: 90, pausedRuns: 2 };
  expect(tracker.update(creditAlertChecks([exhausted]), 4000)[0]).toMatchObject({ status: "firing", severity: "critical", details: { pausedRuns: 2, chatReserveCredits: 100 } });
  const healthy = { ...row, available: 1200 };
  expect(tracker.update(creditAlertChecks([healthy]), 5000)[0]).toMatchObject({ status: "resolved" });
  expect(tracker.update(creditAlertChecks([healthy]), 6000)).toEqual([]);
});
it("keeps leased credits and the separate chat reserve visible", () => {
  expect(creditAlertChecks([{ ...row, available: 350, leased: 100, funded: true }])[0]).toMatchObject({ state: "firing", severity: "critical", details: { processingAvailableCredits: -50, chatReserveCredits: 300 } });
});
it("validates Telegram JSON success, logs delivery failures safely and emits SigNoz alert logs", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const notification = new AlertTracker({ pendingEvaluations: 1, repeatIntervalMs: 0 }).update(creditAlertChecks([{ ...row, available: 0 }]), 1000)[0]!;
  const config = resolveAlertDeliveryConfig({ TELEGRAM_BOT_TOKEN: "secret-test-token", TELEGRAM_CHAT_ID: "test-chat" });
  const transport = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200 }));
  await expect(deliverAlert(notification, config, transport)).rejects.toThrow("Telegram alert delivery incomplete");
  expect(error.mock.calls.flat().join(" ")).toContain("telegram delivery failed");
  expect(error.mock.calls.flat().join(" ")).toContain("[alert] status=firing");
  expect(error.mock.calls.flat().join(" ")).not.toContain("secret-test-token");
  transport.mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
  await deliverAlert({ ...notification, status: "resolved" }, config, transport);
  expect(log.mock.calls.flat().join(" ")).toContain("telegram delivered");
  error.mockRestore(); log.mockRestore();
});

it("reports delayed recovery separately from credit exhaustion", () => {
  const tracker = new AlertTracker({ pendingEvaluations: 1, repeatIntervalMs: 3600000 });
  const waiting = { ...row, available: 1000, pausedRuns: 2, oldestPauseSeconds: 180 };
  expect(tracker.update(creditAlertChecks([waiting]), 1000)).toEqual([expect.objectContaining({ id: 'credit-resume-delayed:org', status: 'firing' })]);
  expect(tracker.update(creditAlertChecks([{ ...waiting, pausedRuns: 0 }]), 2000)).toEqual([expect.objectContaining({ id: 'credit-resume-delayed:org', status: 'resolved' })]);
});
