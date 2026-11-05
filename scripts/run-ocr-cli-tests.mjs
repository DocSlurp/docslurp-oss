#!/usr/bin/env node
// Run the real OCR CLI tests: worker/scripts/test_docslurp_ocr.py (the CLI with its pinned models) and
// worker/src/ocr/__tests__/local-cli.integration.test.ts (the CLI under the real parser sandbox). Both skip without
// the OCR runtime, so this fails on any skipped, failed or missing test, like scripts/run-database-tests.mjs: a broken
// install or a renamed variable cannot quietly turn them off.
//
//   bash scripts/install-ocr-runtime.sh "$PREFIX"
//   DOCSLURP_OCR_TEST_PYTHON="$PREFIX/venv/bin/python3" DOCSLURP_OCR_TEST_MODELS="$PREFIX/models" \
//     node scripts/run-ocr-cli-tests.mjs
//
// Needs bubblewrap with unprivileged user namespaces, pdftoppm, and Latin and CJK fonts (fc-list).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VITEST_FILE = "src/ocr/__tests__/local-cli.integration.test.ts";
export const PYTHON_TESTS = "worker/scripts/test_docslurp_ocr.py";

// Runs the unittest file and prints one JSON line of counts; never echoes test output as the verdict.
const PYTHON_RUNNER = `
import json, sys, unittest
sys.path.insert(0, sys.argv[1])
suite = unittest.defaultTestLoader.loadTestsFromName("test_docslurp_ocr")
result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
print(json.dumps({"run": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                  "skipped": [str(test) + ": " + reason for test, reason in result.skipped],
                  "expectedFailures": len(result.expectedFailures), "unexpectedSuccesses": len(result.unexpectedSuccesses)}))
`;

/** The verdict for one suite's counts: null when it passed with nothing skipped, else why not. */
export function verdict(name, counts) {
  if (!counts) return `${name}: no result`;
  const skipped = Array.isArray(counts.skipped) ? counts.skipped.length : counts.skipped;
  if (counts.failed > 0 || skipped > 0 || counts.passed === 0) {
    return `${name}: passed ${counts.passed}, failed ${counts.failed}, skipped ${skipped}${Array.isArray(counts.skipped) && skipped ? ` (${counts.skipped.join("; ")})` : ""}`;
  }
  return null;
}

function main() {
  const python = process.env.DOCSLURP_OCR_TEST_PYTHON?.trim();
  const models = process.env.DOCSLURP_OCR_TEST_MODELS?.trim();
  if (!python || !models || !existsSync(python) || !existsSync(models)) {
    console.error("[ocr-cli-tests] set DOCSLURP_OCR_TEST_PYTHON and DOCSLURP_OCR_TEST_MODELS (scripts/install-ocr-runtime.sh)");
    process.exit(1);
  }
  const failures = [];
  const scratch = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "ocr-cli-tests-"));
  try {
    const py = spawnSync(python, ["-I", "-c", PYTHON_RUNNER, path.join(root, "worker", "scripts")], {
      cwd: root,
      env: { ...process.env, DOCSLURP_OCR_TEST_MODELS: models, DOCSLURP_OCR_PYTHON: python, TMPDIR: scratch },
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
      timeout: 30 * 60 * 1000,
    });
    let counts = null;
    try {
      const raw = JSON.parse(py.stdout.trim().split("\n").pop() ?? "");
      counts = { passed: raw.run - raw.failures - raw.errors - raw.skipped.length - raw.unexpectedSuccesses, failed: raw.failures + raw.errors + raw.unexpectedSuccesses, skipped: raw.skipped };
    } catch { /* reported below */ }
    const pyVerdict = verdict(PYTHON_TESTS, counts) ?? (py.status === 0 ? null : `${PYTHON_TESTS}: exit ${py.status}`);
    if (pyVerdict) failures.push(pyVerdict);

    const report = path.join(scratch, "vitest.json");
    const run = spawnSync("pnpm", ["exec", "vitest", "run", VITEST_FILE, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`], {
      cwd: path.join(root, "worker"),
      env: { ...process.env, DOCSLURP_OCR_TEST_PYTHON: python, DOCSLURP_OCR_TEST_MODELS: models },
      stdio: "inherit",
    });
    let result = null;
    try { result = JSON.parse(readFileSync(report, "utf8")); } catch { /* reported below */ }
    const jsVerdict = verdict(`worker/${VITEST_FILE}`, result && {
      passed: result.numPassedTests, failed: result.numFailedTests, skipped: (result.numPendingTests ?? 0) + (result.numTodoTests ?? 0),
    }) ?? (run.status === 0 ? null : `worker/${VITEST_FILE}: exit ${run.status}`);
    if (jsVerdict) failures.push(jsVerdict);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`[ocr-cli-tests] failed or skipped tests:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("[ocr-cli-tests] the OCR CLI and local sandbox tests passed with no skipped tests");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
