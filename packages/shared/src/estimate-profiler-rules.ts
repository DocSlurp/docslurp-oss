import { FILE_PROFILE_MAX_SAMPLED_PAGES, FILE_PROFILE_SCHEMA, IMAGE_COVERAGE_BUCKETS, WORDS_PER_PAGE_BUCKETS } from "./file-profile.js";
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  TEXT_EXTENSIONS,
  TEXT_PAGE_CHARS,
  TEXT_PAGE_LINES,
  TEXT_PAGE_MIME_PREFIXES,
  VIDEO_EXTENSIONS,
} from "./media-upload-estimate.js";
import { DENSE_PAGE_EQUIVALENTS, PAGE_AREA_EQUIVALENTS_CAP, STANDARD_PAGE_AREA_PT2 } from "./page-equivalents.js";
import { sha256Hex } from "./hash.js";
import { PAGE_RASTER_ROUTING } from "./page-raster-routing.js";
import { PAGE_TABLE_ROUTING } from "./page-table-routing.js";
import { IMAGE_MAX_FRAMES, MULTI_FRAME_IMAGE_EXTENSIONS, MULTI_FRAME_IMAGE_MIME_TYPES } from "./upload-pages.js";

/*
 * The offline profiler's rules (`packages/estimate/profiler-rules.json`): file-type lists, the text page rule and the PDF
 * page raster thresholds the worker routes with. No prices: the profiler measures, the server quotes.
 * `estimate-profiler-rules.test.ts` fails when the committed JSON differs from what the TypeScript produces;
 * `UPDATE_PROFILER_RULES=1 pnpm --filter @docslurp/shared test estimate-profiler-rules` rewrites it.
 */

/**
 * Text the worker's PDF text extraction keeps, as observed (Poppler): at most `tinyGlyphsPerPage` glyphs under
 * `tinyGlyphPoints` points a page, and nothing placed outside the page's MediaBox. Text outside the CropBox but inside the
 * MediaBox is kept. The profiler mirrors these so a stuffed page is counted as billing will count it.
 */
export const EXTRACTION_LIMITS = { tinyGlyphPoints: 3, tinyGlyphsPerPage: 50_000 } as const;

/**
 * The layout walker's ruled-grid geometry (`worker/scripts/pdf_layout_facts.py`: RULE_THICKNESS_PT, RULE_MIN_LENGTH_PT,
 * RULE_TOUCH_PT, COVERAGE_RASTER, MAX_RULES_PER_PAGE, and MAX_ANCHOR_WORDS, past which a page's word boxes are unknown;
 * core docs/page-layout-facts.md). The profiler builds grids the same
 * way; `estimate-profiler-rules.test.ts` holds these to the walker's constants.
 */
export const LAYOUT_GRID_RULES = { ruleThicknessPt: 3, ruleMinLengthPt: 8, ruleTouchPt: 2.5, coverageRaster: 200, maxRulesPerPage: 5_000, maxWordsPerPage: 20_000 } as const;

/** Content-stream bytes per glyph assumed when a page's text could not be read to the end (an estimate, flagged). */
export const ESTIMATED_CONTENT_BYTES_PER_GLYPH = 2;

/** The rules file's own schema (`profiler-rules.json`), separate from the file profile's. */
export const PROFILER_RULES_SCHEMA = 1;

export function buildProfilerRules() {
  const body = {
    schema: PROFILER_RULES_SCHEMA,
    profileSchema: FILE_PROFILE_SCHEMA,
    maxSampledPages: FILE_PROFILE_MAX_SAMPLED_PAGES,
    wordsPerPageBuckets: [...WORDS_PER_PAGE_BUCKETS],
    imageCoverageBuckets: IMAGE_COVERAGE_BUCKETS.map((bound) => (bound === Number.MIN_VALUE ? 0 : bound)),
    /** Extensions that make a file media, an image or text when the MIME type does not say. */
    extensions: { audio: [...AUDIO_EXTENSIONS], video: [...VIDEO_EXTENSIONS], image: [...IMAGE_EXTENSIONS], text: [...TEXT_EXTENSIONS] },
    /** Text files: MIME prefixes counted from their text, and the lines and characters per page. */
    textPages: { mimePrefixes: [...TEXT_PAGE_MIME_PREFIXES], lines: TEXT_PAGE_LINES, chars: TEXT_PAGE_CHARS },
    /** Multi-frame images (TIFF): each frame is a page; a file with more than `maxFrames` is refused by the worker. */
    multiFrameImages: { maxFrames: IMAGE_MAX_FRAMES, mimeTypes: [...MULTI_FRAME_IMAGE_MIME_TYPES], extensions: [...MULTI_FRAME_IMAGE_EXTENSIONS] },
    /** PDF page raster thresholds the worker routes with. */
    pageRasterRouting: { ...PAGE_RASTER_ROUTING },
    /** The table-heavy thresholds the worker routes with (page-table-routing.ts `isTableHeavy`). */
    pageTableRouting: { ...PAGE_TABLE_ROUTING },
    /** The page-equivalent measurement billing uses (page-equivalents.ts): area against a standard page, capped per page. */
    pageEquivalents: { standardPageAreaPt2: STANDARD_PAGE_AREA_PT2, areaEquivalentsCap: PAGE_AREA_EQUIVALENTS_CAP, densePageEquivalents: DENSE_PAGE_EQUIVALENTS },
    /** Ruled grids and table coverage as the layout walker builds them. */
    layout: { ...LAYOUT_GRID_RULES },
    /** What the PDF text extractor keeps, so the profiler counts the text billing will measure (EXTRACTION_LIMITS). */
    extraction: { ...EXTRACTION_LIMITS, estimatedContentBytesPerGlyph: ESTIMATED_CONTENT_BYTES_PER_GLYPH },
  };
  // A content hash of everything above, so a profile can name the rules it was measured with.
  return { ...body, revision: sha256Hex(JSON.stringify(body)) };
}
export type ProfilerRules = ReturnType<typeof buildProfilerRules>;
