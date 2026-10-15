/**
 * Decision-model client for the page router.
 *
 * Decision models answer typed questions (noul / choice / score) about a state
 * (text, structured facts, or images) with calibrated probabilities and bill
 * input tokens only. Endpoints (verified 2026-10-12):
 *
 * - perplexity-decisions: POST https://api.perplexity.ai/v1/decisions,
 *   Bearer PERPLEXITYAI_API_KEY, body {model, state, questions}, model id is
 *   the bare name (`pplx-decider-v1.1-27b`), images are OpenAI-style
 *   `image_url` parts in a `state` array, 1-128 questions, body < 32 MiB.
 * - openrouter-systemone: POST https://openrouter.ai/api/v1/systemone,
 *   Bearer OPENROUTER_API_KEY, same body/response schema, model ids
 *   `typesafe/jev-1.13` / `liquid/d1` (text only).
 * - liquid-systemone: POST https://api.liquid.ai/decisions/v1/systemone,
 *   Bearer LIQUID_API_KEY, same schema, <= 8 images, <= 4.5 MB body.
 * - local-transformers: optional sidecar command (DECISION_LOCAL_SIDECAR_CMD)
 *   that reads the request JSON on stdin and writes the response JSON to stdout.
 *
 * Every hosted call passes the privacy guard (fails closed outside `standard`
 * mode) and goes through provider retry/back-pressure. Usage is recorded with
 * `recordDecisionUsage` (metric `page-route-decision`) through the pipeline
 * usage ledger, which also writes the `[ai-usage]` log line.
 */

import { spawn } from "node:child_process";
import {
  assertProviderAllowed,
  resolveDecisionModelLicense,
  type DecisionModel,
  type PrivacyMode,
} from "@docslurp/shared";

import type { UsageEvent } from "../models.js";
import { fetchWithProviderRetry, type ProviderRetryOptions } from "../lib/provider-retry.js";
import type { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { readRoutingFlags } from "./flags.js";

export const PAGE_ROUTE_DECISION_METRIC = "page-route-decision";
/** Health-canary probes of a decision model (see health/canary.ts). */
export const PAGE_ROUTE_DECISION_CANARY_METRIC = "page-route-decision-canary";
export const PERPLEXITY_DECISIONS_URL = "https://api.perplexity.ai/v1/decisions";
export const OPENROUTER_SYSTEMONE_URL = "https://openrouter.ai/api/v1/systemone";
export const LIQUID_SYSTEMONE_URL = "https://api.liquid.ai/decisions/v1/systemone";

const LIQUID_MAX_BODY_BYTES = 4_500_000;
const PERPLEXITY_MAX_BODY_BYTES = 32 * 1024 * 1024;

export type DecisionQuestion =
  | { type: "noul"; instructions?: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions?: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions?: string; criteria: string[] };

export interface DecisionImagePart {
  type: "image_url";
  image_url: { url: string };
}
export type DecisionStatePart = string | DecisionImagePart;
export type DecisionState = string | Record<string, unknown> | DecisionStatePart[];

export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; legend?: Record<string, string>; probabilities: Record<string, number> };

export interface DecisionCallOptions {
  signal?: AbortSignal;
}

export interface DecisionCallResult {
  answers: Record<string, DecisionAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  /** Input tokens x catalog price, in cents (fractional). */
  costCents: number;
  model: string;
  provider: string;
}

export interface DecisionClient {
  ask(
    model: DecisionModel,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    opts?: DecisionCallOptions,
  ): Promise<DecisionCallResult>;
}

export class DecisionUnavailableError extends Error {
  readonly code = "DECISION_MODEL_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "DecisionUnavailableError";
  }
}

export class DecisionRequestError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "DecisionRequestError";
  }
}

export function decisionCostCents(model: DecisionModel, inputTokens: number): number {
  return (inputTokens / 1_000_000) * model.pricing.inputUsdPerMTok * 100;
}

export function imageDataUrlPart(png: Buffer | Uint8Array, mime = "image/png"): DecisionImagePart {
  return {
    type: "image_url",
    image_url: { url: `data:${mime};base64,${Buffer.from(png).toString("base64")}` },
  };
}

function countImages(state: DecisionState): number {
  return Array.isArray(state)
    ? state.filter((part) => typeof part !== "string" && part.type === "image_url").length
    : 0;
}

