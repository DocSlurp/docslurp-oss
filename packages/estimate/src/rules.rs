//! The profiler's rules (`profiler-rules.json`, generated from `@docslurp/shared` by `estimate-profiler-rules.test.ts`):
//! file-type lists, the text page rule and the PDF page raster thresholds the worker routes with. No prices.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Profile JSON shape this build emits (`FILE_PROFILE_SCHEMA` in `@docslurp/shared`).
pub const PROFILE_SCHEMA: u32 = 1;

const BUNDLED: &str = include_str!("../profiler-rules.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Extensions {
    pub audio: Vec<String>,
    pub video: Vec<String>,
    pub image: Vec<String>,
    pub text: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextPages {
    pub mime_prefixes: Vec<String>,
    pub lines: f64,
    pub chars: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MultiFrameImages {
    pub max_frames: f64,
    pub mime_types: Vec<String>,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRasterRouting {
    pub sparse_page_words: f64,
    pub min_significant_image_coverage: f64,
    pub min_significant_image_pixels: f64,
    pub raster_page_min_largest_image_coverage: f64,
    pub raster_page_min_total_image_coverage: f64,
    pub stamp_text_max_words: f64,
    pub stamped_scan_min_image_coverage: f64,
    pub sparse_text_full_page_image_coverage: f64,
    pub drawn_content_min_bytes_per_page: f64,
    pub repeated_image_min_pages: f64,
    pub repeated_image_min_share: f64,
    pub unspaced_chars_per_word: f64,
    pub mixed_scan_min_coverage: f64,
    pub mixed_scan_max_words_inside: f64,
    pub mixed_scan_min_short_side_px: f64,
    pub mixed_scan_min_ppi: f64,
    pub scan_like_max_bytes_per_pixel: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rules {
    /// The rules file's schema, and the content hash of everything else in it.
    pub schema: u32,
    pub profile_schema: u32,
    pub max_sampled_pages: usize,
    pub words_per_page_buckets: Vec<f64>,
    pub image_coverage_buckets: Vec<f64>,
    pub extensions: Extensions,
    pub text_pages: TextPages,
    pub multi_frame_images: MultiFrameImages,
    pub page_raster_routing: PageRasterRouting,
    pub page_table_routing: PageTableRouting,
    pub page_equivalents: PageEquivalentRules,
    pub extraction: ExtractionLimits,
    pub layout: LayoutRules,
    pub revision: String,
}

/// The table-heavy thresholds the worker routes with (`PAGE_TABLE_ROUTING`, page-table-routing.ts `isTableHeavy`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageTableRouting {
    pub table_heavy_min_rows: u32,
    pub table_heavy_min_coverage: f64,
}

/// The layout walker's ruled-grid geometry and word cap (`LAYOUT_GRID_RULES`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutRules {
    pub rule_thickness_pt: f64,
    pub rule_min_length_pt: f64,
    pub rule_touch_pt: f64,
    pub coverage_raster: u32,
    pub max_rules_per_page: u32,
    pub max_words_per_page: u32,
}

/// The page-equivalent rule billing measures with: area against a standard page, capped per page; text by the text rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageEquivalentRules {
    pub standard_page_area_pt2: f64,
    pub area_equivalents_cap: f64,
    /** A page whose text counts as more than this many pages is dense (possible hidden or stuffed text). */
    pub dense_page_equivalents: f64,
}

/// What the worker's PDF text extraction keeps (`EXTRACTION_LIMITS` in `@docslurp/shared`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractionLimits {
    pub tiny_glyph_points: f64,
    pub tiny_glyphs_per_page: f64,
    pub estimated_content_bytes_per_glyph: f64,
}

impl Rules {
    /// Text pages of `chars` glyphs on `lines` lines: at least 1, else the larger of lines and characters per page. The
    /// text rule counts the extracted text's characters, so the line breaks between the lines count too.
    pub fn text_equivalents(&self, chars: f64, lines: f64) -> f64 {
        if chars <= 0.0 {
            return 1.0;
        }
        let characters = chars + (lines - 1.0).max(0.0);
        1f64.max((lines / self.text_pages.lines).ceil()).max((characters / self.text_pages.chars).ceil())
    }

