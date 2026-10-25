import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

/** One file in a streamed zip. `body` is read only when the archive reaches it. */
export interface ZipStreamEntry {
  path: string;
  /** Deflate text and JSON; store media that is already compressed. */
  compress: boolean;
  modifiedAt?: Date;
  /** Always included, even past the size limit (a small index of the archive). */
  required?: boolean;
  body: () => Promise<ZipStreamBody | null>;
}

/** Bytes in hand, or a stream with its length when storage reports one. */
export type ZipStreamBody = Uint8Array | string | { stream: AsyncIterable<Uint8Array>; size: number | null };

/** Zip without ZIP64 must stay under 4 GiB; stop adding files well before that. */
export const ZIP_MAX_BYTES = 3.5 * 1024 ** 3;

const encoder = new TextEncoder();

/**
 * Streams a zip archive entry by entry, so memory holds one chunk at a time.
 * An entry whose body throws or returns null is left out and reported through
 * `onSkip`; the archive itself only fails when the consumer stops reading.
 */
export async function* zipStream(
  entries: AsyncIterable<ZipStreamEntry> | Iterable<ZipStreamEntry>,
  options: { onSkip?: (path: string, reason: string) => void; onAdd?: (path: string) => void; maxBytes?: number } = {},
): AsyncGenerator<Uint8Array> {
  const pending: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else pending.push(chunk);
  });
  const drain = function* () {
    if (failure) throw failure;
    while (pending.length > 0) yield pending.shift()!;
  };
  const maxBytes = options.maxBytes ?? ZIP_MAX_BYTES;
  let written = 0;

  for await (const entry of entries) {
    let body: Awaited<ReturnType<ZipStreamEntry["body"]>>;
    try {
      body = await entry.body();
    } catch (error) {
      options.onSkip?.(entry.path, error instanceof Error ? error.message : "unreadable");
      continue;
    }
    if (body === null) continue;

    const file = entry.compress ? new ZipDeflate(entry.path, { level: 6 }) : new ZipPassThrough(entry.path);
    if (entry.modifiedAt) file.mtime = entry.modifiedAt;

    if (typeof body === "string" || body instanceof Uint8Array) {
      const bytes = typeof body === "string" ? encoder.encode(body) : body;
      if (!entry.required && written + bytes.byteLength > maxBytes) {
        options.onSkip?.(entry.path, "export size limit reached");
        continue;
      }
      zip.add(file);
    options.onAdd?.(entry.path);
      file.push(bytes, true);
      written += bytes.byteLength;
      yield* drain();
      continue;
    }

    if (body.size !== null && written + body.size > maxBytes) {
      options.onSkip?.(entry.path, "export size limit reached");
      continue;
    }
    // A started entry cannot be withdrawn, so a stream that fails midway ends
    // its file early and is reported rather than corrupting the archive.
    zip.add(file);
    options.onAdd?.(entry.path);
    try {
      for await (const chunk of body.stream) {
        written += chunk.byteLength;
        if (written > maxBytes) throw new Error("export size limit reached");
        file.push(chunk, false);
        yield* drain();
      }
    } catch (error) {
      options.onSkip?.(entry.path, `incomplete: ${error instanceof Error ? error.message : "read failed"}`);
    }
    file.push(new Uint8Array(0), true);
    yield* drain();
  }

  zip.end();
  yield* drain();
}
