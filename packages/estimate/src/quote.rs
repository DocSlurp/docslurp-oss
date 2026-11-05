//! Port of `quoteUpload` (`@docslurp/shared/upload-quote.ts`): an upload's price range from an estimate profile.

use serde::{Deserialize, Serialize};

use crate::card::{Card, PageMix};
use crate::error::Error;
use crate::price::{
    declared_type, estimate_ingest, estimate_upload_media, extension_of, is_generic_type, is_image_file, is_text_file, js_round,
    upload_media_kind, CreditRange, IngestEstimate, IngestInput, MediaFile, UploadMediaEstimate,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Billing {
    Enforced,
    Disabled,
}

/// Optional per-document features. A card or profile naming any other feature is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentFeature {
    DocumentSummary,
    StructuredFields,
    KnowledgeGraph,
    Propositions,
}

impl DocumentFeature {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "documentSummary" => Some(Self::DocumentSummary),
            "structuredFields" => Some(Self::StructuredFields),
            "knowledgeGraph" => Some(Self::KnowledgeGraph),
            "propositions" => Some(Self::Propositions),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentFeatures {
    pub document_summary: bool,
    pub structured_fields: bool,
    pub knowledge_graph: bool,
    pub propositions: bool,
}

impl DocumentFeatures {
    fn enabled(&self, feature: DocumentFeature) -> bool {
        match feature {
            DocumentFeature::DocumentSummary => self.document_summary,
            DocumentFeature::StructuredFields => self.structured_fields,
            DocumentFeature::KnowledgeGraph => self.knowledge_graph,
            DocumentFeature::Propositions => self.propositions,
        }
    }
}

/// What pricing reads from a workspace. The server returns it from `POST /v1/uploads/estimate` (`profile`).
/// Unknown fields are refused: they come from a newer server whose pricing this build may not know.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EstimateProfile {
    pub card_version: String,
    pub quality: String,
    pub document_features: DocumentFeatures,
    pub video_frames: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_slots: Option<f64>,
    pub stage_count: u32,
    pub billing: Billing,
}

/// One file of an upload. `pages`, `durationSeconds`, `mix` and `type` usually come from [`crate::probe`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteFile {
    pub name: String,
    pub size: f64,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mix: Option<PageMix>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mix_confidence: Option<f64>,
}

impl QuoteFile {
    fn media(&self) -> MediaFile {
        MediaFile {
            name: self.name.clone(),
            size: self.size,
            mime_type: self.mime_type.clone(),
            duration_seconds: self.duration_seconds,
        }
    }

