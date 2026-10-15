export type PipelineArtifactMap = Record<string, string>;
export type DocumentArtifactName =
  | "canonical-document"
  | "classification"
  | "embeddings"
  | "extraction-contract"
  | "format-detect"
  | "format-tooling"
  | "hasTablePages"
  | "heatmap"
  | "html-manifest"
  | "images"
  | "json-schema"
  | "markdown"
  | "markdown-critique"
  | "markdown-manifest"
  | "normalize"
  | "normalizedFormat"
  | "page-image-evidence"
  | "page-index"
  | "parser-eval"
  | "parser-playbook"
  | "pdf-regions"
  | "pdf-tooling"
  | "proposition-index"
  | "structured"
  | "to-canonical"
  | (string & {});

export class DocumentArtifactLedger {
  constructor(
    private artifacts: PipelineArtifactMap,
    private runArtifacts: PipelineArtifactMap = artifacts,
  ) {}

  static create(
    artifacts: PipelineArtifactMap,
    runArtifacts: PipelineArtifactMap = artifacts,
  ): DocumentArtifactLedger {
    return new DocumentArtifactLedger(artifacts, runArtifacts);
  }

  replace(
    artifacts: PipelineArtifactMap,
    runArtifacts: PipelineArtifactMap = artifacts,
  ): void {
    this.artifacts = artifacts;
    this.runArtifacts = runArtifacts;
  }

  all(): PipelineArtifactMap {
    return this.artifacts;
  }

  slot(documentId: string, name: DocumentArtifactName): string {
    return `${documentId}:${name}`;
  }

  read(slot: string): string | undefined {
    return this.artifacts[slot];
  }

  readDocument(documentId: string, name: DocumentArtifactName): string | undefined {
    return this.read(this.slot(documentId, name));
  }

  record(slot: string, artifactUri: string | null | undefined): string | undefined {
    if (!artifactUri) {
      return undefined;
    }

    this.artifacts[slot] = artifactUri;
    this.runArtifacts[slot] = artifactUri;
    return artifactUri;
  }

  recordDocument(
    documentId: string,
    name: DocumentArtifactName,
    artifactUri: string | null | undefined,
  ): string | undefined {
    return this.record(this.slot(documentId, name), artifactUri);
  }

  changedSince(previous: PipelineArtifactMap): PipelineArtifactMap {
    return Object.fromEntries(
      Object.entries(this.artifacts).filter(
        ([key, value]) => previous[key] !== value,
      ),
    );
  }
}
