import test from "node:test";
import assert from "node:assert/strict";
import { buildItems, buildRecordItems, createClient, syncDataset } from "./langfuse.mjs";
const spec = { name: "sample-development-v1", split: "development", cases: [{ id: "one", question: "A question?", expectedAnswer: "An answer" }], sourceHashes: { cases: "abc" }, commit: "commit" };
test("stable IDs separate datasets and preserve evidence identity", () => {
  const a = buildItems(spec)[0];
  assert.equal(a.id, buildItems(spec)[0].id);
  assert.notEqual(a.id, buildItems({ ...spec, name: "sample-development-v2" })[0].id);
  assert.equal(a.metadata.sourceCommit, "commit");
  assert.deepEqual(a.expectedOutput, { expectedAnswer: "An answer" });
  assert.throws(() => buildItems({ ...spec, split: "heldout" }), /split/);
  assert.throws(() => buildItems({ ...spec, cases: [{ ...spec.cases[0], split: "heldout" }] }), /Mixed/);
  assert.throws(() => buildItems({ ...spec, cases: [...spec.cases, ...spec.cases] }), /duplicate/);
});
test("remote sync verifies readback and a repeated sync creates no writes", async () => {
  let dataset = null; const items = new Map(); let writes = 0;
  const api = async (path, body) => {
    if (body) writes++;
    if (path === "/v2/datasets") return dataset = { id: "dataset", ...body };
    if (path.startsWith("/v2/datasets/")) return dataset ? { ...dataset, items: [...items.values()] } : null;
    if (path.startsWith("/dataset-items?")) return { data: [...items.values()], meta: { totalPages: 1 } };
    if (path === "/dataset-items") { const value = { ...structuredClone(body), datasetId: "dataset" }; items.set(body.id, value); return value; }
    return items.get(path.split("/").at(-1)) ?? null;
  };
  const input = { ...spec, items: buildItems(spec) };
  assert.equal((await syncDataset(api, input)).created, 1);
  const before = writes;
  assert.equal((await syncDataset(api, input)).unchanged, 1);
  assert.equal(writes, before);
  // A manually edited label can retain stale sync metadata. Repair it too.
  items.get(input.items[0].id).expectedOutput = { expectedAnswer: "Corrupted label" };
  assert.equal((await syncDataset(api, input)).updated, 1);
});
test("HTTP failures never expose provider bodies or credentials", async () => {
  const api = createClient({ baseUrl: "https://example.com", publicKey: "secret-user", secretKey: "secret-password", fetchImpl: async () => ({ status: 401, ok: false, text: async () => "secret-password" }) });
  await assert.rejects(api("/v2/datasets"), { message: "Langfuse HTTP 401 (response body redacted)" });
  assert.throws(() => createClient({ baseUrl: "https://user:secret@example.com", publicKey: "x", secretKey: "y" }), /HTTPS/);
});

test("separate gold fails closed on missing, empty or mismatched labels", () => {
  for (const gold of [[], [{ id: "other", answer: "value" }]]) {
    assert.throws(() => buildItems({ ...spec, gold }), /label every case/);
  }
  const labeled = buildItems({ ...spec, gold: [{ id: "one", answer: "value" }] });
  assert.deepEqual(labeled[0].expectedOutput, { id: "one", answer: "value" });
});

// ---------- dual-target, held-out guard, score configs, idempotency, runs ----------
import { mkdtemp, writeFile as write } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTuningReadable, datasetNameFor, isHeldoutSplit } from "./langfuse.mjs";
import { runSync } from "./sync.mjs";
import { desiredScoreConfigs, syncScoreConfigs } from "./score-configs.mjs";
import { otlpPayload, prepareRun, syncRun } from "./runs.mjs";

