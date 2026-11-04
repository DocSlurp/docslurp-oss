//! The price card and planning constants, generated from `@docslurp/shared` (`card.json`).
//!
//! The bundled card is the one this build was released with. Online callers can pass a newer card (the same JSON),
//! so a long-lived offline build can still quote current prices.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Card shape this build reads; `card.json` with another `schema` is rejected.
pub const CARD_SCHEMA: u32 = 1;

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct PageMix {
    #[serde(default)]
    pub text: f64,
    #[serde(default)]
    pub complex: f64,
    #[serde(default)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaExtensions {
    pub audio: Vec<String>,
    pub video: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub schema: u32,
    pub version: String,
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
    pub media_extensions: MediaExtensions,
    pub default_profile: crate::quote::EstimateProfile,
}

impl Card {
    /// Parse a card (the `card.json` shape). Rejects unknown schema versions and cards without the `auto` profile.
    pub fn from_json(json: &str) -> Result<Card, String> {
        let card: Card = serde_json::from_str(json).map_err(|error| format!("invalid price card: {error}"))?;
        if card.schema != CARD_SCHEMA {
            return Err(format!("price card schema {} is not supported (expected {CARD_SCHEMA})", card.schema));
        }
        if !card.profiles.contains_key("auto") {
            return Err("price card has no `auto` profile".into());
        }
        Ok(card)
    }

    /// The card this build was released with.
    pub fn bundled() -> &'static Card {
        static CARD: OnceLock<Card> = OnceLock::new();
        CARD.get_or_init(|| Card::from_json(BUNDLED).expect("bundled card.json is valid"))
    }

    /// Profile pages for `id`, falling back to `auto` for an unknown id (as the server's schema default does).
    pub fn profile(&self, id: &str) -> (&str, &ProfilePages) {
        match self.profiles.get_key_value(id) {
            Some((key, pages)) => (key.as_str(), pages),
            None => {
                let (key, pages) = self.profiles.get_key_value("auto").expect("card has an auto profile");
                (key.as_str(), pages)
            }
        }
    }
}