/** Wire model id: Perplexity wants the bare name, the others the namespaced id. */
export function wireModelId(model: DecisionModel): string {
  switch (model.endpoint) {
    case "perplexity-decisions":
      return model.id.replace(/^perplexity\//, "");
    case "liquid-systemone":
      return model.id.replace(/:direct$/, "");
    default:
      return model.id;
  }
}

interface EndpointSpec {
  url: string;
  keyEnv: string;
  provider: string;
  maxBodyBytes: number;
}

function endpointSpec(model: DecisionModel): EndpointSpec | null {
  switch (model.endpoint) {
    case "perplexity-decisions":
      return { url: PERPLEXITY_DECISIONS_URL, keyEnv: "PERPLEXITYAI_API_KEY", provider: "perplexity", maxBodyBytes: PERPLEXITY_MAX_BODY_BYTES };
    case "openrouter-systemone":
      return { url: OPENROUTER_SYSTEMONE_URL, keyEnv: "OPENROUTER_API_KEY", provider: "openrouter", maxBodyBytes: PERPLEXITY_MAX_BODY_BYTES };
    case "liquid-systemone":
      return { url: LIQUID_SYSTEMONE_URL, keyEnv: "LIQUID_API_KEY", provider: "liquid", maxBodyBytes: LIQUID_MAX_BODY_BYTES };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProb(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function probRecord(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, p] of Object.entries(value)) {
    if (!isProb(p)) return null;
    out[key] = p;
  }
  return out;
}

/** Validates a response body against the questions asked; throws on malformed answers. */
export function parseDecisionResponse(
  body: unknown,
  questions: Record<string, DecisionQuestion>,
): { answers: Record<string, DecisionAnswer>; usage: { inputTokens: number; outputTokens: number } } {
  if (!isRecord(body) || !isRecord(body.answers)) {
    throw new DecisionRequestError("decision response has no answers object");
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const raw = body.answers[key];
    if (!isRecord(raw)) continue; // missing keys are rejected by callers that need them
    if (question.type === "noul") {
      if (!isProb(raw.noul)) throw new DecisionRequestError(`malformed noul answer for ${key}`);
      answers[key] = { type: "noul", noul: raw.noul };
    } else if (question.type === "choice") {
      const probabilities = probRecord(raw.probabilities);
      if (typeof raw.choice !== "string" || !probabilities) {
        throw new DecisionRequestError(`malformed choice answer for ${key}`);
      }
      answers[key] = {
        type: "choice",
        choice: raw.choice,
        confidence: isProb(raw.confidence) ? raw.confidence : (probabilities[raw.choice] ?? 0),
        probabilities,
      };
    } else {
      const probabilities = probRecord(raw.probabilities);
      if (typeof raw.score !== "number" || !probabilities) {
        throw new DecisionRequestError(`malformed score answer for ${key}`);
      }
      answers[key] = {
        type: "score",
        score: raw.score,
        confidence: isProb(raw.confidence) ? raw.confidence : 0,
        legend: isRecord(raw.legend) ? (raw.legend as Record<string, string>) : undefined,
        probabilities,
      };
    }
  }
  const usage = isRecord(body.usage) ? body.usage : {};
  const inputTokens = Number(usage.input_tokens);
  if (!Number.isFinite(inputTokens) || inputTokens < 0) {
    throw new DecisionRequestError("decision response has no usage.input_tokens");
  }
  const outputTokens = Number(usage.output_tokens);
  return { answers, usage: { inputTokens, outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0 } };
}

export interface DecisionClientOptions {
  /** Workspace privacy mode; hosted calls fail closed outside `standard`. */
  privacyMode: PrivacyMode | string | null | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Extra retry options (sleep/random for tests, limiter, maxRetries). */
  retry?: Partial<Omit<ProviderRetryOptions, "provider" | "label" | "signal" | "fetchImpl">>;
  /** Called once per successful request, e.g. to record usage. */
  onUsage?: (model: DecisionModel, result: DecisionCallResult) => void;
  /** Local sidecar runner override (tests). */
  runSidecar?: (command: string[], request: unknown, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
}

function parseSidecarCommand(raw: string | undefined): string[] | null {
  const text = raw?.trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string") && parsed.length > 0) return parsed as string[];
    } catch {
      return null;
    }
    return null;
  }
  return text.split(/\s+/);
}

function defaultRunSidecar(command: string[], request: unknown, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new DecisionRequestError(`local decision sidecar exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new DecisionRequestError("local decision sidecar returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function createDecisionClient(options: DecisionClientOptions): DecisionClient {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => performance.now());

  return {
    async ask(model, state, questions, opts = {}) {
      if (readRoutingFlags(env).disableNonFreeSoftware && resolveDecisionModelLicense(model).licenseClass === "non-free") {
        throw new DecisionUnavailableError(`${model.id} has a non-free licence and DISABLE_NON_FREE_SOFTWARE is on`);
      }
      const questionCount = Object.keys(questions).length;
      if (questionCount < 1) throw new DecisionRequestError("decision request needs at least one question");
      if (questionCount > model.maxQuestionsPerRequest) {
        throw new DecisionRequestError(
          `${questionCount} questions exceeds ${model.id} limit of ${model.maxQuestionsPerRequest}`,
        );
      }
      const images = countImages(state);
      if (images > 0 && !model.modalities.image) {
        throw new DecisionRequestError(`${model.id} is text-only; got ${images} image(s)`);
      }
      if (images > model.modalities.maxImagesPerRequest) {
        throw new DecisionRequestError(
          `${images} images exceeds ${model.id} limit of ${model.modalities.maxImagesPerRequest}`,
        );
      }

      const request = { model: wireModelId(model), state, questions };
      const started = now();

      let body: unknown;
      let provider: string;
      if (model.endpoint === "local-transformers") {
        provider = "local";
        // Local runtimes never leave the machine, so they stay allowed in every privacy mode.
        assertProviderAllowed(options.privacyMode, {
          provider: "transformers.js",
          model: model.id,
          operation: "worker.routing.decision",
          target: "local",
        });
        const command = parseSidecarCommand(readRoutingFlags(env).localDecisionSidecarCmd ?? undefined);
        if (!command) {
          throw new DecisionUnavailableError("local decision sidecar not configured (DECISION_LOCAL_SIDECAR_CMD)");
        }
        body = await (options.runSidecar ?? defaultRunSidecar)(command, request, opts.signal);
      } else {
        const spec = endpointSpec(model);
        if (!spec) throw new DecisionUnavailableError(`unsupported decision endpoint ${model.endpoint}`);
        provider = spec.provider;
        // Decision-model calls send workspace content to a hosted AI provider.
        assertProviderAllowed(options.privacyMode, {
          provider: spec.provider,
          model: model.id,
          operation: "worker.routing.decision",
          target: "hosted",
          baseUrl: spec.url,
        });
        const key = env[spec.keyEnv]?.trim();
        if (!key) throw new DecisionUnavailableError(`${spec.keyEnv} is not set`);
        const payload = JSON.stringify(request);
        const bytes = Buffer.byteLength(payload);
        if (bytes > spec.maxBodyBytes) {
          throw new DecisionRequestError(`request body ${bytes} bytes exceeds ${model.id} limit of ${spec.maxBodyBytes}`);
        }
        const response = await fetchWithProviderRetry(
          spec.url,
          {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: payload,
          },
          {
            ...options.retry,
            provider: `decision-${spec.provider}`,
            label: "decision request",
            signal: opts.signal,
            fetchImpl: options.fetchImpl,
          },
        );
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new DecisionRequestError(`${model.id} returned ${response.status}: ${text.slice(0, 300)}`, response.status);
        }
        body = await response.json();
      }

      const parsed = parseDecisionResponse(body, questions);
      const result: DecisionCallResult = {
        answers: parsed.answers,
        usage: parsed.usage,
        latencyMs: Math.round(now() - started),
        costCents: decisionCostCents(model, parsed.usage.inputTokens),
        model: model.id,
        provider,
      };
      options.onUsage?.(model, result);
      return result;
    },
  };
}

export interface DecisionUsageContext {
  documentId?: string;
  /** e.g. "triage" | "verify" | "route" */
  role?: string;
  pages?: number[];
  format?: string;
  /** Usage metric; defaults to `page-route-decision`. */
  metric?: string;
}

/** Records one decision call through the pipeline usage ledger (logs `[ai-usage]`, buffers the event). */
export function recordDecisionUsage(
  ledger: PipelineUsageEventLedger,
  model: DecisionModel,
  result: DecisionCallResult,
  context: DecisionUsageContext = {},
): UsageEvent | null {
  return ledger.record({
      provider: result.provider,
      model: model.id,
      metric: context.metric ?? PAGE_ROUTE_DECISION_METRIC,
      amount: 1,
      unit: "request",
      costCents: result.costCents,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      metadata: {
        costSource: "catalog-input-price",
        endpoint: model.endpoint,
        latencyMs: result.latencyMs,
        questionAnswers: Object.keys(result.answers).length,
        ...(context.documentId ? { documentId: context.documentId } : {}),
        ...(context.role ? { role: context.role } : {}),
        ...(context.pages ? { pages: context.pages } : {}),
        ...(context.format ? { format: context.format } : {}),
      },
    },
  );
}
