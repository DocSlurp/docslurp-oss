/*
 * Worker startup preflight: the configuration checks the worker runs before it takes work, and nothing else.
 *
 * A deployment runs this on a new worker image, with the production environment and secrets, before it migrates the
 * database: a configuration the new worker would refuse at startup then blocks the release instead of crash-looping the
 * fleet after the schema has moved. Entry point: `node worker/dist/temporal/preflight-main.js` (exit 0 = would start).
 *
 * It must never act: no Temporal connection or polling, no database connection (the database may still be on the
 * previous schema), no migrations, schedulers, maintenance sweeps, webhook or outbox drains, and no writes for any
 * tenant. Checks that need the database (the vision ledger schema) are reported as skipped. This module deliberately
 * imports none of the store, Temporal or scheduler modules; `preflight.test.ts` holds it to that.
 */
import { sandboxedPdfConfigured } from "@docslurp/shared";

import { loadExtractorPlugins } from "../extractors/plugins.js";
import { configureWorkerExtractorIdAliases } from "../extractors/registry.js";
import { assertNativePdfEngineAtStartup } from "../native-pdf/loader.js";
import { ocrLanguageSettingFromEnv } from "../ocr/languages.js";
import { assertOcrConfiguration } from "../ocr/mode.js";
import { pinnedOcrModels } from "../ocr/models.js";
import { initializeParserSandbox } from "../sandbox/startup.js";

export interface PreflightStepResult {
  step: string;
  status: "passed" | "skipped";
  detail: string;
}

export class WorkerPreflightError extends Error {
  constructor(readonly step: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkerPreflightError";
  }
}

export interface WorkerPreflightDeps {
  initializeParserSandbox: typeof initializeParserSandbox;
  loadExtractorPlugins: (env: NodeJS.ProcessEnv) => Promise<readonly unknown[]>;
  configureWorkerExtractorIdAliases: (env: NodeJS.ProcessEnv) => ReadonlyMap<string, string>;
  assertOcrConfiguration: (env: NodeJS.ProcessEnv) => string;
  pinnedOcrModels: (env: NodeJS.ProcessEnv) => ReadonlyMap<string, string>;
  assertNativePdfEngineAtStartup: (env: NodeJS.ProcessEnv) => Promise<unknown>;
  platform: NodeJS.Platform;
}

const defaultDeps: WorkerPreflightDeps = {
  initializeParserSandbox,
  loadExtractorPlugins: (env) => loadExtractorPlugins(env),
  configureWorkerExtractorIdAliases,
  assertOcrConfiguration,
  pinnedOcrModels,
  assertNativePdfEngineAtStartup,
  platform: process.platform,
};

/** Checks the database would need; preflight never connects, so these are always reported as skipped. */
export const PREFLIGHT_SKIPPED_DATABASE_CHECKS = ["vision ledger schema (migration 0101)"] as const;

/**
 * Run the startup configuration checks in the worker's order. Throws `WorkerPreflightError` naming the first failing
 * step; returns one result per step otherwise.
 */
export async function runWorkerPreflight(env: NodeJS.ProcessEnv = process.env, deps: Partial<WorkerPreflightDeps> = {}): Promise<PreflightStepResult[]> {
  const d = { ...defaultDeps, ...deps };
  const results: PreflightStepResult[] = [];
  const step = async (name: string, run: () => Promise<string> | string) => {
    try {
      results.push({ step: name, status: "passed", detail: await run() });
    } catch (error) {
      throw new WorkerPreflightError(name, error instanceof Error ? error.message : String(error), { cause: error });
    }
  };

  await step("parser sandbox", async () => {
    const sandbox = await d.initializeParserSandbox(env, d.platform);
    return `provider=${sandbox.provider.id}`;
  });
  // Plugin load checks each plugin's API version and refuses an unknown DOCSLURP_PDF_EXTRACTOR or a VM selection
  // without a provider.
  await step("extractor plugins", async () => {
    const plugins = await d.loadExtractorPlugins(env);
    return `plugins=${plugins.length} vmPdf=${sandboxedPdfConfigured(env) ? "selected" : "off"}`;
  });
  await step("extractor id aliases", () => `aliases=${d.configureWorkerExtractorIdAliases(env).size}`);
  // Mode, profile, provider presence and the provider's own configuration (for a VM provider: image, protocol, credentials).
  let mode = "";
  await step("ocr configuration", () => {
    mode = d.assertOcrConfiguration(env);
    return `mode=${mode} language=${ocrLanguageSettingFromEnv(env)}`;
  });
  if (mode === "vm" || mode === "local") {
    await step("ocr model pins", () => {
      const models = d.pinnedOcrModels(env);
      if (models.size === 0) throw new Error("the OCR model manifest pins no models");
      return `models=${models.size}`;
    });
  } else {
    results.push({ step: "ocr model pins", status: "skipped", detail: `mode=${mode} runs no pinned models` });
  }
  await step("native pdf engine", async () => {
    await d.assertNativePdfEngineAtStartup(env);
    return "ok";
  });
  for (const check of PREFLIGHT_SKIPPED_DATABASE_CHECKS) {
    results.push({ step: check, status: "skipped", detail: "needs the database; preflight never connects" });
  }
  return results;
}
