import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEstimator } from "../js/index.mjs";

const fixture = new URL("../tests/fixtures/vector_page_in_text_doc.pdf", import.meta.url);
const blob = async () => new Blob([await readFile(fixture)]);

test("JSONL is incremental and consumer return releases the module session", async () => {
  const estimator = await createEstimator();
  const input = await blob();
  const stream = estimator.profileJsonl(input);
  assert.equal(JSON.parse((await stream.next()).value).t, "header");
  const other = estimator.profileJsonl(input);
  await assert.rejects(other.next(), /already active/);
  await stream.return();
  const records = [];
  for await (const line of estimator.profileJsonl(input, { batchPages: 1 })) {
    assert.equal(line.endsWith("\n"), true);
    records.push(JSON.parse(line));
  }
  assert.equal(records.at(-1).deepMeasured, 2);
  assert.equal(records.filter((r) => r.t === "pages").length, 2);
});

test("cancellation marks partial and permits another profile", async () => {
  const estimator = await createEstimator();
  const controller = new AbortController();
  const input = await blob();
  const stream = estimator.profileJsonl(input, { signal: controller.signal });
  await stream.next();
  controller.abort();
  assert.deepEqual(JSON.parse((await stream.next()).value), { t: "end", complete: false, reason: "cancelled" });
  await stream.return();
  const next = estimator.profileJsonl(input);
  assert.equal(JSON.parse((await next.next()).value).t, "header");
  await next.return();
});

test("invalid options and oversized input fail before a session is retained", async () => {
  const estimator = await createEstimator();
  const input = await blob();
  await assert.rejects(estimator.profileJsonl(input, { maxDeepPages: 1001 }).next(), /maxDeepPages/);
  const tooLarge = { size: 67108865, arrayBuffer() { throw new Error("must not read"); } };
  await assert.rejects(estimator.profileJsonl(tooLarge).next(), /64 MiB/);
  const stream = estimator.profileJsonl(input, { maxDeepPages: 0 });
  const records = [];
  for await (const line of stream) records.push(JSON.parse(line));
  assert.equal(records.at(-1).deepMeasured, 0);
  assert.equal(records.at(-1).inventoryPages, 2);
});

test("aborting after the terminal record does not emit another terminal", async () => {
  const estimator = await createEstimator();
  const controller = new AbortController();
  const records = [];
  for await (const line of estimator.profileJsonl(await blob(), { signal: controller.signal })) {
    const record = JSON.parse(line);
    records.push(record);
    if (record.t === "end") controller.abort();
  }
  assert.equal(records.filter((r) => r.t === "end").length, 1);
  assert.equal(records.at(-1).complete, true);
});