    /// The same bounds `POST /v1/uploads/estimate` enforces (`quoteFileSchema`).
    pub fn validate(&self) -> Result<(), Error> {
        let fail = |message: String| Err(Error::invalid_request(format!("file `{}`: {message}", self.name)));
        if self.name.is_empty() || self.name.chars().count() > 1024 {
            return fail("name must be 1-1024 characters".into());
        }
        if !(self.size.is_finite() && (0.0..=1e13).contains(&self.size) && self.size.fract() == 0.0) {
            return fail("size must be a non-negative integer of at most 10^13".into());
        }
        if let Some(pages) = self.pages {
            if !(pages.is_finite() && (1.0..=1e7).contains(&pages) && pages.fract() == 0.0) {
                return fail("pages must be a positive integer of at most 10^7".into());
            }
        }
        if let Some(seconds) = self.duration_seconds {
            if !(seconds.is_finite() && seconds > 0.0 && seconds <= 24.0 * 3600.0) {
                return fail("durationSeconds must be positive and at most 24 hours".into());
            }
        }
        if let Some(mix) = &self.mix {
            if [mix.text, mix.complex, mix.scanned].iter().any(|weight| !(weight.is_finite() && *weight >= 0.0)) {
                return fail("mix weights must be non-negative".into());
            }
        }
        if let Some(confidence) = self.mix_confidence {
            if !(0.0..=1.0).contains(&confidence) {
                return fail("mixConfidence must be between 0 and 1".into());
            }
        }
        if self.mime_type.as_ref().is_some_and(|mime| mime.chars().count() > 255) {
            return fail("type must be at most 255 characters".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    /// Pages priced: counted pages, or the middle of the range for files whose pages were not counted.
    pub pages: f64,
    /// Present when some files' pages were not counted: the fewest and most pages their sizes allow. `pages` is not a ceiling then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages_range: Option<PagesRange>,
    /// How many files' page counts are unknown (priced over a range).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unmeasured_files: Option<u32>,
    pub documents: f64,
    pub billing: Billing,
    pub credits: Option<CreditRange>,
    pub seconds: Option<CreditRange>,
    pub basis: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PagesRange {
    pub low: f64,
    pub high: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CardSource {
    /// The card compiled into this build.
    Bundled,
    /// A card the caller passed in (usually fetched from `GET /v1/billing/estimate-card`).
    Supplied,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardIdentity {
    pub version: String,
    pub revision: String,
    pub source: CardSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Quote {
    /// The card the quote used; an offline quote is only as current as this.
    pub card: CardIdentity,
    pub estimate: CostEstimate,
    pub media: Option<UploadMediaEstimate>,
    /// Reasons to trust the quote less, e.g. `profile-card-mismatch` (profile built for another price card).
    pub warnings: Vec<String>,
}

/// Port of `workerCountedFormat`: the format (Word, slides, sheets, EPUB) a file is, by declared MIME type when one claims it,
/// else by extension when the type is absent or generic. `None` for any other file.
fn worker_counted_format<'a>(card: &'a Card, name: &str, mime_type: Option<&str>) -> Option<&'a str> {
    let mime = declared_type(mime_type);
    let formats = &card.unmeasured_pages.formats;
    if let Some(spec) = formats.iter().find(|spec| spec.mime_types.iter().any(|candidate| *candidate == mime)) {
        return Some(&spec.format);
    }
    if !is_generic_type(&mime) {
        return None;
    }
    let extension = extension_of(name);
    formats.iter().find(|spec| spec.extensions.iter().any(|candidate| *candidate == extension)).map(|spec| spec.format.as_str())
}

/// Pages a non-media file counts as: its known page count; else 1 for an image file, its size over the card's
/// characters per text page for a text file, its size at the format's typical bytes per page for a Word, slide, sheet or EPUB
/// file, and its size at the card's bytes per page for anything else (at least 1).
pub fn quote_file_pages(card: &Card, file: &QuoteFile) -> f64 {
    // A TIFF's frames are its pages, up to the frames one file may hold (more are refused, never read or billed).
    if is_multi_frame_image(card, file) {
        return 1f64.max(card.multi_frame_images.max_frames.min(js_round(file.pages.unwrap_or(1.0))));
    }
    let pages = file.pages.unwrap_or_else(|| {
        let mime = file.mime_type.as_deref();
        if is_image_file(card, &file.name, mime) {
            1.0
        } else if is_text_file(card, &file.name, mime) {
            // Text pages count characters; bytes bound them from above for UTF-8.
            (file.size / card.text_pages.chars).ceil()
        } else if let Some(bytes) = worker_counted_format(card, &file.name, mime).and_then(|format| card.unmeasured_pages.worker_counted.get(format)) {
            (file.size.max(0.0) / bytes.typical).ceil()
        } else {
            (file.size / card.assumed_bytes_per_page).ceil()
        }
    });
    1f64.max(js_round(pages))
}

/// Port of `isMultiFrameImageFile`: the card's multi-frame image types, or their extensions when the type is absent or generic.
pub fn is_multi_frame_image(card: &Card, file: &QuoteFile) -> bool {
    let mime = declared_type(file.mime_type.as_deref());
    let frames = &card.multi_frame_images;
    if frames.mime_types.iter().any(|candidate| *candidate == mime) {
        return true;
    }
    is_generic_type(&mime) && frames.extensions.iter().any(|candidate| *candidate == extension_of(&file.name))
}

/// Port of `isFastOnlyFile`: a Word, slide or sheet file (the card's `fastOnlyFormats`) whose pages no model reads in any quality.
/// A page mix the client sent does not change that.
fn is_fast_only_file(card: &Card, file: &QuoteFile) -> bool {
    worker_counted_format(card, &file.name, file.mime_type.as_deref())
        .is_some_and(|format| card.unmeasured_pages.fast_only_formats.iter().any(|candidate| candidate == format))
}

const IMAGE_FILE_MIX: PageMix = PageMix::new(0.0, 0.0, 1.0);
const TEXT_FILE_MIX: PageMix = PageMix::new(1.0, 0.0, 0.0);

// The ends of the page range of a file whose pages were not counted, and the Rich pages the high end counts for a page a vision
// model reads, are on the card (`unmeasuredPages`, `quoteHighRichPageFactor`; `upload-quote.ts` is the source). The golden cases hold
// this port in step with the TypeScript.

/// Where a file's page count sits: the cheap end, the middle and the expensive end; `measured` when the client counted them.
struct PageRange {
    low: f64,
    high: f64,
    measured: bool,
}

/// Port of `quoteFilePageRange`.
fn quote_file_page_range(card: &Card, file: &QuoteFile) -> PageRange {
    let central = quote_file_pages(card, file);
    let mime = file.mime_type.as_deref();
    // An uncounted TIFF holds one frame to as many as its size allows at the densest page, up to the frame cap.
    if file.pages.is_none() && is_multi_frame_image(card, file) {
        let by_size = (file.size / card.unmeasured_pages.default.min_bytes_per_page).ceil();
        return PageRange { low: 1.0, high: central.max(card.multi_frame_images.max_frames.min(by_size)), measured: false };
    }
    if file.pages.is_some() || is_image_file(card, &file.name, mime) {
        return PageRange { low: central, high: central, measured: true };
    }
    let unmeasured = &card.unmeasured_pages;
    let (low_divisor, high_divisor) = if is_text_file(card, &file.name, mime) {
        (unmeasured.text.max_bytes_per_page, unmeasured.text.min_bytes_per_page)
    } else if let Some(bytes) = worker_counted_format(card, &file.name, mime).and_then(|format| unmeasured.worker_counted.get(format)) {
        (bytes.max, bytes.min)
    } else {
        (unmeasured.default.max_bytes_per_page, unmeasured.default.min_bytes_per_page)
    };
    PageRange {
        low: 1f64.max(central.min((file.size / low_divisor).ceil())),
        high: central.max((file.size / high_divisor).ceil()),
        measured: false,
    }
}

/// A file's known page mix and its trust: measured, every page scanned for an image file, or all text for a text file.
fn known_mix(card: &Card, file: &QuoteFile) -> Option<(PageMix, f64)> {
    if let Some(mix) = file.mix.filter(|mix| mix.text + mix.complex + mix.scanned > 0.0) {
        return Some((mix, file.mix_confidence.unwrap_or(1.0)));
    }
    let mime = file.mime_type.as_deref();
    if is_image_file(card, &file.name, mime) {
        return Some((IMAGE_FILE_MIX, 1.0));
    }
    // Text files have no scanned pages whatever their length; only their page count is uncertain (`quote_file_page_range`).
    is_text_file(card, &file.name, mime).then_some((TEXT_FILE_MIX, 1.0))
}

/// The expensive end for a known mix: blended toward the scan-heavy bound, never below the measured scanned share.
fn high_mix(card: &Card, mix: &PageMix, confidence: f64) -> PageMix {
    let blended = blended_mix(mix, confidence, &card.quote_high_mix);
    let total = mix.text + mix.complex + mix.scanned;
    let measured_scanned = mix.scanned / total;
    if measured_scanned > blended.scanned {
        PageMix::new(mix.text / total, mix.complex / total, measured_scanned)
    } else {
        blended
    }
}

fn blended_mix(mix: &PageMix, confidence: f64, bound: &PageMix) -> PageMix {
    let total = mix.text + mix.complex + mix.scanned;
    if !(total > 0.0) {
        return *bound;
    }
    let trust = if confidence.is_finite() { confidence.max(0.0).min(1.0) } else { 1.0 };
    PageMix::new(
        (mix.text / total) * trust + bound.text * (1.0 - trust),
        (mix.complex / total) * trust + bound.complex * (1.0 - trust),
        (mix.scanned / total) * trust + bound.scanned * (1.0 - trust),
    )
}

struct QuoteMixes {
    low: PageMix,
    high: PageMix,
    fast_low: f64,
    fast_high: f64,
    known: usize,
    unmeasured: usize,
    range_low: f64,
    range_high: f64,
}

/// Port of `quoteMixes`: page counts per class at each end of the range, the scanned share of the high end counted `rich_factor` times.
fn quote_mixes(card: &Card, files: &[&QuoteFile], rich_factor: f64) -> QuoteMixes {
    // A Word, slide or sheet file's pages are as known as a text file's: no model reads them.
    let known = files.iter().filter(|file| is_fast_only_file(card, file) || known_mix(card, file).is_some()).count();
    let mut low = PageMix::default();
    let mut high = PageMix::default();
    let (mut fast_low, mut fast_high) = (0.0, 0.0);
    let (mut unmeasured, mut range_low, mut range_high) = (0usize, 0.0, 0.0);
    for file in files {
        let range = quote_file_page_range(card, file);
        if !range.measured {
            unmeasured += 1;
        }
        range_low += range.low;
        range_high += range.high;
        // No model reads a Word, slide or sheet page in any quality: Fast at both ends, over its page range.
        if is_fast_only_file(card, file) {
            fast_low += range.low;
            fast_high += range.high;
            continue;
        }
        let (file_low, file_high) = match known_mix(card, file) {
            Some((mix, confidence)) => (blended_mix(&mix, confidence, &card.quote_low_mix), high_mix(card, &mix, confidence)),
            None => (card.quote_low_mix, card.quote_high_mix),
        };
        low.text += range.low * file_low.text;
        low.complex += range.low * file_low.complex;
        low.scanned += range.low * file_low.scanned;
        high.text += range.high * file_high.text;
        high.complex += range.high * file_high.complex;
        high.scanned += range.high * file_high.scanned * rich_factor;
    }
    QuoteMixes { low, high, fast_low, fast_high, known, unmeasured, range_low, range_high }
}

/// What the high end of a quote assumes of a page a vision model reads (`richHighEnd`): typical, not a ceiling.
fn rich_high_end(card: &Card) -> String {
    format!(
        "high end assumes {} Rich pages for each page a vision model reads (a dense page's typical {}-token output; each further 1,000 output tokens bills one more, so it is typical, not a ceiling)",
        js_number(card.quote_high_rich_page_factor),
        thousands(card.quote_high_rich_output_tokens)
    )
}

/// A JavaScript number as a template literal prints it, for the whole numbers the card holds.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 { format!("{}", value as i64) } else { format!("{value}") }
}

/// `toLocaleString("en-US")` for a whole number: comma-grouped thousands.
fn thousands(value: f64) -> String {
    let digits = format!("{}", value.abs() as u64);
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    if value < 0.0 { format!("-{grouped}") } else { grouped }
}

/// The bitrates durations are assumed at when a media file's length is not known, for the quote's basis text.
fn assumed_bitrates(card: &Card) -> String {
    let kbps = |bytes_per_minute: f64| js_round(bytes_per_minute * 8.0 / 60.0 / 1000.0);
    let mbps = |bytes_per_minute: f64| js_round(bytes_per_minute * 8.0 / 60.0 / 100_000.0) / 10.0;
    format!("{} kbps audio and {} Mbps video", kbps(card.media_bytes_per_minute.audio), mbps(card.media_bytes_per_minute.video))
}

fn round_up5(value: f64) -> f64 {
    (value * 100_000.0).ceil() / 100_000.0
}

/// Port of `quoteUpload`: price `files` uploaded into a workspace with `profile`. Fails for a profile whose quality
/// is not on the card; callers validate files with [`QuoteFile::validate`] first (the TypeScript does not).
pub fn quote_upload(
    card: &Card,
    source: CardSource,
    files: &[QuoteFile],
    profile: &EstimateProfile,
    speed_boost: bool,
) -> Result<Quote, Error> {
    card.profile(&profile.quality)?;
    let multiplier = if speed_boost { card.speed_boost_multiplier } else { 1.0 };
    let paged: Vec<&QuoteFile> =
        files.iter().filter(|file| upload_media_kind(card, &file.name, file.mime_type.as_deref()).is_none()).collect();
    let pages = 0f64.max(js_round(paged.iter().fold(0.0, |sum, file| sum + quote_file_pages(card, file))));
    let documents = paged.len() as f64;
    // Fast never reads a page with a model, so no page can bill the extra Rich pages of a long output.
    let mixes = quote_mixes(card, &paged, if profile.quality == "fast" { 1.0 } else { card.quote_high_rich_page_factor });
    let features: std::collections::BTreeMap<String, bool> = card
        .document_features
        .iter()
        .map(|name| {
            let enabled = DocumentFeature::parse(name).is_some_and(|feature| profile.document_features.enabled(feature));
            (name.clone(), enabled)
        })
        .collect();
    // `mix` holds page counts; the pages priced are their sum, so each end of the range prices its own page count.
    let run = |mix: PageMix, bound: PageMix, fast_only: f64| -> Result<IngestEstimate, Error> {
        let total = mix.text + mix.complex + mix.scanned;
        let priced_mix = if total > 0.0 { mix } else { bound };
        let fast_only_pages = 0f64.max(js_round(fast_only));
        estimate_ingest(
            card,
            &IngestInput {
                pages: if total > 0.0 { 0f64.max(js_round(total)) } else if fast_only_pages > 0.0 { 0.0 } else { pages },
                fast_only_pages: Some(fast_only_pages),
                documents: Some(1f64.max(documents)),
                mix: priced_mix.into(),
                profile: Some(profile.quality.clone()),
                features: features.clone(),
                worker_slots: profile.worker_slots.filter(|slots| *slots != 0.0 && !slots.is_nan()),
                ..IngestInput::default()
            },
        )
    };
    // Same arithmetic as estimatePipelineWork with every planned stage selected.
    let paged_credits = |estimate: &IngestEstimate| {
        (estimate.credits.total_credits - estimate.credits.breakdown.features) + estimate.credits.breakdown.features
    };
    let low = run(mixes.low, card.quote_low_mix, mixes.fast_low)?;
    let high = run(mixes.high, card.quote_high_mix, mixes.fast_high)?;
    let fixed = card.fixed_overhead_seconds;
    let seconds = |wall: f64| if pages > 0.0 { 0f64.max(wall - fixed) + fixed } else { 0.0 };
    let mix_range = if mixes.known == 0 {
        "range from all-text to every page read by vision".to_string()
    } else if mixes.known == paged.len() {
        "page mix known for every file".to_string()
    } else {
        format!("page mix known for {} of {} files, others range from all-text to every page read by vision", mixes.known, paged.len())
    };
    let range_low = 0f64.max(js_round(mixes.range_low));
    let range_high = 0f64.max(js_round(mixes.range_high));
    let range = if mixes.unmeasured == 0 {
        mix_range
    } else {
        format!(
            "{mix_range}; pages not counted for {} of {} files, assumed {range_low} to {range_high} from their sizes",
            mixes.unmeasured,
            paged.len()
        )
    };
    // A TIFF with more frames than one file may hold is refused unread; it is quoted at the cap, the most it could bill.
    let max_frames = card.multi_frame_images.max_frames;
    let too_many_frames = paged.iter().filter(|file| is_multi_frame_image(card, file) && file.pages.unwrap_or(0.0) > max_frames).count();
    let frames_note = if too_many_frames == 0 {
        String::new()
    } else {
        format!(
            "{too_many_frames} image {} more than {max_frames} frames and will be refused (quoted at {max_frames}); ",
            if too_many_frames == 1 { "file holds" } else { "files hold" }
        )
    };
    let paged_estimate = CostEstimate {
        pages,
        pages_range: (mixes.unmeasured > 0).then_some(PagesRange { low: range_low, high: range_high }),
        unmeasured_files: (mixes.unmeasured > 0).then_some(mixes.unmeasured as u32),
        documents,
        billing: profile.billing,
        credits: match profile.billing {
            Billing::Disabled => None,
            Billing::Enforced => Some(CreditRange {
                low: round_up5(paged_credits(&low)) * multiplier,
                high: round_up5(paged_credits(&high)) * multiplier,
            }),
        },
        seconds: Some(CreditRange { low: round_up5(seconds(low.wall_seconds)), high: round_up5(seconds(high.wall_seconds)) }),
        basis: format!(
            "{} profile, {} of {} stages; {range}; {}{frames_note}modeled averages, not measured for this corpus",
            profile.quality,
            profile.stage_count,
            profile.stage_count,
            if profile.quality == "fast" { String::new() } else { format!("{}; ", rich_high_end(card)) }
        ),
    };

    let media_files: Vec<MediaFile> = files.iter().map(QuoteFile::media).collect();
    let mut media = estimate_upload_media(card, &media_files, profile.video_frames);
    if let Some(media) = media.as_mut() {
        media.credits = CreditRange { low: media.credits.low * multiplier, high: media.credits.high * multiplier };
        if let Some(lighter) = media.lighter.as_mut() {
            lighter.credits *= multiplier;
            lighter.saved_credits *= multiplier;
        }
    }
    let estimate = match &media {
        None => paged_estimate,
        Some(media) => CostEstimate {
            documents: paged_estimate.documents + f64::from(media.audio_files) + f64::from(media.video_files),
            credits: paged_estimate
                .credits
                .as_ref()
                .map(|credits| CreditRange { low: credits.low + media.credits.low, high: credits.high + media.credits.high }),
            basis: format!(
                "{}; audio and video priced by duration{}",
                paged_estimate.basis,
                if media.durations_assumed { format!(" (not read from every file: assumed from size at {})", assumed_bitrates(card)) } else { String::new() }
            ),
            ..paged_estimate
        },
    };
    let mut warnings = Vec::new();
    if profile.card_version != card.version {
        warnings.push("profile-card-mismatch".to_string());
    }
    Ok(Quote {
        card: CardIdentity { version: card.version.clone(), revision: card.revision.clone(), source },
        estimate,
        media,
        warnings,
    })
}
