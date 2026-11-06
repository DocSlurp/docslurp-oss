//! The price card and planning constants, generated from `@docslurp/shared` (`card.json`).
//!
//! The bundled card is the one this build was released with. Online callers can pass a newer card (the same JSON),
//! so a long-lived offline build can still quote current prices.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::error::{Error, ErrorCode};

/// Card shape this build reads; a card with another `schema` is rejected.
pub const CARD_SCHEMA: u32 = 2;
/// Pricing formulas this build implements; a card for other `rules` is rejected rather than quoted with stale logic.
pub const CARD_RULES: u32 = 6;

const BUNDLED: &str = include_str!("../card.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageMode {
    Fast,
    Rich,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCost {
    pub worker_seconds: f64,
    pub mode: PageMode,
    pub source_bytes: f64,
    pub artifact_bytes: f64,
    pub index_bytes: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfilePages {
    pub text: PageCost,
    pub complex: PageCost,
    pub scanned: PageCost,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceCard {
    pub fast_per1k_pages: f64,
    pub rich_per1k_pages: f64,
    pub audio_minute_rich_pages: f64,
    pub video_minute_rich_pages: f64,
    pub storage_gb_month: f64,
    pub document_summary: f64,
    pub structured_fields_per10_pages: f64,
    pub knowledge_graph_per10_pages: f64,
    pub propositions_per10_pages: f64,
}

/// Page-class weights. All three are required, as the server requires them (`pageMixSchema`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageMix {
    pub text: f64,
    pub complex: f64,
    pub scanned: f64,
}

impl PageMix {
    pub const fn new(text: f64, complex: f64, scanned: f64) -> Self {
        Self { text, complex, scanned }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaPair {
    pub audio: f64,
    pub video: f64,
}

/// Extensions (lower case, without the dot) priced as media or image files when the MIME type does not say.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Extensions {
    pub audio: Vec<String>,
    pub video: Vec<String>,
    pub image: Vec<String>,
    pub text: Vec<String>,
}

/// Text files: pages counted from the text (`textPageCount` in `@docslurp/shared`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPages {
    pub mime_prefixes: Vec<String>,
    pub lines: f64,
    pub chars: f64,
}

/// Bytes of source per page at the two ends of a quote's page range for a file whose pages were not counted: the densest
/// (`min`, most pages, the high end) and the sparsest (`max`, fewest pages, the low end).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BytesPerPageRange {
    pub min_bytes_per_page: f64,
    pub max_bytes_per_page: f64,
}

/// As [`BytesPerPageRange`] plus the `typical` value that prices the middle (formats only the worker can count).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BytesPerPageTriple {
    pub min: f64,
    pub typical: f64,
    pub max: f64,
}

/// A format only the worker can count (Word, slides, sheets, EPUB): the MIME types and extensions (without the dot) that make a file one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerCountedFormatSpec {
    pub format: String,
    pub mime_types: Vec<String>,
    pub extensions: Vec<String>,
}

/// How a file of unknown page count is quoted over its size (`UNMEASURED_*` in `@docslurp/shared`'s `upload-quote.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmeasuredPages {
    pub default: BytesPerPageRange,
    pub text: BytesPerPageRange,
    pub worker_counted: BTreeMap<String, BytesPerPageTriple>,
    pub formats: Vec<WorkerCountedFormatSpec>,
    /// Worker-counted formats no model reads in any quality (Word, slides, sheets): priced Fast at both ends of a quote.
    pub fast_only_formats: Vec<String>,
}

/// Multi-frame images (TIFF, `IMAGE_MAX_FRAMES` in `@docslurp/shared`): each frame is a page, at most `max_frames` per file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiFrameImages {
    pub max_frames: f64,
    pub mime_types: Vec<String>,
    pub extensions: Vec<String>,
}

/// The worker's raster-page routing thresholds (`PAGE_RASTER_ROUTING` in `@docslurp/shared`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// A scan beside native text (`mixedScanImage`; geometry in docs/page-layout-facts.md).
    pub mixed_scan_min_coverage: f64,
    pub mixed_scan_max_words_inside: f64,
    pub mixed_scan_min_short_side_px: f64,
    pub mixed_scan_min_ppi: f64,
    pub scan_like_max_bytes_per_pixel: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub schema: u32,
    pub rules: u32,
    pub version: String,
    /// sha256 of the card's content; the server's `cardRevision` and the card endpoint's ETag.
    pub revision: String,
    pub credits_per_dollar: f64,
    pub price_card: PriceCard,
    pub profiles: BTreeMap<String, ProfilePages>,
    pub document_features: Vec<String>,
    pub parallel_efficiency: f64,
    pub fixed_overhead_seconds: f64,
    pub media_worker_seconds_per_minute: MediaPair,
    pub media_bytes_per_minute: MediaPair,
    pub max_page_fanout_per_run: f64,
    pub funded_worker_slots: f64,
    pub speed_boost_multiplier: f64,
    pub assumed_bytes_per_page: f64,
    pub unmeasured_pages: UnmeasuredPages,
    pub multi_frame_images: MultiFrameImages,
    /// Rich pages the high end of a quote counts for each page a vision model reads (a dense page's typical output).
    pub quote_high_rich_page_factor: f64,
    pub quote_high_rich_output_tokens: f64,
    pub quote_low_mix: PageMix,
    pub quote_high_mix: PageMix,
    pub default_profile: crate::quote::EstimateProfile,
    pub extensions: Extensions,
    pub text_pages: TextPages,
    pub page_raster_routing: PageRasterRouting,
}

impl Card {
    /// Parse a card (the `card.json` / `GET /v1/billing/estimate-card` shape). Rejects other schemas and rules, and
    /// cards whose default profile or features this build cannot price.
    pub fn from_json(json: &str) -> Result<Card, Error> {
        let card: Card = serde_json::from_str(json).map_err(|error| Error::invalid_card(error.to_string()))?;
        if card.schema != CARD_SCHEMA {
            return Err(Error::invalid_card(format!("schema {} is not supported (expected {CARD_SCHEMA})", card.schema)));
        }
        if card.rules != CARD_RULES {
            return Err(Error::new(
                ErrorCode::UnsupportedRules,
                format!("card rules {} need a newer estimator (this build implements rules {CARD_RULES})", card.rules),
            ));
        }
        for feature in &card.document_features {
            if crate::quote::DocumentFeature::parse(feature).is_none() {
                return Err(Error::new(ErrorCode::UnsupportedRules, format!("card prices unknown feature `{feature}`")));
            }
        }
        card.profile(&card.default_profile.quality)?;
        // Every format the card lists must have its bytes per page, or a file of that format could not be quoted.
        for spec in &card.unmeasured_pages.formats {
            if !card.unmeasured_pages.worker_counted.contains_key(&spec.format) {
                return Err(Error::invalid_card(format!("card lists format `{}` without its bytes per page", spec.format)));
            }
        }
        Ok(card)
    }

    /// The card this build was released with.
    pub fn bundled() -> &'static Card {
        static CARD: OnceLock<Card> = OnceLock::new();
        CARD.get_or_init(|| Card::from_json(BUNDLED).expect("bundled card.json is valid"))
    }

    /// Profile pages for quality `id`. An unknown quality is an error, never priced as another one.
    pub fn profile(&self, id: &str) -> Result<&ProfilePages, Error> {
        self.profiles
            .get(id)
            .ok_or_else(|| Error::new(ErrorCode::UnsupportedRules, format!("quality `{id}` is not on this price card")))
    }
}
