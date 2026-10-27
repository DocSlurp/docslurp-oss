// Harness run manifest -> Langfuse experiment (dataset run) linked to dataset items, plus scores.
// Contract (checked 2026-10-26): experiments are synthesised from OTLP spans carrying `langfuse.experiment.*`
// attributes, POSTed to /api/public/otel/v1/traces with `x-langfuse-ingestion-version: 4`; scores go to
// POST /api/public/scores against the item's root observation; readback uses GET /experiments and
// GET /experiment-items. POST /dataset-run-items and POST /ingestion trace events are deprecated and unused.
// https://langfuse.com/integrations/native/opentelemetry/experiments
// https://langfuse.com/faq/all/deprecated-api-migration
import { readFile } from "node:fs/promises";
import { assertSplitName, encodeUnsafe, hash, itemId, listDatasetItems, stableJson } from "./langfuse.mjs";

export const RUN_SCHEMA = "docslurp-eval-run@v1";
const iso = (value, label) => { const ms = Date.parse(value); if (!Number.isFinite(ms)) throw new Error(`Run ${label} must be an ISO timestamp from the actual run`); return ms; };
const nanos = (ms) => (BigInt(ms) * 1_000_000n).toString();
const attr = (key, value) => ({ key, value: typeof value === "number" ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }) : typeof value === "boolean" ? { boolValue: value } : { stringValue: typeof value === "string" ? value : JSON.stringify(value) } });

/** Validate a run manifest and derive stable identities. Never invents timestamps, costs or outputs. */
export function prepareRun(run, { manifestSha256 }) {
  if (run.schema !== RUN_SCHEMA) throw new Error(`Run manifest schema must be ${RUN_SCHEMA}`);
  if (!run.experiment?.name || !run.dataset?.name || !run.dataset?.split) throw new Error("Run needs experiment.name, dataset.name and dataset.split");
  const heldout = assertSplitName(run.dataset.name, run.dataset.split);
  const started = iso(run.startedAt, "startedAt"), ended = iso(run.endedAt, "endedAt");
  if (ended < started) throw new Error("Run endedAt precedes startedAt");
  if (!run.timing) throw new Error("Run must state what its timestamps measure (timing)");
  if (!Array.isArray(run.items) || !run.items.length) throw new Error("Run has no items");
  const experimentId = `docslurp-exp-${hash(stableJson({ name: run.experiment.name, dataset: run.dataset.name, manifestSha256 })).slice(0, 32)}`;
  const seen = new Set();
  const items = run.items.map((item) => {
    if (typeof item.caseId !== "string" || seen.has(item.caseId)) throw new Error("Run items need unique caseId");
    seen.add(item.caseId);
    const itemStart = item.startedAt ? iso(item.startedAt, "item startedAt") : started;
    const itemEnd = item.endedAt ? iso(item.endedAt, "item endedAt") : ended;
    if (itemStart < started || itemEnd > ended || itemEnd < itemStart) throw new Error(`Item ${item.caseId} timing falls outside the run window`);
    const traceHash = hash(`${experimentId}\0${item.caseId}`);
    const scores = Object.entries(item.scores ?? {}).filter(([, value]) => value !== null && value !== undefined);
    if (scores.length > 50) throw new Error(`Item ${item.caseId} has more than 50 scores; readback is bounded to 50 per item`);
    for (const [name, value] of scores) if (typeof value !== "number" && typeof value !== "boolean") throw new Error(`Score ${name} for ${item.caseId} must be numeric or boolean`);
    return {
      caseId: item.caseId,
      datasetItemId: itemId(run.dataset.name, item.caseId),
      traceId: traceHash.slice(0, 32),
      spanId: traceHash.slice(32, 48),
      start: itemStart, end: itemEnd,
      input: encodeUnsafe(item.input ?? { caseId: item.caseId }),
      output: encodeUnsafe(item.output ?? null),
      outputSha256: hash(stableJson(item.output ?? null)),
      metadata: { ...encodeUnsafe(item.metadata ?? {}), caseId: item.caseId, notApplicableScores: Object.entries(item.scores ?? {}).filter(([, value]) => value === null || value === undefined).map(([name]) => name) },
      scores: scores.map(([name, value]) => ({ name, value: typeof value === "boolean" ? Number(value) : value })),
    };
  });
  return { experimentId, name: run.experiment.name, description: run.experiment.description ?? null, metadata: run.experiment.metadata ?? {}, dataset: run.dataset, heldout, started, ended, timing: run.timing, costs: run.costs ?? { usd: null, status: "not-recorded" }, scoredAt: run.scoredAt ?? run.endedAt, environment: run.environment ?? "experiment", manifestSha256, items };
}

