import { describe, expect, it } from "vitest";
import { applySpeakers, planChunkWindows, SegmentAssembler, toTimedSegments, type TimedSegment } from "./segments.js";
import { buildMediaCanonicalDocument, clockRange } from "./canonical.js";
import { buildMediaSummary, framesWithText } from "./summary.js";
import { parseTranscription } from "./providers.js";

const seg = (start: number, end: number, text: string, extra: Partial<TimedSegment> = {}): TimedSegment => ({ start, end, text, timing: "segment", ...extra });

describe("chunk windows and overlap stitching", () => {
  it("plans owned slices with overlap on both sides, clamped to the media", () => {
    expect(planChunkWindows(650, 300, 4)).toEqual([
      { ownStart: 0, ownEnd: 300, start: 0, end: 304 },
      { ownStart: 300, ownEnd: 600, start: 296, end: 604 },
      { ownStart: 600, ownEnd: 650, start: 596, end: 650 },
    ]);
  });
  it("keeps a boundary-straddling sentence once and whole", () => {
    const [w0, w1] = planChunkWindows(600, 300, 4);
    const assembler = new SegmentAssembler();
    // Window 0 sees the sentence 298-302 whole thanks to its tail overlap.
    assembler.add(w0, [seg(290, 297, "before"), seg(298, 302, "straddling sentence")], false);
    // Window 1 sees it again with slightly different timing, then new material.
    assembler.add(w1, [seg(298.2, 302.1, "straddling sentence"), seg(303, 310, "after")], true);
    expect(assembler.segments.map(s => s.text)).toEqual(["before", "straddling sentence", "after"]);
  });
  it("does not lose a sentence whose start jitters across the boundary", () => {
    const [w0, w1] = planChunkWindows(600, 300, 4);
    const assembler = new SegmentAssembler();
    assembler.add(w0, [seg(290, 297, "a"), seg(300.1, 303, "b")], false);
    assembler.add(w1, [seg(299.8, 303, "b"), seg(304, 306, "c")], true);
    expect(assembler.segments.map(s => s.text)).toEqual(["a", "b", "c"]);
  });
  it("defers a segment cut off at the end of the audio window to the next window", () => {
    const [w0, w1] = planChunkWindows(600, 300, 4);
    const assembler = new SegmentAssembler();
    assembler.add(w0, [seg(290, 297, "a"), seg(299, 304, "cut off mid")], false);
    assembler.add(w1, [seg(299, 306, "cut off mid sentence, now whole")], true);
    expect(assembler.segments.map(s => s.text)).toEqual(["a", "cut off mid sentence, now whole"]);
  });
  it("labels responses without provider timestamps as chunk timing over the owned slice", () => {
    const window = planChunkWindows(600, 300, 4)[1];
    expect(toTimedSegments({ text: " all of it ", segments: [] }, window)).toEqual([{ start: 300, end: 600, text: "all of it", timing: "chunk" }]);
    expect(toTimedSegments({ text: " ", segments: [] }, window)).toEqual([]);
  });
  it("uses word timestamps for tight bounds and marks timing as word", () => {
    const window = planChunkWindows(600, 300, 4)[1];
    const [segment] = toTimedSegments({ text: "x", segments: [{ start: 0, end: 10, text: " hello there",
      words: [{ start: 1, end: 1.4, text: "hello" }, { start: 1.5, end: 2, text: "there" }] }] }, window);
    expect(segment).toMatchObject({ start: 297, end: 298, timing: "word" });
  });
});

