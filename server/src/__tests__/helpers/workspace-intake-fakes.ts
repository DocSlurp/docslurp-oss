import type { Readable } from "node:stream";

import { defaultPipelineFeatures, mergePipelineFeatures, type PipelineFeatureOverrides, type PipelineFeatures, type WorkspaceRecord } from "@docslurp/shared";

import { AllSourcesUnreadableError, UnreadableSourceError } from "../../services/source-metadata.js";
import type {
  StoredIntakeFile,
  WorkspaceIntakePorts,
  WorkspaceIntakeRecords,
} from "../../services/workspace-intake.js";

type AuditEntry = Parameters<WorkspaceIntakeRecords["appendAudit"]>[0];
type RunManifest = Awaited<ReturnType<WorkspaceIntakeRecords["createRun"]>>;

export type FakeStoredObject = {
  body: Buffer;
  contentType: string;
  /** "bytes" when handed over in memory, "stream" when piped. */
  via: "bytes" | "stream";
};

export type FakeRun = {
  id: string;
  workspaceId: string;
  kind: string;
  pipeline: PipelineFeatures;
  apiKeyId: string | null;
  files: StoredIntakeFile[];
};

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function fakeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: "ws-existing",
    orgId: "org-1",
    name: "Existing",
    pipeline: null,
    ...overrides,
  } as WorkspaceRecord;
}

/**
 * In-memory Workspace Intake ports: object storage, workspace/run/audit
 * records, and a workflow starter that can simulate Temporal being down.
 */
export function createWorkspaceIntakeFakes(options: { workspaces?: WorkspaceRecord[] } = {}) {
  const objects = new Map<string, FakeStoredObject>();
  const workspaces = new Map((options.workspaces ?? []).map((workspace) => [workspace.id, workspace]));
  const createdWorkspaces: Array<{ name: string; orgId?: string; autoNamed: boolean; pipeline?: PipelineFeatureOverrides }> = [];
  const runs: FakeRun[] = [];
  const audit: AuditEntry[] = [];
  const started: string[] = [];
  const discardedWorkspaces: string[] = [];
  const state = {
    temporalDown: false,
    blockRunCreation: null as Error | null,
    /** Filenames createRun treats as unreadable when asked to skip them (as pdfinfo failures are). */
    unreadable: new Set<string>(),
    /** Thrown by startRun (a non-Temporal failure after the Run is committed). */
    startError: null as Error | null,
    /** Number of upcoming appendAudit calls that throw. */
    auditFailures: 0,
  };

  const ports: WorkspaceIntakePorts = {
    storage: {
      async put(key, content, contentType) {
        if ("bytes" in content) {
          objects.set(key, { body: content.bytes, contentType, via: "bytes" });
          return;
        }
        objects.set(key, { body: await collect(content.stream), contentType, via: "stream" });
      },
      async remove(key) {
        objects.delete(key);
      },
    },
    records: {
      async findWorkspace(workspaceId) {
        return workspaces.get(workspaceId) ?? null;
      },
      async defaultWorkspace({ orgId }) {
        const id = `ws-default-${orgId ?? "personal"}`;
        const workspace = workspaces.get(id)
          ?? fakeWorkspace({ id, orgId: orgId ?? "org-personal", name: "Default", isDefault: true });
        workspaces.set(id, workspace);
        return workspace;
      },
      async createWorkspace(args) {
        const workspace = fakeWorkspace({
          id: `ws-${workspaces.size + 1}`,
          orgId: args.orgId ?? "org-default",
          name: args.name,
          pipeline: args.pipeline ? mergePipelineFeatures(defaultPipelineFeatures, args.pipeline) : undefined,
        });
        workspaces.set(workspace.id, workspace);
        createdWorkspaces.push({ name: args.name, orgId: args.orgId, autoNamed: args.autoNamed, pipeline: args.pipeline });
        return workspace;
      },
      async discardWorkspace(workspaceId) {
        discardedWorkspaces.push(workspaceId);
        workspaces.delete(workspaceId);
      },
      async createRun(args) {
        if (state.blockRunCreation) throw state.blockRunCreation;
        const unreadable = args.files.filter((file) => state.unreadable.has(file.filename));
        if (unreadable.length > 0 && !args.skipUnreadable) throw new UnreadableSourceError(unreadable[0]!.filename, "invalid PDF");
        if (unreadable.length === args.files.length) throw new AllSourcesUnreadableError(unreadable.map((file) => new UnreadableSourceError(file.filename, "invalid PDF")));
        const readable = args.files.filter((file) => !state.unreadable.has(file.filename));
        const run: FakeRun = {
          id: `run-${runs.length + 1}`,
          workspaceId: args.workspaceId,
          kind: args.kind,
          pipeline: args.pipeline,
          apiKeyId: args.apiKeyId ?? null,
          files: readable,
        };
        runs.push(run);
        return {
          run: { id: run.id, orgId: workspaces.get(args.workspaceId)?.orgId, workspaceId: args.workspaceId, kind: args.kind, pagesTotal: 0 },
          unreadable: unreadable.map((file) => ({ filename: file.filename, sourceKey: file.sourceKey, error: new UnreadableSourceError(file.filename, "invalid PDF") })),
          documents: readable.map((file, index) => ({
            id: `${run.id}-doc-${index + 1}`,
            filename: file.filename,
            mimeType: file.mimeType,
            sourceKey: file.sourceKey,
          })),
        } as unknown as RunManifest;
      },
      async appendAudit(entry) {
        if (state.auditFailures > 0) {
          state.auditFailures -= 1;
          throw new Error("canceling statement due to user request");
        }
        audit.push(entry);
      },
    },
    async startRun(runId) {
      if (state.startError) throw state.startError;
      if (state.temporalDown) return "Run created, but processing has not started yet because Temporal is currently unavailable.";
      started.push(runId);
      return null;
    },
  };

  return { ports, objects, workspaces, createdWorkspaces, discardedWorkspaces, runs, audit, started, state, defaultPipeline: defaultPipelineFeatures };
}
