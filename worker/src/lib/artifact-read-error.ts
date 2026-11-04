/** A recorded artifact that could not be read. Retried by the stage; never answered from the raw source. */
export class ArtifactReadError extends Error {
  readonly retryable = true;
  constructor(readonly artifactUri: string, reason: string, options?: { cause?: unknown }) {
    super(`artifact ${artifactUri} could not be read: ${reason}`, options);
    this.name = "ArtifactReadError";
  }
}
