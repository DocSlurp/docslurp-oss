import type { EstimateOptions, EstimateProfile, EstimateCard, EstimateResult } from "./index.js";

export type EstimateWorkerOptions = Omit<EstimateOptions, "profile"> & {
  profile?: EstimateProfile;
  /** URL of the wasm module, resolved inside the worker; default: the bundled file. */
  module?: string;
  card?: EstimateCard;
  /** How long an aborted run may take to return its partial result before the worker is terminated. Default 1500 ms. */
  abortGraceMs?: number;
};

export type EstimateWorkerClient = {
  estimate(files: ArrayLike<Blob & { name: string }> | Iterable<Blob & { name: string }>, options?: EstimateWorkerOptions): Promise<EstimateResult>;
  terminate(): void;
};

/** Wrap a worker running `@docslurp/estimate/worker` (a Web Worker, or a node:worker_threads Worker). */
export function createEstimateWorker(worker: Worker | { postMessage(message: unknown): void; on(event: string, listener: (...args: any[]) => void): unknown; off(event: string, listener: (...args: any[]) => void): unknown; terminate(): unknown }, defaults?: EstimateWorkerOptions): EstimateWorkerClient;
