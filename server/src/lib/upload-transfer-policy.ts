/**
 * How direct uploads are cut up and how long their signed URLs live.
 *
 * Files up to one part go up as a single signed PUT. Larger files use multipart
 * with parts of at least `partSizeBytes`, grown (in whole MiB) when a file would
 * otherwise need more than the provider's 10,000 parts. Streams of unknown size
 * use a smaller part, because clients buffer a few of them in memory.
 */

const MIB = 1024 * 1024;
/**
 * S3-compatible limits: every part but the last at least 5 MiB, at most 10,000 parts. Parts are capped at 2047 MiB (below
 * the provider's 5 GiB) because `upload_session_files.part_size` is a 32-bit integer.
 */
export const MIN_PART_BYTES = 5 * MIB;
export const MAX_PART_BYTES = 2047 * MIB;
const MAX_PART_MIB = MAX_PART_BYTES / MIB;
export const MAX_PARTS = 10_000;
/** The largest object one signed PUT may create. */
export const MAX_SINGLE_PUT_BYTES = 5 * 1024 * MIB;

export const DEFAULT_PART_SIZE_MIB = 64;
export const DEFAULT_STREAM_PART_SIZE_MIB = 16;
/** Long enough for a slow connection to send a large file without re-signing; capped below the 24 h session. */
export const DEFAULT_URL_TTL_SECONDS = 3 * 60 * 60;
export const MIN_URL_TTL_SECONDS = 5 * 60;
/** Cleanup waits this long after the last URL could have been signed, whatever the current setting. */
export const MAX_URL_TTL_SECONDS = 12 * 60 * 60;

export interface UploadTransferPolicy {
  /** Lifetime of a signed PUT or part URL (never longer than the session that issued it). */
  urlTtlSeconds: number;
  /** Smallest part of a known-size multipart upload, and the largest file sent as one PUT. */
  partSizeBytes: number;
  /** Part size of an unknown-size (streamed) upload. */
  streamPartSizeBytes: number;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * UPLOAD_URL_TTL_SECONDS (300–43200, default 10800), UPLOAD_PART_SIZE_MB (5–2047, default 64) and
 * UPLOAD_STREAM_PART_SIZE_MB (5–2047, default 16). A value out of range fails startup instead of being clamped.
 */
export function readUploadTransferPolicy(env: Record<string, string | undefined>, maxUploadBytes: number): UploadTransferPolicy {
  const named = (name: string, fallback: number, min: number, max: number) => {
    try { return boundedInt(env[name], fallback, min, max); }
    catch (error) { throw new Error(`${name}: ${(error as Error).message}`); }
  };
  const urlTtlSeconds = named("UPLOAD_URL_TTL_SECONDS", DEFAULT_URL_TTL_SECONDS, MIN_URL_TTL_SECONDS, MAX_URL_TTL_SECONDS);
  const partSizeBytes = named("UPLOAD_PART_SIZE_MB", DEFAULT_PART_SIZE_MIB, 5, MAX_PART_MIB) * MIB;
  // An unknown-size stream cannot grow its parts later, so its part must fit the largest accepted upload in 10,000 parts.
  const streamPartSizeBytes = Math.max(
    named("UPLOAD_STREAM_PART_SIZE_MB", DEFAULT_STREAM_PART_SIZE_MIB, 5, MAX_PART_MIB) * MIB,
    roundUpToMiB(Math.ceil(maxUploadBytes / MAX_PARTS)),
  );
  return { urlTtlSeconds, partSizeBytes, streamPartSizeBytes: Math.min(MAX_PART_BYTES, streamPartSizeBytes) };
}

function roundUpToMiB(bytes: number): number {
  return Math.ceil(bytes / MIB) * MIB;
}

/** Part size for a known-size multipart file: the policy's part, grown so the file fits in 10,000 parts. */
export function partSizeFor(sizeBytes: number, policy: Pick<UploadTransferPolicy, "partSizeBytes">): number {
  return Math.min(MAX_PART_BYTES, Math.max(policy.partSizeBytes, roundUpToMiB(Math.ceil(sizeBytes / MAX_PARTS))));
}

export type DirectUploadPlan = { mode: "single"; partSize: null } | { mode: "multipart"; partSize: number };

/**
 * Single PUT for a known size up to one part (or any size up to 5 GiB when the caller asks for `singlePart`);
 * multipart otherwise. Unknown sizes always stream as multipart.
 */
export function planDirectUpload(file: { sizeBytes?: number; singlePart?: boolean }, policy: UploadTransferPolicy): DirectUploadPlan {
  if (file.sizeBytes === undefined) return { mode: "multipart", partSize: policy.streamPartSizeBytes };
  if (file.singlePart || file.sizeBytes <= policy.partSizeBytes) return { mode: "single", partSize: null };
  return { mode: "multipart", partSize: partSizeFor(file.sizeBytes, policy) };
}

/** Exact size of part `partNumber` (1-based) of a known-size file. */
export function partSizeAt(partNumber: number, sizeBytes: number, partSize: number): number {
  return Math.max(0, Math.min(partSize, sizeBytes - (partNumber - 1) * partSize));
}
