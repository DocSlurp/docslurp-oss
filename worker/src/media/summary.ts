import type { MediaSummary } from "@docslurp/shared";
import type { MediaKind, VisualSegment } from "./canonical.js";
import { wordCount } from "./canonical.js";
import type { SegmentTiming } from "./types.js";
import type { TimedSegment } from "./segments.js";

const TEXT_CUE = /["“”'‘’][^"“”'‘’\n]{3,}["“”'‘’]|\b(text|label|caption|title|reads|says|written|slide|heading|menu|logo)\b/i;
const FRAME_CITE = /(\d+(?:\.\d+)?)\s*(?:s\b|sec)/gi;

/**
 * Heuristic: a sampled frame "has text" when the description line citing its timestamp quotes text or
 * names text-bearing UI (label, caption, title, ...). Descriptions without per-frame citations fall back
 * to the batch as a whole, so this is an upper-bound estimate, not OCR coverage.
 */
export function framesWithText(visual: Pick<VisualSegment, "samples" | "text">[]): number {
  let count = 0;
  for (const segment of visual) {
    const cited = new Set<number>();
    for (const line of segment.text.split("\n")) {
      if (!TEXT_CUE.test(line)) continue;
      for (const match of line.matchAll(FRAME_CITE)) {
        const t = Number(match[1]);
        const frame = segment.samples.findIndex(s => Math.abs(s - t) < 0.51);
        if (frame >= 0) cited.add(frame);
      }
    }
    count += cited.size > 0 ? cited.size : TEXT_CUE.test(segment.text) ? segment.samples.length : 0;
  }
  return count;
}

export function buildMediaSummary(args: {
  mediaKind: MediaKind; durationSeconds: number; segments: TimedSegment[]; visualSegments: VisualSegment[];
  coverage: MediaSummary["coverage"]; costUsd: number; diarized: boolean;
  diarization?: MediaSummary["diarization"]; diarizationReason?: string;
}): MediaSummary {
  const rank: Record<SegmentTiming, number> = { word: 2, segment: 1, chunk: 0 };
  const timing = args.segments.reduce<SegmentTiming>((lowest, s) => rank[s.timing] < rank[lowest] ? s.timing : lowest, "word");
  return {
    mediaKind: args.mediaKind, durationSeconds: args.durationSeconds,
    wordCount: args.segments.reduce((n, s) => n + wordCount(s.text), 0),
    speakerCount: new Set(args.segments.map(s => s.speaker).filter(Boolean)).size,
    segmentCount: args.segments.length,
    keyframesIndexed: args.visualSegments.reduce((n, v) => n + v.samples.length, 0),
    framesWithText: framesWithText(args.visualSegments),
    coverage: args.coverage, ingestCostCents: args.costUsd * 100,
    timing: args.segments.length ? timing : "segment", diarized: args.diarized,
    ...(args.diarization ? { diarization: args.diarization, ...(args.diarizationReason ? { diarizationReason: args.diarizationReason } : {}) } : {}),
  };
}
