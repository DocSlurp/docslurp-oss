import type { Readable } from "node:stream";

import { defaultPipelineFeatures, mergePipelineFeatures, slugifyWorkspaceName, type PipelineFeatureOverrides, type PipelineFeatures, type WorkspaceRecord } from "@docslurp/shared";

import { AllSourcesUnreadableError, UnreadableSourceError } from "../../services/source-metadata.js";
import { RUN_START_FAILED_DEFERRED_MESSAGE } from "../../services/run-creation.js";
import type {
  StoredIntakeFile,
  WorkspaceIntakePorts,
  WorkspaceIntakeRecords,
} from "../../services/workspace-intake.js";

type AuditEntry = Parameters<WorkspaceIntakeRecords["appendAudit"]>[0];
type CreatedRun = Awaited<ReturnType<WorkspaceIntakeRecords["createRun"]>>;

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
  const createdWorkspaces: Array<{ name: string; slug?: string; orgId?: string; autoNamed: boolean; pipeline?: PipelineFeatureOverrides }> = [];
  const runs: FakeRun[] = [];
  const audit: AuditEntry[] = [];
  const started: string[] = [];
  const discardedWorkspaces: string[] = [];
  const state = {
    temporalDown: false,
    blockRunCreation: null as Error | null,
    /** Filenames createRun treats as unreadable when asked to skip them (as pdfinfo failures are). */
    unreadable: new Set<string>(),
    /** A non-Temporal start failure after the Run is committed (surfaces as a deferred start). */
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
      // Same rules as findWorkspaceForInput: an ID, a slug (fakes use their ID as one) or a name's slug, inside the scope.
      async findWorkspace(ref, scope) {
        for (const workspace of workspaces.values()) {
          if (scope.orgId && workspace.orgId !== scope.orgId) continue;
          if (scope.allowedWorkspaceIds?.length && !scope.allowedWorkspaceIds.includes(workspace.id)) continue;
          const matches = ref.kind === "id"
            ? workspace.id === ref.id
            : [workspace.slug, workspace.id].includes(ref.slug) || slugifyWorkspaceName(workspace.name) === ref.slug;
          if (matches) return workspace;
        }
        return null;
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
          slug: args.slug ?? `ws-${workspaces.size + 1}`,
          pipeline: args.pipeline ? mergePipelineFeatures(defaultPipelineFeatures, args.pipeline) : undefined,
        });
        workspaces.set(workspace.id, workspace);
        createdWorkspaces.push({ name: args.name, ...(args.slug ? { slug: args.slug } : {}), orgId: args.orgId, autoNamed: args.autoNamed, pipeline: args.pipeline });
        return workspace;
      },
      async discardWorkspace(workspaceId) {
        discardedWorkspaces.push(workspaceId);
        workspaces.delete(workspaceId);
      },
      async createRun(args) {
        if (state.blockRunCreation) throw state.blockRunCreation;
        const unreadable = args.files.filter((file) => state.unreadable.has(file.filename));
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
        // The merged port also starts the Run; a start error defers, never throws.
        let deferredReason: string | null = null;
        if (state.startError) deferredReason = RUN_START_FAILED_DEFERRED_MESSAGE;
        else if (state.temporalDown) deferredReason = "Run created, but processing has not started yet because Temporal is currently unavailable.";
        else started.push(run.id);
        return {
          deferredReason,
          run: { id: run.id, orgId: workspaces.get(args.workspaceId)?.orgId, workspaceId: args.workspaceId, kind: args.kind, pagesTotal: 0 },
          unreadable: unreadable.map((file) => ({ filename: file.filename, sourceKey: file.sourceKey, error: new UnreadableSourceError(file.filename, "invalid PDF") })),
          documents: readable.map((file, index) => ({
            id: `${run.id}-doc-${index + 1}`,
            filename: file.filename,
            mimeType: file.mimeType,
            sourceKey: file.sourceKey,
          })),
        } as unknown as CreatedRun;
      },
      async appendAudit(entry) {
        if (state.auditFailures > 0) {
          state.auditFailures -= 1;
          throw new Error("canceling statement due to user request");
        }
        audit.push(entry);
      },
    },
  };

  return { ports, objects, workspaces, createdWorkspaces, discardedWorkspaces, runs, audit, started, state, defaultPipeline: defaultPipelineFeatures };
}
