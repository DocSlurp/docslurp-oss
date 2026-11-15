//! `pageCostRoute` (`@docslurp/shared` page-cost-route.ts): the cost path a sampled page takes in production, from its
//! structural facts. The shared rule generates `page-cost-routes.json`; the test below holds this port to it.

use crate::rules::PageTableRouting;

/// The routes, in `PAGE_COST_ROUTES` order (the profile's `routePages` array is indexed by this).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageCostRoute {
    OcrRead = 0,
    OcrBlank = 1,
    Table = 2,
    Text = 3,
    Unknown = 4,
}

pub const PAGE_COST_ROUTES: usize = 5;

impl PageCostRoute {
    pub fn name(self) -> &'static str {
        match self {
            Self::OcrRead => "ocr-read",
            Self::OcrBlank => "ocr-blank",
            Self::Table => "table",
            Self::Text => "text",
            Self::Unknown => "unknown",
        }
    }
}

/// A page's structural facts; `None` is unknown, never zero. Grids are (rows, coverage of the page).
pub struct PageCostFacts<'a> {
    pub words: Option<f64>,
    pub images: Option<f64>,
    pub vector_paths: Option<f64>,
    pub grids: Option<&'a [(u32, Option<f64>)]>,
    pub grid_coverage: Option<f64>,
}

/// `isTableHeavy`: a grid of `tableHeavyMinRows` rows, or grids covering the share (their union when known, else summed).
fn table_heavy(tables: &PageTableRouting, grids: &[(u32, Option<f64>)], coverage: Option<f64>) -> bool {
    if grids.iter().any(|grid| grid.0 >= tables.table_heavy_min_rows) {
        return true;
    }
    let covered = coverage.unwrap_or_else(|| grids.iter().map(|grid| grid.1.unwrap_or(0.0)).sum());
    covered >= tables.table_heavy_min_coverage
}

/// `pageCostRoute`.
pub fn page_cost_route(tables: &PageTableRouting, facts: &PageCostFacts<'_>) -> PageCostRoute {
    let Some(words) = facts.words.filter(|words| words.is_finite()) else { return PageCostRoute::Unknown };
    if words <= 0.0 {
        if facts.images.unwrap_or(0.0) > 0.0 || facts.vector_paths.unwrap_or(0.0) > 0.0 {
            return PageCostRoute::OcrRead;
        }
        return if facts.images.is_none() || facts.vector_paths.is_none() { PageCostRoute::Unknown } else { PageCostRoute::OcrBlank };
    }
    match facts.grids {
        None => PageCostRoute::Table,
        Some(grids) if table_heavy(tables, grids, facts.grid_coverage) => PageCostRoute::Table,
        Some(_) => PageCostRoute::Text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::Rules;

    #[derive(serde::Deserialize)]
    struct Grid {
        rows: u32,
        coverage: Option<f64>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Facts {
        words: Option<f64>,
        images: Option<f64>,
        vector_paths: Option<f64>,
        grids: Option<Vec<Grid>>,
        grid_coverage: Option<f64>,
    }
    #[derive(serde::Deserialize)]
    struct Case {
        facts: Facts,
        route: String,
    }

    /// Every case the shared rule generated routes the same here (`page-cost-routes.json`, from `buildPageCostRouteCases`).
    #[test]
    fn routes_every_shared_case_like_page_cost_route() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../../page-cost-routes.json")).expect("fixture");
        assert!(cases.len() >= 10);
        let tables = &Rules::bundled().page_table_routing;
        for (index, case) in cases.iter().enumerate() {
            let grids: Option<Vec<(u32, Option<f64>)>> = case.facts.grids.as_ref().map(|grids| grids.iter().map(|g| (g.rows, g.coverage)).collect());
            let facts = PageCostFacts {
                words: case.facts.words,
                images: case.facts.images,
                vector_paths: case.facts.vector_paths,
                grids: grids.as_deref(),
                grid_coverage: case.facts.grid_coverage,
            };
            assert_eq!(page_cost_route(tables, &facts).name(), case.route, "case {index}");
        }
    }
}
