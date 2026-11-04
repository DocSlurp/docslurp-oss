//! Offline DocSlurp credit estimator.
//!
//! [`probe`] reads a file locally (PDF pages and text layer, media duration, Office page counts, images) and
//! [`quote::quote_upload`] prices an upload with the published price card ([`card::Card`]), the same way
//! `POST /v1/uploads/estimate` does. Nothing leaves the machine. Bindings: WebAssembly (`wasm` feature,
//! `@docslurp/estimate` on npm) and Python (`python` feature).

pub mod card;
pub mod price;
pub mod probe;
pub mod quote;

#[cfg(feature = "wasm")]
mod wasm;

#[cfg(feature = "python")]
mod python;

pub use card::{Card, PageMix};
pub use price::{estimate_ingest, IngestEstimate, IngestInput};
pub use probe::{probe, ProbeInput, ProbeResult};
pub use quote::{quote_upload, EstimateProfile, Quote, QuoteFile};

use serde::{Deserialize, Serialize};

/// The default profile: a new hosted workspace with default settings.
pub fn default_profile(card: &Card) -> EstimateProfile {
    card.default_profile.clone()
}

/// One request for [`quote_json`]: files (probe results already merged in), an optional workspace profile and card.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRequest {
    pub files: Vec<QuoteFile>,
    #[serde(default)]
    pub profile: Option<EstimateProfile>,
    #[serde(default)]
    pub speed_boost: Option<bool>,
}

/// Quote with an explicit card (bundled when `card` is `None`) and the request's profile (card default when absent).
pub fn quote(card: Option<&Card>, request: &QuoteRequest) -> Quote {
    let card = card.unwrap_or_else(|| Card::bundled());
    let profile = request.profile.clone().unwrap_or_else(|| default_profile(card));
    quote_upload(card, &request.files, &profile, request.speed_boost.unwrap_or(false))
}

/// JSON in, JSON out, for bindings without a richer type bridge. `card_json` overrides the bundled card.
pub fn quote_json(request_json: &str, card_json: Option<&str>) -> Result<String, String> {
    let request: QuoteRequest = serde_json::from_str(request_json).map_err(|error| format!("invalid quote request: {error}"))?;
    let card = card_json.map(Card::from_json).transpose()?;
    serde_json::to_string(&quote(card.as_ref(), &request)).map_err(|error| error.to_string())
}

/// Port of `estimateIngest` over JSON.
pub fn estimate_ingest_json(input_json: &str, card_json: Option<&str>) -> Result<String, String> {
    let input: IngestInput = serde_json::from_str(input_json).map_err(|error| format!("invalid ingest input: {error}"))?;
    let card = card_json.map(Card::from_json).transpose()?;
    let card = card.as_ref().unwrap_or_else(|| Card::bundled());
    serde_json::to_string(&estimate_ingest(card, &input)).map_err(|error| error.to_string())
}
