import { normalizeNfc, wordParts } from "../lib/unicode-text.js";
import type { SegmentTiming, SpeakerTurn, Transcription, TranscriptSegment, TranscriptWord } from "./types.js";

/** A transcript segment with absolute time (seconds from media start) and an honest precision label. */
export type TimedSegment = TranscriptSegment & { timing: SegmentTiming };

export interface ChunkWindow {
  /** Audio actually sent to the provider (includes overlap on both sides). */
  start: number; end: number;
  /** The slice of the timeline this window is responsible for. */
  ownStart: number; ownEnd: number;
}

/**
 * Fixed-size ownership slices, each sent with `overlap` seconds of extra audio on both sides so a
 * sentence that straddles a boundary is transcribed whole in at least one window.
 */
export function planChunkWindows(duration: number, chunkSeconds: number, overlap: number): ChunkWindow[] {
  const windows: ChunkWindow[] = [];
  for (let ownStart = 0; ownStart < duration; ownStart += chunkSeconds) {
    const ownEnd = Math.min(ownStart + chunkSeconds, duration);
    windows.push({ ownStart, ownEnd, start: Math.max(0, ownStart - overlap), end: Math.min(duration, ownEnd + overlap) });
  }
  return windows;
}

/**
 * A text-only response to an overlapped window contains speech from the neighbouring slices too. Keep the speech
 * that falls proportionally inside the owned slice (speech rate is close enough to uniform over a few seconds), so
 * boundaries are neither duplicated nor dropped. Without overlap the text is returned unchanged.
 *
 * Speech is measured in words (one per word, one per ideographic character) cut at boundaries from the Unicode
 * word segmenter, not at whitespace: Japanese, Chinese and Thai transcripts have no spaces, so a whitespace "word count" saw one word and
 * either kept the whole overlap or dropped the whole window. The text keeps its own spacing.
 */
export function trimToOwnedSlice(text: string, window: ChunkWindow): string {
  const total = window.end - window.start;
  const lead = window.ownStart - window.start; const tail = window.end - window.ownEnd;
  if (!text || total <= 0 || (lead <= 0 && tail <= 0)) return text;
  const parts = wordParts(normalizeNfc(text)).map(part => ({ text: part.text, weight: part.wordLike ? speechWeight(part.text) : 0 }));
  const speech = parts.reduce((sum, part) => sum + part.weight, 0);
  if (speech === 0) return text;
  const boundaryAt = (target: number) => {
    // The unit boundary whose cumulative speech is closest to the target.
    let best = 0; let bestDistance = Infinity; let cumulative = 0;
    for (let i = 0; i <= parts.length; i++) {
      const distance = Math.abs(cumulative - target);
      if (distance < bestDistance) { best = i; bestDistance = distance; }
      if (i < parts.length) cumulative += parts[i].weight;
    }
    return best;
  };
  const from = boundaryAt(speech * (lead / total));
  const to = Math.max(from, boundaryAt(speech * ((total - tail) / total)));
  return parts.slice(from, to).map(part => part.text).join("").trim();
}

/** A word is one unit of speech; each ideographic character is one syllable, so a run of kanji weighs its length. */
const speechWeight = (word: string) => {
  const ideographic = word.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  return ideographic || 1;
};

/** Convert one provider response to absolute-time segments; word timestamps tighten segment bounds. */
export function toTimedSegments(result: Pick<Transcription, "text" | "segments">, window: ChunkWindow): TimedSegment[] {
  if (!result.segments.length) {
    const text = trimToOwnedSlice(result.text.trim(), window);
    // Without provider timestamps only the owned slice is knowable.
    return text ? [{ start: window.ownStart, end: window.ownEnd, text, timing: "chunk" }] : [];
  }
  return result.segments.filter(s => s.text.trim()).map(segment => {
    const words: TranscriptWord[] | undefined = segment.words?.length
      ? segment.words.map(w => ({ ...w, start: w.start + window.start, end: w.end + window.start })) : undefined;
    const start = words ? words[0].start : segment.start + window.start;
    const end = words ? Math.max(start, words[words.length - 1].end) : segment.end + window.start;
    return { ...segment, text: segment.text.trim(), start, end, ...(words ? { words } : {}), timing: words ? "word" as const : "segment" as const };
  });
}

/**
 * Stitches overlapping windows into one timeline without cut or repeated sentences.
 * A window keeps segments that begin after the previous window's last kept segment, and (unless it is
 * the final window) only those that begin inside its own slice; the next window supplies the rest.
 */