export function otlpPayload(prepared, datasetId, items = prepared.items) {
  const experimentAttrs = [
    attr("langfuse.experiment.id", prepared.experimentId),
    attr("langfuse.experiment.name", prepared.name),
    attr("langfuse.experiment.dataset.id", datasetId),
    attr("langfuse.environment", prepared.environment),
    ...Object.entries({ ...prepared.metadata, timing: prepared.timing, costs: prepared.costs, runManifestSha256: prepared.manifestSha256, importer: "docslurp-eval-sync" }).map(([key, value]) => attr(`langfuse.experiment.metadata.${key}`, value)),
  ];
  const spans = items.map((item) => ({
    traceId: item.traceId,
    spanId: item.spanId,
    name: "experiment-item",
    kind: 1,
    startTimeUnixNano: nanos(item.start),
    endTimeUnixNano: nanos(item.end),
    status: { code: 1 },
    attributes: [
      ...experimentAttrs,
      ...(prepared.description ? [attr("langfuse.experiment.description", prepared.description)] : []),
      attr("langfuse.experiment.item.id", item.datasetItemId),
      attr("langfuse.experiment.item.root_observation_id", item.spanId),
      attr("langfuse.observation.input", item.input),
      attr("langfuse.observation.output", item.output),
      attr("langfuse.experiment.item.metadata.outputSha256", item.outputSha256),
      ...Object.entries(item.metadata).map(([key, value]) => attr(`langfuse.experiment.item.metadata.${key}`, value)),
    ],
  }));
  return { resourceSpans: [{ resource: { attributes: [attr("service.name", "docslurp-eval-sync")] }, scopeSpans: [{ scope: { name: "docslurp-eval-sync", version: "1" }, spans }] }] };
}

async function listExperimentItems(api, prepared) {
  const from = new Date(prepared.started - 60_000).toISOString();
  const out = new Map();
  let cursor = null, guard = 0;
  do {
    const query = new URLSearchParams({ experimentId: prepared.experimentId, fromStartTime: from, fields: "core,metadata,itemMetadata,scores", limit: "100", scoreLimit: "50", ...(cursor ? { cursor } : {}) });
    const page = await api(`/experiment-items?${query}`);
    if (!page || !Array.isArray(page.data)) throw new Error("Experiment item readback failed");
    for (const row of page.data) if (row.experimentItemId) out.set(row.experimentItemId, row);
    cursor = page.meta?.cursor ?? null;
  } while (cursor && ++guard < 1000);
  return out;
}
const remoteOutputSha = (row) => row?.experimentItemMetadata?.outputSha256 ?? null;
const remoteScoreNames = (row) => new Set((row?.scores ?? []).map((score) => score.name));
export const scoreId = (item, name) => `docslurp-score-${hash(`${item.traceId}:${name}`).slice(0, 40)}`;

