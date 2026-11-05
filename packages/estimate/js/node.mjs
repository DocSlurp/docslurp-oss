// Node helpers for @docslurp/estimate: probe files on disk, reading only the bytes the probe needs.
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";

import { applyProbe, EstimatorError } from "./index.mjs";

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

/** Probe the file at `path`. `type` is its MIME type when known. */
export async function probePath(estimator, path, type) {
  const { size } = await stat(path);
  const file = { name: basename(path), size, ...(type ? { type } : {}) };
  const plan = estimator.readPlan(file);
  const handle = await open(path, "r");
  try {
    const head = await read(handle, 0, plan.head);
    const tail = plan.tail > 0 ? await read(handle, size - plan.tail, plan.tail) : undefined;
    return { file, probe: estimator.probe(file, head, tail) };
  } finally {
    await handle.close();
  }
}

/** Probe each path and quote them together. Files the probe cannot read are priced from name and size. */
export async function quotePaths(estimator, paths, request = {}) {
  const files = [];
  const probes = [];
  for (const path of paths) {
    try {
      const { file, probe } = await probePath(estimator, path);
      probes.push(probe);
      files.push(applyProbe(file, probe));
    } catch (error) {
      if (!(error instanceof EstimatorError)) throw error;
      const { size } = await stat(path);
      probes.push(null);
      files.push({ name: basename(path), size });
    }
  }
  return { ...estimator.quote({ ...request, files }), probes };
}
