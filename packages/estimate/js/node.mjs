// Node helpers for @docslurp/estimate: profile files on disk, reading only the bytes a profile needs.
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";

import { estimateFiles } from "./index.mjs";

async function read(handle, position, length) {
  const buffer = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

/** Profile the file at `path`. `type` is its MIME type when known. */
export async function profilePath(estimator, path, type) {
  const { size } = await stat(path);
  const file = { name: basename(path), size, ...(type ? { type } : {}) };
  const plan = estimator.readPlan(file);
  const handle = await open(path, "r");
  try {
    const head = await read(handle, 0, plan.head);
    const tail = plan.tail > 0 ? await read(handle, size - plan.tail, plan.tail) : undefined;
    return { file, profile: estimator.profile(file, head, tail) };
  } finally {
    await handle.close();
  }
}

/** A source over a file on disk; a path that cannot be read is reported as a failed file, not thrown. */
async function pathSource(path, type) {
  const name = basename(path);
  try {
    const { size } = await stat(path);
    return {
      name,
      size,
      ...(type ? { type } : {}),
      async open() {
        const handle = await open(path, "r");
        return { read: (position, length) => read(handle, position, length), close: () => handle.close() };
      },
    };
  } catch (error) {
    return { name, size: 0, ...(type ? { type } : {}), error: { code: "read_failed", message: error?.message ?? String(error) }, open: async () => { throw error; } };
  }
}

/**
 * `estimateFiles` for paths on disk: the same events, stats, cancellation and per-file fallbacks. Each entry is a
 * path or `{ path, type }`.
 */
export async function estimatePaths(estimator, paths, options = {}) {
  const sources = [];
  for (const entry of paths) sources.push(typeof entry === "string" ? await pathSource(entry) : await pathSource(entry.path, entry.type));
  return estimateFiles(estimator, sources, options);
}