/** In-memory stand-in for the subset of the Langfuse public API the sync uses. */
function fakeLangfuse({ failOn = null } = {}) {
  const state = { datasets: new Map(), items: new Map(), configs: new Map(), spans: new Map(), scores: new Map(), writes: [], patches: 0 };
  const api = async (path, body, { method } = {}) => {
    const [route, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    if (body) state.writes.push(route);
    if (failOn && failOn(route, body)) throw new Error("Langfuse HTTP 500 (response body redacted)");
    if (method === "PATCH") { state.patches++; throw new Error("PATCH not allowed in tests"); }
    if (route === "/v2/datasets" && body) { const prev = state.datasets.get(body.name); const d = { id: prev?.id ?? `ds-${state.datasets.size + 1}`, ...body }; state.datasets.set(body.name, d); return d; }
    if (route.startsWith("/v2/datasets/")) return state.datasets.get(decodeURIComponent(route.slice(13))) ?? null;
    if (route === "/dataset-items" && body) { const ds = state.datasets.get(body.datasetName); const v = { ...structuredClone(body), datasetId: ds.id }; state.items.set(body.id, v); return v; }
    if (route === "/dataset-items") { const ds = state.datasets.get(params.get("datasetName")); const all = [...state.items.values()].filter((i) => i.datasetId === ds?.id); const limit = Number(params.get("limit")), page = Number(params.get("page")); return { data: all.slice((page - 1) * limit, page * limit), meta: { totalPages: Math.max(1, Math.ceil(all.length / limit)) } }; }
    if (route.startsWith("/dataset-items/")) return state.items.get(route.split("/").at(-1)) ?? null;
    if (route === "/score-configs" && body) { const c = { id: `sc-${state.configs.size + 1}`, isArchived: false, ...body }; state.configs.set(c.id, c); return c; }
    if (route === "/score-configs") return { data: [...state.configs.values()], meta: { totalPages: 1 } };
    if (route.startsWith("/score-configs/")) return state.configs.get(route.split("/").at(-1)) ?? null;
    if (route === "/otel/v1/traces") { for (const span of body.resourceSpans[0].scopeSpans[0].spans) state.spans.set(span.spanId, span); return {}; }
    if (route === "/scores") { state.scores.set(body.id, body); return { id: body.id }; }
    if (route === "/experiment-items") {
      const attrs = (s) => Object.fromEntries(s.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
      const rows = [...state.spans.values()].map(attrs).filter((a) => a["langfuse.experiment.id"] === params.get("experimentId")).map((a) => ({
        experimentItemId: a["langfuse.experiment.item.id"],
        experimentItemMetadata: { outputSha256: a["langfuse.experiment.item.metadata.outputSha256"] },
        scores: [...state.scores.values()].filter((s) => s.observationId === a["langfuse.experiment.item.root_observation_id"]).map((s) => ({ name: s.name })),
      }));
      return { data: rows, meta: {} };
    }
    throw new Error(`fake: unhandled ${route}`);
  };
  return { api, state };
}

async function fixtureManifest({ heldout = true, destinations = ["a", "b"] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "eval-sync-test-"));
  const entries = [
    { id: "doc-1", split: "development", asset: { path: "inputs/doc-1.pdf", sha256: "x" }, reference: { path: "references/doc-1.json" }, expect: [{ type: "anchor", value: "alpha" }] },
    { id: "doc-2", split: "calibration", asset: { path: "inputs/doc-2.pdf", sha256: "y" }, reference: { path: "references/doc-2.json" } },
    ...(heldout ? [{ id: "doc-3", split: "test", asset: { path: "inputs/doc-3.pdf", sha256: "z" }, reference: { path: "references/doc-3.json" } }] : []),
  ];
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "references"));
  for (const entry of entries) await write(join(dir, entry.reference.path), JSON.stringify({ pages: [{ markdown: `# ${entry.id}` }] }));
  await write(join(dir, "catalog.json"), JSON.stringify({ schema: "extract-eval-catalog@v1", entries }));
  const manifest = join(dir, "manifest.json");
  await write(manifest, JSON.stringify({ sourceCommit: "fixture", authorization: { destinations, scope: "test fixture" }, datasets: [{ kind: "catalog", prefix: "fixture/corpus-v1", catalog: "catalog.json", license: "CC0-1.0 synthetic" }] }));
  return { dir, manifest };
}
const targetsFor = (fakes) => async (target) => ({ api: fakes[target.name].api, baseUrl: `fake://${target.name}`, via: "fake", tunnelPid: null, close: async () => {} });
async function targetConfig(dir) {
  const path = join(dir, "targets.json");
  await write(path, JSON.stringify({ targets: { a: { envFile: "a.env" }, b: { envFile: "b.env" } } }));
  return path;
}

