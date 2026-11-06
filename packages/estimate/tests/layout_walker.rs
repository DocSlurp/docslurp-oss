//! Cross-check: the profiler's layout facts against the core layout walker's (`worker/scripts/pdf_layout_facts.py`,
//! `pdf-layout-facts@1`) on the routing eval's fixtures. The walker's output is recorded in `tests/layout-walker/` by
//! `scripts/layout-walker-snapshots.mjs` from the walker's own inputs (`pdfimages -list` and the recorded Doppler
//! `-bbox-layout -rules` XHTML); `test/layout-walker-snapshots.test.mjs` fails when a snapshot is stale.
//!
//! What must agree: the visible page size; each placed image's box, coverage, pixel size, ppi, bytes per pixel,
//! scan-likeness and furniture; the words inside it (within a small tolerance: the profiler places words from the content
//! stream, the walker from the text layer's boxes); the scan-beside-text decision; each ruled grid's rows, columns and
//! coverage; and whether the grids alone make the page table-heavy.

use docslurp_estimate::probe::{layout_pages, LayoutImage, LayoutPage};
use docslurp_estimate::rules::Rules;
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../worker/testdata/pdf-fixtures");
const SNAPSHOTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/layout-walker");

fn snapshots() -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = std::fs::read_dir(SNAPSHOTS)
        .expect("tests/layout-walker")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            (name, serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap())
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn num(value: &Value) -> Option<f64> {
    value.as_f64()
}

fn scan_like(rules: &Rules, image: &Value) -> bool {
    matches!(image["encoding"].as_str(), Some("ccitt" | "jbig2"))
        || image["bitsPerComponent"].as_f64() == Some(1.0)
        || num(&image["bytesPerPixel"]).is_some_and(|bpp| bpp <= rules.page_raster_routing.scan_like_max_bytes_per_pixel)
}

/// `mixedScanImage` over the walker's own facts, gated like `decidePageRaster` (Some(true) read, None unknown).
fn walker_scan_beside(rules: &Rules, page: &Value) -> Option<bool> {
    let routing = &rules.page_raster_routing;
    let words = num(&page["words"])?;
    if words < routing.sparse_page_words {
        return Some(false);
    }
    let images = page["images"].as_array()?;
    Some(images.iter().any(|image| {
        num(&image["coverage"]).is_some_and(|coverage| coverage >= routing.mixed_scan_min_coverage)
            && !image["repeated"].as_bool().unwrap_or(false)
            && num(&image["wordsInside"]).is_some_and(|inside| inside <= routing.mixed_scan_max_words_inside)
            && num(&image["widthPx"]).unwrap().min(num(&image["heightPx"]).unwrap()) >= routing.mixed_scan_min_short_side_px
            && image["ppi"].as_array().is_some_and(|ppi| ppi.iter().all(|value| num(value).is_some_and(|ppi| ppi >= routing.mixed_scan_min_ppi)))
            && scan_like(rules, image)
    }))
}

fn matching<'a>(ours: &'a LayoutPage, theirs: &Value) -> Option<&'a LayoutImage> {
    let bbox: Vec<f64> = theirs["bbox"].as_array()?.iter().filter_map(num).collect();
    ours.images.iter().find(|image| image.bbox.is_some_and(|b| b.iter().zip(&bbox).all(|(a, c)| (a - c).abs() <= 0.5)))
}

