//! Offline DocSlurp credit estimator.
//!
//! [`probe()`] reads a file on the user's own machine (PDF pages and page mix, media duration, Office page counts,
//! the real file type) and [`quote()`] prices an upload with the published price card exactly as
//! `POST /v1/uploads/estimate` does. One WebAssembly build serves every host through the JSON ABI in [`abi`]:
//! the `@docslurp/estimate` npm package (browsers, Node, Deno, Workers), Python on wasmtime, Go on wazero.
//!
//! The pricing rules are ports of `@docslurp/shared` (`quoteUpload`, `estimateIngest`, `estimateUploadMedia`), held
//! to them bit for bit by `golden/cases.json`. See DESIGN.md.

pub mod abi;
pub mod card;
pub mod error;
pub mod price;
pub mod probe;
pub mod quote;

use serde::{Deserialize, Serialize};

pub use card::{Card, PageMix};
pub use error::{Error, ErrorCode};
pub use probe::{probe, read_plan, FileMeta, ProbeInput, ProbeResult, ReadPlan};
pub use quote::{quote_upload, CardSource, EstimateProfile, Quote, QuoteFile};

/// One quote request: files (probe results already applied), an optional project profile (the card's default
/// project when absent) and speed boost. Unknown fields are refused.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuoteRequest {
    pub files: Vec<QuoteFile>,
    #[serde(default)]
    pub profile: Option<EstimateProfile>,
    #[serde(default)]
    pub speed_boost: Option<bool>,
}

/// Price a request with `card` (supplied, e.g. from `GET /v1/billing/estimate-card`) or the bundled card.
pub fn quote(card: Option<&Card>, request: &QuoteRequest) -> Result<Quote, Error> {
    let (card, source) = match card {
        Some(card) => (card, CardSource::Supplied),
        None => (Card::bundled(), CardSource::Bundled),
    };
    if request.files.is_empty() || request.files.len() > 1000 {
        return Err(Error::invalid_request("files must hold 1-1000 files"));
    }
    for file in &request.files {
        file.validate()?;
    }
    let profile = request.profile.clone().unwrap_or_else(|| card.default_profile.clone());
    if profile.worker_slots.is_some_and(|slots| !(slots >= 1.0 && slots.fract() == 0.0 && slots.is_finite())) {
        return Err(Error::invalid_request("profile.workerSlots must be a positive integer"));
    }
    quote_upload(card, source, &request.files, &profile, request.speed_boost.unwrap_or(false))
}
