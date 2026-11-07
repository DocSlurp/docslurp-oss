import { describe, expect, it } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { Document, StageState, ProjectRun, ProjectRunEvent } from "../models.js";
import { runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import type { CheckpointStore, Stage, WorkflowState } from "../pipeline/pipeline.js";
import { createStageExecution, type StageExecutionStore } from "../pipeline/stage-execution.js";
import { RunPolicyError } from "../lib/document-failure.js";

const config = { workerDocConcurrency: 2, workerAdaptiveTuning: false } as Config;
const STAGES = ["extract", "embed", "index"];

function doc(id: string): Document {
  return {
    id, userId: "user-1", runId: "run-1", filename: `${id}.pdf`, mimeType: "application/pdf",
    sourceKey: `raw/${id}.pdf`, status: "queued", extractionMode: "hybrid", pageCount: 2,
    createdAt: new Date(), updatedAt: new Date(),
  } as Document;
}

/** Persists document stage checkpoints between stage activities, like document_run_stage_states. */
class MemoryStore implements StageExecutionStore {
  run: ProjectRun;
  documents: Document[];
  docStages = new Map<string, StageState>();
  runStatus = "processing";
  completedWith: WorkflowState | null = null;
  failures: Array<{ stage: string; message: string }> = [];
  documentFailures: Array<{ documentId: string; stageName: string; message: string }> = [];
  events: ProjectRunEvent[] = [];
  documentEvents: ProjectRunEvent[] = [];
  readonly pageTasks = { completed: async () => new Map() } as unknown as StageExecutionStore["pageTasks"];

  constructor(ids: string[]) {
    this.documents = ids.map(doc);
    this.run = {
      id: "run-1", orgId: "org-1", userId: "user-1", projectId: "ws-1", kind: "bulk-upload",
      status: "processing", stage: "queued", totalDocuments: ids.length, processedDocuments: 0,
      pagesTotal: ids.length * 2, pagesProcessed: 0, spentCents: 0, pipeline: defaultPipelineFeatures,
      error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
    } as ProjectRun;
  }

  private checkpoints: CheckpointStore = {
    startDocumentStage: async () => undefined,
    completeDocumentStage: async (_state: WorkflowState, documentId: string, stageName: string) => {
      this.docStages.set(`${documentId}:${stageName}`, { documentId, stageName, status: "completed" } as StageState);
    },
    failDocumentStage: async (state: WorkflowState, documentId: string, stageName: string, message: string) => {
      this.documentFailures.push({ documentId, stageName, message });
      this.docStages.set(`${documentId}:${stageName}`, { documentId, stageName, status: "failed", error: message } as StageState);
      state.setDocumentStage({ documentId, stageName, status: "failed", error: message } as StageState);
    },
    updateProgress: async () => undefined,
    startRunStage: async () => undefined,
    completeRunStage: async () => undefined,
    failRunStage: async () => undefined,
    appendEvent: async (event: ProjectRunEvent) => { this.documentEvents.push(event); },
    setPageStageComplete: async () => undefined,
    getCompletedPages: async () => new Set<number>(),
  } as unknown as CheckpointStore;

  async loadRun() { return structuredClone(this.run); }
  async loadDocumentsForRun() { return structuredClone(this.documents); }
  async hydrateState(state: WorkflowState) {
    state.store = this.checkpoints;
    for (const stage of this.docStages.values()) state.setDocumentStage({ ...stage });
  }
  async renewHeartbeat() {}
  async startRunStage() {}
  async completeRunStage() {}
  async finishShard() {}
  async failRunStage() { return 1; }
  async updateProgress() {}
  async appendEvent(event: ProjectRunEvent) { this.events.push(event); }
  async completeRun(state: WorkflowState) { this.runStatus = "completed"; this.completedWith = state; state.refreshStats(); }
  async failRun(_runId: string, stage: string, message: string) { this.runStatus = "failed"; this.failures.push({ stage, message }); }
  async currentRunStage() { return null; }
  async seedReusedStageOutputs() { return { seededDocuments: 0, unavailable: [] }; }
  async triggerRunEmails() {}
  async triggerWebhooks() {}
}

type Behaviour = (stage: string, documentId: string) => void;

/** Every stage runs its handler per healthy document through the real checkpoint path. */
function pipeline(calls: string[], behaviour: Behaviour): Stage[] {
  return STAGES.map((name): Stage => ({
    name,
    async run(state) {
      await runDocuments(state.documents, state.docConcurrency, async (document) => {
        await runDocumentStage(state, document, name, `${document.id}:${name}`, `${name} done`, async () => {
          calls.push(`${document.id}:${name}`);
          behaviour(name, document.id);
          return { artifactUri: `s3://a/${document.id}/${name}` };
        });
      });
    },
  }));
}

async function runAll(store: MemoryStore, stages: Stage[]) {
  const execution = createStageExecution({ store, config, stages });
  const rt = { signal: new AbortController().signal, heartbeat: () => undefined, attempt: 1, progressFromProcessCpu: false };
  for (const name of STAGES) {
    await execution.runStage({ stageName: name, runId: "run-1", totalStages: STAGES.length, artifacts: {} }, rt);
  }
  await execution.completeRun({ runId: "run-1" });
}

const poison = (target: string): Behaviour => (_stage, documentId) => {
  if (documentId === target) throw new Error("unparseable file");
};

describe("a failing Document does not stop the Run", () => {
  it("completes the siblings through every stage and the Run with failedDocuments: 1", async () => {
    const store = new MemoryStore(["a", "poisoned", "c"]);
    const calls: string[] = [];
    await runAll(store, pipeline(calls, poison("poisoned")));

    for (const id of ["a", "c"]) {
      for (const name of STAGES) expect(store.docStages.get(`${id}:${name}`)?.status).toBe("completed");
    }
    expect(store.docStages.get("poisoned:extract")?.status).toBe("failed");
    // The poisoned Document is skipped by every later stage instead of being retried.
    expect(calls.filter((call) => call.startsWith("poisoned:") && !call.endsWith(":extract"))).toEqual([]);
    expect(store.runStatus).toBe("completed");
    expect(store.failures).toEqual([]);
    expect(store.completedWith?.run.stats).toMatchObject({ failedDocuments: 1, failedDocumentStages: 1 });
  });

  it("fails the Run when every Document failed", async () => {
    const store = new MemoryStore(["x", "y"]);
    await runAll(store, pipeline([], () => { throw new Error("unparseable file"); }));

    expect(store.runStatus).toBe("failed");
    expect(store.failures).toHaveLength(1);
    expect(store.failures[0]!.message).toMatch(/All 2 documents failed/);
    expect(store.completedWith).toBeNull();
  });

  it("records a genuine document-level failure with its stage state, store write and event", async () => {
    const store = new MemoryStore(["a", "poisoned"]);
    await runAll(store, pipeline([], poison("poisoned")));

    expect(store.documentFailures).toEqual([
      { documentId: "poisoned", stageName: "extract", message: "unparseable file" },
    ]);
    expect(store.docStages.get("poisoned:extract")).toMatchObject({ status: "failed", error: "unparseable file" });
    expect(failedDocumentEvents(store)).toHaveLength(1);
  });

  it("still fails the stage on an infrastructure error without failing the Document", async () => {
    const store = new MemoryStore(["a", "b"]);
    const stages = pipeline([], (_stage, documentId) => {
      if (documentId === "b") throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    });
    await expect(runAll(store, stages)).rejects.toThrow("ECONNREFUSED");
    expect(store.runStatus).toBe("processing");
    expect(store.documentFailures).toEqual([]);
    expect(store.docStages.get("b:extract")?.status).not.toBe("failed");
  });

  it("still fails the stage on a Run-wide policy stop", async () => {
    const store = new MemoryStore(["a", "b"]);
    const stages = pipeline([], () => { throw new RunPolicyError("Embedding cost cap reached"); });
    await expect(runAll(store, stages)).rejects.toThrow("cost cap");
  });
});

function failedDocumentEvents(store: MemoryStore): ProjectRunEvent[] {
  return store.documentEvents.filter((event) => event.documentId && event.status === "failed");
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

describe("an interrupted Document stage", () => {
  /** One stage whose run() is interrupted for Document "b" while `interrupt` is set. */
  function interruptible(calls: string[], interrupt: { controller?: AbortController }): Stage {
    return {
      name: "index",
      async run(state) {
        const signal = interrupt.controller?.signal;
        await runDocuments(state.documents, 1, async (document) => {
          await runDocumentStage(state, document, "index", `${document.id}:index`, "index done", async () => {
            calls.push(document.id);
            if (document.id === "b" && interrupt.controller) {
              // Worker shutdown / activity cancellation fires mid-stage.
              interrupt.controller.abort(abortError());
              throw abortError();
            }
            return { artifactUri: `s3://a/${document.id}/index` };
          }, signal);
        });
      },
    };
  }

  async function runIndex(store: MemoryStore, stage: Stage) {
    const execution = createStageExecution({ store, config, stages: [stage] });
    const rt = { signal: new AbortController().signal, heartbeat: () => undefined, attempt: 1, progressFromProcessCpu: false };
    await execution.runStage({ stageName: "index", runId: "run-1", totalStages: 1, artifacts: {} }, rt);
    return execution;
  }

  it("persists no failure and the retried activity processes the Document", async () => {
    const store = new MemoryStore(["a", "b"]);
    const calls: string[] = [];
    const interrupt: { controller?: AbortController } = { controller: new AbortController() };
    const stage = interruptible(calls, interrupt);

    await expect(runIndex(store, stage)).rejects.toThrow("The operation was aborted");
    expect(store.documentFailures).toEqual([]);
    expect(store.docStages.get("b:index")?.status).not.toBe("failed");
    expect(failedDocumentEvents(store)).toEqual([]);

    // The activity retry: a fresh state hydrated from the persisted checkpoints.
    interrupt.controller = undefined;
    const execution = await runIndex(store, stage);
    await execution.completeRun({ runId: "run-1" });

    expect(calls).toEqual(["a", "b", "b"]);
    expect(store.docStages.get("b:index")?.status).toBe("completed");
    expect(store.runStatus).toBe("completed");
    expect(store.completedWith?.run.stats).toMatchObject({ failedDocuments: 0 });
  });

  it("still checkpoints the interrupted attempt's usage, and a failing flush keeps the cause", async () => {
    for (const flushFails of [false, true]) {
      const store = new MemoryStore(["b"]);
      const flushed: number[] = [];
      const stage: Stage = {
        name: "index",
        async run(state) {
          state.store = {
            ...state.store!,
            updateProgress: async (s: WorkflowState) => {
              flushed.push(s.usageLedger.pendingCount);
              if (flushFails) throw new Error("db down");
            },
          } as CheckpointStore;
          await runDocumentStage(state, state.documents[0]!, "index", "b:index", "index done", async () => {
            state.usageLedger.enqueue({ metric: "embed", model: "m", inputTokens: 10, outputTokens: 0, costCents: 1, metadata: {} } as never);
            throw abortError();
          });
        },
      };
      await expect(runIndex(store, stage)).rejects.toThrow("The operation was aborted");
      expect(flushed).toEqual([1]);
      expect(store.documentFailures).toEqual([]);
    }
  });

  it("persists no failure when an AbortError surfaces without an aborted signal", async () => {
    const store = new MemoryStore(["b"]);
    const stage: Stage = {
      name: "index",
      async run(state) {
        await runDocumentStage(state, state.documents[0]!, "index", "b:index", "index done", async () => {
          throw abortError();
        });
      },
    };
    await expect(runIndex(store, stage)).rejects.toThrow("The operation was aborted");
    expect(store.documentFailures).toEqual([]);
    expect(store.docStages.get("b:index")?.status).not.toBe("failed");
    expect(failedDocumentEvents(store)).toEqual([]);
  });
});

describe("sandbox infrastructure failures retry instead of failing the document (real-Modal check F1)", () => {
  async function runIndex(store: MemoryStore, stage: Stage) {
    const execution = createStageExecution({ store, config, stages: [stage] });
    const rt = { signal: new AbortController().signal, heartbeat: () => undefined, attempt: 1, progressFromProcessCpu: false };
    await execution.runStage({ stageName: "index", runId: "run-1", totalStages: 1, artifacts: {} }, rt);
    return execution;
  }

  it("a VM creation failure inside the per-document loop fails the activity, retryably, and persists no document failure", async () => {
    const { SandboxInfrastructureError } = await import("../sandbox/types.js");
    const { isDocumentLevelFailure } = await import("../lib/document-failure.js");
    const store = new MemoryStore(["b"]);
    const stage: Stage = {
      name: "index",
      async run(state) {
        await runDocumentStage(state, state.documents[0]!, "index", "b:index", "index done", async () => {
          throw new SandboxInfrastructureError("modal sandbox creation failed: parser VM kernel link protections could not be turned on");
        });
      },
    };
    const error = await runIndex(store, stage).catch((e: unknown) => e);
    expect((error as Error).name).toBe("SandboxInfrastructureError");
    expect(isDocumentLevelFailure(error)).toBe(false);
    expect(store.documentFailures).toEqual([]);
    expect(store.docStages.get("b:index")?.status).not.toBe("failed");
    expect(failedDocumentEvents(store)).toEqual([]);
  });

  it("a stage that catches the sandbox failure and falls back neither completes nor fails the document", async () => {
    const { SandboxInfrastructureError } = await import("../sandbox/types.js");
    const { noteSandboxInfrastructureError } = await import("../sandbox/session-context.js");
    const store = new MemoryStore(["b"]);
    const stage: Stage = {
      name: "index",
      async run(state) {
        await runDocumentStage(state, state.documents[0]!, "index", "b:index", "index done", async () => {
          try {
            // What the runner does with a command's sandbox failure, before the stage's own fallback swallows it.
            const failure = new SandboxInfrastructureError("modal sandbox command failed: control deadline exceeded");
            noteSandboxInfrastructureError(failure);
            throw failure;
          } catch {
            return { artifactUri: "memory://fallback", stats: { extractor: "fallback" } };
          }
        });
      },
    };
    const error = await runIndex(store, stage).catch((e: unknown) => e);
    expect((error as Error).name).toBe("SandboxInfrastructureError");
    expect(store.documentFailures).toEqual([]);
    expect(store.docStages.get("b:index")?.status).not.toBe("completed");
    expect(store.docStages.get("b:index")?.status).not.toBe("failed");
  });

  it("documents sharing a session that could not be created each see the failure, even when they swallow it (recheck R #2)", async () => {
    const { SandboxInfrastructureError } = await import("../sandbox/types.js");
    const { SandboxSessionScope, runWithSandboxScope } = await import("../sandbox/session-context.js");
    const store = new MemoryStore(["b", "c"]);
    let opens = 0;
    const scope = new SandboxSessionScope(async () => {
      opens++;
      throw new SandboxInfrastructureError("modal sandbox creation failed: parser VM kernel link protections could not be turned on");
    });
    const stage: Stage = {
      name: "index",
      async run(state) {
        await Promise.allSettled(state.documents.map((document) =>
          runDocumentStage(state, document, "index", `${document.id}:index`, "index done", async () => {
            // A parser fallback: the stage swallows the sandbox error and would otherwise complete on a degraded result.
            await scope.get().catch(() => undefined);
            return { artifactUri: "memory://fallback", stats: { extractor: "fallback" } };
          })));
        // Both documents' watches saw it: neither completed nor failed.
        for (const id of ["b", "c"]) {
          expect(store.docStages.get(`${id}:index`)?.status, id).not.toBe("completed");
          expect(store.docStages.get(`${id}:index`)?.status, id).not.toBe("failed");
        }
        throw new SandboxInfrastructureError("activity retries");
      },
    };
    const error = await runWithSandboxScope(scope, () => runIndex(store, stage)).catch((e: unknown) => e);
    expect((error as Error).name).toBe("SandboxInfrastructureError");
    expect(opens).toBe(1); // the rejection is cached, not retried per document
    expect(store.documentFailures).toEqual([]);
    expect(failedDocumentEvents(store)).toEqual([]);
  });

  it("a command on a session closed by a failed cleanup is a retryable infrastructure failure, not the document's", async () => {
    const { SandboxInfrastructureError } = await import("../sandbox/types.js");
    const { isDocumentLevelFailure } = await import("../lib/document-failure.js");
    const { createModalProvider } = await import("../sandbox/providers/modal/index.js");
    const sdk = {
      ModalClient: class {
        apps = { fromName: async () => ({}) };
        images = { fromRegistry: () => ({}) };
        secrets = { fromName: async () => ({}) };
        sandboxes = { create: async () => ({ sandboxId: "sb", terminate: async () => {}, filesystem: { makeDirectory: async () => {} }, exec: async () => ({ stdout: new ReadableStream({ start(c) { c.close(); } }), stderr: new ReadableStream({ start(c) { c.close(); } }), wait: async () => 0 }) }) };
        close() {}
      },
      Sandbox: class { async terminate() {} },
    } as unknown as typeof import("modal");
    const provider = createModalProvider(async () => sdk);
    const session = await provider.openSession({ tokenId: "t", tokenSecret: "s", app: "a", image: "i", cpu: 1, memoryMb: 512, sessionTimeoutSeconds: 60 }, { activityId: "x", unmetered: true });
    await session.close();
    const failure = await session.run!({ binary: "/bin/true", args: [], env: {}, readablePaths: [], inputPaths: [], writablePaths: [], limits: { timeoutMs: 1_000 } }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SandboxInfrastructureError);
    expect(isDocumentLevelFailure(failure)).toBe(false);
  });

  it("an output over the staging limit fails only that document, once; the other documents complete (recheck Q #1)", async () => {
    const { SandboxOutputError } = await import("../sandbox/types.js");
    const store = new MemoryStore(["b", "c"]);
    let attempts = 0;
    const stage: Stage = {
      name: "index",
      async run(state) {
        await Promise.allSettled(state.documents.map((document) =>
          runDocumentStage(state, document, "index", `${document.id}:index`, "index done", async () => {
            if (document.id === "b") { attempts++; throw new SandboxOutputError("parser VM output entry/depth limit exceeded"); }
            return { artifactUri: "memory://ok", stats: {} };
          })));
      },
    };
    await expect(runIndex(store, stage)).resolves.toBeDefined();
    expect(attempts).toBe(1);
    expect(store.docStages.get("b:index")?.status).toBe("failed");
    expect(store.docStages.get("c:index")?.status).toBe("completed");
  });

  it("every stage with a per-document loop runs it through runDocumentStage, which applies the watch", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../stages/", import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const source = readFileSync(new URL(file, dir), "utf8");
      if (!/runDocuments\(|for \(const document of/.test(source)) continue;
      if (file === "lancedb-relocate.ts") continue; // maintenance: no parser command, no document verdict
      expect(source, file).toMatch(/runDocumentStage\(/);
    }
  });
});
