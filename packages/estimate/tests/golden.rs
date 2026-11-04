//! Replays `golden/cases.json` (written by `@docslurp/shared`'s estimate-card.test.ts) and requires bit-identical
//! numbers: every field the TypeScript returned must match exactly.

use docslurp_estimate::card::Card;
use docslurp_estimate::price::{estimate_ingest, estimate_upload_media, IngestInput, MediaFile};
use docslurp_estimate::quote::{quote_upload, CardSource, EstimateProfile, QuoteFile};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Golden {
    version: String,
    ingest: Vec<Case<IngestInput>>,
    media: Vec<Case<MediaInput>>,
    quote: Vec<Case<QuoteInput>>,
}

#[derive(Deserialize)]
struct Case<I> {
    input: I,
    output: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaInput {
    files: Vec<MediaFile>,
    video_frames: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoteInput {
    files: Vec<QuoteFile>,
    profile: EstimateProfile,
    speed_boost: Option<bool>,
}

/// Every field of `expected` (the TypeScript output) must be present in `actual` with an identical value.
fn assert_subset(path: &str, expected: &Value, actual: &Value) {
    match (expected, actual) {
        (Value::Number(e), Value::Number(a)) => {
            let (e, a) = (e.as_f64().unwrap(), a.as_f64().unwrap());
            assert!(e.to_bits() == a.to_bits() || (e == 0.0 && a == 0.0), "{path}: expected {e:?}, got {a:?}");
        }
        (Value::Object(e), Value::Object(a)) => {
            for (key, value) in e {
                let actual = a.get(key).unwrap_or_else(|| panic!("{path}.{key}: missing in Rust output"));
                assert_subset(&format!("{path}.{key}"), value, actual);
            }
        }
        (Value::Array(e), Value::Array(a)) => {
            assert_eq!(e.len(), a.len(), "{path}: array length");
            for (index, (e, a)) in e.iter().zip(a).enumerate() {
                assert_subset(&format!("{path}[{index}]"), e, a);
            }
        }
        _ => assert_eq!(expected, actual, "{path}"),
    }
}

fn golden() -> Golden {
    serde_json::from_str(include_str!("../golden/cases.json")).expect("golden/cases.json parses")
}

#[test]
fn golden_cases_match_the_bundled_card() {
    assert_eq!(golden().version, Card::bundled().version, "regenerate card.json and golden/cases.json together");
}

#[test]
fn ingest_matches_typescript() {
    let card = Card::bundled();
    for (index, case) in golden().ingest.iter().enumerate() {
        let actual = serde_json::to_value(estimate_ingest(card, &case.input).unwrap()).unwrap();
        assert_subset(&format!("ingest[{index}]"), &case.output, &actual);
    }
}

#[test]
fn media_matches_typescript() {
    let card = Card::bundled();
    for (index, case) in golden().media.iter().enumerate() {
        let actual = serde_json::to_value(estimate_upload_media(card, &case.input.files, case.input.video_frames)).unwrap();
        assert_subset(&format!("media[{index}]"), &case.output, &actual);
    }
}

#[test]
fn quote_matches_typescript() {
    let card = Card::bundled();
    for (index, case) in golden().quote.iter().enumerate() {
        let input = &case.input;
        let quote = quote_upload(card, CardSource::Bundled, &input.files, &input.profile, input.speed_boost.unwrap_or(false)).unwrap();
        let actual = serde_json::json!({ "estimate": quote.estimate, "media": quote.media });
        assert_subset(&format!("quote[{index}]"), &case.output, &actual);
    }
}