test("split policy: held-out splits get separate, explicitly named datasets that tuning tools refuse", () => {
  assert.equal(datasetNameFor("x/wild-v2", "development"), "x/wild-v2/development");
  assert.equal(datasetNameFor("x/wild-v2", "test"), "x/wild-v2/test-heldout");
  assert.equal(isHeldoutSplit("holdout"), true);
  assert.throws(() => isHeldoutSplit("mystery"), /Unknown split/);
  assert.throws(() => buildItems({ ...spec, name: "sample-test-v1", split: "test" }), /heldout/);
  assert.throws(() => assertTuningReadable({ name: "x/test-heldout", metadata: { heldout: true } }), /Refusing/);
  assert.throws(() => assertTuningReadable({ name: "legacy-development-v1", metadata: {} }), /Refusing/);
  assert.ok(assertTuningReadable({ name: "x/development", metadata: { heldout: false, tuningReadable: true } }));
});

test("held-out guard: --allow-heldout must name each target; --exclude-heldout skips explicitly", async () => {
  const { dir, manifest } = await fixtureManifest();
  const config = await targetConfig(dir);
  const refused = await runSync({ config, manifest: [manifest], run: [] }, { commit: "c" });
  assert.equal(refused.ok, false);
  assert.equal(refused.summary.refused.length, 2);
  const partial = await runSync({ config, manifest: [manifest], run: [], allowHeldout: "a" }, { commit: "c" });
  assert.deepEqual(partial.summary.refused.map((r) => r.split(":")[0]), ["b"]);
  await assert.rejects(runSync({ config, manifest: [manifest], run: [], allowHeldout: "nope" }, { commit: "c" }), /unknown target/);
  const fakes = { a: fakeLangfuse(), b: fakeLangfuse() };
  const written = await runSync({ config, manifest: [manifest], run: [], write: true, excludeHeldout: true }, { commit: "c", connectTarget: targetsFor(fakes) });
  assert.equal(written.ok, true);
  assert.ok(![...fakes.a.state.datasets.keys()].some((name) => name.includes("heldout")));
  assert.equal(written.results[0].datasets.find((d) => d.name.endsWith("test-heldout")).skipped, "heldout-excluded");
  const unauthorised = await fixtureManifest({ heldout: false, destinations: ["a"] });
  const result = await runSync({ config, manifest: [unauthorised.manifest], run: [], write: true }, { commit: "c", connectTarget: targetsFor({ a: fakeLangfuse(), b: fakeLangfuse() }) });
  assert.equal(result.ok, false);
  assert.match(result.results[1].datasets[0].error, /authorization\.destinations/);
});

test("dual-target sync: a failing target is reported without stopping the other, and exit is non-zero", async () => {
  const { dir, manifest } = await fixtureManifest();
  const config = await targetConfig(dir);
  const fakes = { a: fakeLangfuse({ failOn: (route) => route === "/dataset-items" }), b: fakeLangfuse() };
  const result = await runSync({ config, manifest: [manifest], run: [], write: true, allowHeldout: "a,b" }, { commit: "c", connectTarget: targetsFor(fakes) });
  assert.equal(result.ok, false);
  const [a, b] = result.summary.targets;
  assert.equal(a.ok, false); assert.equal(a.datasetErrors, 3);
  assert.equal(b.ok, true); assert.equal(b.itemsCreated, 3); assert.equal(b.datasetsCreated, 3);
  const down = await runSync({ config, manifest: [manifest], run: [], write: true, allowHeldout: "a,b" }, { commit: "c", connectTarget: async (target) => { if (target.name === "a") throw new Error("tunnel refused"); return targetsFor(fakes)(target); } });
  assert.equal(down.ok, false);
  assert.match(down.summary.targets[0].errors[0], /tunnel refused/);
  assert.equal(down.summary.targets[1].ok, true);
});

