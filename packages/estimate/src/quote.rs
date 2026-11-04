//! Port of `quoteUpload` (`@docslurp/shared/upload-quote.ts`): an upload's price range from an estimate profile.

use serde::{Deserialize, Serialize};

use crate::card::{Card, PageMix};
use crate::price::{
    estimate_ingest, estimate_upload_media, js_round, upload_media_kind, CreditRange, IngestEstimate, IngestInput,
    MediaFile, UploadMediaEstimate,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Billing {
    Enforced,
    Disabled,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFeatures {
    pub document_summary: bool,
    pub structured_fields: bool,
    pub knowledge_graph: bool,
    pub propositions: bool,
}

impl DocumentFeatures {
    fn get(&self, feature: &str) -> bool {
        match feature {
            "documentSummary" => self.document_summary,
            "structuredFields" => self.structured_fields,
            "knowledgeGraph" => self.knowledge_graph,
            "propositions" => self.propositions,
            _ => false,
        }
    }
}

/// What pricing reads from a workspace. The server returns it from `POST /v1/uploads/estimate` (`profile`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

/// One file of an upload. `pages`, `durationSeconds` and `mix` usually come from [`crate::probe`].
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    /// Price card the quote used; an offline quote is only as current as this.
    pub card_version: String,
    pub estimate: CostEstimate,
    pub media: Option<UploadMediaEstimate>,
}

/// Pages a non-media file counts as: its known page count, else its size at the card's bytes per page (at least 1).
pub fn quote_file_pages(card: &Card, file: &QuoteFile) -> f64 {
    let pages = file.pages.unwrap_or_else(|| (file.size / card.assumed_bytes_per_page).ceil());
    1f64.max(js_round(pages))
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
    let measured = files.iter().filter(|file| file.mix.is_some()).count();
    if measured == 0 {
        return (card.quote_low_mix, card.quote_high_mix, 0);
    }
    let mut low = PageMix::default();
    let mut high = PageMix::default();
    for file in files {
        let pages = quote_file_pages(card, file);
        let (file_low, file_high) = match &file.mix {
            Some(mix) => {
                let confidence = file.mix_confidence.unwrap_or(1.0);
                (blended_mix(mix, confidence, &card.quote_low_mix), blended_mix(mix, confidence, &card.quote_high_mix))
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
    (low, high, measured)
}

fn round_up5(value: f64) -> f64 {
    (value * 100_000.0).ceil() / 100_000.0
}

/// Port of `quoteUpload`: price `files` uploaded into a workspace with `profile`.
pub fn quote_upload(card: &Card, files: &[QuoteFile], profile: &EstimateProfile, speed_boost: bool) -> Quote {
    let multiplier = if speed_boost { card.speed_boost_multiplier } else { 1.0 };
    let paged: Vec<&QuoteFile> =
        files.iter().filter(|file| upload_media_kind(card, &file.name, file.mime_type.as_deref()).is_none()).collect();
    let pages = 0f64.max(js_round(paged.iter().fold(0.0, |sum, file| sum + quote_file_pages(card, file))));
    let documents = paged.len() as f64;
    let (low_mix, high_mix, measured) = quote_mixes(card, &paged);
    let features: std::collections::BTreeMap<String, bool> = card
        .document_features
        .iter()
        .map(|feature| (feature.clone(), profile.document_features.get(feature)))
        .collect();
    let run = |mix: PageMix| -> IngestEstimate {
        estimate_ingest(
            card,
            &IngestInput {
                pages,
                documents: Some(1f64.max(documents)),
                mix,
                profile: Some(profile.quality.clone()),
                features: features.clone(),
                worker_slots: profile.worker_slots.filter(|slots| *slots != 0.0 && !slots.is_nan()),
                ..IngestInput::default()
            },
        )
    };
    let paged_credits = |estimate: &IngestEstimate| {
        (estimate.credits.total_credits - estimate.credits.breakdown.features) + estimate.credits.breakdown.features
    };
    let low = run(low_mix);
    let high = run(high_mix);
    let fixed = card.fixed_overhead_seconds;
    let seconds = |wall: f64| if pages > 0.0 { 0f64.max(wall - fixed) + fixed } else { 0.0 };
    let range = if measured == 0 {
        "range from all-text to scan-heavy pages".to_string()
    } else {
        format!(
            "page mix measured for {measured} of {} files, others range from all-text to scan-heavy pages",
            paged.len()
        )
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
    Quote { card_version: card.version.clone(), estimate, media }
}