export class SegmentAssembler {
  readonly segments: TimedSegment[] = [];
  add(window: ChunkWindow, incoming: TimedSegment[], isLast: boolean) {
    const cursor = this.segments.at(-1)?.end ?? 0;
    let kept = incoming.filter(s => (s.start + s.end) / 2 >= cursor - 1e-6);
    if (!isLast) {
      kept = kept.filter(s => s.start < window.ownEnd);
      // A segment that touches the end of the audio window was probably cut mid-sentence. If the next
      // window (which starts `overlap` earlier) will see its start, let that window transcribe it whole.
      const last = kept.at(-1);
      if (last && last.timing !== "chunk" && last.end >= window.end - 0.25 && last.start >= window.ownEnd - (window.end - window.ownEnd)) kept = kept.slice(0, -1);
    }
    this.segments.push(...kept);
  }
}

const speakerNumber = (label: string, order: Map<string, number>) => {
  if (!order.has(label)) order.set(label, order.size + 1);
  return `Speaker ${order.get(label)}`;
};

function overlapWith(start: number, end: number, turn: SpeakerTurn) {
  return Math.max(0, Math.min(end, turn.end) - Math.max(start, turn.start));
}
function speakerFor(start: number, end: number, turns: SpeakerTurn[]): string | undefined {
  const totals = new Map<string, number>();
  for (const turn of turns) {
    if (turn.start > end) break;
    const overlap = overlapWith(start, end, turn);
    if (overlap > 0) totals.set(turn.speaker, (totals.get(turn.speaker) ?? 0) + overlap);
  }
  let best: string | undefined; let bestValue = 0;
  for (const [speaker, value] of totals) if (value > bestValue) { best = speaker; bestValue = value; }
  if (best) return best;
  // Word or segment sits in a gap between turns: use the nearest turn within a second.
  let near: SpeakerTurn | undefined; let distance = 1;
  for (const turn of turns) {
    const d = start >= turn.end ? start - turn.end : turn.start >= end ? turn.start - end : 0;
    if (d < distance) { near = turn; distance = d; }
  }
  return near?.speaker;
}

/**
 * Attach "Speaker N" labels from diarization turns. Segments with word timestamps are split where the
 * speaker changes (a two-word flicker in the middle of a sentence is absorbed by the surrounding speaker).
 */
export function applySpeakers(segments: TimedSegment[], turns: SpeakerTurn[]): TimedSegment[] {
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  const order = new Map<string, number>();
  const result: TimedSegment[] = [];
  for (const segment of segments) {
    if (!segment.words?.length || segment.timing === "chunk") {
      const label = speakerFor(segment.start, segment.end, sorted);
      result.push(label ? { ...segment, speaker: speakerNumber(label, order) } : segment);
      continue;
    }
    const labelled = segment.words.map(word => ({ word, speaker: speakerFor(word.start, word.end, sorted) }));
    const runs: { speaker: string | undefined; words: TranscriptWord[] }[] = [];
    for (const { word, speaker } of labelled) {
      const run = runs.at(-1);
      if (run && run.speaker === speaker) run.words.push(word); else runs.push({ speaker, words: [word] });
    }
    // Diarization flickers: a run of fewer than three words sandwiched between the same speaker, in the middle of
    // a sentence. A short run after sentence-ending punctuation ("Understood.") is a real turn and is kept.
    for (let i = 1; i < runs.length - 1; i++) {
      const previousText = runs[i - 1].words.at(-1)?.text ?? "";
      if (runs[i].words.length < 3 && runs[i - 1].speaker === runs[i + 1].speaker && !/[.!?…]["')\]]*$/.test(previousText)) {
        runs[i - 1].words.push(...runs[i].words);
        runs.splice(i, 1);
        i--;
      }
    }
    // Merge neighbors that became the same speaker after absorption.
    const merged: typeof runs = [];
    for (const run of runs) {
      const previous = merged.at(-1);
      if (previous && previous.speaker === run.speaker) previous.words.push(...run.words); else merged.push(run);
    }
    for (const run of merged) {
      result.push({ ...segment, text: run.words.map(w => w.text).join(" ").replace(/\s+([,.!?;:])/g, "$1"),
        start: run.words[0].start, end: run.words.at(-1)!.end, words: run.words,
        ...(run.speaker ? { speaker: speakerNumber(run.speaker, order) } : {}) });
    }
  }
  return result;
}
