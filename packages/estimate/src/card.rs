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
pub const CARD_RULES: u32 = 2;

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
