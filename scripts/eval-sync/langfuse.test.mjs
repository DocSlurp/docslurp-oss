import test from "node:test";
import assert from "node:assert/strict";
import { buildItems, createClient, syncDataset } from "./langfuse.mjs";
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
