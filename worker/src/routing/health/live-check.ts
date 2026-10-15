/**
 * Live decision-model canary: `tsx src/routing/health/live-check.ts [modelId ...]`.
 * Reads provider keys from DOCSLURP_ENV_FILE (default: ./.env) without printing them,
 * runs the known-answer canary once per model through the real client and prints one JSON line per model with
 * separate noul and choice verdicts. Each probe is appended to the persisted health history
 * (`--history <file>`, else DOCSLURP_DECISION_HEALTH_HISTORY, else in memory); the line also reports 3-day re-entry status.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { buildDecisionModelCatalog, type DecisionModel } from "@docslurp/shared";

import { createDecisionClient } from "../decision-client.js";
import { runCanary } from "./canary.js";
import { readRoutingFlags } from "../flags.js";
import { DecisionModelHealthHistory } from "./history.js";

const envFile = process.env.DOCSLURP_ENV_FILE ?? path.resolve(".env");
const env: NodeJS.ProcessEnv = { ...process.env };
for (const line of existsSync(envFile) ? readFileSync(envFile, "utf8").split("\n") : []) {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (match && !env[match[1]!]) env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "").trim();
}

const presence = Object.fromEntries(Object.entries(env).filter(([, v]) => v).map(([k]) => [k, true]));
const catalog = buildDecisionModelCatalog({ env: presence }).models;
// pplx is also reachable through OpenRouter; check that route as its own variant.
const pplxViaOpenRouter: DecisionModel = {
  ...catalog.find((m) => m.id === "perplexity/pplx-decider-v1.1-27b")!,
  endpoint: "openrouter-systemone",
  availability: { requiresEnv: ["OPENROUTER_API_KEY"], privacyClass: "hosted" },
};
const args = process.argv.slice(2);
const historyFlag = args.indexOf("--history");
const historyPath = historyFlag >= 0 ? args.splice(historyFlag, 2)[1] : readRoutingFlags(env).healthHistoryPath ?? undefined;
const history = new DecisionModelHealthHistory(historyPath ? { path: historyPath } : {});
const wanted = args;
const ids = wanted.length > 0 ? wanted : [
  "perplexity/pplx-decider-v1.1-27b",
  "perplexity/pplx-decider-v1.1-27b@openrouter",
  "cloudflare/clef-flash",
  "typesafe/jev-1.13",
  "openai/gpt-6-luna-decisions",
];

const client = createDecisionClient({
  privacyMode: "standard",
  env,
  onUsage: (model, result) =>
    console.error(`[ai-usage] page-route-decision-canary model=${model.id} input_tokens=${result.usage.inputTokens} output_tokens=${result.usage.outputTokens}`),
});

for (const id of ids) {
  const model = id.endsWith("@openrouter") ? pplxViaOpenRouter : catalog.find((m) => m.id === id);
  if (!model) { console.log(JSON.stringify({ model: id, healthy: null, error: "not in catalog / key missing" })); continue; }
  try {
    const r = await runCanary(client, model);
    history.recordVerdict(id, r);
    const reentry = history.reentryStatus(id);
    console.log(JSON.stringify({ model: id, endpoint: model.endpoint, healthy: r.healthy, noul: r.noul, choice: r.choice, reentry, reason: r.reason, reading: r.reading, latencyMs: r.latencyMs, inputTokens: r.inputTokens, costUsd: r.costCents / 100 }));
  } catch (error) {
    history.recordError(id, error instanceof Error ? error.message : String(error));
    console.log(JSON.stringify({ model: id, endpoint: model.endpoint, healthy: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }));
  }
}
