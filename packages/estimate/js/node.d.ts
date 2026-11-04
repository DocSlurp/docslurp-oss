import type { Estimator, FileMeta, ProbeResult, Quote, QuoteRequest } from "./index.js";

export function probePath(estimator: Estimator, path: string, type?: string): Promise<{ file: FileMeta; probe: ProbeResult }>;
export function quotePaths(estimator: Estimator, paths: string[], request?: Omit<QuoteRequest, "files">): Promise<Quote & { probes: Array<ProbeResult | null> }>;
