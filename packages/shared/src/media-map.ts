/*
 * The contract for the images a PDF draws, as an embedded-image producer reports them and as `document/media-map`
 * publishes them. The producer measures inside its sandbox (it alone touches untrusted bytes); the worker validates
 * every field here, strictly and with bounds, before any of it can reach an artifact, Markdown or a routing decision.
 *
 * Coordinates: PDF points on the page as a viewer shows it (the page's /Rotate applied), origin at the top-left, y down.
 * That is the frame of the text layer's word boxes, so image and text geometry compare directly. Unknown facts are
 * `null` or `{ status: "unknown" }`; nothing here is ever estimated to look complete.
 *
 * Design: docs/extraction/embedded-images.md.
 */
import { z } from "zod";

export const MEDIA_MAP_VERSION = "docslurp-media-map@2";
export const EMBEDDED_IMAGE_FACTS_VERSION = "embedded-image-facts@2";
export const MAX_IMAGE_ALT_CHARS = 1024;
export const PIXEL_SIGNALS_VERSION = "pixel-signals@1";

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const finite = (min: number, max: number) => z.number().finite().min(min).max(max);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/** Lossless WebP from a VM producer; PNG from the local `pdfimages` default. */
export const embeddedImageMediaTypeSchema = z.enum(["image/webp", "image/png"]);
export type EmbeddedImageMediaType = z.infer<typeof embeddedImageMediaTypeSchema>;

export const imageRoleSchema = z.enum(["image", "mask", "smask", "stencil"]);
export type ImageRole = z.infer<typeof imageRoleSchema>;
export const imageEncodingSchema = z.enum(["image", "rle", "ccitt", "jpeg", "jpx", "jbig2", "other"]);
export const imageColorSpaceSchema = z.enum(["gray", "cal", "rgb", "cmyk", "lab", "icc", "index", "sep", "devn", "-", "other"]);

/** What the PDF itself says about the image stream (poppler's `pdfimages -list`): the encoding is the stored one. */
export const embeddedImageSourceSchema = z.strictObject({
  objectId: z.strictObject({ num: int(0, 2 ** 31), gen: int(0, 65535) }).nullable(),
  inline: z.boolean(),
  encoding: imageEncodingSchema,
  colorSpace: imageColorSpaceSchema,
  components: int(1, 32).nullable(),
  bitsPerComponent: int(1, 32).nullable(),
  interpolate: z.boolean(),
  /** Resolution implied by the PDF's own placement, as poppler reports it. */
  ppi: z.tuple([int(0, 1_000_000).nullable(), int(0, 1_000_000).nullable()]),
  /** Stored stream size, rounded as the listing prints it. */
  streamBytes: int(0, 2 ** 40).nullable(),
});
export type EmbeddedImageSource = z.infer<typeof embeddedImageSourceSchema>;

const bboxSchema = z.tuple([finite(-1e7, 1e7), finite(-1e7, 1e7), finite(-1e7, 1e7), finite(-1e7, 1e7)])
  .refine(([x0, y0, x1, y1]) => x1 >= x0 && y1 >= y0, "bbox must be ordered");

export const embeddedImagePlacementSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("known"),
    /** `sequence`: the page's draws and listing rows lined up one to one; `object`: only this image's identity did. */
    validatedBy: z.enum(["sequence", "object"]),
    bbox: bboxSchema,
    widthPt: finite(0, 1e7),
    heightPt: finite(0, 1e7),
    /** Clockwise degrees of the picture's own x axis on the displayed page. */
    rotationDegrees: finite(0, 360),
    mirrored: z.boolean(),
    /** Share of the visible page (crop ∩ media box) the image covers, clipped to the page. */
    coverage: finite(0, 1),
    pageWidthPt: finite(1e-3, 1e7),
    pageHeightPt: finite(1e-3, 1e7),
    /** Paint order among all image draws on the page (0 is painted first, so lowest). */
    drawOrder: int(0, 100_000),
    /** Image draws on the page, including ones outside the extraction window. */
    pageDraws: int(1, 100_000),
    /** Text-showing operators painted before this image, and on the page in all: 0 before = a background layer. */
    textOpsBefore: int(0, 10_000_000),
    pageTextOps: int(0, 10_000_000),
    /** Pixels per inch along the picture's x and y axes, from its pixel size and placed size. */
    effectivePpi: z.tuple([finite(0, 1e7), finite(0, 1e7)]).nullable(),
  }),
  z.strictObject({ status: z.literal("unknown"), reason: slug }),
]);
export type EmbeddedImagePlacement = z.infer<typeof embeddedImagePlacementSchema>;

export const embeddedImageAltSchema = z.strictObject({
  text: z.string().min(1).max(MAX_IMAGE_ALT_CHARS),
  source: z.enum(["marked-content", "struct-figure"]),
});

/** Measured raster statistics (no model, no OCR); `null` with a reason when the producer could not take them. */
export const pixelSignalsSchema = z.strictObject({
  version: z.literal(PIXEL_SIGNALS_VERSION),
  lumaMean: finite(0, 255),
  lumaStdDev: finite(0, 255),
  bilevel: z.boolean(),
  quantizedColors: int(0, 4097),
  topColorShare: finite(0, 1),
  saturation: finite(0, 255),
  entropy: finite(0, 8.01),
  edgeShare: finite(0, 1),
  inkShare: finite(0, 1),
  textBands: int(0, 100_000),
  bandPitchSpread: finite(0, 1000).nullable(),
  alphaMean: finite(0, 1).nullable(),
  dhash: z.string().regex(/^[0-9a-f]{16}$/),
  sample: z.tuple([int(1, 4096), int(1, 4096)]),
});
export type PixelSignals = z.infer<typeof pixelSignalsSchema>;

