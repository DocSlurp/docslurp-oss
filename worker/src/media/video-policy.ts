export interface VideoSettings {
  enabled?: boolean; scanFps?: number; maxSelectedFps?: number; maxFrames?: number;
  imagesPerCall?: number; maxVisualTokensPerCall?: number; maxClipSeconds?: number; maxCostCents?: number;
}
export interface VideoPolicy {
  duration: number; frames: number; images: number; scanFps: number;
  selectedFps: number; clipSeconds: number; visualTokens: number; maxCostCents: number;
}
// One policy for every organization: up to 2 hours at the frame density PRICE_CARD.videoMinuteRichPages is priced for
// (<= 12 frames/minute). A workspace or upload can only ask for less (`mediaVideo`), never more; credits, budgets and the
// per-document cost cap below bound spend.
const preset = { duration: 7200, frames: 1440, images: 24, scanFps: 2, selectedFps: 2, interval: 5, minimum: 24, clipSeconds: 120, visualTokens: 16384, maxCostCents: 1000 };
export function videoPolicy(duration: number, settings: VideoSettings = {}): VideoPolicy {
  if (!Number.isFinite(duration) || duration <= 0 || duration > preset.duration) throw new Error("Video duration exceeds the 2 hour limit");
  for (const [name, value] of Object.entries(settings)) if (name !== "enabled" && value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new Error(`Invalid video setting: ${name}`);
  return { duration, frames: Math.min(settings.maxFrames ?? preset.frames, preset.frames, Math.max(preset.minimum, Math.ceil(duration / preset.interval))),
    images: Math.min(settings.imagesPerCall ?? preset.images, preset.images),
    scanFps: Math.min(settings.scanFps ?? preset.scanFps, 10, 14400 / duration),
    selectedFps: Math.min(settings.maxSelectedFps ?? preset.selectedFps, preset.selectedFps),
    clipSeconds: Math.min(settings.maxClipSeconds ?? preset.clipSeconds, preset.clipSeconds),
    visualTokens: Math.min(settings.maxVisualTokensPerCall ?? preset.visualTokens, preset.visualTokens),
    maxCostCents: Math.min(settings.maxCostCents ?? preset.maxCostCents, preset.maxCostCents) };
}
export interface VideoCandidate { seconds: number; delta: number; area: number; tile: number; histogram: number; }
export function selectVideoFrames(rows: VideoCandidate[], policy: VideoPolicy): VideoCandidate[] {
  if (!rows.length || rows.length > 14401) throw new Error("Invalid video candidate count");
  rows.forEach((r,i) => { if (Object.values(r).some(v => !Number.isFinite(v) || v < 0) || r.seconds >= policy.duration || (i && r.seconds <= rows[i-1].seconds)) throw new Error("Invalid video candidate timeline"); });
  const budget = Math.floor(Math.min(rows.length, policy.frames));
  const minGap = 1 / policy.selectedFps;
  const anchors = Math.min(budget, Math.floor((rows.at(-1)!.seconds-rows[0].seconds)/minGap)+1, Math.ceil(policy.duration / 10) + 1);
  const selected = new Set<number>();
  for (let i=0;i<anchors;i++) {
    const t = rows[rows.length-1].seconds * i / Math.max(1, anchors-1);
    const previous = [...selected].at(-1);
    const earliest = previous === undefined ? rows[0].seconds : rows[previous].seconds + minGap;
    const latest = rows.at(-1)!.seconds - (anchors-i-1)*minGap;
    let best = -1;
    for (let j=0;j<rows.length;j++) if (rows[j].seconds + 1e-6 >= earliest && rows[j].seconds <= latest + 1e-6 &&
      (best < 0 || Math.abs(rows[j].seconds-t) < Math.abs(rows[best].seconds-t))) best=j;
    if (best >= 0) selected.add(best);
  }
  const ranked = rows.map((r,i) => ({ i, score: r.histogram + (r.area >= .002 ? r.tile : 0) }))
    .filter(({i}) => rows[i].delta >= .06 || (rows[i].area >= .002 && rows[i].tile >= .10)).sort((a,b) => b.score-a.score || a.i-b.i);
  for (const {i} of ranked) {
    if (selected.size >= budget) break;
    if ([...selected].every(j => Math.abs(rows[i].seconds-rows[j].seconds) + 1e-6 >= 1/policy.selectedFps)) selected.add(i);
  }
  return [...selected].sort((a,b) => a-b).map(i => rows[i]);
}
// 384x384 frames have <=144 32x32 patches. Reserve 2048 tokens per frame
// to cover processor padding and timestamps, plus separate prompt/output bounds.
// The full model context is additionally reserved for spend (not this estimate).
export const VIDEO_FRAME_TOKEN_BUDGET = 2048;
export function packVideoFrames(frames: VideoCandidate[], policy: VideoPolicy): VideoCandidate[][] {
  const cap = Math.min(policy.images, Math.floor(policy.visualTokens / VIDEO_FRAME_TOKEN_BUDGET));
  if (cap < 1) throw new Error("Video token budget cannot fit one frame");
  const batches: VideoCandidate[][]=[];
  for (const frame of frames) {
    let batch=batches[batches.length-1];
    if (!batch || batch.length >= cap || frame.seconds-batch[0].seconds > policy.clipSeconds) { batch=[]; batches.push(batch); }
    batch.push(frame);
  }
  return batches;
}
