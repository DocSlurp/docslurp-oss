import { describe, expect, it, vi } from "vitest";

import type { AlertCheck } from "../services/alerts/alert-rules.js";
import { WorkerFloorFallback, pickWorkerToStart, resolveWorkerFloorConfig } from "../services/alerts/worker-floor.js";
import { deliverAlert, resolveAlertDeliveryConfig } from "../services/alerts/alert-delivery.js";

const firing: AlertCheck = { id: "worker-pollers-missing", state: "firing", severity: "critical", summary: "none", details: {} };
const ok: AlertCheck = { id: "worker-pollers-missing", state: "ok", severity: "critical", summary: "ok", details: {} };

function fly(machines: Array<{ id: string; state: string }>) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (String(url).endsWith("/start")) return new Response("{}");
    return Response.json(machines);
  });
}

describe("worker floor fallback", () => {
  it("is off without FLY_WORKER_API_TOKEN", () => {
    expect(resolveWorkerFloorConfig({})).toBeNull();
    expect(resolveWorkerFloorConfig({ FLY_WORKER_API_TOKEN: "t" })).toMatchObject({ app: "docslurp-worker", cooldownMs: 300_000 });
  });

  it("starts one stopped machine when runs wait with no pollers, then cools down", async () => {
    let now = 0;
    const fetchImpl = fly([{ id: "b", state: "stopped" }, { id: "a", state: "stopped" }]);
    const floor = new WorkerFloorFallback(resolveWorkerFloorConfig({ FLY_WORKER_API_TOKEN: "FlyV1 fm2_x" }), fetchImpl as unknown as typeof fetch, () => now, () => {});
    expect(await floor.evaluate([ok])).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await floor.evaluate([firing])).toBe("a");
    const start = fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/start"))!;
    expect(String(start[0])).toBe("https://api.machines.dev/v1/apps/docslurp-worker/machines/a/start");
    expect((start[1]!.headers as Record<string, string>).authorization).toBe("FlyV1 fm2_x");
    now = 60_000;
    expect(await floor.evaluate([firing])).toBeNull();
    now = 301_000;
    expect(await floor.evaluate([firing])).toBe("a");
  });

  it("never starts a machine while one is started or mid-deploy, and never throws", async () => {
    expect(pickWorkerToStart([{ id: "a", state: "started" }, { id: "b", state: "stopped" }])).toEqual({ skip: "a worker machine is already started" });
    expect(pickWorkerToStart([{ id: "a", state: "replacing" }, { id: "b", state: "stopped" }])).toEqual({ skip: "worker machines are transitioning" });
    const logs: string[] = [];
    const broken = new WorkerFloorFallback(resolveWorkerFloorConfig({ FLY_WORKER_API_TOKEN: "secret-token" }), (async () => { throw new Error("network down"); }) as unknown as typeof fetch, () => 0, (line) => logs.push(line));
    await expect(broken.evaluate([firing])).resolves.toBeNull();
    expect(logs.join("\n")).not.toContain("secret-token");
  });
});

describe("telegram alert delivery", () => {
  it.each(["development", "test", "preview", "staging", undefined])("never enables Telegram outside production (%s)", (nodeEnv) => {
    expect(resolveAlertDeliveryConfig({ NODE_ENV: nodeEnv, TELEGRAM_BOT_TOKEN: "b", TELEGRAM_CHAT_ID: "1", ALERT_TELEGRAM: "on", ALERT_ENVIRONMENT: "production", FLY_APP_NAME: "docslurp-app" }).telegram).toBeNull();
  });

  const notification = {
    status: "firing" as const, id: "worker-pollers-missing" as const, severity: "critical" as const,
    summary: "No live worker pollers", details: { pendingRuns: 3 }, startedAt: 0, at: 60_000, repeat: false,
  };

  it("uses the signup bot with ALERT_TELEGRAM_CHAT_ID (else TELEGRAM_CHAT_ID), unless ALERT_TELEGRAM=off", () => {
    expect(resolveAlertDeliveryConfig({ NODE_ENV: "production", TELEGRAM_BOT_TOKEN: "b", TELEGRAM_CHAT_ID: "1" }).telegram).toEqual({ token: "b", chatId: "1" });
    expect(resolveAlertDeliveryConfig({ NODE_ENV: "production", TELEGRAM_BOT_TOKEN: "b", TELEGRAM_CHAT_ID: "1", ALERT_TELEGRAM_CHAT_ID: "2" }).telegram?.chatId).toBe("2");
    expect(resolveAlertDeliveryConfig({ NODE_ENV: "production", TELEGRAM_BOT_TOKEN: "b", TELEGRAM_CHAT_ID: "1", ALERT_TELEGRAM: "off" }).telegram).toBeNull();
    expect(resolveAlertDeliveryConfig({ NODE_ENV: "production", TELEGRAM_CHAT_ID: "1" }).telegram).toBeNull();
  });

  it("sends the alert and never logs the token-bearing URL on failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: Array<{ url: string; body: { chat_id: string; text: string } }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }));
    });
    const config = resolveAlertDeliveryConfig({ NODE_ENV: "production", TELEGRAM_BOT_TOKEN: "bot-secret", TELEGRAM_CHAT_ID: "42" });
    await deliverAlert(notification, config, fetchImpl as unknown as typeof fetch);
    expect(sent[0]?.body.chat_id).toBe("42");
    expect(sent[0]?.body.text).toContain("[FIRING] worker-pollers-missing");
    await expect(deliverAlert(notification, config, (async () => { throw new Error("fetch https://api.telegram.org/botbot-secret failed"); }) as unknown as typeof fetch)).rejects.toThrow("Telegram alert delivery incomplete");
    expect(error.mock.calls.flat().join("\n")).not.toContain("bot-secret");
    error.mockRestore();
  });
});
