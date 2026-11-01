import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { defaultVisionRequestWeightCents, type VisionRequestGate } from './vision-attempt-guard.js';
import { executeDopplerVm, dopplerVmUsage, VM_TIMEOUT_MS } from '../sandbox/providers/modal/doppler-vm.js';
import type { OrientationResult } from '../sandbox/providers/modal/image-orientation.js';
import { SandboxRunError } from '../sandbox/types.js';
import type { UsageEvent } from '../models.js';

export function imageOrientationEnabled(): boolean {
  const value = process.env.DOCSLURP_IMAGE_ORIENTATION ?? 'true';
  if (!['false','true','0','1'].includes(value)) throw new Error('DOCSLURP_IMAGE_ORIENTATION must be true, false, 0 or 1');
  return value === 'true' || value === '1';
}

/** Shared for page scans and extracted image assets; no local parsing/fallback. */
export async function normalizeImageOrientation(input: string, recordUsage: (event: UsageEvent) => void, signal?: AbortSignal) {
  const output = `${input}.${randomUUID()}.upright.png`;
  try {
    const result = await executeDopplerVm({ operation:'image-orientation', input, output }, signal);
    if (result.usage) recordUsage(result.usage);
    const metadata = JSON.parse(result.stdout).orientation as OrientationResult;
    return { path:output, metadata, release:() => rm(output,{force:true}) };
  } catch (error) {
    if (error instanceof SandboxRunError && error.usage) recordUsage(error.usage);
    await rm(output,{force:true});
    throw error;
  }
}

/** Reserve admission before paid preprocessing; the actual VLM request is admitted separately.
 * No model request was sent under this reservation, so release it as cancelled afterward.
 * Compute spend is recorded separately even when preparation fails.
 */
export async function withOrientationAdmission<T>(gate: VisionRequestGate, prepare: () => Promise<T>): Promise<T> {
  await gate.admit({ weightCents: defaultVisionRequestWeightCents() + dopplerVmUsage('orientation', VM_TIMEOUT_MS / 1000).costCents });
  try { return await prepare(); } finally { await gate.unbilled('cancelled'); }
}

/** A bounded allowance per workflow state; failures consume an attempt too.
 * Checkpoints persist the count, but this is not an exactly-once monetary budget.
 */
export function reserveOrientationAttempt(state: { run: { stats: Record<string, unknown> } }): boolean {
  const count = state.run.stats.imageOrientationAttempts ?? 0;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('Invalid image orientation attempt counter');
  }
  if (count >= 64) return false;
  state.run.stats.imageOrientationAttempts = count + 1;
  return true;
}
