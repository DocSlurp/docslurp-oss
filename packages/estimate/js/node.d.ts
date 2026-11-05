import type { EstimateOptions, EstimateResult, Estimator, FileMeta, ProbeResult, Quote, QuoteRequest } from "./index.js";

export function probePath(estimator: Estimator, path: string, type?: string): Promise<{ file: FileMeta; probe: ProbeResult }>;
export function quotePaths(estimator: Estimator, paths: string[], request?: Omit<QuoteRequest, "files">): Promise<Quote & { probes: Array<ProbeResult | null> }>;
export function estimatePaths(estimator: Estimator, paths: Array<string | { path: string; type?: string }>, options?: EstimateOptions): Promise<EstimateResult>;
