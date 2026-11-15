import { afterEach, describe, expect, it, vi } from "vitest";

import { EXTRACTOR_PLUGIN_API_VERSION, registerExtractorPlugin, resetExtractorPluginsForTest, type SandboxedOcrProvider, type SandboxedOcrJob } from "../extractors/plugins.js";
import { runWithPerfContext } from "../lib/perf-context.js";
import { CommandRunner } from "../tools/runner.js";

const job: SandboxedOcrJob = {
  input: "/input", kind: "image", output: "/output.json", imageDir: "/images",
  recognisers: ["multi"], maxAttempts: 1, retryBelow: 0.8, maxFrames: 1, maxLongEdge: 2000, escalation: null,
};

function register() {
  const run = vi.fn<SandboxedOcrProvider["run"]>(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "ctx-ocr", sandboxedOcr: { id: "ctx-ocr", maxSourceBytes: 1 << 20, assertConfigured: () => undefined, run, timeoutMs: () => 1_000 } });
  return run;
}

describe("sandboxed OCR run context", () => {
  afterEach(() => resetExtractorPluginsForTest());

  it("passes the run's organization and document to the provider", async () => {
    const run = register();
    const runner = new CommandRunner();
    const plan = await runner.sandboxedOcrRead(job);
    await runWithPerfContext(
      { runId: "r", orgId: "org-a", documentId: "doc-1", scope: "document", stageName: "ocr", pushPerformance: () => {} },
      () => runner.run(plan),
    );
    expect(run).toHaveBeenCalledWith(job, undefined, { tenantKey: "org-a", affinityKey: "doc-1" });
  });

  it("does not leak another concurrent organization's context or trust affinity as ownership", async () => {
    const run = register();
    const runner = new CommandRunner();
    await Promise.all(["org-a", "org-b"].map(orgId => runWithPerfContext(
      { runId: orgId, orgId, documentId: "same-document", scope: "document", stageName: "ocr", pushPerformance: () => {} },
      async () => { await Promise.resolve(); await runner.run(await runner.sandboxedOcrRead(job)); },
    )));
    expect(run.mock.calls.map(call => call[2])).toEqual(expect.arrayContaining([
      { tenantKey: "org-a", affinityKey: "same-document" },
      { tenantKey: "org-b", affinityKey: "same-document" },
    ]));
    await runner.run(await runner.sandboxedOcrRead(job));
    expect(run.mock.calls[2]![2]).toEqual({});
  });

  it("passes no tenant when the stage has no organization, so a provider cannot reuse a VM for it", async () => {
    const run = register();
    const runner = new CommandRunner();
    await runner.run(await runner.sandboxedOcrRead(job));
    expect(run.mock.calls[0]![2]).toEqual({});
  });
});
