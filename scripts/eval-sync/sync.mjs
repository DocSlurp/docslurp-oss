// Orchestrates datasets, score configs and runs across named targets. Each target is synced and verified
// independently: one target's failure is recorded and the next target still runs. Exit status is non-zero if any
// target failed anything.
import { writeFile } from "node:fs/promises";
import { loadManifest } from "./adapters.mjs";
import { gitHead, listDatasetItems, syncDataset } from "./langfuse.mjs";
import { loadRun, syncRun } from "./runs.mjs";
import { desiredScoreConfigs, loadRegistry, syncScoreConfigs } from "./score-configs.mjs";
import { connectTarget, loadTargets, parseAllowHeldout, selectTargets } from "./targets.mjs";

const message = (error) => String(error?.message ?? error).slice(0, 500);

async function legacyTargets(args) {
  // Single-target compatibility: --env-file [--base-url]. The target is called "default".
  return { targets: { default: { name: "default", envFile: args.envFile ?? null, baseUrl: args.baseUrl ?? null } }, defaults: {} };
}

export async function runSync(args, deps = {}) {
  const connect = deps.connectTarget ?? connectTarget;
  const config = args.config ? await loadTargets(args.config) : await legacyTargets(args);
  const targets = selectTargets(config.targets, args.targets);
  const allowHeldout = parseAllowHeldout(args.allowHeldout, config.targets);
  const commit = deps.commit ?? (() => { try { return gitHead(); } catch { return null; } })();
  const only = args.only ? args.only.split(",") : null;
  const manifests = [];
  for (const path of args.manifest) manifests.push(await loadManifest(path, { commit, onlyDatasets: only }));
  const datasets = args.skipDatasets ? [] : manifests.flatMap((manifest) => manifest.datasets.map((dataset) => ({ ...dataset, authorization: manifest.authorization })));
  const registry = args.scorers && !args.skipScoreConfigs ? desiredScoreConfigs(await loadRegistry(args.scorers), deps) : { configs: [], skipped: [] };
  const runs = [];
  for (const path of args.run) runs.push(await loadRun(path));
  if (args.outbox) await writeFile(args.outbox, JSON.stringify({ datasets: datasets.map(({ name, split, items, sourceHashes }) => ({ name, split, items, sourceHashes })) }, null, 2) + "\n", { mode: 0o600 });

  const plan = {
    datasets: datasets.map(({ name, split, heldout, items, mirror }) => ({ name, split, heldout: Boolean(heldout), items: mirror ? `mirror of ${mirror.fromTarget}` : items.length })),
    scoreConfigs: registry.configs.map(({ body, codeStatus }) => ({ name: body.name, dataType: body.dataType, codeStatus })),
    scoreConfigsSkipped: registry.skipped,
    runs: runs.map((run) => ({ name: run.name, dataset: run.dataset.name, heldout: run.heldout, items: run.items.length })),
  };
  const guard = (target, dataset) => {
    if (!dataset.authorization.destinations.includes(target.name)) return `target ${target.name} is not in this manifest's authorization.destinations`;
    if (dataset.heldout && !allowHeldout.has(target.name)) return args.excludeHeldout ? "excluded" : `held-out dataset; target ${target.name} is not named by --allow-heldout`;
    return null;
  };
  if (!args.write) {
    const perTarget = targets.map((target) => ({
      target: target.name,
      datasets: datasets.map((dataset) => ({ name: dataset.name, action: guard(target, dataset) ?? "sync" })),
    }));
    const refused = perTarget.flatMap((t) => t.datasets.filter((d) => d.action !== "sync" && d.action !== "excluded").map((d) => `${t.target}:${d.name}: ${d.action}`));
    const summary = { mode: "dry-run (no credentials loaded, no network)", commit, totals: { datasets: datasets.length, items: datasets.reduce((n, d) => n + (d.items?.length ?? 0), 0), heldoutDatasets: datasets.filter((d) => d.heldout).length, scoreConfigs: registry.configs.length, runs: runs.length }, plan, refused };
    return { ok: refused.length === 0, summary, perTarget };
  }

  const connections = new Map();
  const connectionErrors = new Map();
  const getConnection = async (target) => {
    if (connections.has(target.name)) return connections.get(target.name);
    if (connectionErrors.has(target.name)) throw connectionErrors.get(target.name);
    try { const c = await connect(target); connections.set(target.name, c); return c; }
    catch (error) { connectionErrors.set(target.name, error); throw error; }
  };
  const results = [];
  try {
    // Resolve mirrors from their source target first.
    for (const dataset of datasets.filter((d) => d.mirror)) {
      // Only read a mirror source when some selected target will actually receive the mirror.
      if (!targets.some((target) => target.name !== dataset.mirror.fromTarget && !guard(target, dataset))) continue;
      try {
        const source = config.targets[dataset.mirror.fromTarget];
        if (!source) throw new Error(`Mirror source target ${dataset.mirror.fromTarget} is not configured`);
        const { api } = await getConnection(source);
        const remote = await api(`/v2/datasets/${encodeURIComponent(dataset.name)}`);
        if (!remote) throw new Error("Mirror source dataset missing");
        if (remote.metadata?.split !== undefined && remote.metadata.split !== dataset.split) throw new Error("Mirror source dataset split differs from the manifest split");
        if (remote.metadata?.heldout !== undefined && Boolean(remote.metadata.heldout) !== dataset.heldout) throw new Error("Mirror source held-out flag differs from the manifest split");
        const sourceItems = [...(await listDatasetItems(api, dataset.name)).values()];
        if (sourceItems.some((item) => item.metadata?.split !== undefined && item.metadata.split !== dataset.split)) throw new Error("Mirror source items carry another split");
        dataset.items = sourceItems.map(({ id, input, expectedOutput, metadata, sourceTraceId, sourceObservationId }) => ({ id, datasetName: dataset.name, input, expectedOutput, metadata, ...(sourceTraceId ? { sourceTraceId } : {}), ...(sourceObservationId ? { sourceObservationId } : {}) }));
        dataset.sourceHashes = remote.metadata?.sourceHashes ?? null;
        dataset.commit = remote.metadata?.sourceCommit ?? dataset.commit;
        dataset.datasetMetadata = { ...dataset.datasetMetadata, mirroredFrom: dataset.mirror.fromTarget, mirroredDescription: remote.description ?? null };
      } catch (error) { dataset.mirrorError = message(error); }
    }
    for (const target of targets) {
      const result = { target: target.name, ok: true, via: null, tunnelPid: null, datasets: [], scoreConfigs: null, runs: [], errors: [] };
      results.push(result);
      let connection;
      try { connection = await getConnection(target); result.via = connection.via; result.baseUrl = connection.baseUrl; result.tunnelPid = connection.tunnelPid; }
      catch (error) { result.ok = false; result.errors.push(`connect: ${message(error)}`); continue; }
      for (const dataset of datasets) {
        const refusal = guard(target, dataset);
        if (refusal === "excluded") { result.datasets.push({ name: dataset.name, skipped: "heldout-excluded" }); continue; }
        if (refusal) { result.ok = false; result.datasets.push({ name: dataset.name, error: refusal }); continue; }
        if (dataset.mirror && dataset.mirror.fromTarget === target.name) { result.datasets.push({ name: dataset.name, source: true, remoteItems: dataset.items?.length ?? null, ...(dataset.mirrorError ? { error: dataset.mirrorError } : {}) }); if (dataset.mirrorError) result.ok = false; continue; }
        if (dataset.mirror && !dataset.items && !dataset.mirrorError) dataset.mirrorError = "mirror source not read";
        if (dataset.mirrorError) { result.ok = false; result.datasets.push({ name: dataset.name, error: `mirror: ${dataset.mirrorError}` }); continue; }
        try { result.datasets.push(await syncDataset(connection.api, { ...dataset, concurrency: config.defaults.concurrency ?? 6 })); }
        catch (error) { result.ok = false; result.datasets.push({ name: dataset.name, error: message(error) }); }
      }
      if (registry.configs.length) {
        try { result.scoreConfigs = await syncScoreConfigs(connection.api, registry.configs); }
        catch (error) { result.ok = false; result.scoreConfigs = { error: message(error), ...(error.partial ?? {}) }; }
      }
      if (!args.skipRuns) for (const run of runs) {
        try { result.runs.push(await syncRun(connection.api, run, { targetName: target.name, allowHeldout: allowHeldout.has(target.name), ...(deps.runOptions ?? {}) })); }
        catch (error) { result.ok = false; result.runs.push({ experiment: run.name, error: message(error) }); }
      }
    }
  } finally {
    for (const [name, connection] of connections) {
      try { await connection.close(); } catch (error) { const r = results.find((x) => x.target === name); if (r) { r.ok = false; r.errors.push(`close: ${message(error)}`); } }
    }
  }
  for (const [name] of connectionErrors) if (!results.some((r) => r.target === name)) results.push({ target: name, ok: false, errors: [`connect (mirror source): ${message(connectionErrors.get(name))}`] });
  const totals = (r) => ({
    datasets: r.datasets?.length ?? 0,
    datasetsCreated: r.datasets?.filter((d) => d.dataset === "created").length ?? 0,
    datasetsMetadataUpdated: r.datasets?.filter((d) => d.dataset === "updated").length ?? 0,
    itemsCreated: r.datasets?.reduce((n, d) => n + (d.created ?? 0), 0) ?? 0,
    itemsUpdated: r.datasets?.reduce((n, d) => n + (d.updated ?? 0), 0) ?? 0,
    itemsUnchanged: r.datasets?.reduce((n, d) => n + (d.unchanged ?? 0), 0) ?? 0,
    datasetErrors: r.datasets?.filter((d) => d.error).length ?? 0,
    scoreConfigsCreated: r.scoreConfigs?.created ?? 0,
    scoreConfigsUnchanged: r.scoreConfigs?.unchanged ?? 0,
    scoreConfigConflicts: r.scoreConfigs?.conflicts?.length ?? 0,
    runItemsWritten: r.runs?.reduce((n, x) => n + (x.itemsWritten ?? 0), 0) ?? 0,
    runItemsUnchanged: r.runs?.reduce((n, x) => n + (x.itemsUnchanged ?? 0), 0) ?? 0,
    runScoresWritten: r.runs?.reduce((n, x) => n + (x.scoresWritten ?? 0), 0) ?? 0,
    runErrors: r.runs?.filter((x) => x.error).length ?? 0,
  });
  const summary = {
    mode: "write", commit, at: new Date().toISOString(),
    targets: results.map((r) => ({ target: r.target, ok: r.ok, via: r.via, tunnelPid: r.tunnelPid, ...totals(r), errors: [...(r.errors ?? []), ...(r.datasets ?? []).filter((d) => d.error).map((d) => `${d.name}: ${d.error}`), ...(r.scoreConfigs?.error ? [`score-configs: ${r.scoreConfigs.error}`] : []), ...(r.runs ?? []).filter((x) => x.error).map((x) => `${x.experiment}: ${x.error}`)].slice(0, 50) })),
    scoreConfigsSkipped: registry.skipped,
    experimentsCreatedFromHistoricalSummaries: 0,
    llmCalls: 0,
  };
  return { ok: results.every((r) => r.ok), summary, results };
}
