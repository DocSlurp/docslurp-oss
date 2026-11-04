/**
 * Why a recorded artifact could not be read:
 * - `storage`: the read itself failed (network, throttling, a 5xx); the artifact may be fine, so a retry can succeed.
 * - `missing`: the store says the object does not exist (NoSuchKey / 404); a retry reads nothing new.
 * - `invalid`: the object is there but is not what was recorded (not UTF-8, bad manifest, not the canonical schema).
 * - `outside-bucket`: the URI names another bucket or an unsafe key; the worker reads only its own bucket.
 */
export type ArtifactReadFailureKind = "storage" | "missing" | "invalid" | "outside-bucket";

/** Temporal ApplicationFailure type for an artifact that will never be readable (non-retryable). */
export const ARTIFACT_UNREADABLE = "ArtifactUnreadable";

/**
 * A recorded artifact that could not be read. Never answered from the raw source. `retryable` is true only for
 * `storage` failures: the stage retry classification (`toStageActivityFailure`) fails the others at once with this
 * error's message instead of spending retries on an object that is not coming back.
 */
export class ArtifactReadError extends Error {
  readonly retryable: boolean;
  readonly kind: ArtifactReadFailureKind;
  constructor(readonly artifactUri: string, reason: string, options?: { cause?: unknown; kind?: ArtifactReadFailureKind }) {
    const kind = options?.kind ?? "storage";
    super(`artifact ${artifactUri} could not be read: ${reason}${kind === "storage" ? "" : " (not retryable)"}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArtifactReadError";
    this.kind = kind;
    this.retryable = kind === "storage";
  }
}

/** The ArtifactReadError in `error`'s cause chain, if any. */
export function findArtifactReadError(error: unknown): ArtifactReadError | null {
  const seen = new Set<unknown>();
  for (let link: unknown = error; link instanceof Error && !seen.has(link); link = link.cause) {
    if (link instanceof ArtifactReadError) return link;
    seen.add(link);
  }
  return null;
}

/** `missing` for an object-store "no such object" answer, `storage` for everything else. */
export function artifactReadFailureKind(error: unknown): ArtifactReadFailureKind {
  const seen = new Set<unknown>();
  for (let link: unknown = error; typeof link === "object" && link !== null && !seen.has(link); link = (link as { cause?: unknown }).cause) {
    seen.add(link);
    const { name, code, Code, $metadata } = link as { name?: unknown; code?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };
    if ([name, code, Code].some((value) => value === "NoSuchKey" || value === "NotFound" || value === "NoSuchBucket" || value === "ENOENT")) return "missing";
    if ($metadata?.httpStatusCode === 404) return "missing";
  }
  return "storage";
}
