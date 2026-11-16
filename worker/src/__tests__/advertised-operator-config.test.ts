import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeOperatorConfig, resetOperatorConfigState } from "@docslurp/shared/operator-config";

import { advertisedWorkerConfig } from "../lib/vm-only-parsing.js";

/** The worker advertises its operator config digest in worker_capabilities.config, for /ops/worker-fleet's skew check. */
describe("advertisedWorkerConfig operatorConfig", () => {
  afterEach(() => resetOperatorConfigState());

  it("is null without an operator config file", () => {
    initializeOperatorConfig("worker", {}, () => {});
    const config = advertisedWorkerConfig();
    if (config) expect(config.operatorConfig).toBeNull();
  });

  it("carries the loaded file's digest", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "advertised-operator-"));
    try {
      const path = join(dir, "operator.json");
      writeFileSync(path, JSON.stringify({ version: 1, ocr: { maxAttempts: 3 } }));
      const state = initializeOperatorConfig("worker", { DOCSLURP_OPERATOR_CONFIG: path }, () => {});
      const config = advertisedWorkerConfig();
      expect(config).not.toBeNull();
      expect(config!.operatorConfig).toBe(state.digest);
      expect(state.digest).toMatch(/^sha256:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
