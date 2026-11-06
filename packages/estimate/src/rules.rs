//! The neutral evidence and routing rules the router and this profiler share, generated from `@docslurp/shared`
//! (`profiler-rules.json`, `buildProfilerRules`): thresholds over measured structure only, never prices. The probe classifies
//! pages with these, so a profile measures pages the way the worker routes them.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::error::{Error, ErrorCode};

const BUNDLED: &str = include_str!("../profiler-rules.json");
/// The rules schema this build reads (`PROFILER_RULES_SCHEMA`).
pub const PROFILER_RULES_SCHEMA: u32 = 1;

/// The worker's raster-page routing thresholds (`PAGE_RASTER_ROUTING` in `@docslurp/shared`), all of them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

/// When a page is table-heavy (`PAGE_TABLE_ROUTING`): a table of this many rows, or tables covering this share.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageTableRouting {
    pub table_heavy_min_rows: f64,
    pub table_heavy_min_coverage: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfilerRules {
    pub schema: u32,
    pub page_raster_routing: PageRasterRouting,
    pub page_table_routing: PageTableRouting,
    /// sha256 of the rules' content (`buildProfilerRules`), so a change to any threshold is visible.
    pub revision: String,
}

impl ProfilerRules {
    /// Parse rules in the `profiler-rules.json` shape. Rejects other schemas and unknown fields.
    pub fn from_json(json: &str) -> Result<Self, Error> {
        let rules: ProfilerRules = serde_json::from_str(json)
            .map_err(|error| Error::new(ErrorCode::InvalidRequest, format!("invalid profiler rules: {error}")))?;
        if rules.schema != PROFILER_RULES_SCHEMA {
            return Err(Error::new(ErrorCode::InvalidRequest, format!("unsupported profiler rules schema {}", rules.schema)));
        }
        Ok(rules)
    }

    /// The rules this build was generated with.
    pub fn bundled() -> &'static ProfilerRules {
        static RULES: OnceLock<ProfilerRules> = OnceLock::new();
        RULES.get_or_init(|| ProfilerRules::from_json(BUNDLED).expect("bundled profiler-rules.json is valid"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::Card;

    #[test]
    fn bundled_rules_round_trip_exactly() {
        // Every field of the committed file is read, and nothing is added: parity with the TypeScript generator.
        let file: serde_json::Value = serde_json::from_str(BUNDLED).unwrap();
        assert_eq!(numbers_as_f64(serde_json::to_value(ProfilerRules::bundled()).unwrap()), numbers_as_f64(file));
        assert!(ProfilerRules::bundled().revision.len() == 64);
    }

    /// JSON numbers as f64, so `16384` and `16384.0` compare equal (the thresholds are read as f64).
    fn numbers_as_f64(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Number(number) => serde_json::json!(number.as_f64().unwrap()),
            serde_json::Value::Object(map) => serde_json::Value::Object(map.into_iter().map(|(key, value)| (key, numbers_as_f64(value))).collect()),
            other => other,
        }
    }

    #[test]
    fn the_cards_frozen_routing_copy_agrees_with_the_rules() {
        let rules = &ProfilerRules::bundled().page_raster_routing;
        let card = serde_json::to_value(&Card::bundled().page_raster_routing).unwrap();
        let rules = serde_json::to_value(rules).unwrap();
        for (key, value) in card.as_object().unwrap() {
            assert_eq!(rules.get(key).and_then(|v| v.as_f64()), value.as_f64(), "{key}");
        }
    }

    #[test]
    fn rejects_other_schemas_and_unknown_fields() {
        let mut value: serde_json::Value = serde_json::from_str(BUNDLED).unwrap();
        value["schema"] = 2.into();
        assert!(ProfilerRules::from_json(&value.to_string()).is_err());
        let mut value: serde_json::Value = serde_json::from_str(BUNDLED).unwrap();
        value["priceCard"] = serde_json::json!({});
        assert!(ProfilerRules::from_json(&value.to_string()).is_err());
    }
}
