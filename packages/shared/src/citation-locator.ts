import { z } from "zod";

/**
 * Where inside a source a citation points. One locator per citation, keyed by
 * the shape of the source, so the chat can draw the cited thing exactly:
 * a passage on a page, a region on a slide, a cell range, a moment in a
 * recording (said or shown), or a region of an image.
 *
 * Boxes are normalized to the page/slide/frame/image: 0..1 from the top-left.
 */
/** Boxes per locator are bounded at write time (worker) and read time (API) so citations stay small. */
export const MAX_LOCATOR_BOXES = 32;

export const normalizedBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type NormalizedBox = z.infer<typeof normalizedBoxSchema>;

export const pageLocatorSchema = z.object({
  kind: z.literal("page"),
  pageNumber: z.number().int().positive(),
  /** Character offsets of the cited span within the page's extracted text. */
  charStart: z.number().int().nonnegative().nullable().default(null),
  charEnd: z.number().int().nonnegative().nullable().default(null),
  boxes: z.array(normalizedBoxSchema).default([]),
});

export const slideLocatorSchema = z.object({
  kind: z.literal("slide"),
  slideNumber: z.number().int().positive(),
  slideCount: z.number().int().positive().nullable().default(null),
  /** True when the cited text came from the speaker notes, not the slide body. */
  notes: z.boolean().default(false),
  title: z.string().nullable().default(null),
  boxes: z.array(normalizedBoxSchema).default([]),
});

export const sheetLocatorSchema = z.object({
  kind: z.literal("sheet"),
  sheetName: z.string().nullable().default(null),
  /** A1-style range, e.g. "B7:D8". */
  range: z.string(),
  headerRow: z.number().int().positive().nullable().default(null),
});

export const mediaLocatorSchema = z.object({
  kind: z.literal("media"),
  media: z.enum(["audio", "video"]),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative().nullable().default(null),
  /** "said" = transcript speech; "shown" = on-screen evidence from sampled frames. */
  mode: z.enum(["said", "shown"]),
  speaker: z.string().nullable().default(null),
  /** Provider timestamps are precise; chunk timing only bounds the segment. */
  timing: z.enum(["word", "segment", "chunk"]).default("segment"),
  frameSeconds: z.array(z.number().nonnegative()).default([]),
  boxes: z.array(normalizedBoxSchema).default([]),
});

export const imageLocatorSchema = z.object({
  kind: z.literal("image"),
  boxes: z.array(normalizedBoxSchema).default([]),
});

export const citationLocatorSchema = z.discriminatedUnion("kind", [
  pageLocatorSchema,
  slideLocatorSchema,
  sheetLocatorSchema,
  mediaLocatorSchema,
  imageLocatorSchema,
]);
export type CitationLocator = z.infer<typeof citationLocatorSchema>;
export type PageLocator = z.infer<typeof pageLocatorSchema>;
export type SlideLocator = z.infer<typeof slideLocatorSchema>;
export type SheetLocator = z.infer<typeof sheetLocatorSchema>;
export type MediaLocator = z.infer<typeof mediaLocatorSchema>;
export type ImageLocator = z.infer<typeof imageLocatorSchema>;

export function formatTimecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${String(m).padStart(2, "0")}:${sec}`;
}

/** Short human label used on citation chips, e.g. "p. 12", "slide 14", "Timeline!B7:D8", "04:12–04:30". */
export function formatCitationLocator(locator: CitationLocator): string {
  switch (locator.kind) {
    case "page":
      return `p. ${locator.pageNumber}`;
    case "slide":
      return locator.notes ? `slide ${locator.slideNumber} notes` : `slide ${locator.slideNumber}`;
    case "sheet":
      return locator.sheetName ? `${locator.sheetName}!${locator.range}` : locator.range;
    case "media": {
      const start = formatTimecode(locator.startSeconds);
      // The end rounds up, matching the transcript text's clock range, so the chip and the passage agree.
      const end = formatTimecode(Math.ceil(locator.endSeconds));
      return locator.endSeconds - locator.startSeconds >= 1 && end !== start ? `${start}–${end}` : start;
    }
    case "image":
      return "region";
  }
}