/**
 * Where the image sits in the page's Markdown: the index of the Markdown block it goes before (`block === blocks`
 * means after the last). Blocks are counted by `markdownBlocks` (image-anchors.ts), the same way the producer counted.
 */
export const embeddedImageAnchorSchema = z.strictObject({
  block: int(0, 100_000),
  blocks: int(0, 100_000),
  method: z.enum(["aligned", "page-start", "page-end"]),
  /** Markdown blocks whose text was found in the text layer, out of `blocks`: the evidence behind `aligned`. */
  matchedBlocks: int(0, 100_000),
}).refine((a) => a.block <= a.blocks && a.matchedBlocks <= a.blocks, "anchor out of range");

/** One drawn image or mask as the producer reports it (wire form, before the host adds class, route and artifact IDs). */
export const embeddedImageFactsSchema = z.strictObject({
  pageNumber: int(1, 100_000),
  occurrence: int(0, 511),
  role: imageRoleSchema,
  width: int(1, 16_000_000),
  height: int(1, 16_000_000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  maskOf: int(0, 511).optional(),
  source: embeddedImageSourceSchema,
  placement: embeddedImagePlacementSchema,
  alt: embeddedImageAltSchema.nullable(),
  signals: pixelSignalsSchema.nullable(),
  signalsUnavailable: slug.nullable(),
  anchor: embeddedImageAnchorSchema.nullable(),
});
export type EmbeddedImageFacts = z.infer<typeof embeddedImageFactsSchema>;

export const IMAGE_CLASSES = ["blank", "decorative", "text-scan", "chart-diagram", "photo", "figure", "mask"] as const;
export const imageClassSchema = z.enum(IMAGE_CLASSES);
export type ImageClass = z.infer<typeof imageClassSchema>;
export const IMAGE_ROUTE_ACTIONS = ["skip", "ocr", "vision", "label", "keep"] as const;
export const imageRouteActionSchema = z.enum(IMAGE_ROUTE_ACTIONS);
export type ImageRouteAction = z.infer<typeof imageRouteActionSchema>;

export const imageClassificationSchema = z.strictObject({
  label: imageClassSchema,
  confidence: finite(0, 1),
  /** The measurements and rules that decided it, by stable name. */
  signals: z.array(slug).max(16),
});
export type ImageClassification = z.infer<typeof imageClassificationSchema>;

export const imageRouteSchema = z.strictObject({
  action: imageRouteActionSchema,
  /** Stable reason slug, optionally with a `:` detail (`duplicate-of:3.0`). */
  reason: z.string().regex(/^[a-z0-9][a-z0-9:.-]{0,95}$/),
});
export type ImageRoute = z.infer<typeof imageRouteSchema>;

export const mediaMapMarkdownSchema = z.strictObject({
  /** True when a reference to this image is in the document Markdown. Decorative, blank and duplicate images are not. */
  included: z.boolean(),
  /** The stable fragment of the reference, `p<page>o<occurrence>`. */
  anchor: z.string().regex(/^p[0-9]+o[0-9]+$/),
  /** Block index it was inserted before, or null when not included. */
  block: int(0, 100_000).nullable(),
  method: z.enum(["aligned", "page-start", "page-end"]).nullable(),
});

/** An entry in `document/media-map`: the validated facts plus the host's classification, route and artifact link. */
export const mediaMapImageSchema = z.strictObject({
  pageNumber: int(1, 100_000),
  occurrence: int(0, 511),
  role: imageRoleSchema,
  artifactId: z.string().min(1).max(512),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mediaType: embeddedImageMediaTypeSchema,
  width: int(1, 16_000_000),
  height: int(1, 16_000_000),
  maskOf: z.strictObject({ pageNumber: int(1, 100_000), occurrence: int(0, 511) }).optional(),
  source: embeddedImageSourceSchema,
  placement: embeddedImagePlacementSchema,
  alt: embeddedImageAltSchema.nullable(),
  signals: pixelSignalsSchema.nullable(),
  signalsUnavailable: slug.nullable(),
  class: imageClassificationSchema,
  route: imageRouteSchema,
  markdown: mediaMapMarkdownSchema,
  /** Present only when the orientation stage ran for this asset. */
  orientation: z.unknown().optional(),
});
export type MediaMapImage = z.infer<typeof mediaMapImageSchema>;

export const mediaMapSchema = z.strictObject({
  version: z.literal(MEDIA_MAP_VERSION),
  pageCount: int(1, 100_000),
  encoding: z.enum(["lossless-webp", "png"]),
  minWidth: int(1, 4096),
  minHeight: int(1, 4096),
  masks: z.literal("separate-linked-assets"),
  /**
   * How placements were established: `content-stream` when the producer walked each page's content stream and joined
   * it to the image listing; `none` when it had no placement source, and every placement is `unknown`.
   */
  placementSource: z.enum(["content-stream", "none"]),
  coordinateSpace: z.literal("pdf-points-top-left"),
  routing: z.strictObject({
    table: z.string().min(1).max(64),
    routedImages: int(0, 512),
    cap: int(0, 512),
    counts: z.partialRecord(imageRouteActionSchema, int(0, 512)),
  }),
  images: z.array(mediaMapImageSchema).max(512),
});
export type MediaMap = z.infer<typeof mediaMapSchema>;