test("idempotent re-run: second dual-target write has zero creates and updates", async () => {
  const { dir, manifest } = await fixtureManifest();
  const config = await targetConfig(dir);
  const fakes = { a: fakeLangfuse(), b: fakeLangfuse() };
  const args = { config, manifest: [manifest], run: [], write: true, allowHeldout: "a,b" };
  const first = await runSync(args, { commit: "c", connectTarget: targetsFor(fakes) });
  assert.equal(first.ok, true);
  const writes = fakes.a.state.writes.length + fakes.b.state.writes.length;
  const second = await runSync(args, { commit: "c", connectTarget: targetsFor(fakes) });
  for (const t of second.summary.targets) { assert.equal(t.itemsCreated + t.itemsUpdated + t.datasetsCreated + t.datasetsMetadataUpdated, 0); assert.equal(t.itemsUnchanged, 3); }
  assert.equal(fakes.a.state.writes.length + fakes.b.state.writes.length, writes);
  const heldout = [...fakes.b.state.datasets.values()].find((d) => d.name.endsWith("test-heldout"));
  assert.equal(heldout.metadata.heldout, true); assert.equal(heldout.metadata.tuningReadable, false);
  const item = [...fakes.b.state.items.values()].find((i) => i.metadata.caseId === "doc-1");
  assert.deepEqual(item.expectedOutput.reference.content, { pages: [{ markdown: "# doc-1" }] });
});

const registry = (description = "Token F1 of content") => ({ scorers: [{ id: "judge", version: "3.5", prefix: "judge-v3.5", description: "Frozen judge", code: { repo: "o/r", path: "s.py", commit: "abcdef1", sourceSha256: "f".repeat(64) }, components: [{ name: "contentTokenF1", dataType: "NUMERIC", min: 0, max: 1, description }, { name: "pass", dataType: "BOOLEAN", description: "All checks" }] }, { id: "v4", version: "4.0", prefix: "fidelity-v4.0", description: "Draft", status: "pending", pendingReason: "uncommitted", code: {}, components: [] }] });

test("score configs are versioned by name: unchanged on re-run, conflicts are never patched, new versions add configs", async () => {
  const { api, state } = fakeLangfuse();
  const desired = desiredScoreConfigs(registry());
  assert.deepEqual(desired.skipped, [{ scorer: "v4@4.0", reason: "uncommitted" }]);
  assert.equal((await syncScoreConfigs(api, desired.configs)).created, 2);
  const again = await syncScoreConfigs(api, desired.configs);
  assert.equal(again.created, 0); assert.equal(again.unchanged, 2);
  assert.match([...state.configs.values()][0].description, /code=o\/r:s\.py@abcdef1 sha256=f{64}/);
  await assert.rejects(syncScoreConfigs(api, desiredScoreConfigs(registry("Changed semantics")).configs), /bump the scorer version/);
  assert.equal(state.patches, 0);
  const bumped = registry("Changed semantics"); bumped.scorers[0].version = "3.6"; bumped.scorers[0].prefix = "judge-v3.6";
  assert.equal((await syncScoreConfigs(api, desiredScoreConfigs(bumped).configs)).created, 2);
  assert.equal(state.configs.size, 4);
  const long = registry(); long.scorers[0].prefix = "an-extremely-long-scorer-prefix-v1";
  assert.throws(() => desiredScoreConfigs(long), /at most 35/);
  const learned = registry(); learned.scorers[0].kind = "learned";
  assert.throws(() => desiredScoreConfigs(learned), /model and promptVersion/);
});

