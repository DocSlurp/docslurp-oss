import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { loadAssets, syncAssets, syncEvaluator, syncPrompt, validateAssets } from "./assets.mjs";

const fixture = new URL("./content-safety/manifest.json", import.meta.url);
function store() {
  const prompts = new Map(), evaluators = new Map();
  let writes = 0;
  const api = async (path, body) => {
    if (body) writes++;
    if (path === "/v2/prompts") {
      const value = { ...structuredClone(body), version: prompts.size + 1 };
      for (const label of body.labels) prompts.set(`${encodeURIComponent(body.name)}?label=${label}&resolve=false`, value);
      return value;
    }
    if (path.startsWith("/v2/prompts/")) return prompts.get(path.slice("/v2/prompts/".length)) ?? null;
    if (path.startsWith("/v2/evaluators?")) return { data: [...evaluators.values()], meta: {} };
    if (path === "/v2/evaluators") {
      const value = { ...structuredClone(body), id: `e${evaluators.size}`, version: 1, status: "active" };
      evaluators.set(value.id, value); return value;
    }
    if (path.startsWith("/v2/evaluators/")) return evaluators.get(path.split("/").at(-1));
    throw new Error(`Unexpected API path ${path}`);
  };
  return { api, prompts, evaluators, writes: () => writes };
}
test("repeated assets sync does not duplicate prompts or evaluators; versions remain immutable", async () => {
  const { manifest } = await loadAssets(fixture.pathname);
  const remote = store();
  const first = await syncAssets(remote.api, manifest, []);
  const writes = remote.writes();
  const second = await syncAssets(remote.api, manifest, []);
  assert.equal(remote.writes(), writes);
  assert.equal(second.prompts[0].version, first.prompts[0].version);
  assert.equal(second.evaluators[0].id, first.evaluators[0].id);
  const changed = { ...manifest.evaluators[0], sourceCode: manifest.evaluators[0].sourceCode + "\n// version two" };
  const next = await syncEvaluator(remote.api, changed, manifest.sourceCommit);
  assert.notEqual(next.id, first.evaluators[0].id);
  assert.equal(remote.evaluators.size, manifest.evaluators.length + 1);
});
test("detects remote prompt drift and duplicate evaluator names", async () => {
  const { manifest } = await loadAssets(fixture.pathname);
  const remote = store();
  await syncPrompt(remote.api, manifest.prompts[0], manifest.sourceCommit);
  [...remote.prompts.values()][0].prompt = "changed elsewhere";
  await assert.rejects(syncPrompt(remote.api, manifest.prompts[0], manifest.sourceCommit), /drift/);
  await syncEvaluator(remote.api, manifest.evaluators[0], manifest.sourceCommit);
  remote.evaluators.set("duplicate", { ...[...remote.evaluators.values()][0], id: "duplicate" });
  await assert.rejects(syncEvaluator(remote.api, manifest.evaluators[0], manifest.sourceCommit), /Ambiguous/);
});
test("rejects automatic production promotion, unreviewed holdout and implicit judge model", async () => {
  const { manifest } = await loadAssets(fixture.pathname);
  const production = structuredClone(manifest); production.prompts[0].labels = ["production"];
  assert.throws(() => validateAssets(production), /promote/);
  const heldout = structuredClone(manifest); heldout.datasets[0].split = "heldout";
  assert.throws(() => validateAssets(heldout), /human reviewed/);
  const judge = structuredClone(manifest); judge.evaluators = [{ name: manifest.namespace + "/judge", type: "llm_as_judge", prompt: "policy", outputDefinition: {} }];
  assert.throws(() => validateAssets(judge), /explicit model/);
});
test("unavailable evaluator API fails before any writes", async () => {
  const { manifest } = await loadAssets(fixture.pathname);
  let writes = 0;
  await assert.rejects(syncAssets(async (_, body) => { if (body) writes++; return null; }, manifest, []), /unavailable/);
  assert.equal(writes, 0);
});
test("native prompt normalization and paused status are retained", async () => {
  const { manifest } = await loadAssets(fixture.pathname);
  const remote = store();
  const wrapped = async (path, body) => {
    const result = await remote.api(path, body);
    if (result?.type === "llm_as_judge") return { ...result, prompt: [{ role: "user", content: result.prompt }], status: "paused", pausedReason: "LLM_CONNECTION_MISSING" };
    return result;
  };
  const report = await syncAssets(wrapped, manifest, []);
  assert.equal(report.complete, true);
  assert.equal(report.runtimeReady, false);
  assert.equal(report.evaluators[1].pausedReason, "LLM_CONNECTION_MISSING");
  assert.ok(report.prompts.every(p => p.label.length <= 36));
});
test("disabled native code evaluator is reported while other assets continue", async () => {
  const { manifest } = await loadAssets(fixture.pathname);
  const remote = store();
  const report = await syncAssets(async (path, body) => {
    if (body?.type === "code") throw new Error("Langfuse HTTP 412 (response body redacted)");
    return remote.api(path, body);
  }, manifest, []);
  assert.equal(report.complete, false);
  assert.equal(report.runtimeReady, false);
  assert.equal(report.failures.length, 1);
  assert.equal(report.evaluators.length, 1);
});
test("reference scorer does not count abstentions or malformed output as autonomous success", async () => {
  const source = await readFile(new URL("./content-safety/decision-evaluator.js", import.meta.url), "utf8");
  const evaluate = vm.runInNewContext(`${source}; evaluate`);
  const run = (expected, output) => Object.fromEntries(evaluate({ observation: { output }, experiment: { itemExpectedOutput: { decision: expected } } }).scores.map(s => [s.name, s.value]));
  assert.equal(run("allow", { decision: "block" })["safety.false_positive"], true);
  assert.equal(run("block", { decision: "allow" })["safety.false_negative"], true);
  assert.equal(run("review_required", { decision: "review_required" })["safety.autonomous_correct"], false);
  assert.equal(run("block", "bad JSON")["safety.unresolved"], true);
  assert.throws(() => run(undefined, { decision: "allow" }), /reference/);
});