    /// Standard pages a page of `area_pt2` square points counts as, 1..cap.
    pub fn area_equivalents(&self, area_pt2: f64) -> f64 {
        if !(area_pt2.is_finite() && area_pt2 > 0.0) {
            return 1.0;
        }
        self.page_equivalents.area_equivalents_cap.min(1f64.max((area_pt2 / self.page_equivalents.standard_page_area_pt2 - 1e-9).ceil()))
    }

}

impl Rules {
    /// The rules compiled into this build.
    pub fn bundled() -> &'static Rules {
        static RULES: OnceLock<Rules> = OnceLock::new();
        RULES.get_or_init(|| {
            let rules: Rules = serde_json::from_str(BUNDLED).expect("bundled profiler-rules.json is valid");
            assert_eq!(rules.profile_schema, PROFILE_SCHEMA, "profiler-rules.json is for another profile schema");
            assert_eq!(rules.schema, 1, "profiler-rules.json has another rules schema");
            assert!(rules.revision.len() == 64 && rules.revision.bytes().all(|byte| byte.is_ascii_hexdigit()), "profiler-rules.json revision");
            assert_eq!(rules.words_per_page_buckets.len(), crate::probe::WORDS_BUCKETS, "words-per-page buckets");
            assert_eq!(rules.image_coverage_buckets.len(), crate::probe::COVERAGE_BUCKETS, "image coverage buckets");
            rules
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Audio,
    Video,
}

pub fn declared_type(mime_type: Option<&str>) -> String {
    mime_type.unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase()
}

pub fn extension_of(name: &str) -> String {
    name.rfind('.').map(|dot| name[dot + 1..].to_lowercase()).unwrap_or_default()
}

fn listed(extensions: &[String], extension: &str) -> bool {
    extensions.iter().any(|candidate| candidate == extension)
}

/// Port of `uploadMediaKind`: MIME type first, then the extension; `None` for paged files.
pub fn upload_media_kind(rules: &Rules, name: &str, mime_type: Option<&str>) -> Option<MediaKind> {
    let mime = declared_type(mime_type);
    if mime.starts_with("audio/") {
        return Some(MediaKind::Audio);
    }
    if mime.starts_with("video/") {
        return Some(MediaKind::Video);
    }
    let extension = extension_of(name);
    if listed(&rules.extensions.audio, &extension) {
        return Some(MediaKind::Audio);
    }
    if listed(&rules.extensions.video, &extension) {
        return Some(MediaKind::Video);
    }
    None
}

pub fn is_generic_type(mime: &str) -> bool {
    mime.is_empty() || mime == "application/octet-stream"
}

/// Port of `isUploadImageFile`: an `image/*` MIME type, or an image extension when the type is absent or generic.
#[allow(dead_code)]
pub fn is_image_file(rules: &Rules, name: &str, mime_type: Option<&str>) -> bool {
    let mime = declared_type(mime_type);
    mime.starts_with("image/") || (is_generic_type(&mime) && listed(&rules.extensions.image, &extension_of(name)))
}

/// Port of `isUploadTextFile`: a text MIME type, or a text extension when the type is absent or generic.
pub fn is_text_file(rules: &Rules, name: &str, mime_type: Option<&str>) -> bool {
    let mime = declared_type(mime_type);
    if rules.text_pages.mime_prefixes.iter().any(|prefix| mime.starts_with(prefix.as_str())) {
        return true;
    }
    is_generic_type(&mime) && listed(&rules.extensions.text, &extension_of(name))
}

/// East Asian characters carry about three times the content of a Latin one: each counts as this many characters toward a page.
const TEXT_PAGE_CJK_WEIGHT: usize = 3;

fn is_cjk(c: char) -> bool {
    matches!(u32::from(c),
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff | 0xff66..=0xff9f | 0x20000..=0x2fa1f)
}

fn js_space(c: char) -> bool {
    c == '\u{FEFF}' || (c.is_whitespace() && c != '\u{85}')
}

/// Decodes a text file by its byte-order mark: UTF-16 either way, UTF-8 (BOM removed), else UTF-8 with replacement characters.
fn decode_text(bytes: &[u8]) -> String {
    let wide = |rest: &[u8], big_endian: bool| {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|pair| if big_endian { u16::from_be_bytes([pair[0], pair[1]]) } else { u16::from_le_bytes([pair[0], pair[1]]) })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return wide(rest, false);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return wide(rest, true);
    }
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{FEFF}').map(str::to_string).unwrap_or_else(|| text.into_owned())
}

fn starts_with_ascii_ci(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.len() >= needle.len() && haystack.iter().zip(needle).all(|(a, b)| a.to_ascii_lowercase() == *b)
}

/// Index of lower-case ASCII `needle` in `bytes` at or after `from`, ignoring ASCII case.
fn find_ascii_ci(bytes: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    (from..=bytes.len().checked_sub(needle.len())?).find(|at| starts_with_ascii_ci(&bytes[*at..], needle))
}

/// Port of `stripMarkup`: the visible text of HTML with tags, comments, scripts and styles removed.
fn strip_markup(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < bytes.len() {
        let Some(relative) = text[at..].find('<') else {
            out.push_str(&text[at..]);
            break;
        };
        let open = at + relative;
        out.push_str(&text[at..open]);
        if text[open..].starts_with("<!--") {
            at = text[open + 4..].find("-->").map_or(text.len(), |close| open + 4 + close + 3);
            continue;
        }
        let block = ["script", "style"].into_iter().find(|name| {
            starts_with_ascii_ci(&bytes[open..], format!("<{name}").as_bytes())
                && matches!(bytes.get(open + name.len() + 1), Some(b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r' | 0x0c))
        });
        if let Some(name) = block {
            at = match find_ascii_ci(bytes, format!("</{name}").as_bytes(), open) {
                Some(close) => text[close..].find('>').map_or(text.len(), |end| close + end + 1),
                None => text.len(),
            };
            continue;
        }
        let end = text[open..].find('>').map(|end| open + end);
        let tag_start = bytes.get(open + 1).is_some_and(|first| matches!(first, b'!' | b'/' | b'?') || first.is_ascii_alphabetic());
        match end {
            Some(end) if tag_start => {
                out.push('\n');
                at = end + 1;
            }
            _ => {
                out.push('<');
                at = open + 1;
            }
        }
    }
    out
}

/// Port of `textPageCount`: one page per `lines` lines or per `chars` characters, whichever is more. Characters are
/// UTF-16 code units of the text with JavaScript's `trim` applied, as the API counts them; East Asian characters count
/// [`TEXT_PAGE_CJK_WEIGHT`] each. With `markup` (HTML) tags, scripts and styles are removed first and only non-blank
/// lines count. The text is decoded by its byte-order mark (UTF-16 or UTF-8).
pub fn text_page_count(rules: &Rules, bytes: &[u8], markup: bool) -> f64 {
    text_page_count_and_chars(rules, bytes, markup).0
}

/// [`text_page_count`] and the characters it counted (UTF-16 code units of the trimmed visible text).
pub fn text_page_count_and_chars(rules: &Rules, bytes: &[u8], markup: bool) -> (f64, u64) {
    let decoded = decode_text(bytes);
    let visible = if markup { strip_markup(&decoded) } else { decoded };
    let lines = if markup {
        visible.split('\n').filter(|line| !line.trim_matches(js_space).is_empty()).count() as f64
    } else {
        visible.matches('\n').count() as f64 + 1.0
    };
    let trimmed = visible.trim_matches(js_space);
    let units = trimmed.encode_utf16().count();
    let chars = (units + trimmed.chars().filter(|c| is_cjk(*c)).count() * (TEXT_PAGE_CJK_WEIGHT - 1)) as f64;
    (1f64.max((lines / rules.text_pages.lines).ceil()).max((chars / rules.text_pages.chars).ceil()), units as u64)
}

