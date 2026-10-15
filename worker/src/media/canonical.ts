import type { CanonicalBlock, CanonicalDocument } from "@docslurp/shared";
import type { TimedSegment } from "./segments.js";

export interface VisualSegment { id: string; start: number; end: number; samples: number[]; text: string; }
export type MediaKind = "audio" | "video";

const pad = (n: number) => String(n).padStart(2, "0");
/** mm:ss, or h:mm:ss from one hour on. */
export function clock(seconds: number, round: "floor" | "ceil" = "floor"): string {
  const s = Math.max(0, Math[round](seconds - (round === "ceil" ? 1e-6 : 0)));
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
export function clockRange(start: number, end: number): string {
  const a = clock(start);
  if (end - start < 1) return a;
  const b = clock(end, "ceil");
  return a === b ? a : `${a}–${b}`;
}

export function segmentLine(segment: Pick<TimedSegment, "start" | "end" | "text" | "speaker">): string {
  return `[${clockRange(segment.start, segment.end)}] ${segment.speaker ? `${segment.speaker}: ` : ""}${segment.text.trim()}`;
}
export function visualLine(segment: Pick<VisualSegment, "start" | "end" | "text">): string {
  return `[${clockRange(segment.start, segment.end)}] On screen: ${segment.text.trim()}`;
}

/**
 * One canonical block per transcript segment (or speaker turn) and per visual batch, in time order.
 * Block metadata carries the machine-readable time span so chunks and citations never have to parse the text.
 */
export function buildMediaCanonicalDocument(args: {
  documentId: string; mediaKind: MediaKind; durationSeconds: number; segments: TimedSegment[];
  visualSegments: VisualSegment[]; sourceArtifactUri: string; extractor: string;
}): { text: string; canonical: CanonicalDocument } {
  type Entry = { start: number; text: string; metadata: Record<string, unknown> };
  const entries: Entry[] = [
    ...args.segments.map((s): Entry => ({ start: s.start, text: segmentLine(s), metadata: {
      mediaKind: args.mediaKind, mode: "said", startSeconds: s.start, endSeconds: s.end, speaker: s.speaker ?? null, timing: s.timing,
      durationSeconds: args.durationSeconds, frameSeconds: [], wordCount: wordCount(s.text) } })),
    ...args.visualSegments.map((v): Entry => ({ start: v.start, text: visualLine(v), metadata: {
      mediaKind: args.mediaKind, mode: "shown", startSeconds: v.start, endSeconds: v.end, speaker: null, timing: "segment",
      durationSeconds: args.durationSeconds, frameSeconds: v.samples, evidenceId: v.id } })),
  ].sort((a, b) => a.start - b.start);
  const blocks: CanonicalBlock[] = entries.map((entry, order) => ({
    id: `${args.documentId}:block:${String(order).padStart(4, "0")}`, type: "paragraph", order, text: entry.text, headingPath: [],
    pageNumber: 1, lineStart: null, lineEnd: null, bbox: null, metadata: entry.metadata,
  }));
  const text = entries.map(e => e.text).join("\n\n");
  return { text, canonical: {
    documentId: args.documentId, generator: "media-segment-blocks@v1",
    source: { format: "plain-text", artifactUri: args.sourceArtifactUri, extractor: args.extractor, parser: null, parserArtifactUri: null },
    stats: { blockCount: blocks.length, headingCount: 0, paragraphCount: blocks.length, codeBlockCount: 0, tableCount: 0, pageCount: 1 },
    blocks,
  } };
}

export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
