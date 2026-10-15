/**
 * Persisted multi-day decision-model health history.
 *
 * A model quarantined for a silent degradation (2026-10-12: one hosted model answered every noul question with
 * the same probability while choice questions still worked) re-enters the chain only after BOTH the noul and the
 * choice canary passed on `requiredDays` distinct UTC days, with no failed probe on those days. History is a
 * small JSON file (DOCSLURP_DECISION_HEALTH_HISTORY, default: in-memory only) so it survives worker restarts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { DecisionModel } from "@docslurp/shared";

import type { DecisionCallResult, DecisionClient, DecisionQuestion } from "../decision-client.js";
import { readRoutingFlags } from "../flags.js";
import { CANARY_QUESTIONS, judgeCanary, type CanaryThresholds, type CanaryVerdict } from "./canary.js";

export const DEFAULT_REENTRY_DAYS = 3;
/** Days older than this are ignored when deciding re-entry. */
export const DEFAULT_REENTRY_WINDOW_DAYS = 14;

export interface DayRecord {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  noulPass: number;
  noulFail: number;
  choicePass: number;
  choiceFail: number;
  /** Probes that threw (transport errors) count as failures of both types. */
  errors: number;
  lastAt: number;
  lastReason: string;
}

export interface HealthHistoryFile {
  version: 1;
  models: Record<string, DayRecord[]>;
}

export interface ReentryStatus {
  modelId: string;
  eligible: boolean;
  cleanDays: string[];
  requiredDays: number;
  reason: string;
}

export interface HealthHistoryOptions {
  /** JSON file path; defaults to $DOCSLURP_DECISION_HEALTH_HISTORY; undefined keeps history in memory. */
  path?: string;
  now?: () => number;
  requiredDays?: number;
  windowDays?: number;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayClean(d: DayRecord): boolean {
  return d.noulPass > 0 && d.choicePass > 0 && d.noulFail === 0 && d.choiceFail === 0 && d.errors === 0;
}

export class DecisionModelHealthHistory {
  private data: HealthHistoryFile = { version: 1, models: {} };
  private readonly path: string | undefined;
  private readonly now: () => number;
  readonly requiredDays: number;
  private readonly windowDays: number;

  constructor(options: HealthHistoryOptions = {}) {
    this.path = options.path ?? readRoutingFlags().healthHistoryPath ?? undefined;
    this.now = options.now ?? Date.now;
    this.requiredDays = options.requiredDays ?? DEFAULT_REENTRY_DAYS;
    this.windowDays = options.windowDays ?? DEFAULT_REENTRY_WINDOW_DAYS;
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as HealthHistoryFile;
      if (parsed?.version === 1 && parsed.models) this.data = parsed;
    } catch {
      // A corrupt history file means "no evidence": nothing re-enters until fresh clean days accumulate.
      this.data = { version: 1, models: {} };
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.path);
  }

  private today(modelId: string): DayRecord {
    const at = this.now();
    const day = utcDay(at);
    const rows = (this.data.models[modelId] ??= []);
    let rec = rows.find((r) => r.day === day);
    if (!rec) {
      rec = { day, noulPass: 0, noulFail: 0, choicePass: 0, choiceFail: 0, errors: 0, lastAt: at, lastReason: "" };
      rows.push(rec);
      rows.sort((a, b) => a.day.localeCompare(b.day));
      // Keep a bounded tail.
      if (rows.length > 60) rows.splice(0, rows.length - 60);
    }
    return rec;
  }

  recordVerdict(modelId: string, verdict: Pick<CanaryVerdict, "noul" | "choice" | "reason">): void {
    const rec = this.today(modelId);
    if (verdict.noul.healthy) rec.noulPass++; else rec.noulFail++;
    if (verdict.choice.healthy) rec.choicePass++; else rec.choiceFail++;
    rec.lastAt = this.now();
    rec.lastReason = verdict.reason.slice(0, 200);
    this.save();
  }

