/**
 * Where a run's artifacts live: `<user>/<run>` normally, or the extract's own
 * prefix (`extracts/<org>/<extract>`) for an extract run, so expiry deletes
 * one prefix. Every stage builds artifact keys from this.
 */
export function runArtifactRoot(run: { id: string; storagePrefix?: string | null }, ownerUserId: string): string {
  return run.storagePrefix ?? `${ownerUserId}/${run.id}`;
}

/** runArtifactRoot for code that holds a document rather than the run. */
export function documentArtifactRoot(document: { userId: string; runId: string; artifactRoot?: string | null }, runId: string = document.runId): string {
  return document.artifactRoot ?? `${document.userId}/${runId}`;
}
