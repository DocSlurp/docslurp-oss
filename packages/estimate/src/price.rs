//! Ports of `estimateIngest` and `estimateUploadMedia` (`@docslurp/shared`).
//!
//! The arithmetic follows the TypeScript operation for operation, so results agree to the last bit; the golden
//! cases in `golden/cases.json` hold it there. Change the TypeScript first, regenerate, then mirror it here.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::card::{Card, PageCost, PageMix, PageMode};
use crate::error::Error;

const BYTES_PER_GB: f64 = 1024.0 * 1024.0 * 1024.0;

/// `nonNegative` in billing.ts: non-finite and missing values are 0, negatives clamp to 0.
pub(crate) fn non_negative(value: Option<f64>) -> f64 {
    match value {
        Some(v) if v.is_finite() => v.max(0.0),
        _ => 0.0,
    }
}

/// JavaScript `Math.round`: halves round towards +infinity.
pub(crate) fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    // `value - floor` is exact for every finite double, unlike `value + 0.5`.
    if value - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// Credits for `pages` pages in `mode`.
pub fn page_credits(card: &Card, mode: PageMode, pages: f64) -> f64 {
    let per1k = match mode {
        PageMode::Rich => card.price_card.rich_per1k_pages,
        PageMode::Fast => card.price_card.fast_per1k_pages,
    };
    (non_negative(Some(pages)) * per1k) / 1_000.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Audio,
    Video,
}

/// Rich pages a media file counts as: its duration rounded up to whole minutes, times the kind's factor.
pub fn media_rich_pages(card: &Card, kind: MediaKind, seconds: f64) -> f64 {
    let minutes = (non_negative(Some(seconds)) / 60.0).ceil();
    minutes
        * match kind {
            MediaKind::Video => card.price_card.video_minute_rich_pages,
            MediaKind::Audio => card.price_card.audio_minute_rich_pages,
        }
}

/// Credits for one optional per-document feature over one document of `pages` pages.
pub fn feature_credits(card: &Card, feature: &str, pages: f64) -> f64 {
    if feature == "documentSummary" {
        return card.price_card.document_summary;
    }
    let pages = if pages.is_finite() { pages } else { 0.0 };
    let blocks = 1f64.max((0f64.max(pages) / 10.0).ceil());
    let per10 = match feature {
        "structuredFields" => card.price_card.structured_fields_per10_pages,
        "knowledgeGraph" => card.price_card.knowledge_graph_per10_pages,
        _ => card.price_card.propositions_per10_pages,
    };
    per10 * blocks
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestInput {
    pub pages: f64,
    /// Partial weights are allowed here, as in `estimateIngest` (missing classes weigh 0).
    #[serde(default)]
    pub mix: PartialMix,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub worker_slots: Option<f64>,
    #[serde(default)]
    pub documents: Option<f64>,
    #[serde(default)]
    pub audio_minutes: Option<f64>,
    #[serde(default)]
    pub video_minutes: Option<f64>,
    /// Optional per-document features to price (`documentSummary`, `structuredFields`, `knowledgeGraph`, `propositions`).
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
    /// Pages, beyond `pages`, that no model reads in any quality (Word, slide and sheet files): billed Fast and timed as the
    /// Fast profile's text page, whatever `profile` is (`fastOnlyPages`).
    #[serde(default)]
    pub fast_only_pages: Option<f64>,
}

/// `Partial<PageMix>` as `estimateIngest` takes it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct PartialMix {
    #[serde(default)]
    pub text: f64,
    #[serde(default)]
    pub complex: f64,
    #[serde(default)]
    pub scanned: f64,
}

