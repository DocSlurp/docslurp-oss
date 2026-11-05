import { describe, expect, it } from "vitest";

import { PRICE_CARD, pageCredits } from "./billing.js";
import { estimateUploadMedia, stripHtmlMarkup, textPageCount, uploadMediaKind } from "./media-upload-estimate.js";

describe("uploadMediaKind", () => {
  it("reads the MIME type, then the extension", () => {
    expect(uploadMediaKind({ name: "a.bin", type: "audio/mpeg" })).toBe("audio");
    expect(uploadMediaKind({ name: "a.bin", type: "video/mp4; codecs=avc1" })).toBe("video");
    expect(uploadMediaKind({ name: "Talk.MP3" })).toBe("audio");
    expect(uploadMediaKind({ name: "talk.weba", type: "application/octet-stream" })).toBe("audio");
    expect(uploadMediaKind({ name: "demo.webm" })).toBe("video");
    expect(uploadMediaKind({ name: "report.pdf", type: "application/pdf" })).toBeNull();
    expect(uploadMediaKind({ name: "no-extension" })).toBeNull();
  });
});

describe("estimateUploadMedia", () => {
  it("is null when nothing is audio or video", () => {
    expect(estimateUploadMedia([{ name: "a.pdf", size: 1_000 }], { videoFrames: true })).toBeNull();
  });

  it("prices video by the minute, three times audio when frames are read", () => {
    const estimate = estimateUploadMedia([{ name: "demo.mp4", size: 50_000_000, durationSeconds: 600 }], { videoFrames: true })!;
    expect(estimate.videoMinutes).toBe(10);
    expect(estimate.durationsAssumed).toBe(false);
    expect(estimate.credits.high).toBeCloseTo(pageCredits("rich", 10 * PRICE_CARD.videoMinuteRichPages));
    expect(estimate.credits.low).toBeCloseTo(pageCredits("rich", 10 * PRICE_CARD.audioMinuteRichPages));
    expect(estimate.lighter).toEqual({
      kind: "video-audio-track-only",
      credits: estimate.credits.low,
      savedCredits: estimate.credits.high - estimate.credits.low,
      pipeline: { mediaVideo: { enabled: false } },
    });
  });

  it("rounds each file up to whole minutes", () => {
    const estimate = estimateUploadMedia([
      { name: "a.mp3", size: 1, durationSeconds: 61 },
      { name: "b.mp3", size: 1, durationSeconds: 61 },
    ], { videoFrames: true })!;
    expect(estimate.credits.high).toBeCloseTo(pageCredits("rich", 4));
    expect(estimate.lighter).toBeNull();
  });

  it("offers nothing cheaper when the workspace already skips video frames", () => {
    const estimate = estimateUploadMedia([{ name: "demo.mp4", size: 1, durationSeconds: 300 }], { videoFrames: false })!;
    expect(estimate.credits.low).toBe(estimate.credits.high);
    expect(estimate.lighter).toBeNull();
  });

  it("guesses a missing duration from the file size and says so", () => {
    const estimate = estimateUploadMedia([{ name: "talk.mp3", size: 10 * 1_000 * 1024 }], { videoFrames: true })!;
    expect(estimate.durationsAssumed).toBe(true);
    expect(estimate.audioMinutes).toBe(10);
  });
});


describe("stripHtmlMarkup and textPageCount on hostile input", () => {
  const MEGABYTES = (n: number) => n * 1_000_000;
  const timed = (run: () => unknown) => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  // Each case floods the scanner with the construction that made it rescan the remainder from every "<".
  const floods: Record<string, (bytes: number) => string> = {
    "bare '<a' with no closing '>'": (bytes) => "<a".repeat(bytes / 2),
    "'< ' that is never a tag, with one '>' at the end": (bytes) => `${"< ".repeat(bytes / 2)}>`,
    "'<!x' bogus comments with no '>'": (bytes) => "<!x".repeat(bytes / 3),
    "unclosed comments": (bytes) => "<!--".repeat(bytes / 4),
    "unclosed <script": (bytes) => "<script ".repeat(bytes / 8),
    "unclosed </script": (bytes) => "<script></script ".repeat(bytes / 17),
    "'<' only": (bytes) => "<".repeat(bytes),
    "alternating script and style openers": (bytes) => "<style x<script y".repeat(bytes / 17),
  };

  for (const [name, build] of Object.entries(floods)) {
    it(`strips ${name} in linear time at 5 MB`, () => {
      // Compared with one plain pass over the same text, measured back to back, so machine load slows both alike.
      // Linear stripping costs a small multiple of that pass (~10-30x); a quadratic one costs thousands of times more
      // at 5 MB. Best of three per measurement; the absolute cap only catches a pass that never finishes.
      const input = build(MEGABYTES(5));
      const best = (fn: () => void) => Math.min(timed(fn), timed(fn), timed(fn));
      const scan = () => {
        let sum = 0;
        for (let index = 0; index < input.length; index++) sum = (sum + input.charCodeAt(index)) | 0;
        return sum;
      };
      for (const run of [() => stripHtmlMarkup(input), () => textPageCount(input, { markup: true })]) {
        const scanMs = Math.max(1, best(scan));
        const runMs = best(run);
        expect(runMs / scanMs).toBeLessThan(400);
        expect(runMs).toBeLessThan(10_000);
      }
    }, 30_000);
  }

  it("still removes tags, comments, scripts and styles", () => {
    const html = "<p>Hello <b>world</b></p><!-- hidden --><script>var a = '<b>';</script><style>p{}</style>< not a tag > x";
    const visible = stripHtmlMarkup(html);
    expect(visible).toContain("Hello");
    expect(visible).toContain("world");
    expect(visible).not.toContain("hidden");
    expect(visible).not.toContain("var a");
    expect(visible).not.toContain("p{}");
    expect(visible).toContain("< not a tag > x");
  });

  it("measures plain text of any size in bounded time, extrapolating past the sample", () => {
    const line = "word ".repeat(40) + "\n";
    const input = line.repeat(Math.ceil(MEGABYTES(20) / line.length));
    expect(timed(() => textPageCount(input))).toBeLessThan(500);
    const sampled = textPageCount(input);
    // 20 MB of 201-char lines is ~99,500 lines; an unsampled count would be ~1,660 pages by lines, ~5,700 by characters.
    expect(sampled).toBeGreaterThan(5_000);
    expect(sampled).toBeLessThan(7_000);
  });

  it("counts CJK-heavy hostile input in bounded time", () => {
    const input = "漢字".repeat(MEGABYTES(5) / 2);
    expect(timed(() => textPageCount(input))).toBeLessThan(500);
  });
});