  recordError(modelId: string, message: string): void {
    const rec = this.today(modelId);
    rec.errors++;
    rec.lastAt = this.now();
    rec.lastReason = `error: ${message}`.slice(0, 200);
    this.save();
  }

  days(modelId: string): DayRecord[] {
    return (this.data.models[modelId] ?? []).map((r) => ({ ...r }));
  }

  /**
   * Eligible when each of the `requiredDays` most recent probed UTC days (within the window) is clean:
   * at least one noul and one choice pass, and no failed or errored probe.
   */
  reentryStatus(modelId: string): ReentryStatus {
    const cutoff = utcDay(this.now() - this.windowDays * 86_400_000);
    const recent = this.days(modelId).filter((d) => d.day >= cutoff).sort((a, b) => b.day.localeCompare(a.day));
    const latest = recent.slice(0, this.requiredDays);
    const cleanDays = latest.filter(dayClean).map((d) => d.day);
    const eligible = latest.length === this.requiredDays && cleanDays.length === this.requiredDays;
    const reason = eligible
      ? `noul and choice canaries clean on ${cleanDays.join(", ")}`
      : `${cleanDays.length}/${this.requiredDays} clean days` +
        (latest.some((d) => !dayClean(d)) ? ` (failing: ${latest.filter((d) => !dayClean(d)).map((d) => `${d.day} ${d.lastReason}`).join("; ")})` : "");
    return { modelId, eligible, cleanDays, requiredDays: this.requiredDays, reason };
  }
}

export class DecisionModelQuarantinedError extends Error {
  readonly code = "DECISION_MODEL_QUARANTINED";
  constructor(readonly modelId: string, readonly status: ReentryStatus) {
    super(`${modelId} quarantined: ${status.reason}`);
    this.name = "DecisionModelQuarantinedError";
  }
}

function isCanary(questions: Record<string, DecisionQuestion>): boolean {
  const keys = Object.keys(questions);
  return keys.length === Object.keys(CANARY_QUESTIONS).length && keys.every((k) => k in CANARY_QUESTIONS);
}

export interface HistoryClientOptions {
  history: DecisionModelHealthHistory;
  /** Model ids that may only serve after the history shows `requiredDays` clean days (e.g. the PPLX decider). */
  quarantined?: Iterable<string>;
  thresholds?: CanaryThresholds;
}

/**
 * Wraps the canary client: every canary call is judged and recorded in the history. For a quarantined model the
 * probe is rejected (a thrown error, which the registry treats as an unhealthy probe) until the history shows enough
 * clean days, even when the current probe passes. Non-canary calls pass through untouched.
 */
export function withHealthHistory(inner: DecisionClient, options: HistoryClientOptions): DecisionClient {
  const quarantined = new Set(options.quarantined ?? []);
  return {
    async ask(model: DecisionModel, state, questions, opts): Promise<DecisionCallResult> {
      if (!isCanary(questions)) return inner.ask(model, state, questions, opts);
      let result: DecisionCallResult;
      try {
        result = await inner.ask(model, state, questions, opts);
      } catch (error) {
        options.history.recordError(model.id, error instanceof Error ? error.message : String(error));
        throw error;
      }
      const verdict = judgeCanary(result.answers, options.thresholds);
      options.history.recordVerdict(model.id, verdict);
      if (quarantined.has(model.id)) {
        const status = options.history.reentryStatus(model.id);
        if (!status.eligible) throw new DecisionModelQuarantinedError(model.id, status);
      }
      return result;
    },
  };
}

/** Models that may only serve after the history shows clean days (2026-10-12: noul answers collapsed to one constant). */
export const QUARANTINED_DECISION_MODELS: readonly string[] = ["perplexity/pplx-decider-v1.1-27b"];

let processHistory: DecisionModelHealthHistory | undefined;

/** Process-wide history, persisted at $DOCSLURP_DECISION_HEALTH_HISTORY (in memory when unset). */
export function getDecisionHealthHistory(): DecisionModelHealthHistory {
  processHistory ??= new DecisionModelHealthHistory();
  return processHistory;
}
