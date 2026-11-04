//! Port of `quoteUpload` (`@docslurp/shared/upload-quote.ts`): an upload's price range from an estimate profile.

use serde::{Deserialize, Serialize};

use crate::card::{Card, PageMix};
use crate::error::Error;
use crate::price::{
    estimate_ingest, estimate_upload_media, is_image_file, is_text_file, js_round, upload_media_kind, CreditRange, IngestEstimate,
    IngestInput, MediaFile, UploadMediaEstimate,
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

/// Pages a non-media file counts as: its known page count; else 1 for an image file, its size over the card's
/// characters per text page for a text file, and its size at the card's bytes per page for anything else (at least 1).
pub fn quote_file_pages(card: &Card, file: &QuoteFile) -> f64 {
    let pages = file.pages.unwrap_or_else(|| {
        let mime = file.mime_type.as_deref();
        if is_image_file(card, &file.name, mime) {
            1.0
        } else if is_text_file(card, &file.name, mime) {
            // Text pages count characters; bytes bound them from above for UTF-8.
            (file.size / card.text_pages.chars).ceil()
        } else {
            (file.size / card.assumed_bytes_per_page).ceil()
        }
    });
    1f64.max(js_round(pages))
}

const IMAGE_FILE_MIX: PageMix = PageMix::new(0.0, 0.0, 1.0);
const TEXT_FILE_MIX: PageMix = PageMix::new(1.0, 0.0, 0.0);

// The ends of the page range of a file whose pages were not counted (`upload-quote.ts`: UNMEASURED_* and QUOTE_HIGH_RICH_*).
// The golden cases hold these in step with the TypeScript.
const UNMEASURED_MIN_BYTES_PER_PAGE: f64 = 16.0 * 1024.0;
const UNMEASURED_MAX_BYTES_PER_PAGE: f64 = 300.0 * 1024.0;
const UNMEASURED_TEXT_MAX_BYTES_PER_PAGE: f64 = 7_000.0;
const UNMEASURED_TEXT_MIN_BYTES_PER_PAGE: f64 = 720.0;
/// `richPagesForOutputTokens(2000)`: a dense page's output bills the included 1,000 tokens plus one extra Rich page.
const QUOTE_HIGH_RICH_PAGE_FACTOR: f64 = 2.0;

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
    if file.pages.is_some() || is_image_file(card, &file.name, mime) {
        return PageRange { low: central, high: central, measured: true };
    }
    let (low_divisor, high_divisor) = if is_text_file(card, &file.name, mime) {
        (UNMEASURED_TEXT_MAX_BYTES_PER_PAGE, UNMEASURED_TEXT_MIN_BYTES_PER_PAGE)
    } else {
        (UNMEASURED_MAX_BYTES_PER_PAGE, UNMEASURED_MIN_BYTES_PER_PAGE)
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
    known: usize,
    unmeasured: usize,
    range_low: f64,
    range_high: f64,
}

/// Port of `quoteMixes`: page counts per class at each end of the range, the scanned share of the high end counted `rich_factor` times.
fn quote_mixes(card: &Card, files: &[&QuoteFile], rich_factor: f64) -> QuoteMixes {
    let known = files.iter().filter(|file| known_mix(card, file).is_some()).count();
    let mut low = PageMix::default();
    let mut high = PageMix::default();
    let (mut unmeasured, mut range_low, mut range_high) = (0usize, 0.0, 0.0);
    for file in files {
        let range = quote_file_page_range(card, file);
        if !range.measured {
            unmeasured += 1;
        }
        range_low += range.low;
        range_high += range.high;
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
    QuoteMixes { low, high, known, unmeasured, range_low, range_high }
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
    let mixes = quote_mixes(card, &paged, if profile.quality == "fast" { 1.0 } else { QUOTE_HIGH_RICH_PAGE_FACTOR });
    let features: std::collections::BTreeMap<String, bool> = card
        .document_features
        .iter()
        .map(|name| {
            let enabled = DocumentFeature::parse(name).is_some_and(|feature| profile.document_features.enabled(feature));
            (name.clone(), enabled)
        })
        .collect();
    // `mix` holds page counts; the pages priced are their sum, so each end of the range prices its own page count.
    let run = |mix: PageMix, bound: PageMix| -> Result<IngestEstimate, Error> {
        let total = mix.text + mix.complex + mix.scanned;
        let priced_mix = if total > 0.0 { mix } else { bound };
        estimate_ingest(
            card,
            &IngestInput {
                pages: if total > 0.0 { 0f64.max(js_round(total)) } else { pages },
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
    let low = run(mixes.low, card.quote_low_mix)?;
    let high = run(mixes.high, card.quote_high_mix)?;
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
            "{} profile, {} of {} stages; {range}; modeled averages, not measured for this corpus",
            profile.quality, profile.stage_count, profile.stage_count
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
