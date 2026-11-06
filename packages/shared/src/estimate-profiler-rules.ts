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
import { PAGE_AREA_EQUIVALENTS_CAP, STANDARD_PAGE_AREA_PT2 } from "./page-equivalents.js";
import { PAGE_RASTER_ROUTING } from "./page-raster-routing.js";
import { IMAGE_MAX_FRAMES, MULTI_FRAME_IMAGE_EXTENSIONS, MULTI_FRAME_IMAGE_MIME_TYPES } from "./upload-pages.js";

/*
 * The offline profiler's rules (`packages/estimate/profiler-rules.json`): file-type lists, the text page rule and the PDF
 * page raster thresholds the worker routes with. No prices: the profiler measures, the server quotes.
 * `estimate-profiler-rules.test.ts` fails when the committed JSON differs from what the TypeScript produces;
 * `UPDATE_PROFILER_RULES=1 pnpm --filter @docslurp/shared test estimate-profiler-rules` rewrites it.
 */

export function buildProfilerRules() {
  return {
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
    /** The page-equivalent measurement billing uses (page-equivalents.ts): area against a standard page, capped per page. */
    pageEquivalents: { standardPageAreaPt2: STANDARD_PAGE_AREA_PT2, areaEquivalentsCap: PAGE_AREA_EQUIVALENTS_CAP },
  };
}
export type ProfilerRules = ReturnType<typeof buildProfilerRules>;