describe("speaker assignment", () => {
  const turns = [{ start: 0, end: 6, speaker: "speaker_0" }, { start: 6.3, end: 16, speaker: "speaker_1" }];
  it("labels whole segments by dominant overlap in arrival order", () => {
    const out = applySpeakers([seg(0, 5, "hi"), seg(7, 12, "hello")], turns);
    expect(out.map(s => s.speaker)).toEqual(["Speaker 1", "Speaker 2"]);
  });
  it("splits a word-timed segment at a speaker change, keeping a one-word reply", () => {
    const w = (items: [string, number, number][]) => items.map(([text, start, end]) => ({ text, start, end }));
    const words = w([["Sounds", 4.6, 5], ["good", 5, 5.4], ["to", 5.5, 5.8], ["me.", 5.8, 6], ["Great.", 6.4, 6.8], ["Then", 6.8, 7.2], ["go.", 7.6, 8]]);
    const out = applySpeakers([{ start: 4.6, end: 8, text: "x", timing: "word", words }], turns);
    expect(out.map(s => [s.speaker, s.text])).toEqual([["Speaker 1", "Sounds good to me."], ["Speaker 2", "Great. Then go."]]);
    expect(out[1]).toMatchObject({ start: 6.4, end: 8 });
    // "Understood." directly after a sentence end is its own turn, even though it is one word.
    const reply = applySpeakers([{ start: 5, end: 7, text: "x", timing: "word", words: w([["Fine.", 5, 5.9], ["Understood.", 6.4, 6.9], ["Thanks.", 7, 7.4]]) }],
      [{ start: 0, end: 6, speaker: "a" }, { start: 6.3, end: 6.95, speaker: "b" }, { start: 6.95, end: 9, speaker: "a" }]);
    expect(reply.map(s => [s.speaker, s.text])).toEqual([["Speaker 1", "Fine."], ["Speaker 2", "Understood."], ["Speaker 1", "Thanks."]]);
  });
  it("absorbs a diarization flicker in the middle of a sentence", () => {
    const flicker = ["so", "we", "should", "maybe", "ship", "it", "soon"].map((text, i) => ({ text, start: 1 + i * 0.5, end: 1.5 + i * 0.5 }));
    const out = applySpeakers([{ start: 1, end: 4.5, text: "x", timing: "word", words: flicker }],
      [{ start: 0, end: 2.4, speaker: "a" }, { start: 2.4, end: 3.1, speaker: "b" }, { start: 3.1, end: 6, speaker: "a" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ speaker: "Speaker 1", text: "so we should maybe ship it soon" });
  });
  it("leaves segments unlabeled with no turns", () => {
    expect(applySpeakers([seg(0, 1, "a")], [])[0].speaker).toBeUndefined();
  });
});

describe("media canonical blocks", () => {
  it("emits one readable block per segment and visual batch, in time order, with machine-readable spans", () => {
    const { text, canonical } = buildMediaCanonicalDocument({ documentId: "d", mediaKind: "video", durationSeconds: 3700,
      segments: [seg(252, 270, "Revenue rose.", { speaker: "Speaker 1", timing: "word" }), seg(3605, 3606.5, "Thanks.")],
      visualSegments: [{ id: "d:visual:0", start: 250, end: 260, samples: [250, 255, 260], text: "Slide shows 'Q3 results'" }],
      sourceArtifactUri: "s3://x", extractor: "media:deepinfra" });
    expect(text.split("\n\n")).toEqual(["[04:10–04:20] On screen: Slide shows 'Q3 results'", "[04:12–04:30] Speaker 1: Revenue rose.", "[1:00:05–1:00:07] Thanks."]);
    expect(canonical.blocks.map(b => b.metadata.mode)).toEqual(["shown", "said", "said"]);
    expect(canonical.blocks[1].metadata).toMatchObject({ startSeconds: 252, endSeconds: 270, speaker: "Speaker 1", timing: "word", mediaKind: "video" });
    expect(clockRange(3, 3.4)).toBe("00:03");
  });
  it("summarizes the recording", () => {
    const segments = [seg(0, 2, "one two three", { speaker: "Speaker 1" }), seg(2, 4, "four five", { speaker: "Speaker 2", timing: "chunk" })];
    const visual = [{ id: "v", start: 0, end: 10, samples: [0, 5, 10], text: "0s: a room\n5s: slide titled \"Q3 results\"\n10s: people" }];
    expect(buildMediaSummary({ mediaKind: "video", durationSeconds: 12, segments, visualSegments: visual, coverage: "audio-and-sampled-visual", costUsd: 0.0123, diarized: true }))
      .toMatchObject({ wordCount: 5, speakerCount: 2, segmentCount: 2, keyframesIndexed: 3, framesWithText: 1, ingestCostCents: 1.23, timing: "chunk", diarized: true });
    expect(framesWithText([{ samples: [1, 2], text: "A plain landscape" }])).toBe(0);
  });
});

describe("provider timestamps", () => {
  it("attaches flat word lists to their segments and parses diarization turns", () => {
    const parsed = parseTranscription({ text: "hi there you", segments: [{ start: 0, end: 2, text: " hi there" }, { start: 2, end: 3, text: " you" }],
      words: [{ word: " hi", start: 0, end: .5 }, { word: " there", start: .5, end: 1 }, { word: " you", start: 2, end: 2.5 }],
      speaker_segments: [{ start: 0, end: 2, speaker: "speaker_0" }] }, 3, .01);
    expect(parsed.segments.map(s => s.words?.map(w => w.text))).toEqual([["hi", "there"], ["you"]]);
    expect(parsed.speakerTurns).toEqual([{ start: 0, end: 2, speaker: "speaker_0" }]);
  });
  it("parses optional words and speaker turns leniently: bad items are dropped or clamped, never thrown", () => {
    const parsed = parseTranscription({ text: "hi there", segments: [{ start: 0, end: 2, text: " hi there" }],
      words: [{ word: "there", start: 1, end: 1.5 }, { word: "hi", start: 0, end: .5 }, { word: "bad", start: 2, end: 1 }, { word: 3, start: 0, end: 1 },
        null, { word: "tail", start: 1.8, end: 9 }, { word: "late", start: 40, end: 41 }],
      speaker_segments: [{ start: 3, end: 1, speaker: "s" }, { start: 0, end: 1, speaker: "speaker_0" }, { start: 1, end: 99, speaker: "speaker_1" },
        { start: 50, end: 60, speaker: "speaker_2" }, null, { start: 0, end: 1, speaker: "" }] }, 5, 0);
    // sorted, bad items dropped, trailing word clamped to the audio length
    expect(parsed.segments[0].words).toEqual([{ start: 0, end: .5, text: "hi" }, { start: 1, end: 1.5, text: "there" }, { start: 1.8, end: 5, text: "tail" }]);
    // the trailing turn is clamped to the audio length instead of throwing; turns that start after the audio are dropped
    expect(parsed.speakerTurns).toEqual([{ start: 0, end: 1, speaker: "speaker_0" }, { start: 1, end: 5, speaker: "speaker_1" }]);
    expect(parseTranscription({ text: "x", segments: [], words: "nope", speaker_segments: "nope" }, 5, 0)).toMatchObject({ text: "x", segments: [] });
  });
});

describe("overlap on text-only responses", () => {
  const [w0, w1, w2] = planChunkWindows(900, 300, 4);
  it("keeps only the owned share of the words so boundary speech is not duplicated", () => {
    const text = Array.from({ length: 308 }, (_, i) => `w${i}`).join(" ");
    const middle = toTimedSegments({ text, segments: [] }, w1);
    expect(middle).toHaveLength(1);
    expect(middle[0]).toMatchObject({ start: 300, end: 600, timing: "chunk" });
    expect(middle[0].text.split(" ")).toHaveLength(300);
    expect(middle[0].text.startsWith("w4 ")).toBe(true);
    // without overlap the text is untouched
    const [plain] = planChunkWindows(300, 300, 0);
    expect(toTimedSegments({ text: "a b c", segments: [] }, plain)[0].text).toBe("a b c");
    expect(toTimedSegments({ text: " ", segments: [] }, w0)).toEqual([]);
    expect(w2.ownStart).toBe(600);
  });
});
