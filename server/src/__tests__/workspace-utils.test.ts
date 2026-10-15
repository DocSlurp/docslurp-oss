import { describe, expect, it } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";

import {
  buildClonedWorkspaceName,
  buildWorkspaceChatAuditMetadata,
  createWorkspaceVersionSnapshot,
  readWorkspaceVersionSnapshot,
} from "../services/workspace-utils.js";

describe("workspace-utils", () => {
  it("creates a serializable workspace snapshot", () => {
    const snapshot = createWorkspaceVersionSnapshot({
      name: "Contracts",
      templateKey: "legal-contracts",
      systemPrompt: null,
      pipeline: {
        ...defaultPipelineFeatures,
        inferenceLane: "standard",
        embedding: {
          profile: "good-fast-local",
          target: "local",
          modelUri: "llm://transformers.js/Xenova/bge-m3",
          task: "document",
          normalize: true,
          lateChunking: false,
          lateChunkingWindow: 2,
        },
        vectorBackends: ["lancedb"],
        summarize: true
      },
    });

    expect(snapshot.name).toBe("Contracts");
    expect(snapshot.templateKey).toBe("legal-contracts");
    expect(snapshot.systemPrompt).toBeNull();
    expect(snapshot.pipeline.summarize).toBe(true);
  });

  it("reads a valid snapshot from audit metadata", () => {
    const snapshot = readWorkspaceVersionSnapshot({
      snapshot: {
        name: "Playbooks",
        templateKey: "meeting-notes",
        systemPrompt: "Use terse meeting-recap language.",
        pipeline: {
          ...defaultPipelineFeatures,
          inferenceLane: "standard",
          embedding: {
            profile: "good-fast-local",
            target: "local",
            modelUri: "llm://transformers.js/Xenova/bge-m3",
            task: "document",
            normalize: true,
            lateChunking: false,
            lateChunkingWindow: 2,
          },
          vectorBackends: ["lancedb"]
        },
      },
    });

    expect(snapshot?.name).toBe("Playbooks");
    expect(snapshot?.templateKey).toBe("meeting-notes");
    expect(snapshot?.systemPrompt).toBe("Use terse meeting-recap language.");
  });

  it("returns null for malformed snapshot metadata", () => {
    expect(readWorkspaceVersionSnapshot({ snapshot: { name: "Broken" } })).toBeNull();
  });

  it("builds a stable clone name", () => {
    expect(buildClonedWorkspaceName("Contracts")).toBe("Contracts copy");
    expect(buildClonedWorkspaceName("Contracts copy")).toBe("Contracts copy 2");
  });

  it("captures compact chat audit metadata", () => {
    const metadata = buildWorkspaceChatAuditMetadata({
      query: "What changed?",
      searchSessionId: "session-1",
      model: "claude",
      fallback: false,
      citations: [
        {
          text: "One",
          score: 0.9,
          citation: {
            source: "document",
            documentId: "doc-1",
            filename: "alpha.pdf",
            regionBoxes: [],
            regions: [],
            regionCoordinateSpace: null,
            pageNumber: 1,
            pageNumbers: [1],
            headingPath: [],
            chunkIndex: 0,
            blockIds: [],
            blockTypes: [],
          },
        },
        {
          text: "Two",
          score: 0.7,
          citation: {
            source: "document",
            documentId: "doc-2",
            filename: "beta.pdf",
            regionBoxes: [],
            regions: [],
            regionCoordinateSpace: null,
            pageNumber: 4,
            pageNumbers: [4],
            headingPath: [],
            chunkIndex: 1,
            blockIds: [],
            blockTypes: [],
          },
        },
      ],
    });

    expect(metadata.query).toBe("What changed?");
    expect(metadata.citations).toBe(2);
    expect(metadata.topCitations).toMatchObject([
      {
        documentId: "doc-1",
        chunkIndex: 0,
        filename: "alpha.pdf",
        pageNumber: 1,
        score: 0.9,
        regionBox: null,
        regionCoordinateSpace: null,
        sourceTrace: null
      },
      {
        documentId: "doc-2",
        chunkIndex: 1,
        filename: "beta.pdf",
        pageNumber: 4,
        score: 0.7,
        regionBox: null,
        regionCoordinateSpace: null,
        sourceTrace: null
      }
    ]);
  });
});