impl From<PageMix> for PartialMix {
    fn from(mix: PageMix) -> Self {
        Self { text: mix.text, complex: mix.complex, scanned: mix.scanned }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreditBreakdown {
    pub fast: f64,
    pub rich: f64,
    pub media: f64,
    pub features: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestCredits {
    pub total_credits: f64,
    pub breakdown: CreditBreakdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestStorage {
    pub bytes: f64,
    pub object_bytes: f64,
    pub index_bytes: f64,
    pub monthly_credits: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestEstimate {
    pub pages: f64,
    pub profile: String,
    pub workers: f64,
    pub effective_parallelism: f64,
    pub worker_seconds: f64,
    pub wall_seconds: f64,
    pub pages_per_minute: f64,
    pub minutes_per100_pages: f64,
    pub fast_pages: f64,
    pub rich_pages: f64,
    pub media_rich_pages: f64,
    pub credits: IngestCredits,
    pub feature_credits: BTreeMap<String, f64>,
    pub pages_per_dollar: f64,
    pub credits_per1000_pages: f64,
    pub storage: IngestStorage,
}

fn normalize_mix(mix: &PartialMix) -> PageMix {
    let text = non_negative(Some(mix.text));
    let complex = non_negative(Some(mix.complex));
    let scanned = non_negative(Some(mix.scanned));
    let total = text + complex + scanned;
    if total <= 0.0 {
        return PageMix::new(1.0, 0.0, 0.0);
    }
    PageMix::new(text / total, complex / total, scanned / total)
}

/// Port of `estimateIngest`: credits, time and storage for a corpus of `pages` pages with a page-class mix.
pub fn estimate_ingest(card: &Card, input: &IngestInput) -> Result<IngestEstimate, Error> {
    let profile_id = input.profile.as_deref().unwrap_or("auto");
    let profile = card.profile(profile_id)?;
    let slots = js_round(non_negative(Some(input.worker_slots.unwrap_or(card.funded_worker_slots))));
    let workers = 1f64.max(if slots == 0.0 || slots.is_nan() { card.funded_worker_slots } else { slots });
    let mix_pages = 0f64.max(js_round(non_negative(Some(input.pages))));
    let fast_only_pages = 0f64.max(js_round(non_negative(input.fast_only_pages)));
    let pages = mix_pages + fast_only_pages;
    let documents = 1f64.max(js_round(non_negative(Some(input.documents.unwrap_or(1.0)))));
    let audio_minutes = non_negative(input.audio_minutes).ceil();
    let video_minutes = non_negative(input.video_minutes).ceil();
    let mix = normalize_mix(&input.mix);

    let mut worker_seconds = 0.0;
    let mut fast_pages = 0.0;
    let mut rich_pages = 0.0;
    let mut source_bytes = 0.0;
    let mut artifact_bytes = 0.0;
    let mut index_bytes = 0.0;
    let mut slowest_page_seconds: f64 = 0.0;
    let classes: [(f64, &PageCost); 3] =
        [(mix.text, &profile.text), (mix.complex, &profile.complex), (mix.scanned, &profile.scanned)];
    for (share, cost) in classes {
        let count = mix_pages * share;
        if count <= 0.0 {
            continue;
        }
        worker_seconds += count * cost.worker_seconds;
        match cost.mode {
            PageMode::Rich => rich_pages += count,
            PageMode::Fast => fast_pages += count,
        }
        source_bytes += count * cost.source_bytes;
        artifact_bytes += count * cost.artifact_bytes;
        index_bytes += count * cost.index_bytes;
        slowest_page_seconds = slowest_page_seconds.max(cost.worker_seconds);
    }
    if fast_only_pages > 0.0 {
        let cost = &card.profile("fast")?.text;
        worker_seconds += fast_only_pages * cost.worker_seconds;
        fast_pages += fast_only_pages;
        source_bytes += fast_only_pages * cost.source_bytes;
        artifact_bytes += fast_only_pages * cost.artifact_bytes;
        index_bytes += fast_only_pages * cost.index_bytes;
        slowest_page_seconds = slowest_page_seconds.max(cost.worker_seconds);
    }
    let media_pages = media_rich_pages(card, MediaKind::Audio, audio_minutes * 60.0)
        + media_rich_pages(card, MediaKind::Video, video_minutes * 60.0);
    worker_seconds += audio_minutes * card.media_worker_seconds_per_minute.audio
        + video_minutes * card.media_worker_seconds_per_minute.video;
    source_bytes += audio_minutes * card.media_bytes_per_minute.audio + video_minutes * card.media_bytes_per_minute.video;

    let units = 1f64.max(pages + audio_minutes + video_minutes);
    let effective_parallelism = 1f64.max(workers.min(documents * card.max_page_fanout_per_run).min(units));
    let has_work = pages > 0.0 || audio_minutes > 0.0 || video_minutes > 0.0;
    let wall_seconds = if !has_work {
        0.0
    } else {
        slowest_page_seconds.max(worker_seconds / (effective_parallelism * card.parallel_efficiency))
            + card.fixed_overhead_seconds
    };

    let fast = page_credits(card, PageMode::Fast, fast_pages);
    let rich = page_credits(card, PageMode::Rich, rich_pages);
    let media = page_credits(card, PageMode::Rich, media_pages);
    let pages_per_document = (pages + media_pages) / documents;
    let mut feature_totals = BTreeMap::new();
    let mut features = 0.0;
    if has_work {
        for feature in &card.document_features {
            if !input.features.get(feature).copied().unwrap_or(false) {
                continue;
            }
            let credits = feature_credits(card, feature, pages_per_document) * documents;
            feature_totals.insert(feature.clone(), credits);
            features += credits;
        }
    }
    let total_credits = fast + rich + media + features;

    let object_bytes = source_bytes + artifact_bytes;
    let bytes = object_bytes + index_bytes;
    let pages_per_minute = if wall_seconds > 0.0 { pages / (wall_seconds / 60.0) } else { 0.0 };
    let dollars = total_credits / card.credits_per_dollar;

    Ok(IngestEstimate {
        pages,
        profile: profile_id.to_string(),
        workers,
        effective_parallelism,
        worker_seconds,
        wall_seconds,
        pages_per_minute,
        minutes_per100_pages: if pages_per_minute > 0.0 { 100.0 / pages_per_minute } else { 0.0 },
        fast_pages,
        rich_pages,
        media_rich_pages: media_pages,
        credits: IngestCredits { total_credits, breakdown: CreditBreakdown { fast, rich, media, features } },
        feature_credits: feature_totals,
        pages_per_dollar: if dollars > 0.0 { pages / dollars } else { 0.0 },
        credits_per1000_pages: if pages > 0.0 { (total_credits / pages) * 1000.0 } else { 0.0 },
        storage: IngestStorage {
            bytes,
            object_bytes,
            index_bytes,
            monthly_credits: (non_negative(Some(bytes)) / BYTES_PER_GB) * card.price_card.storage_gb_month,
        },
    })
}

/// A file as the upload estimate sees it: name, size, MIME type, and duration when the client knows it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub name: String,
    pub size: f64,
    #[serde(default, rename = "type")]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
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

/// Port of `uploadMediaKind`: MIME type first, then the extension; `None` for files priced per page.
pub fn upload_media_kind(card: &Card, name: &str, mime_type: Option<&str>) -> Option<MediaKind> {
    let mime = declared_type(mime_type);
    if mime.starts_with("audio/") {
        return Some(MediaKind::Audio);
    }
    if mime.starts_with("video/") {
        return Some(MediaKind::Video);
    }
    let extension = extension_of(name);
    if listed(&card.extensions.audio, &extension) {
        return Some(MediaKind::Audio);
    }
    if listed(&card.extensions.video, &extension) {
        return Some(MediaKind::Video);
    }
    None
}

pub fn is_generic_type(mime: &str) -> bool {
    mime.is_empty() || mime == "application/octet-stream"
}

/// Port of `isUploadImageFile`: an `image/*` MIME type, or an image extension when the type is absent or generic.
pub fn is_image_file(card: &Card, name: &str, mime_type: Option<&str>) -> bool {
    let mime = declared_type(mime_type);
    mime.starts_with("image/") || (is_generic_type(&mime) && listed(&card.extensions.image, &extension_of(name)))
}

/// Port of `isUploadTextFile`: a text MIME type, or a text extension when the type is absent or generic.
pub fn is_text_file(card: &Card, name: &str, mime_type: Option<&str>) -> bool {
    let mime = declared_type(mime_type);
    if card.text_pages.mime_prefixes.iter().any(|prefix| mime.starts_with(prefix.as_str())) {
        return true;
    }
    is_generic_type(&mime) && listed(&card.extensions.text, &extension_of(name))
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
pub fn text_page_count(card: &Card, bytes: &[u8], markup: bool) -> f64 {
    let decoded = decode_text(bytes);
    let visible = if markup { strip_markup(&decoded) } else { decoded };
    let lines = if markup {
        visible.split('\n').filter(|line| !line.trim_matches(js_space).is_empty()).count() as f64
    } else {
        visible.matches('\n').count() as f64 + 1.0
    };
    let trimmed = visible.trim_matches(js_space);
    let chars = (trimmed.encode_utf16().count() + trimmed.chars().filter(|c| is_cjk(*c)).count() * (TEXT_PAGE_CJK_WEIGHT - 1)) as f64;
    1f64.max((lines / card.text_pages.lines).ceil()).max((chars / card.text_pages.chars).ceil())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreditRange {
    pub low: f64,
    pub high: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LighterPipeline {
    pub media_video: LighterMediaVideo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LighterMediaVideo {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LighterOption {
    pub kind: String,
    pub credits: f64,
    pub saved_credits: f64,
    pub pipeline: LighterPipeline,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadMediaEstimate {
    pub audio_files: u32,
    pub video_files: u32,
    pub audio_minutes: f64,
    pub video_minutes: f64,
    pub durations_assumed: bool,
    pub video_frames: bool,
    pub credits: CreditRange,
    pub lighter: Option<LighterOption>,
}

fn round_tenth(value: f64) -> f64 {
    js_round(value * 10.0) / 10.0
}

/// Port of `estimateUploadMedia`: what the audio and video among `files` cost. `None` when no file is media.
pub fn estimate_upload_media<'a, I>(card: &Card, files: I, video_frames: bool) -> Option<UploadMediaEstimate>
where
    I: IntoIterator<Item = &'a MediaFile>,
{
    let mut audio_files = 0;
    let mut video_files = 0;
    let mut audio_seconds = 0.0;
    let mut video_seconds = 0.0;
    let mut audio_pages = 0.0;
    let mut video_frame_pages = 0.0;
    let mut video_track_pages = 0.0;
    let mut assumed = false;
    for file in files {
        let Some(kind) = upload_media_kind(card, &file.name, file.mime_type.as_deref()) else { continue };
        let known = matches!(file.duration_seconds, Some(d) if d.is_finite() && d > 0.0);
        if !known {
            assumed = true;
        }
        let seconds = if known {
            file.duration_seconds.unwrap_or_default()
        } else {
            let per_minute = match kind {
                MediaKind::Audio => card.media_bytes_per_minute.audio,
                MediaKind::Video => card.media_bytes_per_minute.video,
            };
            (0f64.max(file.size) / per_minute) * 60.0
        };
        match kind {
            MediaKind::Audio => {
                audio_files += 1;
                audio_seconds += seconds;
                audio_pages += media_rich_pages(card, MediaKind::Audio, seconds);
            }
            MediaKind::Video => {
                video_files += 1;
                video_seconds += seconds;
                video_frame_pages += media_rich_pages(card, MediaKind::Video, seconds);
                video_track_pages += media_rich_pages(card, MediaKind::Audio, seconds);
            }
        }
    }
    if audio_files + video_files == 0 {
        return None;
    }
    let low = page_credits(card, PageMode::Rich, audio_pages + video_track_pages);
    let high = if video_frames { page_credits(card, PageMode::Rich, audio_pages + video_frame_pages) } else { low };
    Some(UploadMediaEstimate {
        audio_files,
        video_files,
        audio_minutes: round_tenth(audio_seconds / 60.0),
        video_minutes: round_tenth(video_seconds / 60.0),
        durations_assumed: assumed,
        video_frames,
        credits: CreditRange { low, high },
        lighter: (video_frames && video_files > 0 && high > low).then(|| LighterOption {
            kind: "video-audio-track-only".into(),
            credits: low,
            saved_credits: high - low,
            pipeline: LighterPipeline { media_video: LighterMediaVideo { enabled: false } },
        }),
    })
}
