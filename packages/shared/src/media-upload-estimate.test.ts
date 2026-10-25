import { describe, expect, it } from "vitest";

import { PRICE_CARD, pageCredits } from "./billing.js";
import { estimateUploadMedia, uploadMediaKind } from "./media-upload-estimate.js";

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
