/** Enough for 5,000 data rows by 20 columns, plus headers, with independent byte/work caps. */
export const HTML_TABLE_MAX_SOURCE_CHARS = 4 * 1024 * 1024;
export const HTML_TABLE_MAX_TAGS = 300_000;
export const HTML_TABLE_MAX_CELLS = 128_000;
export const HTML_TABLE_MAX_BATCH_BYTES = 32 * 1024 * 1024;
