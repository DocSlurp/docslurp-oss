import type { AlertCheck, AlertDetailValue, AlertId, AlertSeverity } from "./alert-rules.js";

/**
 * Dedupe and cooldown for alert checks. A condition must fire on
 * `pendingEvaluations` consecutive evaluations before it notifies (absorbs
 * one-tick blips such as a deploy restart), then re-notifies at most every
 * `repeatIntervalMs` while it stays firing, and sends one resolved
 * notification when it clears. Unknown checks leave the state untouched.
 */

export interface AlertNotification {
  status: "firing" | "resolved";
  id: AlertId;
  severity: AlertSeverity;
  summary: string;
  details: Record<string, AlertDetailValue>;
  /** When the condition was first seen firing (epoch ms). */
  startedAt: number;
  at: number;
  /** True for cooldown reminders of an alert that was already sent. */
  repeat: boolean;
}

type AlertState = {
  consecutiveFiring: number;
  firstFiringAt: number;
  active: boolean;
  lastNotifiedAt: number;
  severity: AlertSeverity;
};

export interface AlertTrackerOptions {
  pendingEvaluations: number;
  repeatIntervalMs: number;
}

export class AlertTracker {
  private readonly states = new Map<AlertId, AlertState>();

  constructor(private readonly options: AlertTrackerOptions) {}

  update(checks: AlertCheck[], now: number): AlertNotification[] {
    const notifications: AlertNotification[] = [];
    for (const check of checks) {
      if (check.state === "unknown") continue;
      const state = this.states.get(check.id);

      if (check.state === "firing") {
        const next: AlertState = state ?? {
          consecutiveFiring: 0,
          firstFiringAt: now,
          active: false,
          lastNotifiedAt: 0,
          severity: check.severity,
        };
        if (next.consecutiveFiring === 0) next.firstFiringAt = now;
        next.consecutiveFiring += 1;
        const escalated = next.active && next.severity !== "critical" && check.severity === "critical";
        next.severity = check.severity;
        const base = { id: check.id, severity: check.severity, summary: check.summary, details: check.details, startedAt: next.firstFiringAt, at: now };
        if (!next.active && next.consecutiveFiring >= Math.max(1, this.options.pendingEvaluations)) {
          next.active = true;
          next.lastNotifiedAt = now;
          notifications.push({ ...base, status: "firing", repeat: false });
        } else if (next.active && (escalated || (this.options.repeatIntervalMs > 0 && now - next.lastNotifiedAt >= this.options.repeatIntervalMs))) {
          next.lastNotifiedAt = now;
          notifications.push({ ...base, status: "firing", repeat: true });
        }
        this.states.set(check.id, next);
        continue;
      }

      if (!state) continue;
      if (state.active) {
        notifications.push({
          status: "resolved",
          id: check.id,
          severity: state.severity,
          summary: check.summary,
          details: check.details,
          startedAt: state.firstFiringAt,
          at: now,
          repeat: false,
        });
      }
      this.states.delete(check.id);
    }
    return notifications;
  }

  /** Forget alert states silently (leadership handed to another instance). */
  drop(predicate: (id: AlertId) => boolean): void {
    for (const id of [...this.states.keys()]) {
      if (predicate(id)) this.states.delete(id);
    }
  }

  /** Alerts currently notified as firing (for /metrics). */
  activeAlerts(): AlertId[] {
    return [...this.states].filter(([, state]) => state.active).map(([id]) => id);
  }
}
