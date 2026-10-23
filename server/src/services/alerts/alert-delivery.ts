import type { AlertNotification } from "./alert-tracker.js";

/**
 * Alert delivery. Every notification is logged as an `[alert]` line (Fly
 * logs, any log drain). When ALERT_WEBHOOK_URL is set it is also POSTed:
 * `slack` (default) sends `{ text }`, which Slack incoming webhooks and the
 * Slack-compatible endpoints of Discord (`/slack`), Mattermost, Rocket.Chat
 * and most pagers accept; `json` sends the structured notification.
 */

export type AlertWebhookFormat = "slack" | "json";

export interface AlertDeliveryConfig {
  webhookUrl: string | null;
  /**
   * Telegram (the signup-notification bot): TELEGRAM_BOT_TOKEN plus
   * ALERT_TELEGRAM_CHAT_ID, else TELEGRAM_CHAT_ID. ALERT_TELEGRAM=off disables.
   */
  telegram?: { token: string; chatId: string } | null;
  format: AlertWebhookFormat;
  /** Label for the deployment, e.g. the Fly app name. */
  environment: string;
  /** Extra source label: the instance that evaluated the alert. */
  instance: string;
  timeoutMs: number;
}

export function resolveAlertDeliveryConfig(env: NodeJS.ProcessEnv = process.env, instance = "app"): AlertDeliveryConfig {
  const format = env.ALERT_WEBHOOK_FORMAT?.trim().toLowerCase();
  const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const telegramChat = env.ALERT_TELEGRAM_CHAT_ID?.trim() || env.TELEGRAM_CHAT_ID?.trim();
  const telegramOff = ["0", "false", "off", "no"].includes(env.ALERT_TELEGRAM?.trim().toLowerCase() ?? "");
  return {
    webhookUrl: env.ALERT_WEBHOOK_URL?.trim() || null,
    telegram: telegramToken && telegramChat && !telegramOff ? { token: telegramToken, chatId: telegramChat } : null,
    format: format === "json" ? "json" : "slack",
    environment: env.ALERT_ENVIRONMENT?.trim() || env.FLY_APP_NAME?.trim() || env.NODE_ENV?.trim() || "development",
    instance,
    timeoutMs: 5_000,
  };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function formatAlertLogLine(notification: AlertNotification, config: Pick<AlertDeliveryConfig, "environment" | "instance">): string {
  const details = Object.entries(notification.details)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `${key}=${typeof value === "string" ? quote(value) : String(value)}`);
  return [
    "[alert]",
    `status=${notification.status}`,
    `id=${notification.id}`,
    `severity=${notification.severity}`,
    `env=${config.environment}`,
    `instance=${config.instance}`,
    ...(notification.repeat ? ["repeat=true"] : []),
    `summary=${quote(notification.summary)}`,
    ...details,
  ].join(" ");
}

export function formatAlertPayload(notification: AlertNotification, config: Pick<AlertDeliveryConfig, "format" | "environment" | "instance">): Record<string, unknown> {
  if (config.format === "json") {
    return {
      source: "docslurp",
      environment: config.environment,
      instance: config.instance,
      status: notification.status,
      alert: notification.id,
      severity: notification.severity,
      summary: notification.summary,
      details: notification.details,
      startedAt: new Date(notification.startedAt).toISOString(),
      at: new Date(notification.at).toISOString(),
      repeat: notification.repeat,
    };
  }
  const icon = notification.status === "resolved" ? ":white_check_mark:" : notification.severity === "critical" ? ":rotating_light:" : ":warning:";
  const label = notification.status === "resolved" ? "RESOLVED" : notification.repeat ? "STILL FIRING" : "FIRING";
  const durationMin = Math.max(0, Math.round((notification.at - notification.startedAt) / 60_000));
  const details = Object.entries(notification.details)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `• ${key}: \`${String(value)}\``);
  const lines = [
    `${icon} *[${label}] ${notification.id}* (${notification.severity}) — ${config.environment}`,
    notification.summary,
    ...details,
    `_since ${new Date(notification.startedAt).toISOString()}${durationMin > 0 ? ` (${durationMin} min)` : ""} · ${config.instance}_`,
  ];
  return { text: lines.join("\n") };
}

export async function deliverAlert(
  notification: AlertNotification,
  config: AlertDeliveryConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const line = formatAlertLogLine(notification, config);
  if (notification.status === "firing") console.error(line);
  else console.log(line);
  const telegramDelivered = !config.telegram || await deliverTelegram(notification, config, config.telegram, fetchImpl);
  if (!config.webhookUrl) {
    if (!telegramDelivered) throw new Error("Telegram alert delivery incomplete");
    return;
  }
  try {
    const response = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formatAlertPayload(notification, config)),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      console.error(`[alert] webhook delivery failed id=${notification.id} status=${response.status}`);
    }
  } catch (error) {
    console.error(`[alert] webhook delivery failed id=${notification.id} error=${quote(error instanceof Error ? error.message : String(error))}`);
  }
  if (!telegramDelivered) throw new Error("Telegram alert delivery incomplete");
}

/** Plain-text Telegram message; failures are logged without the token-bearing URL. */
async function deliverTelegram(
  notification: AlertNotification,
  config: AlertDeliveryConfig,
  telegram: { token: string; chatId: string },
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const text = formatAlertPayload(notification, { ...config, format: "slack" }).text;
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: telegram.chatId, text: String(text).replace(/[*`]/g, "").slice(0, 4096), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const result = await response.json().catch(() => null) as { ok?: boolean } | null;
    if (!response.ok || result?.ok !== true) console.error(`[alert] telegram delivery failed id=${notification.id} status=${response.status}`);
    else console.log(`[alert] telegram delivered id=${notification.id} status=${notification.status}`);
    return response.ok && result?.ok === true;
  } catch {
    // The request URL carries the bot token: never log the error.
    console.error(`[alert] telegram delivery failed id=${notification.id}`);
    return false;
  }
}
