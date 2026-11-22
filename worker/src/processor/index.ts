import { executeArtifactGraph, type ArtifactGraphAdapter, type ArtifactGraphInput } from "../extractors/artifact-graph.js";

export type { ExtractionArtifactRef } from "@docslurp/shared";
export type { ArtifactGraphAdapter, ArtifactGraphResult } from "../extractors/artifact-graph.js";

/** References are already staged and authorized by the caller. */
export type ArtifactRequest = Omit<ArtifactGraphInput, "adapters" | "signal">;

export function createArtifactProcessor(adapters: readonly ArtifactGraphAdapter[]) {
  const installed = [...adapters];
  return {
    async execute(request: ArtifactRequest, signal?: AbortSignal) {
      signal?.throwIfAborted();
      return executeArtifactGraph({ ...request, adapters: installed, signal });
    },
  };
}

/** The CLI loads this from trusted operator code. A host supplies staging and tool/model adapters. */
export interface ProcessorModule {
  configure(env: NodeJS.ProcessEnv): Promise<{
    adapters: readonly ArtifactGraphAdapter[];
    prepare(input: string, targets: readonly string[], signal: AbortSignal): Promise<{
      request: Omit<ArtifactRequest, "target">;
      close?: () => Promise<void>;
    }>;
  }>;
}