test("run upload links experiment items to dataset items, attaches scores and re-runs with zero writes", async () => {
  const { api, state } = fakeLangfuse();
  const items = buildRecordItems({ name: "fixture/corpus-v1/development", split: "development", records: [{ id: "doc-1", split: "development", input: { caseId: "doc-1" }, expectedOutput: null, metadata: {} }], commit: "c" });
  await syncDataset(api, { name: "fixture/corpus-v1/development", split: "development", items, sourceHashes: {}, commit: "c" });
  await syncScoreConfigs(api, desiredScoreConfigs(registry()).configs);
  const run = { schema: "docslurp-eval-run@v1", experiment: { name: "arm-x judge-v3.5" }, dataset: { name: "fixture/corpus-v1/development", split: "development" }, startedAt: "2026-10-26T10:00:00Z", endedAt: "2026-10-26T10:01:00Z", timing: "scoring-window", items: [{ caseId: "doc-1", output: { markdown: "# doc-1" }, scores: { "judge-v3.5.contentTokenF1": 0.9, "judge-v3.5.pass": true, "judge-v3.5.mathPartial": null } }] };
  const prepared = prepareRun(run, { manifestSha256: "m" });
  const payload = otlpPayload(prepared, "ds-1");
  const attrs = Object.fromEntries(payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a) => [a.key, Object.values(a.value)[0]]));
  assert.equal(attrs["langfuse.experiment.item.id"], items[0].id);
  assert.equal(attrs["langfuse.experiment.item.root_observation_id"], prepared.items[0].spanId);
  assert.equal(attrs["langfuse.experiment.dataset.id"], "ds-1");
  assert.equal(payload.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano, "1793008800000000000");
  const first = await syncRun(api, prepared, { sleep: async () => {} });
  assert.equal(first.itemsWritten, 1); assert.equal(first.scoresWritten, 2);
  const [score] = state.scores.values();
  assert.equal(score.traceId, prepared.items[0].traceId); assert.equal(score.observationId, prepared.items[0].spanId); assert.ok(score.configId);
  const writes = state.writes.length;
  const second = await syncRun(api, prepared, { sleep: async () => {} });
  assert.equal(second.itemsWritten + second.scoresWritten, 0);
  assert.equal(state.writes.length, writes);
  assert.throws(() => prepareRun({ ...run, startedAt: undefined }, { manifestSha256: "m" }), /ISO timestamp/);
  const heldout = prepareRun({ ...run, dataset: { name: "fixture/corpus-v1/test-heldout", split: "test" } }, { manifestSha256: "m" });
  await assert.rejects(syncRun(api, heldout), /allow-heldout/);
  await assert.rejects(syncRun(api, prepareRun({ ...run, items: [{ caseId: "unknown", scores: {} }] }, { manifestSha256: "m" })), /no dataset item/);
});

test("tunnel: opened per target, health-checked, and closed by signalling exactly its own child", async () => {
  const { EventEmitter } = await import("node:events");
  const { openTunnel } = await import("./targets.mjs");
  const signals = []; let spawned;
  const spawnImpl = (command, args) => { const child = new EventEmitter(); child.pid = 4242; child.stderr = new EventEmitter(); child.kill = (signal) => { signals.push([child.pid, signal]); queueMicrotask(() => child.emit("exit", null, signal)); }; spawned = { command, args }; return child; };
  const tunnel = await openTunnel({ sshHost: "user@host", remotePort: 3000, localPort: 45678 }, { settleMs: 1, spawnImpl, fetchImpl: async () => ({ ok: true, json: async () => ({ version: "4.59.0" }) }) });
  assert.equal(spawned.command, "ssh");
  assert.ok(spawned.args.includes("127.0.0.1:45678:127.0.0.1:3000") && spawned.args.includes("BatchMode=yes"));
  assert.deepEqual([tunnel.baseUrl, tunnel.pid, tunnel.version], ["http://127.0.0.1:45678", 4242, "4.59.0"]);
  await tunnel.close();
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
});

