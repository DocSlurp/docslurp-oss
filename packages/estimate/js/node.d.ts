import type { EstimateOptions, EstimateResult, Estimator, FileMeta, FileProfile } from "./index.js";

export function profilePath(estimator: Estimator, path: string, type?: string): Promise<{ file: FileMeta; profile: FileProfile }>;
export function profilePathWithPageStats(estimator: Estimator, path: string, type?: string): Promise<{ file: FileMeta; profile: FileProfile; pageStats: string }>;
export function profilePathJsonl(estimator: Estimator, path: string, options?: import("./index.js").PageProfileOptions): AsyncGenerator<string>;
export function estimatePaths(estimator: Estimator, paths: Array<string | { path: string; type?: string }>, options?: EstimateOptions): Promise<EstimateResult>;