#[test]
fn the_profiler_reproduces_the_layout_walkers_facts_on_the_routing_fixtures() {
    let rules = Rules::bundled();
    let routing = &rules.page_raster_routing;
    let all = snapshots();
    assert!(all.len() >= 10, "expected the routing fixtures' walker snapshots, found {}", all.len());
    let mut checked_images = 0;
    let mut checked_grids = 0;
    for (name, snapshot) in &all {
        let bytes = std::fs::read(format!("{FIXTURES}/{name}")).unwrap_or_else(|error| panic!("{name}: {error}"));
        let ours = layout_pages(&bytes);
        let theirs = snapshot["pages"].as_array().unwrap();
        assert_eq!(ours.len(), theirs.len(), "{name}: pages");
        for (index, (page, walker)) in ours.iter().zip(theirs).enumerate() {
            let at = format!("{name} p{}", index + 1);
            assert!(walker["known"].as_bool().unwrap(), "{at}: the walker could not place the page");
            assert!((page.width_pt - num(&walker["widthPt"]).unwrap()).abs() < 0.01, "{at}: width");
            assert!((page.height_pt - num(&walker["heightPt"]).unwrap()).abs() < 0.01, "{at}: height");

            // Images: every image the walker placed over the significance floor, with the same facts.
            for image in walker["images"].as_array().unwrap() {
                let Some(coverage) = num(&image["coverage"]) else { continue };
                if coverage < routing.min_significant_image_coverage
                    || num(&image["widthPx"]).unwrap().min(num(&image["heightPx"]).unwrap()) < routing.min_significant_image_pixels
                {
                    continue;
                }
                let mine = matching(page, image).unwrap_or_else(|| panic!("{at}: no image at {}", image["bbox"]));
                checked_images += 1;
                assert!((mine.coverage.unwrap() - coverage).abs() <= 0.002, "{at}: coverage {:?} vs {coverage}", mine.coverage);
                assert_eq!((mine.width_px, mine.height_px), (num(&image["widthPx"]).unwrap(), num(&image["heightPx"]).unwrap()), "{at}: pixels");
                let ppi: Vec<f64> = image["ppi"].as_array().unwrap().iter().filter_map(num).collect();
                assert!(mine.ppi.iter().zip(&ppi).all(|(a, b)| (a - b).abs() <= 1.0), "{at}: ppi {:?} vs {ppi:?}", mine.ppi);
                // The listing prints stream sizes rounded (12.3K): bytes per pixel agree to that rounding.
                let bpp = num(&image["bytesPerPixel"]).unwrap();
                assert!((mine.bytes_per_pixel - bpp).abs() <= bpp * 0.03 + 1e-4, "{at}: bytes per pixel {} vs {bpp}", mine.bytes_per_pixel);
                let mine_scan_like = mine.bilevel || mine.bytes_per_pixel <= routing.scan_like_max_bytes_per_pixel;
                assert_eq!(mine_scan_like, scan_like(rules, image), "{at}: scan-like");
                assert_eq!(mine.repeated, image["repeated"].as_bool().unwrap(), "{at}: furniture");
                if let (Some(inside), Some(walker_inside)) = (mine.words_inside, num(&image["wordsInside"])) {
                    let tolerance = (walker_inside * 0.1).max(1.0);
                    assert!((f64::from(inside) - walker_inside).abs() <= tolerance, "{at}: words inside {inside} vs {walker_inside}");
                    assert_eq!(f64::from(inside) <= routing.mixed_scan_max_words_inside, walker_inside <= routing.mixed_scan_max_words_inside, "{at}: words-inside gate");
                }
            }

            // The routing rule: the same decision, and unknown never reads.
            match walker_scan_beside(rules, walker) {
                Some(expected) => assert_eq!(page.scan_beside_text, Some(expected), "{at}: scan beside text"),
                None => assert_ne!(page.scan_beside_text, Some(true), "{at}: unknown evidence read"),
            }

            // Ruled grids, where the walker had ruling lines.
            if let Some(grids) = walker["grids"].as_array() {
                let mine = page.grids.as_ref().unwrap_or_else(|| panic!("{at}: grids unknown"));
                assert_eq!(mine.len(), grids.len(), "{at}: grids {mine:?} vs {grids:?}");
                for (grid, theirs) in mine.iter().zip(grids) {
                    checked_grids += 1;
                    assert_eq!((grid.0, grid.1), (theirs["rows"].as_u64().unwrap() as u32, theirs["columns"].as_u64().unwrap() as u32), "{at}: grid shape");
                    assert!((grid.2 - num(&theirs["coverage"]).unwrap()).abs() <= 0.005, "{at}: grid coverage {} vs {}", grid.2, theirs["coverage"]);
                }
                let heavy = grids.iter().any(|grid| grid["rows"].as_u64().unwrap() >= u64::from(rules.page_table_routing.table_heavy_min_rows))
                    || grids.iter().map(|grid| num(&grid["coverage"]).unwrap()).sum::<f64>() >= rules.page_table_routing.table_heavy_min_coverage;
                assert_eq!(page.ruled_table_heavy, heavy, "{at}: table-heavy from grids");
                assert!(page.grid_coverage.unwrap() <= num(&walker["tableCoverage"]).unwrap() + 0.005, "{at}: grid coverage over the walker's table coverage");
            }
        }
    }
    assert!(checked_images >= 8, "only {checked_images} images compared");
    assert!(checked_grids >= 5, "only {checked_grids} grids compared");
}