test("strings with control characters Langfuse would strip are wrapped losslessly", async () => {
  const { dir, manifest } = await fixtureManifest({ heldout: false });
  const bad = "broken\u0003tounicode \\begin{x}\u007f\u0097\ud83d\ude00";
  await write(join(dir, "references/doc-1.json"), JSON.stringify({ pages: [{ markdown: bad, ok: "fine \\u0003 text" }] }));
  const { loadManifest } = await import("./adapters.mjs");
  const { decodeUnsafe, hasUnsafeControlChars } = await import("./langfuse.mjs");
  const { datasets } = await loadManifest(manifest);
  const item = datasets.find((d) => d.split === "development").items[0];
  const page = item.expectedOutput.reference.content.pages[0];
  assert.ok(/^[\x20-\x7e]*$/.test(page.markdown.$asciiJson));
  assert.equal(page.ok, "fine \\u0003 text");
  assert.equal(hasUnsafeControlChars(item), false);
  assert.equal(decodeUnsafe(item.expectedOutput).reference.content.pages[0].markdown, bad);
  const plain = datasets.find((d) => d.split === "calibration").items[0].expectedOutput.reference;
  assert.deepEqual(plain.content, { pages: [{ markdown: "# doc-2" }] });
});

test("council fixes: held-out mirrors, contained paths, split relabelling, policy metadata, run authorization, ssh options", async () => {
  const { loadManifest } = await import("./adapters.mjs");
  const { openTunnel } = await import("./targets.mjs");
  const { encodeUnsafe, decodeUnsafe } = await import("./langfuse.mjs");
  const { dir } = await fixtureManifest({ heldout: false });
  const config = await targetConfig(dir);
  const auth = { destinations: ["a", "b"], scope: "t" };
  const man = async (name, datasets) => { const p = join(dir, name); await write(p, JSON.stringify({ sourceCommit: "c", authorization: auth, datasets })); return p; };

  // A held-out mirror is refused for targets not named by --allow-heldout, and excluded with --exclude-heldout.
  const mirror = await man("mirror.json", [{ kind: "mirror", name: "p/test-heldout", split: "test", fromTarget: "a", license: "x" }]);
  const fakes = { a: fakeLangfuse(), b: fakeLangfuse() };
  await fakes.a.api("/v2/datasets", { name: "p/test-heldout", metadata: { split: "test", heldout: true } });
  await fakes.a.api("/dataset-items", { id: "i1", datasetName: "p/test-heldout", input: {}, metadata: { split: "test" } });
  const refused = await runSync({ config, manifest: [mirror], run: [], write: true, targets: "b" }, { commit: "c", connectTarget: targetsFor(fakes) });
  assert.equal(refused.ok, false); assert.equal(fakes.b.state.datasets.size, 0);
  const excluded = await runSync({ config, manifest: [mirror], run: [], write: true, targets: "b", excludeHeldout: true }, { commit: "c", connectTarget: targetsFor(fakes) });
  assert.equal(excluded.results[0].datasets[0].skipped, "heldout-excluded"); assert.equal(fakes.b.state.datasets.size, 0);
  await assert.rejects(man("bad-mirror.json", [{ kind: "mirror", name: "p/test", split: "test", fromTarget: "a", license: "x" }]).then((p) => loadManifest(p)), /heldout/);

  // Catalog paths must stay inside the corpus root.
  await write(join(dir, "secret.txt"), "SECRET=1");
  await write(join(dir, "evil-catalog.json"), JSON.stringify({ entries: [{ id: "e", split: "development", reference: { path: "../secret.txt" } }] }));
  const { mkdir } = await import("node:fs/promises"); await mkdir(join(dir, "sub"), { recursive: true });
  await write(join(dir, "sub/catalog.json"), JSON.stringify({ entries: [{ id: "e", split: "development", reference: { path: "../secret.txt" } }] }));
  await assert.rejects(man("evil.json", [{ kind: "catalog", prefix: "e", catalog: "sub/catalog.json", license: "x" }]).then((p) => loadManifest(p)), /escapes the corpus root/);
  await write(join(dir, "sub/catalog.json"), JSON.stringify({ entries: [{ id: "e", split: "development", reference: { path: join(dir, "secret.txt") } }] }));
  await assert.rejects(loadManifest(join(dir, "evil.json")), /must be relative/);

  // Held-out query rows cannot be relabelled as tuning data.
  await write(join(dir, "q.jsonl"), JSON.stringify({ id: "q1", text: "?", split: "heldout", qrels: { d: 1 } }) + "\n" + JSON.stringify({ id: "q2", text: "?", split: "development", qrels: { d: 1 } }) + "\n");
  await assert.rejects(man("q1.json", [{ kind: "queries", prefix: "q", queries: "q.jsonl", splitMap: { heldout: "development" }, license: "x" }]).then((p) => loadManifest(p)), /relabel/);
  await assert.rejects(man("q2.json", [{ kind: "queries", prefix: "q", queries: "q.jsonl", split: "test", license: "x" }]).then((p) => loadManifest(p)), /contradicts held-out/);
  await assert.rejects(man("m.json", [{ kind: "catalog", prefix: "f", catalog: "catalog.json", license: "x", metadata: { heldout: false } }]).then((p) => loadManifest(p)), /set by the sync/);

  // Runs inherit their dataset's authorization.
  const { api } = fakeLangfuse();
  const items = buildRecordItems({ name: "f/development", split: "development", records: [{ id: "doc-1", split: "development", input: {}, metadata: {} }], commit: "c" });
  await syncDataset(api, { name: "f/development", split: "development", items, sourceHashes: {}, commit: "c", datasetMetadata: { authorization: { destinations: ["a"] } } });
  const run = prepareRun({ schema: "docslurp-eval-run@v1", experiment: { name: "x" }, dataset: { name: "f/development", split: "development" }, startedAt: "2026-10-26T10:00:00Z", endedAt: "2026-10-26T10:01:00Z", timing: "t", items: [{ caseId: "doc-1", scores: {} }] }, { manifestSha256: "m" });
  await assert.rejects(syncRun(api, run, { targetName: "b" }), /not authorised for target b/);
  assert.throws(() => prepareRun({ schema: "docslurp-eval-run@v1", experiment: { name: "x" }, dataset: { name: "f/development", split: "development" }, startedAt: "2026-10-26T10:00:00Z", endedAt: "2026-10-26T10:01:00Z", timing: "t", items: [{ caseId: "doc-1", startedAt: "2026-10-26T09:00:00Z" }] }, { manifestSha256: "m" }), /outside the run window/);

  // ssh fields are allow-listed; a dead ssh behind a squatting listener is detected.
  await assert.rejects(openTunnel({ sshHost: "h", remotePort: 3000, sshOptions: ["-o", "ProxyCommand=sh -c id"] }), /allow-list/);
  await assert.rejects(openTunnel({ sshHost: "-oProxyCommand=x", remotePort: 3000 }), /\[user@\]host/);
  const { EventEmitter } = await import("node:events");
  const dying = () => { const c = new EventEmitter(); c.pid = 1; c.stderr = new EventEmitter(); c.kill = () => {}; setTimeout(() => c.emit("exit", 255, null), 5); return c; };
  await assert.rejects(openTunnel({ sshHost: "h", remotePort: 3000, localPort: 1 }, { spawnImpl: dying, settleMs: 20, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /another listener|exited/);

  // Source data shaped like a wrapper survives a round trip.
  const tricky = { $asciiJson: "\"not a wrapper\"" };
  assert.deepEqual(decodeUnsafe(encodeUnsafe(tricky)), tricky);
});
