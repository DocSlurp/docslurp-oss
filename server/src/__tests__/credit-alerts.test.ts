import { expect, it, vi } from "vitest";
import { deliverAlert, resolveAlertDeliveryConfig } from "../services/alerts/alert-delivery.js";
it("never delivers tenant funding or delayed-resume notifications to operator channels", async () => {
  const transport = vi.fn();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const id of ["credits-running-low:org", "credit-resume-delayed:org"] as const) {
      for (const status of ["firing", "resolved"] as const) {
        await deliverAlert({ id, status, severity: "warning", summary: "tenant funding", details: {}, startedAt: 0, at: 1000, repeat: false }, { ...resolveAlertDeliveryConfig({ TELEGRAM_BOT_TOKEN: "secret", TELEGRAM_CHAT_ID: "chat" }), webhookUrl: "https://operator.invalid" }, transport);
      }
    }
    expect(transport).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  } finally { error.mockRestore(); log.mockRestore(); }
});
