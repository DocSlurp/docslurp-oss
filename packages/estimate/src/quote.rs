//! Port of `quoteUpload` (`@docslurp/shared/upload-quote.ts`): an upload's price range from an estimate profile.

use serde::{Deserialize, Serialize};

use crate::card::{Card, PageMix};
use crate::error::Error;
use crate::price::{
    estimate_ingest, estimate_upload_media, is_image_file, js_round, upload_media_kind, CreditRange, IngestEstimate,
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
        if !(self.size.is_finite() && self.size >= 0.0 && self.size.fract() == 0.0) {
            return fail("size must be a non-negative integer".into());
        }
        if let Some(pages) = self.pages {
            if !(pages.is_finite() && pages >= 1.0 && pages.fract() == 0.0) {
                return fail("pages must be a positive integer".into());
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
    pub pages: f64,
    pub documents: f64,
    pub billing: Billing,
    pub credits: Option<CreditRange>,
    pub seconds: Option<CreditRange>,
    pub basis: String,
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

/// Pages a non-media file counts as: its known page count; else 1 for an image file and its size at the card's
/// bytes per page for anything else (at least 1).
pub fn quote_file_pages(card: &Card, file: &QuoteFile) -> f64 {
    let pages = file.pages.unwrap_or_else(|| {
        if is_image_file(card, &file.name, file.mime_type.as_deref()) {
            1.0
        } else {
            (file.size / card.assumed_bytes_per_page).ceil()
        }
    });
    1f64.max(js_round(pages))
}

const IMAGE_FILE_MIX: PageMix = PageMix::new(0.0, 0.0, 1.0);

/// A file's known page mix and its trust: measured, or every page scanned for an image file.
fn known_mix(card: &Card, file: &QuoteFile) -> Option<(PageMix, f64)> {
    if let Some(mix) = file.mix {
        return Some((mix, file.mix_confidence.unwrap_or(1.0)));
    }
    is_image_file(card, &file.name, file.mime_type.as_deref()).then_some((IMAGE_FILE_MIX, 1.0))
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

fn quote_mixes(card: &Card, files: &[&QuoteFile]) -> (PageMix, PageMix, usize) {
    let known = files.iter().filter(|file| known_mix(card, file).is_some()).count();
    if known == 0 {
        return (card.quote_low_mix, card.quote_high_mix, 0);
    }
    let mut low = PageMix::default();
    let mut high = PageMix::default();
    for file in files {
        let pages = quote_file_pages(card, file);
        let (file_low, file_high) = match known_mix(card, file) {
            Some((mix, confidence)) => {
                (blended_mix(&mix, confidence, &card.quote_low_mix), blended_mix(&mix, confidence, &card.quote_high_mix))
            }
            None => (card.quote_low_mix, card.quote_high_mix),
        };
        low.text += pages * file_low.text;
        low.complex += pages * file_low.complex;
        low.scanned += pages * file_low.scanned;
        high.text += pages * file_high.text;
        high.complex += pages * file_high.complex;
        high.scanned += pages * file_high.scanned;
    }
    (low, high, known)
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
    let (low_mix, high_mix, known) = quote_mixes(card, &paged);
    let features: std::collections::BTreeMap<String, bool> = card
        .document_features
        .iter()
        .map(|name| {
            let enabled = DocumentFeature::parse(name).is_some_and(|feature| profile.document_features.enabled(feature));
            (name.clone(), enabled)
        })
        .collect();
    let run = |mix: PageMix| -> Result<IngestEstimate, Error> {
        estimate_ingest(
            card,
            &IngestInput {
                pages,
                documents: Some(1f64.max(documents)),
                mix: mix.into(),
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
    let low = run(low_mix)?;
    let high = run(high_mix)?;
    let fixed = card.fixed_overhead_seconds;
    let seconds = |wall: f64| if pages > 0.0 { 0f64.max(wall - fixed) + fixed } else { 0.0 };
    let range = if known == 0 {
        "range from all-text to scan-heavy pages".to_string()
    } else if known == paged.len() {
        "page mix known for every file".to_string()
    } else {
        format!("page mix known for {known} of {} files, others range from all-text to scan-heavy pages", paged.len())
    };
    let paged_estimate = CostEstimate {
        pages,
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
            basis: format!("{}; audio and video priced by duration", paged_estimate.basis),
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
