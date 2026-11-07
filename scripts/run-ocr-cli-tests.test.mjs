import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { PYTHON_TESTS, VITEST_FILE, verdict } from "./run-ocr-cli-tests.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a suite passes only with tests run and none failed or skipped", () => {
  assert.equal(verdict("x", { passed: 3, failed: 0, skipped: 0 }), null);
  assert.match(verdict("x", { passed: 3, failed: 0, skipped: 1 }), /skipped 1/);
  assert.match(verdict("x", { passed: 3, failed: 0, skipped: ["test_pdf: pdftoppm not installed"] }), /pdftoppm not installed/);
  assert.match(verdict("x", { passed: 0, failed: 0, skipped: 0 }), /passed 0/);
  assert.match(verdict("x", { passed: 3, failed: 1, skipped: 0 }), /failed 1/);
  assert.match(verdict("x", null), /no result/);
});

test("the gated files exist and CI runs this script", () => {
  assert.ok(existsSync(path.join(root, PYTHON_TESTS)));
  assert.ok(existsSync(path.join(root, "worker", VITEST_FILE)));
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /node scripts\/run-ocr-cli-tests\.mjs/);
  assert.match(ci, /bash scripts\/install-ocr-runtime\.sh/);
  assert.match(ci, /needs: \[[^\]]*\bocr-cli\b[^\]]*\]/);
});

test("the OCR CLI job runs on every PR into main and feat/offline-credit-estimator", () => {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const on = ci.slice(ci.indexOf("\non:"), ci.indexOf("\nconcurrency:"));
  const pullRequest = on.slice(on.indexOf("pull_request:"), on.indexOf("workflow_dispatch:"));
  assert.match(pullRequest, /branches: \[main, feat\/offline-credit-estimator\]/);
  // Neither a path filter on the trigger nor a condition on the job may skip it.
  assert.doesNotMatch(on, /paths(-ignore)?:/);
  const job = ci.slice(ci.indexOf("\n  ocr-cli:"), ci.indexOf("\n  # The offline file profiler"));
  assert.ok(job.length > 0);
  assert.doesNotMatch(job, /^\s{4}if:/m);
  assert.match(job, /node scripts\/run-ocr-cli-tests\.mjs/);
});
