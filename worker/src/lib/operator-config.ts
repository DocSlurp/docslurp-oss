/*
 * The worker's side of the operator config file (@docslurp/shared/operator-config, docs/self-host/operator-config.md):
 * load it for the worker role (env.ts already did, idempotently) and run the checks only the worker can make.
 */
import { initializeOperatorConfig, OperatorConfigError, type OperatorConfigState } from "@docslurp/shared/operator-config";

import { CHART_GENERATOR_CANDIDATES } from "../chart-export/model-selection.js";

function normalizeGeneratorUri(uri: string): string {
  const trimmed = uri.trim();
  return trimmed.startsWith("llm://") ? trimmed : `llm://openrouter/${trimmed}`;
}

/**
 * Load and apply the operator config for the worker and check what the shared schema cannot: a chart generator override
 * must be one of the worker's admitted generator candidates. Throws OperatorConfigError (the worker does not start).
 */
export function assertWorkerOperatorConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfigState {
  const state = initializeOperatorConfig("worker", env);
  const generator = state.config?.models?.overrides?.chartGenerator;
  if (generator !== undefined && !CHART_GENERATOR_CANDIDATES.includes(normalizeGeneratorUri(generator))) {
    throw new OperatorConfigError("models.overrides.chartGenerator refused: not one of the admitted chart generator candidates");
  }
  return state;
}