/** Upload one prepared run to one target; idempotent and verified by readback. */
export async function syncRun(api, prepared, { targetName = null, allowHeldout = false, maxBatchBytes = 2_000_000, pollMs = 2000, timeoutMs = 300_000, batch = 25, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (prepared.heldout && !allowHeldout) throw new Error(`Run ${prepared.name} scores held-out dataset ${prepared.dataset.name}; this target is not named by --allow-heldout`);
  const dataset = await api(`/v2/datasets/${encodeURIComponent(prepared.dataset.name)}`);
  if (!dataset?.id) throw new Error(`Dataset ${prepared.dataset.name} is not synced to this target; sync datasets first`);
  if (Boolean(dataset.metadata?.heldout) !== prepared.heldout) throw new Error("Run and remote dataset disagree on held-out status");
  if (targetName && !(dataset.metadata?.authorization?.destinations ?? []).includes(targetName)) throw new Error(`Dataset ${prepared.dataset.name} is not authorised for target ${targetName}; runs inherit their dataset's authorization`);
  const remoteItems = await listDatasetItems(api, prepared.dataset.name);
  const missing = prepared.items.filter((item) => !remoteItems.has(item.datasetItemId));
  if (missing.length) throw new Error(`${missing.length} run items have no dataset item (first: ${missing[0].caseId})`);
  const configs = new Map();
  for (const config of await (await import("./score-configs.mjs")).listScoreConfigs(api)) if (!config.isArchived) configs.set(config.name, config);
  const scoreNames = new Set(prepared.items.flatMap((item) => item.scores.map((score) => score.name)));
  for (const name of scoreNames) if (!configs.has(name)) throw new Error(`Score config ${name} is not registered on this target`);

  let existing = await listExperimentItems(api, prepared);
  const stale = prepared.items.filter((item) => remoteOutputSha(existing.get(item.datasetItemId)) !== item.outputSha256);
  // Batch by count and by serialised size so large inline outputs never exceed request body limits.
  let chunk = [];
  const flush = async () => { if (chunk.length) await api("/otel/v1/traces", otlpPayload(prepared, dataset.id, chunk), { headers: { "x-langfuse-ingestion-version": "4" } }); chunk = []; };
  for (const item of stale) {
    const size = JSON.stringify(otlpPayload(prepared, dataset.id, [item])).length;
    if (size > maxBatchBytes) throw new Error(`Run item ${item.caseId} serialises to ${size} bytes, above the ${maxBatchBytes}-byte request bound`);
    if (chunk.length >= batch || JSON.stringify(otlpPayload(prepared, dataset.id, [...chunk, item])).length > maxBatchBytes) await flush();
    chunk.push(item);
  }
  await flush();
  const scoreWrites = [];
  for (const item of prepared.items) {
    const have = stale.includes(item) ? new Set() : remoteScoreNames(existing.get(item.datasetItemId));
    for (const score of item.scores) if (!have.has(score.name)) scoreWrites.push({ item, score });
  }
  for (const { item, score } of scoreWrites) {
    const config = configs.get(score.name);
    await api("/scores", { id: scoreId(item, score.name), traceId: item.traceId, observationId: item.spanId, name: score.name, value: score.value, configId: config.id, environment: prepared.environment, timestamp: prepared.scoredAt, metadata: { experimentId: prepared.experimentId, caseId: item.caseId, runManifestSha256: prepared.manifestSha256 } });
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stale.length || scoreWrites.length) existing = await listExperimentItems(api, prepared);
    const pendingItems = prepared.items.filter((item) => remoteOutputSha(existing.get(item.datasetItemId)) !== item.outputSha256);
    const pendingScores = prepared.items.filter((item) => item.scores.some((score) => !remoteScoreNames(existing.get(item.datasetItemId)).has(score.name)));
    if (!pendingItems.length && !pendingScores.length) break;
    if (Date.now() > deadline) throw new Error(`Experiment readback incomplete: ${pendingItems.length} items, ${pendingScores.length} items with missing scores`);
    await sleep(pollMs);
  }
  const before = prepared.items.length - stale.length;
  return { experiment: prepared.name, experimentId: prepared.experimentId, dataset: prepared.dataset.name, datasetId: dataset.id, heldout: prepared.heldout, items: prepared.items.length, itemsWritten: stale.length, itemsUnchanged: before, scoresWritten: scoreWrites.length, scoresTotal: prepared.items.reduce((n, item) => n + item.scores.length, 0), readbackVerified: true };
}

export async function loadRun(path) {
  const raw = await readFile(path, "utf8");
  return prepareRun(JSON.parse(raw), { manifestSha256: hash(raw) });
}
