//! PDF profile: page count, and facts measured on sampled pages.
//!
//! Each sampled page is measured the way the worker reads its evidence (`decidePageRaster` in
//! `packages/shared/src/page-raster-routing.ts`, evidence from `worker/src/lib/page-image-evidence.ts`), with the
//! thresholds the profiler rules carry: native words, significant image placements and their coverage, vector drawing,
//! fonts without a Unicode mapping, and whether the page raster rule finds the page held by a full-page image. Words come
//! from text runs, image coverage from each image's placement matrix over the page's CropBox, so nothing is rendered. An image object drawn on at least
//! `repeatedImageMinPages` sampled pages and `repeatedImageMinShare` of them is page furniture (a logo, a letterhead,
//! a slide background) and counts for nothing, as in the worker; an image no bigger than `minSignificantImagePixels`
//! or `minSignificantImageCoverage` counts for nothing either, so a blank page with a 1x1 image is blank.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use lopdf::content::Content;
use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId};

use super::{PdfProfile, ProbeInput, ProbeKind, ProbeResult, AREA_EQUIVALENT_BUCKETS, COVERAGE_BUCKETS, TEXT_EQUIVALENT_BOUNDS, WHOLE_FILE_MAX_BYTES, WORDS_BUCKETS};
use super::layout;
use crate::rules::{PageRasterRouting, Rules};

#[path = "detail.rs"]
pub mod detail;
#[path = "range.rs"]
pub mod range;
#[path = "features.rs"]
mod features;
#[path = "inline.rs"]
mod inline;
#[path = "encoding.rs"]
mod encoding;

/// Decompressed bytes of one content stream or form XObject.
const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;
/// Content bytes interpreted per page, page content and every form invocation together.
const MAX_INTERPRETED_BYTES_PER_PAGE: usize = 16 * 1024 * 1024;
/// Content operations interpreted per page, forms included.
const MAX_OPERATIONS_PER_PAGE: usize = 200_000;
/// Form XObject invocations per page.
const MAX_FORM_CALLS_PER_PAGE: usize = 2_000;
/// Nested form XObjects followed.
const MAX_FORM_DEPTH: u32 = 3;
/// Decompression limit per stream while loading the document (object and xref streams).
const MAX_LOAD_STREAM_BYTES: usize = 16 * 1024 * 1024;
/// Decompressed bytes of all object streams together (`budget_object_streams`): lopdf decodes and keeps every object
/// stream at load time with only a per-stream limit.
const MAX_OBJECT_STREAM_BYTES: usize = 64 * 1024 * 1024;
/// lopdf's loader keeps every object in memory: 1.0 to 1.25 KiB each on wasm32 beyond the input itself (measured on
/// real PDFs, streams included), charged at 1.25 KiB per object the trailer declares (`/Size`), plus the input's copy.
const LOAD_BYTES_PER_OBJECT: u64 = 1280;
/// What a whole-document load may take of the module's 256 MiB memory; past it the probe reads only the page tree. A
/// file that declares too few objects still traps, and the host's bounded retry gives it a page count.
const MAX_LOAD_BYTES: u64 = 224 * 1024 * 1024;
/// Decompressed page content and form bytes per document, cached forms included.
const MAX_DOCUMENT_CONTENT_BYTES: usize = 32 * 1024 * 1024;
/// A page with this much image coverage or this many path operations is layout-heavy (figures, charts, tables).
const LAYOUT_MIN_IMAGE_COVERAGE: f64 = 0.15;
const LAYOUT_MIN_PATH_OPERATIONS: usize = 60;
const DEFAULT_PAGE_AREA: f64 = 612.0 * 792.0;

pub(super) fn probe(rules: &Rules, input: &ProbeInput<'_>) -> ProbeResult {
    let result = ProbeResult::new(ProbeKind::Pdf, "pdf", Some("application/pdf"));
    if input.size > WHOLE_FILE_MAX_BYTES {
        return result.note("PDF larger than the probe limit; pages not counted");
    }
    if !input.is_whole() {
        return result.note("PDF profiles need the whole file; pages not counted");
    }
    // lopdf's encrypted-document path decodes object streams without the budget hook below, and the probe does not
    // measure encrypted content anyway: count pages from the raw objects instead of loading.
    if has_name(input.head, b"Encrypt") {
        let mut result = fallback_page_count(input.head, result).note("encrypted PDF; page facts not measured");
        result.encrypted = Some(true);
        return result;
    }
    // A document whose objects would not fit a whole load, or one the host retries after the module ran out of memory,
    // gets its page count from a bounded read of the page tree instead (a declared /Size can lie low: the host retry
    // covers that).
    if input.bounded || !whole_load_fits(input.head) {
        let note = if input.bounded { "retried without loading the whole document" } else { "too many objects to load the whole document" };
        return bounded_page_count(input.head, result).note(format!("{note}; page facts not measured"));
    }
    OBJECT_STREAM_BUDGET.with(|budget| budget.set(MAX_OBJECT_STREAM_BYTES));
    OBJECT_STREAM_BUDGET_EXCEEDED.with(|exceeded| exceeded.set(false));
    let options = LoadOptions {
        max_decompressed_size: Some(MAX_LOAD_STREAM_BYTES),
        filter: Some(budget_object_streams),
        ..LoadOptions::default()
    };
    let loaded = Document::load_mem_with_options(input.head, options);
    if OBJECT_STREAM_BUDGET_EXCEEDED.with(Cell::get) {
        return fallback_page_count(input.head, result)
            .note("compressed object streams exceed the profiler's budget; page facts not measured");
    }
    match loaded {
        Ok(document) => probe_document(rules, &document, input.head.len(), result),
        Err(error) => fallback_page_count(input.head, result).note(format!("PDF did not parse ({error})")),
    }
}

fn probe_document(rules: &Rules, document: &Document, file_bytes: usize, mut result: ProbeResult) -> ProbeResult {
    let routing = &rules.page_raster_routing;
    let pages: Vec<ObjectId> = document.get_pages().into_values().collect();
    if pages.is_empty() {
        return result.note("PDF has no pages");
    }
    result.pages = Some(pages.len() as f64);
    if document.is_encrypted() {
        result.encrypted = Some(true);
        return result.note("encrypted PDF; page facts not measured");
    }
    let mut forms = FormCache::default();
    let mut readings: Vec<PageReading> = Vec::new();
    let mut read_pages: Vec<(usize, ObjectId)> = Vec::new();
    for index in sample_indices(pages.len(), rules.max_sampled_pages) {
        if forms.document_budget_spent() {
            break;
        }
        if let Some(reading) = classify_page(routing, document, pages[index], &mut forms) {
            readings.push(reading);
            read_pages.push((index, pages[index]));
        }
    }
    if readings.is_empty() {
        return result.note("no page content could be read; page facts not measured");
    }
    let budget_hit = readings.iter().any(|reading| reading.exhausted) || forms.document_budget_spent();
    let repeated = repeated_images(routing, &readings);
    let drawn = readings.iter().all(|reading| reading.blank(&repeated)) && drawn_document(routing, document, file_bytes, pages.len());
    let mut profile = PdfProfile { sampled_pages: readings.len() as u32, drawn_content: drawn, budget_exhausted: budget_hit, ..PdfProfile::default() };
    profile.furniture_images = repeated.len() as u32;
    let encoding_rules = &rules.encoding;
    let sampled_ids: HashSet<ObjectId> = read_pages.iter().map(|(_, id)| *id).collect();
    // The structure tree is read only while the content budget lasts (pages that spent it end the reading); its reads
    // come out of the encoding facts' own budget.
    let tagged = (!forms.document_budget_spent()).then(|| {
        let mut budget = encoding::Budget::new(forms.encoding_budget());
        let left = budget.left;
        let facts = encoding::struct_facts(document, encoding_rules, &sampled_ids, &mut budget);
        forms.encoding_spend(left - budget.left);
        facts
    });
    // Strip and table-shaped images repeated like page furniture (often too small to count as significant images).
    let mut furniture = repeated.clone();
    let mut shaped: HashMap<ObjectId, usize> = HashMap::new();
    for reading in &readings {
        let on_page: HashSet<ObjectId> = reading.encoding.strips.iter().chain(&reading.encoding.table_images).filter_map(|id| *id).collect();
        for id in on_page { *shaped.entry(id).or_insert(0) += 1; }
    }
    let scope = readings.len().max(1) as f64;
    furniture.extend(shaped.into_iter().filter(|(_, pages)| *pages as f64 >= routing.repeated_image_min_pages && *pages as f64 / scope >= routing.repeated_image_min_share).map(|(id, _)| id));
    profile.tagged_formulas = tagged.as_ref().map(|facts| facts.formulas);
    profile.tagged_tables = tagged.as_ref().map(|facts| facts.tables);
    profile.tagged_math_sources = tagged.as_ref().map(|facts| facts.sources);
    profile.tagged_truncated = tagged.as_ref().is_some_and(|facts| facts.truncated).then_some(true);
    let mut masks: Vec<(u16, u32)> = Vec::new();
    let mut page_stats: Vec<PageStat> = Vec::new();
    for (reading, (page_index, page_id)) in readings.iter().zip(&read_pages) {
        let totals = reading.totals(&repeated);
        let raster = is_raster_page(routing, reading.words, &totals);
        profile.words_per_page[bucket(&rules.words_per_page_buckets, reading.words, WORDS_BUCKETS)] += 1;
        profile.image_coverage[coverage_bucket(&rules.image_coverage_buckets, totals.coverage)] += 1;
        if reading.words > 0.0 {
            profile.text_layer_pages += 1;
        }
        if reading.words < routing.sparse_page_words {
            profile.low_text_pages += 1;
        }
        if reading.blank(&repeated) {
            profile.blank_pages += 1;
        }
        if raster {
            profile.raster_pages += 1;
        }
        if totals.count > 0 {
            profile.image_pages += 1;
        }
        profile.images += totals.count as u32;
        let vector_heavy = reading.path_operations >= LAYOUT_MIN_PATH_OPERATIONS;
        if vector_heavy {
            profile.vector_heavy_pages += 1;
        }
        if !raster && (totals.coverage >= LAYOUT_MIN_IMAGE_COVERAGE || vector_heavy) {
            profile.layout_heavy_pages += 1;
        }
        if reading.unmapped_text {
            profile.unmapped_font_pages += 1;
        }
        profile.sampled_words = profile.sampled_words.saturating_add(reading.words.min(f64::from(u32::MAX)) as u32);
        let volume = &reading.text;
        let count = |value: f64| value.max(0.0).min(u64::MAX as f64) as u64;
        profile.sampled_chars = profile.sampled_chars.saturating_add(count(volume.chars));
        profile.sampled_text_lines = profile.sampled_text_lines.saturating_add(count(volume.lines));
        for (bucket, glyphs) in volume.by_size.iter().enumerate() {
            profile.chars_by_font_size[bucket] = profile.chars_by_font_size[bucket].saturating_add(count(*glyphs));
        }
        profile.invisible_chars = profile.invisible_chars.saturating_add(count(volume.invisible));
        profile.off_crop_chars = profile.off_crop_chars.saturating_add(count(volume.off_crop));
        let text = rules.text_equivalents(volume.chars, volume.lines);
        let area = rules.area_equivalents(reading.area);
        profile.sampled_text_equivalents = profile.sampled_text_equivalents.saturating_add(count(text));
        profile.sampled_area_equivalents = profile.sampled_area_equivalents.saturating_add(count(area));
        let page = text.max(area);
        profile.sampled_page_equivalents = profile.sampled_page_equivalents.saturating_add(count(page));
        profile.max_page_equivalents = profile.max_page_equivalents.max(page.min(f64::from(u32::MAX)) as u32);
        let text_bucket = TEXT_EQUIVALENT_BOUNDS.iter().rposition(|bound| text >= *bound).unwrap_or(0);
        profile.text_equivalents_per_page[text_bucket] += 1;
        let area_bucket = ((area as usize).clamp(1, AREA_EQUIVALENT_BUCKETS)) - 1;
        profile.area_equivalents_per_page[area_bucket] += 1;
        if text > rules.page_equivalents.dense_page_equivalents {
            profile.dense_pages += 1;
        }
        for (index, allowance) in [1.0, 2.0, 3.0].into_iter().enumerate() {
            let billed = (if text > allowance { text } else { 1.0 }).max(area).max(1.0);
            profile.page_equivalents_by_allowance[index] = profile.page_equivalents_by_allowance[index].saturating_add(count(billed));
            profile.max_page_equivalents_by_allowance[index] = profile.max_page_equivalents_by_allowance[index].max(billed.min(f64::from(u32::MAX)) as u32);
        }
        profile.off_page_chars = profile.off_page_chars.saturating_add(count(volume.off_page));
        profile.tiny_chars_dropped = profile.tiny_chars_dropped.saturating_add(count(volume.tiny_dropped));
        if volume.estimated {
            profile.text_estimated_pages += 1;
        }
        let images: Vec<&ImageUse> = reading.images.iter().filter(|image| !image.id.is_some_and(|id| repeated.contains(&id))).collect();
        for image in &images {
            let ppi = [0.0, 100.0, 200.0, 300.0].iter().rposition(|bound| image.ppi[0].min(image.ppi[1]) >= *bound).unwrap_or(0);
            profile.image_ppi[ppi] = profile.image_ppi[ppi].saturating_add(1);
            let bpp = [0.0, 0.05, 0.2, 0.5, 1.0].iter().rposition(|bound| image.bytes_per_pixel >= *bound).unwrap_or(0);
            profile.image_bytes_per_pixel[bpp] = profile.image_bytes_per_pixel[bpp].saturating_add(1);
        }
        profile.observed_vector_paths = profile.observed_vector_paths.saturating_add(reading.path_operations as u64);
        profile.observed_image_placements = profile.observed_image_placements.saturating_add(reading.images.len() as u32);
        profile.lexical_pages[match reading.lexical { Some(true) => 0, Some(false) => 1, None => 2 }] += 1;
        profile.chart_candidate_unknown_pages += 1;
        for image in &reading.images {
            let repeated_image = image.id.is_some_and(|id| repeated.contains(&id));
            if repeated_image { profile.repeated_image_placements += 1; }
            let mp = image.width_px * image.height_px / 1_000_000.0;
            let bin = [0.0625, 0.25, 1.0, 4.0].iter().filter(|floor| mp >= **floor).count();
            profile.image_region_sizes[bin] += 1;
            let class = if image.placement.is_none() || image.width_px <= 0.0 || image.height_px <= 0.0 { 3 }
                else if repeated_image || image.width_px.min(image.height_px) < 32.0 || image.coverage < 0.02 { 0 }
                else if image.coverage >= 0.5 { 2 } else { 1 };
            profile.image_region_classes[class] += 1;
        }
        let facts = page_layout(rules, reading, &repeated);
        profile.glyphs_over_images = profile.glyphs_over_images.saturating_add(count(facts.glyphs_over_images));
        if facts.glyphs_over_images >= 20.0 {
            profile.text_over_image_pages += 1;
        }
        // `mixedScanImage`: read for a scan beside native text; unknown evidence never authorizes a read.
        match facts.scan_beside_text {
            Some(true) => profile.scan_beside_text_pages += 1,
            None => profile.scan_beside_text_unknown_pages += 1,
            Some(false) => {}
        }
        if facts.ruled_table_heavy {
            profile.ruled_table_pages += 1;
        }
        let word_boxes: Vec<[f64; 4]> = reading.words_at.iter().map(|w| [w.x - w.width / 2.0, w.y - w.height / 2.0, w.x + w.width / 2.0, w.y + w.height / 2.0]).collect();
        let (mask, counts) = encoding::page_mask(encoding_rules, &reading.encoding, &encoding::PageView {
            visible: reading.display_visible,
            chars: reading.text.chars,
            words: reading.words,
            words_at: &word_boxes,
            words_known: !reading.exhausted && !reading.words_overflow,
            rules: &reading.rules.rules,
            rules_known: !reading.exhausted && !reading.rules.overflow,
            rule_thickness: rules.layout.rule_thickness_pt,
            grids: facts.grids.as_ref().map(Vec::len),
            exhausted: reading.exhausted,
            images: totals.count,
            path_operations: reading.path_operations,
            repeated: &furniture,
            // Unknown structure (not read): the page's tagged bits are unknown too.
            tagged: tagged.as_ref().map_or(1 << encoding_rules.bits.partial, |facts| facts.pages.iter().filter(|entry| entry.0 == *page_id).fold(0, |bits, entry| bits | entry.1)),
            document_mathml: tagged.as_ref().is_some_and(|facts| facts.document_mathml),
        });
        match masks.iter_mut().find(|entry| entry.0 == mask) {
            Some(entry) => entry.1 += 1,
            None => masks.push((mask, 1)),
        }
        page_stats.push(PageStat { page: *page_index as u32 + 1, mask, counts });
        // `pageCostRoute`: what production does with the page (scan-fill OCR, table path or text layer).
        let grids: Option<Vec<(u32, Option<f64>)>> = facts.grids.as_ref().map(|grids| grids.iter().map(|grid| (grid.0, Some(grid.2))).collect());
        let route = super::cost_route::page_cost_route(&rules.page_table_routing, &super::cost_route::PageCostFacts {
            words: reading.lexical.map(|present| if present { reading.words.max(1.0) } else { 0.0 }),
            images: (!reading.exhausted).then_some(reading.images.len() as f64),
            vector_paths: (!reading.exhausted).then_some(reading.path_operations as f64),
            grids: grids.as_deref(),
            grid_coverage: facts.grid_coverage,
        });
        profile.route_pages[route as usize] += 1;
    }
    let points = |value: f64| value.round().clamp(0.0, 10_000_000.0) as u32;
    let median = |mut values: Vec<f64>| { values.sort_by(f64::total_cmp); values[values.len() / 2] };
    profile.median_page_width_pt = points(median(readings.iter().map(|reading| reading.width).collect()));
    profile.median_page_height_pt = points(median(readings.iter().map(|reading| reading.height).collect()));
    profile.max_page_width_pt = points(readings.iter().map(|reading| reading.width).fold(0.0, f64::max));
    profile.max_page_height_pt = points(readings.iter().map(|reading| reading.height).fold(0.0, f64::max));
    let mut areas: Vec<f64> = readings.iter().map(|reading| reading.area / (72.0 * 72.0)).collect();
    areas.sort_by(f64::total_cmp);
    let square_inches = |value: f64| value.round().clamp(0.0, 1_000_000.0) as u32;
    profile.median_page_area_sq_in = square_inches(areas[areas.len() / 2]);
    profile.max_page_area_sq_in = square_inches(*areas.last().unwrap_or(&0.0));
    profile.page_encodings = Some(encoding::sorted_keys(masks.iter().map(|entry| f64::from(entry.0))).into_iter().map(|(_, index)| masks[index]).collect());
    PAGE_STATS.with(|slot| *slot.borrow_mut() = page_stats);
    if budget_hit {
        result.notes.push("a page hit the profiler's content budget; its facts are approximate".into());
    }
    result.pdf = Some(profile);
    result
}

/// Histogram bucket of `value` for ascending lower bounds `bounds` (the first bound is 0).
fn bucket(bounds: &[f64], value: f64, buckets: usize) -> usize {
    bounds.iter().take(buckets).rposition(|bound| value >= *bound).unwrap_or(0)
}

/// Coverage bucket: none, then the rules' lower bounds over (0, 1]; the second bound (0) is exclusive.
fn coverage_bucket(bounds: &[f64], coverage: f64) -> usize {
    if !(coverage > 0.0) {
        return 0;
    }
    bounds.iter().take(COVERAGE_BUCKETS).rposition(|bound| coverage >= *bound && (*bound > 0.0)).unwrap_or(1).max(1)
}

/// Image objects that are page furniture: drawn on at least `repeatedImageMinPages` of the sampled pages and on at least
/// `repeatedImageMinShare` of them (a scan is a different image on every page).
fn repeated_images(routing: &PageRasterRouting, readings: &[PageReading]) -> HashSet<ObjectId> {
    let mut pages: HashMap<ObjectId, usize> = HashMap::new();
    for reading in readings {
        let on_page: HashSet<ObjectId> = reading.images.iter().filter_map(|image| image.id).collect();
        for id in on_page {
            *pages.entry(id).or_insert(0) += 1;
        }
    }
    let scope = readings.len().max(1) as f64;
    pages
        .into_iter()
        .filter(|(_, count)| *count as f64 >= routing.repeated_image_min_pages && *count as f64 / scope >= routing.repeated_image_min_share)
        .map(|(id, _)| id)
        .collect()
}

/// `count` indices spread evenly over `0..total`, first and last included.
fn sample_indices(total: usize, count: usize) -> Vec<usize> {
    if total <= count {
        return (0..total).collect();
    }
    let mut indices: Vec<usize> = (0..count).map(|i| i * (total - 1) / (count - 1)).collect();
    indices.dedup();
    indices
}

/// The largest object count a `/Size` entry declares (trailers and xref streams; incremental updates repeat it). An
/// array (`/Size [..]`, function dictionaries) is not a count and is skipped.
fn declared_objects(bytes: &[u8]) -> u64 {
    let mut most = 0u64;
    let mut at = 0usize;
    while let Some(found) = bytes[at..].windows(5).position(|window| window == b"/Size") {
        let mut cursor = at + found + 5;
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\r' | b'\n' | b'\t' | b'\x0c' | b'\0') {
            cursor += 1;
        }
        let digits = bytes[cursor..].iter().take_while(|byte| byte.is_ascii_digit()).take(10).fold(0u64, |n, byte| n * 10 + u64::from(byte - b'0'));
        most = most.max(digits);
        at = cursor.max(at + found + 1);
    }
    most
}

/// Whether lopdf's whole-document load fits the module memory, from the declared objects and the input size.
fn whole_load_fits(bytes: &[u8]) -> bool {
    declared_objects(bytes).saturating_mul(LOAD_BYTES_PER_OBJECT).saturating_add(bytes.len() as u64) <= MAX_LOAD_BYTES
}

/// The page count from the bounded range reader (`range::RangeSession`, inventory only, no page deep-measured) over the
/// bytes in hand: it parses the xref and page tree lazily under its own object, read and decode limits. Falls back to
/// the raw page-object scan when the reader refuses the document.
fn bounded_page_count(bytes: &[u8], result: ProbeResult) -> ProbeResult {
    match range_inventory_pages(bytes) {
        Ok(pages) if pages > 0 => {
            let mut result = result;
            result.pages = Some(pages as f64);
            result.note("page count read from the page tree")
        }
        Ok(_) => fallback_page_count(bytes, result),
        Err(error) => fallback_page_count(bytes, result).note(format!("page tree not read ({error})")),
    }
}

fn range_inventory_pages(bytes: &[u8]) -> Result<usize, String> {
    use self::range::{RangeSession, Request};
    let options = self::detail::Options { max_deep_pages: 0, groups: Vec::new(), ranked_pages: 0, ..Default::default() };
    let mut session = RangeSession::new(bytes.len() as u64, options, 0).map_err(|error| error.to_string())?;
    let mut pages = None;
    // Every step reads, emits or finishes; the reader's own budgets end a hostile walk long before this bound.
    for _ in 0..10_000_000u32 {
        let step = session.step().map_err(|error| error.to_string())?;
        match step["kind"].as_str() {
            Some("read") => {
                let offset = step["offset"].as_u64().ok_or("bad read offset")? as usize;
                let length = step["length"].as_u64().ok_or("bad read length")? as usize;
                let request_id = step["requestId"].as_u64().ok_or("bad read id")?;
                let end = offset.checked_add(length).filter(|end| *end <= bytes.len()).ok_or("read past the end")?;
                session.supply(Request { request_id, offset: offset as u64, length }, &bytes[offset..end]).map_err(|error| error.to_string())?;
            }
            Some("output") => {
                for line in step["jsonl"].as_str().unwrap_or_default().lines() {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                        if value["t"] == "end" {
                            pages = value["inventoryPages"].as_u64().map(|n| n as usize);
                        }
                    }
                }
            }
            Some("done") => return pages.ok_or_else(|| "no page inventory".to_owned()),
            _ => return Err("unexpected range step".to_owned()),
        }
    }
    Err("range walk did not finish".to_owned())
}

/// When the document does not parse, count `/Type /Page` objects in the raw bytes (misses compressed object streams).
fn fallback_page_count(bytes: &[u8], mut result: ProbeResult) -> ProbeResult {
    let mut count = 0usize;
    let mut at = 0usize;
    while let Some(found) = bytes[at..].windows(5).position(|window| window == b"/Type") {
        let mut cursor = at + found + 5;
        while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\r' | b'\n' | b'\t') {
            cursor += 1;
        }
        if bytes[cursor..].starts_with(b"/Page") && !bytes[cursor..].starts_with(b"/Pages") {
            count += 1;
        }
        at = cursor.max(at + found + 1);
    }
    if count > 0 {
        result.pages = Some(count as f64);
        result.notes.push("page count read from raw page objects".into());
    }
    result
}

/// Decompressed form XObject content, once per object for the whole document, and the document-wide budget for
/// decompressed content (page streams and forms).
#[derive(Default)]
struct FormCache {
    content: HashMap<ObjectId, Option<Rc<Vec<u8>>>>,
    decompressed: usize,
    /// Font classes (`encoding::font_class`) per font dictionary (by its place in the loaded document, so direct fonts
    /// are cached too), at most `MAX_CACHED_FONTS`; past that fonts are not classified and their glyphs make the page
    /// partial.
    fonts: HashMap<usize, usize>,
    /// Bytes the encoding facts may read (font program and glyph procedure heads, associated files, text prefixes),
    /// apart from the content budget so they never cut the pages sampled; set on first use.
    encoding_left: Option<usize>,
    /// Font program and glyph procedure answers per stream object (`encoding::stream_facts`).
    streams: encoding::StreamMemo,
}

const MAX_CACHED_FONTS: usize = 4_096;
/// Bytes the encoding facts may read per document (compressed plus decoded), apart from the content budget.
const MAX_ENCODING_BYTES: usize = 8 * 1024 * 1024;

impl FormCache {
    fn document_budget_spent(&self) -> bool {
        self.decompressed >= MAX_DOCUMENT_CONTENT_BYTES
    }

    /// Bytes still allowed for one stream: the per-stream limit or what is left of the document budget.
    fn stream_limit(&self) -> usize {
        MAX_STREAM_BYTES.min(MAX_DOCUMENT_CONTENT_BYTES.saturating_sub(self.decompressed))
    }

    /// What the encoding facts may still read.
    fn encoding_budget(&mut self) -> usize {
        *self.encoding_left.get_or_insert(MAX_ENCODING_BYTES)
    }

    fn encoding_spend(&mut self, bytes: usize) {
        let left = self.encoding_budget();
        self.encoding_left = Some(left.saturating_sub(bytes));
    }

    fn charge(&mut self, bytes: usize) {
        self.decompressed = self.decompressed.saturating_add(bytes);
    }

    fn get(&mut self, id: ObjectId, stream: &lopdf::Stream) -> Option<Rc<Vec<u8>>> {
        if let Some(cached) = self.content.get(&id) {
            return cached.clone();
        }
        let content = self.decompress(stream);
        self.content.insert(id, content.clone());
        content
    }

    fn decompress(&mut self, stream: &lopdf::Stream) -> Option<Rc<Vec<u8>>> {
        let limit = self.stream_limit();
        if limit == 0 {
            return None;
        }
        let content = match stream.decompressed_content_with_limit(limit) {
            Ok(content) => content,
            Err(_) => { self.charge(limit); return None; }
        };
        self.charge(content.len());
        Some(Rc::new(content))
    }
}

/// One sampled page's line in the per-page stat stream (`PDF_PAGE_STAT_COUNTS` in `@docslurp/shared`): its 1-based
/// page number, encoding mask and packed 4-bit count buckets. Never part of the file profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct PageStat {
    pub page: u32,
    pub mask: u16,
    pub counts: u32,
}

thread_local! {
    /// The per-page stat lines of the last PDF probed (the module is single-threaded); taken by `take_page_stats`.
    static PAGE_STATS: std::cell::RefCell<Vec<PageStat>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Clear the per-page stat lines before a probe, and take them after it.
pub fn take_page_stats() -> Vec<PageStat> {
    PAGE_STATS.with(|slot| std::mem::take(&mut *slot.borrow_mut()))
}

thread_local! {
    /// Decompressed object-stream bytes the current load may still decode (the module is single-threaded).
    static OBJECT_STREAM_BUDGET: Cell<usize> = const { Cell::new(0) };
    static OBJECT_STREAM_BUDGET_EXCEEDED: Cell<bool> = const { Cell::new(false) };
}

/// lopdf load hook, called on every raw object before lopdf decodes object streams: decode each object stream with
/// lopdf's own decoder (every filter in its chain, names as lopdf reads them) against the document-wide budget, and
/// drop it, and every later one, once the budget is spent. lopdf keeps only a per-stream limit.
fn budget_object_streams(id: ObjectId, object: &mut Object) -> Option<(ObjectId, Object)> {
    if let Object::Stream(stream) = object {
        if stream.dict.has_type(b"ObjStm") {
            if OBJECT_STREAM_BUDGET_EXCEEDED.with(Cell::get) {
                return None;
            }
            let remaining = OBJECT_STREAM_BUDGET.with(Cell::get);
            match stream.get_plain_content_with_limit(remaining) {
                Ok(content) => OBJECT_STREAM_BUDGET.with(|budget| budget.set(remaining.saturating_sub(content.len()))),
                Err(lopdf::Error::Decompress(lopdf::DecompressError::MemoryLimitExceeded { .. })) => {
                    OBJECT_STREAM_BUDGET_EXCEEDED.with(|exceeded| exceeded.set(true));
                    return None;
                }
                // Undecodable: lopdf will skip it as well.
                Err(_) => {}
            }
        }
    }
    // lopdf keeps the original top-level object after this hook and uses the returned value only for object-stream
    // members, which are never streams: streams return a placeholder, everything else a copy.
    match object {
        Object::Stream(_) => Some((id, Object::Null)),
        other => Some((id, other.clone())),
    }
}

/// Whether the file contains the PDF name `/<name>`, with `#xx` escapes decoded as a PDF parser decodes them.
fn has_name(bytes: &[u8], name: &[u8]) -> bool {
    // PDF white space includes NUL, as lopdf reads it.
    let delimiter = |byte: u8| byte.is_ascii_whitespace() || b"\0()<>[]{}/%".contains(&byte);
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut at = 0usize;
    while let Some(offset) = bytes.get(at..).and_then(|rest| rest.iter().position(|byte| *byte == b'/')) {
        let mut cursor = at + offset + 1;
        let mut decoded = Vec::with_capacity(name.len());
        while cursor < bytes.len() && !delimiter(bytes[cursor]) && decoded.len() <= name.len() {
            let byte = bytes[cursor];
            if byte == b'#' {
                if let (Some(high), Some(low)) = (bytes.get(cursor + 1).and_then(|b| hex(*b)), bytes.get(cursor + 2).and_then(|b| hex(*b))) {
                    decoded.push(high << 4 | low);
                    cursor += 3;
                    continue;
                }
            }
            decoded.push(byte);
            cursor += 1;
        }
        if decoded == name && (cursor >= bytes.len() || delimiter(bytes[cursor])) {
            return true;
        }
        at = cursor.max(at + offset + 1);
    }
    false
}

/// Native words as the worker counts them on extracted text (`pageEvidenceWordCount`): runs of 2+ letters or
/// digits, or letters and digits / 6 for scripts without spaces, whichever is larger. Shown strings are joined
/// the way text extraction joins them: text moves within a word's advance continue it, larger moves and line
/// changes break it. Two-byte (CID) strings carry glyph ids, not characters, so they count as letters only.
#[derive(Default)]
struct WordCounter {
    runs: f64,
    encoding_unknown: bool,
    characters: f64,
    run_length: usize,
    /// Glyphs shown since the last text move, to tell a next-character move from a word gap.
    run_glyphs: f64,
}

impl WordCounter {
    fn end_run(&mut self) {
        if self.run_length >= 2 {
            self.runs += 1.0;
        }
        self.run_length = 0;
    }

    fn show(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.encoding_unknown |= bytes.iter().any(|byte| !byte.is_ascii() || *byte == 0);
        let zero_high_bytes = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
        if bytes.len() >= 4 && zero_high_bytes * 2 >= bytes.len() / 2 {
            let glyphs = bytes.len() as f64 / 2.0;
            self.end_run();
            self.characters += glyphs;
            self.run_glyphs += glyphs;
            return;
        }
        for byte in bytes {
            // Bytes above ASCII are accented letters in the common single-byte encodings.
            if byte.is_ascii_alphanumeric() || *byte >= 0xC0 {
                self.run_length += 1;
                self.characters += 1.0;
            } else {
                self.end_run();
            }
        }
        self.run_glyphs += bytes.len() as f64;
    }

    fn gap(&mut self) {
        self.end_run();
        self.run_glyphs = 0.0;
    }

    /// A relative text move (`Td`/`TD`) in unscaled text space with the current font size: same line and no further
    /// than the glyphs just shown (about half an em each, plus a little) continues the word.
    fn moved(&mut self, tx: f64, ty: f64, font_size: f64) {
        let advance = (self.run_glyphs * 0.6 + 0.3) * font_size.abs().max(1.0);
        if ty.abs() > 0.01 || tx < 0.0 || tx > advance {
            self.end_run();
        }
        self.run_glyphs = 0.0;
    }

    fn words(&self) -> f64 {
        let pending = if self.run_length >= 2 { 1.0 } else { 0.0 };
        (self.runs + pending).max((self.characters / 6.0).floor())
    }
}

#[derive(Default)]
struct PageStats {
    inline_budget: inline::Budget,
    vector_bounds: Option<[f64;4]>,
    words: WordCounter,
    path_operations: usize,
    operations: usize,
    interpreted_bytes: usize,
    form_calls: usize,
    exhausted: bool,
    failure_bits: u64,
    /// Text was shown in a font with no Unicode mapping (`unmapped_font`).
    unmapped_text: bool,
    /// Text volume: glyphs shown and text lines started (both as extraction would see them).
    text: TextVolume,
    /// The text layer's words at their box centres (displayed coordinates); `words_overflow` past the walker's cap.
    words_at: Vec<WordAt>,
    words_overflow: bool,
    /// Ruling lines (stroked horizontal and vertical segments and rectangle edges, thin filled rectangles).
    rules: layout::RuleSet,
    /// Significant images (pixels and placed area over the rules' floors), at most `MAX_TRACKED_IMAGES_PER_PAGE`; the
    /// totals the class is read from are taken after repeated objects are dropped (`ImageTotals`).
    images: Vec<ImageUse>,
    /// What the page's math and table encoding mask is read from.
    encoding: encoding::PageEncoding,
}

const MAX_TRACKED_IMAGES_PER_PAGE: usize = 64;

#[derive(Debug, Clone, Copy)]
struct ImageUse {
    /// The image XObject, or none for an inline image (which has no identity to repeat).
    id: Option<ObjectId>,
    coverage: f64,
    /// The layout walker's image facts (`worker/scripts/pdf_layout_facts.py`, docs/page-layout-facts.md): the placed box
    /// in displayed coordinates and its clipped share of the visible page (None when the draw could not be placed), pixel
    /// size, pixels per inch on each axis as `pdfimages -list` rounds them, stream bytes per pixel, and a bilevel or fax
    /// encoding (CCITT, JBIG2, 1 bit per component, an image mask).
    placement: Option<([f64; 4], f64)>,
    width_px: f64,
    height_px: f64,
    ppi: [f64; 2],
    bytes_per_pixel: f64,
    bilevel: bool,
}

impl ImageUse {
    #[cfg(test)]
    fn plain(id: Option<ObjectId>, coverage: f64) -> Self {
        Self { id, coverage, placement: Some(([0.0, 0.0, 612.0, 792.0], coverage)), width_px: 1_000.0, height_px: 1_000.0, ppi: [150.0, 150.0], bytes_per_pixel: 0.2, bilevel: false }
    }
}

/// One text-layer word at the centre of its box, in displayed coordinates, with its glyphs.
#[derive(Debug, Clone, Copy)]
struct WordAt {
    x: f64,
    y: f64,
    glyphs: f64,
    width: f64,
    height: f64,
}

/// Words in one shown string as text extraction splits them, as (first glyph, glyph count): whitespace-separated runs,
/// or for a two-byte (CID) string, a word per `unspaced` glyphs.
fn string_words(bytes: &[u8], unspaced: f64) -> Vec<(usize, usize)> {
    let zero_high_bytes = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
    if bytes.len() >= 4 && zero_high_bytes * 2 >= bytes.len() / 2 {
        let glyphs = bytes.len() / 2;
        let step = (unspaced.max(1.0)) as usize;
        return (0..glyphs).step_by(step).map(|start| (start, step.min(glyphs - start))).collect();
    }
    let mut words = Vec::new();
    let mut start: Option<usize> = None;
    for (index, byte) in bytes.iter().chain(std::iter::once(&b' ')).enumerate() {
        if byte.is_ascii_whitespace() {
            if let Some(first) = start.take() {
                words.push((first, index - first));
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    words
}

/// Significant, non-repeated image totals of one page.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct ImageTotals {
    count: usize,
    coverage: f64,
    largest: f64,
}

impl PageStats {
    fn totals(&self, repeated: &HashSet<ObjectId>) -> ImageTotals {
        let mut totals = ImageTotals::default();
        for image in &self.images {
            if image.id.is_some_and(|id| repeated.contains(&id)) {
                continue;
            }
            totals.count += 1;
            totals.coverage = (totals.coverage + image.coverage).min(1.0);
            totals.largest = totals.largest.max(image.coverage);
        }
        totals
    }
}

impl PageStats {
    fn fail(&mut self, bit: u64) { self.exhausted = true; self.failure_bits |= bit; }
    fn charge_bytes(&mut self, bytes: usize) -> bool {
        self.interpreted_bytes = self.interpreted_bytes.saturating_add(bytes);
        if self.interpreted_bytes > MAX_INTERPRETED_BYTES_PER_PAGE {
            self.fail(1);
        }
        !self.exhausted
    }
}

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `a × b` for PDF matrices `[a b c d e f]` (row vectors: a point transforms by `a`, then `b`).
fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn number(object: &Object) -> Option<f64> {
    match object {
        Object::Integer(value) => Some(*value as f64),
        Object::Real(value) => Some(f64::from(*value)),
        _ => None,
    }
    .filter(|value| value.is_finite())
}

fn matrix_from(operands: &[Object]) -> Option<Matrix> {
    if operands.len() != 6 {
        return None;
    }
    let mut matrix = [0.0; 6];
    for (slot, operand) in matrix.iter_mut().zip(operands) {
        *slot = number(operand)?;
    }
    Some(matrix)
}

fn deref<'a>(document: &'a Document, object: &'a Object) -> Option<(Option<ObjectId>, &'a Object)> {
    document.dereference(object).ok()
}

fn dictionary<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match deref(document, object)?.1 {
        Object::Dictionary(dictionary) => Some(dictionary),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

/// A page box (`MediaBox`, `CropBox`) inherited through the page tree, as `[x0, y0, x1, y1]` normalized.
fn page_box(document: &Document, page_id: ObjectId, key: &[u8]) -> Option<[f64; 4]> {
    let mut node = document.get_dictionary(page_id).ok();
    for _ in 0..32 {
        let current = node?;
        if let Some((_, Object::Array(values))) = current.get(key).ok().and_then(|object| deref(document, object)) {
            let numbers: Vec<f64> =
                values.iter().filter_map(|value| deref(document, value).and_then(|(_, value)| number(value))).collect();
            if numbers.len() == 4 {
                return Some([
                    numbers[0].min(numbers[2]),
                    numbers[1].min(numbers[3]),
                    numbers[0].max(numbers[2]),
                    numbers[1].max(numbers[3]),
                ]);
            }
        }
        node = current.get(b"Parent").ok().and_then(|parent| dictionary(document, parent));
    }
    None
}

/// Visible page area: the CropBox clipped to the MediaBox, as the worker measures coverage.
/// The page's visible box: its CropBox clipped to its MediaBox (either alone when only one is set).
fn visible_box(document: &Document, page_id: ObjectId) -> Option<[f64; 4]> {
    let media = page_box(document, page_id, b"MediaBox");
    let crop = page_box(document, page_id, b"CropBox");
    match (media, crop) {
        (Some(m), Some(c)) => Some([m[0].max(c[0]), m[1].max(c[1]), m[2].min(c[2]), m[3].min(c[3])]),
        (Some(b), None) | (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// The page's /Rotate (inherited), a multiple of 90; anything else is 0, as the walker reads it.
fn page_rotate(document: &Document, page_id: ObjectId) -> i64 {
    let mut node = document.get_dictionary(page_id).ok();
    for _ in 0..32 {
        let Some(current) = node else { break };
        if let Some((_, value)) = current.get(b"Rotate").ok().and_then(|object| deref(document, object)) {
            return number(value).map(|rotate| rotate as i64).filter(|rotate| rotate % 90 == 0).map_or(0, |rotate| rotate.rem_euclid(360));
        }
        node = current.get(b"Parent").ok().and_then(|parent| dictionary(document, parent));
    }
    0
}

fn page_area(document: &Document, page_id: ObjectId) -> f64 {
    let media = page_box(document, page_id, b"MediaBox");
    let crop = page_box(document, page_id, b"CropBox");
    let visible = match (media, crop) {
        (Some(m), Some(c)) => Some([m[0].max(c[0]), m[1].max(c[1]), m[2].min(c[2]), m[3].min(c[3])]),
        (Some(b), None) | (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    visible
        .map(|b| (b[2] - b[0]).max(0.0) * (b[3] - b[1]).max(0.0))
        .filter(|area| area.is_finite() && *area > 1.0)
        .unwrap_or(DEFAULT_PAGE_AREA)
}

/// Resource dictionaries in lookup order (nearest first).
fn page_resources(document: &Document, page_id: ObjectId) -> Vec<&Dictionary> {
    let Ok((direct, ids)) = document.get_page_resources(page_id) else { return Vec::new() };
    let mut resources: Vec<&Dictionary> = direct.into_iter().collect();
    resources.extend(ids.into_iter().filter_map(|id| document.get_dictionary(id).ok()));
    resources
}

/// A composite (Type0) font, or a simple font with an Identity encoding, that has no ToUnicode map: its shown bytes are
/// glyph ids, so the page's extracted text is likely unreadable.
fn unmapped_font(document: &Document, font: &Dictionary) -> bool {
    if font.get(b"ToUnicode").is_ok() {
        return false;
    }
    let name_of = |key: &[u8]| match font.get(key).ok().and_then(|object| deref(document, object)).map(|(_, value)| value) {
        Some(Object::Name(value)) => Some(value.as_slice()),
        _ => None,
    };
    name_of(b"Subtype").is_some_and(|subtype| subtype == b"Type0")
        || name_of(b"Encoding").is_some_and(|encoding| encoding.starts_with(b"Identity"))
}

fn lookup_xobject<'a>(document: &'a Document, resources: &[&'a Dictionary], name: &[u8]) -> Option<(Option<ObjectId>, &'a Object)> {
    resources.iter().find_map(|resource| {
        let xobjects = resource.get(b"XObject").ok().and_then(|object| dictionary(document, object))?;
        xobjects.get(name).ok().and_then(|object| deref(document, object))
    })
}

fn inline_color_components(document:&Document,resources:&[&Dictionary],name:&[u8],depth:usize)->Option<usize>{
    if depth>8{return None;}
    match name{b"G"|b"DeviceGray"=>return Some(1),b"RGB"|b"DeviceRGB"=>return Some(3),b"CMYK"|b"DeviceCMYK"=>return Some(4),_=>{}}
    let value=resources.iter().find_map(|r|{
        let colors=dictionary(document,r.get(b"ColorSpace").ok()?)?;
        deref(document,colors.get(name).ok()?).map(|(_,v)|v)
    })?;
    match value{
        Object::Name(name)=>inline_color_components(document,resources,name,depth+1),
        Object::Array(values)=>match values.first()?.as_name().ok()?{
            b"CalGray"|b"Indexed"|b"I"=>Some(1),b"CalRGB"|b"Lab"=>Some(3),
            b"ICCBased"=>{
                let (_,Object::Stream(profile))=deref(document,values.get(1)?)? else{return None;};
                let n=usize::try_from(profile.dict.get(b"N").ok()?.as_i64().ok()?).ok()?;
                [1,3,4].contains(&n).then_some(n)
            }
            _=>None,
        },
        _=>None,
    }
}

struct PageReading {
    vector_bounds: Option<[f64;4]>,
    operations: usize,
    words: f64,
    lexical: Option<bool>,
    path_operations: usize,
    images: Vec<ImageUse>,
    exhausted: bool,
    failure_bits: u64,
    /// Text was shown in a font with no Unicode mapping.
    unmapped_text: bool,
    /// Visible page area in square points, and the visible box's width and height in points.
    area: f64,
    width: f64,
    height: f64,
    text: TextVolume,
    words_at: Vec<WordAt>,
    words_overflow: bool,
    rules: layout::RuleSet,
    /// The visible box in displayed coordinates.
    display_visible: [f64; 4],
    encoding: encoding::PageEncoding,
}

impl PageReading {
    fn totals(&self, repeated: &HashSet<ObjectId>) -> ImageTotals {
        PageStats { images: self.images.clone(), ..PageStats::default() }.totals(repeated)
    }

    /// Neither native words nor significant, non-repeated images.
    fn blank(&self, repeated: &HashSet<ObjectId>) -> bool {
        self.words == 0.0 && self.totals(repeated).count == 0
    }
}

fn classify_page(routing: &PageRasterRouting, document: &Document, page_id: ObjectId, forms: &mut FormCache) -> Option<PageReading> {
    classify_page_checked(routing, document, page_id, forms, false)
}

fn classify_page_checked(routing: &PageRasterRouting, document: &Document, page_id: ObjectId, forms: &mut FormCache, strict_validation: bool) -> Option<PageReading> {
    let limit = forms.stream_limit();
    let content = match document.get_page_content_with_limit(page_id, limit) {
        Ok(content) => content,
        Err(_) => { forms.charge(limit); return None; }
    };
    forms.charge(content.len());
    let resources = page_resources(document, page_id);
    let area = page_area(document, page_id);
    let visible = visible_box(document, page_id).unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let media = page_box(document, page_id, b"MediaBox").unwrap_or(visible);
    let bundled = crate::rules::Rules::bundled();
    let rules = &bundled.extraction;
    let limits = ExtractionLimitsCopy { tiny_points: rules.tiny_glyph_points, tiny_per_page: rules.tiny_glyphs_per_page };
    let mut stats = PageStats::default();
    stats.rules.eligible_only = strict_validation;
    let display = layout::DisplaySpace::new(media, visible, page_rotate(document, page_id));
    let mut context = Context { document, routing, forms, area, visible, media, limits, display, layout: &bundled.layout, encoding: &bundled.encoding, strict_validation };
    context.interpret(&content, &resources, IDENTITY, 0, &mut stats);
    if stats.exhausted && stats.text.chars > 0.0 {
        // A page with text that was not read to the end: estimate its glyphs from its own content stream's size (forms it
        // draws are not text), never fewer than counted. The font size histogram keeps only the glyphs measured.
        let estimated = content.len() as f64 / rules.estimated_content_bytes_per_glyph;
        if estimated > stats.text.chars {
            stats.text.lines = stats.text.lines.max((estimated / 80.0).ceil());
            stats.text.chars = estimated;
        }
        stats.text.estimated = true;
    }
    let (width, height) = ((visible[2] - visible[0]).max(0.0), (visible[3] - visible[1]).max(0.0));
    Some(PageReading { vector_bounds:stats.vector_bounds, operations: stats.operations, lexical: if stats.exhausted || stats.unmapped_text || stats.words.encoding_unknown { None } else { Some(stats.words.characters > 0.0) }, words: stats.words.words(), path_operations: stats.path_operations, images: stats.images, exhausted: stats.exhausted, failure_bits: stats.failure_bits, unmapped_text: stats.unmapped_text, area, width, height, text: stats.text, words_at: stats.words_at, words_overflow: stats.words_overflow, rules: stats.rules, display_visible: display.visible, encoding: stats.encoding })
}

/// The worker's drawn-content rule (`classify-route.ts`): a document with no extractable text anywhere whose bytes,
/// less embedded images, exceed the threshold per page holds text drawn as paths, and its pages go to vision.
fn drawn_document(routing: &PageRasterRouting, document: &Document, file_bytes: usize, pages: usize) -> bool {
    let image_bytes: usize = document
        .objects
        .values()
        .filter_map(|object| match object {
            Object::Stream(stream) => Some(stream),
            _ => None,
        })
        .filter(|stream| matches!(stream.dict.get(b"Subtype"), Ok(Object::Name(kind)) if kind == b"Image"))
        .map(|stream| stream.content.len())
        .sum();
    let drawn_per_page = file_bytes.saturating_sub(image_bytes) as f64 / pages.max(1) as f64;
    drawn_per_page >= routing.drawn_content_min_bytes_per_page
}

/// One image in the walker's terms (`pdf-layout-facts@1` `images[]`), for the cross-check and the page decision.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutImage {
    pub bbox: Option<[f64; 4]>,
    pub coverage: Option<f64>,
    pub width_px: f64,
    pub height_px: f64,
    pub ppi: [f64; 2],
    pub bytes_per_pixel: f64,
    pub bilevel: bool,
    pub repeated: bool,
    /// Text-layer words whose box centre lies inside the image's box; None when either is unknown.
    pub words_inside: Option<u32>,
}

/// One page's layout facts as the profiler measures them (the walker's fields it can reproduce).
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutPage {
    /// Native words (the worker's count), None when the page was not read to the end.
    pub words: Option<f64>,
    pub width_pt: f64,
    pub height_pt: f64,
    pub images: Vec<LayoutImage>,
    /// Ruled grids as (rows, columns, coverage); None when the page was not read to the end or had more rules than kept.
    pub grids: Option<Vec<(u32, u32, f64)>>,
    /// The union of the grid boxes as a share of the visible page (the walker adds the extractor's tables, which the
    /// profiler cannot see).
    pub grid_coverage: Option<f64>,
    /// `mixedScanImage`: Some(true) read, Some(false) not, None unknown (never read).
    pub scan_beside_text: Option<bool>,
    /// Table-heavy from the grids alone (a grid of `tableHeavyMinRows` rows, or grids covering `tableHeavyMinCoverage`).
    pub ruled_table_heavy: bool,
    pub glyphs_over_images: f64,
}

/// The walker's facts for one sampled page, and the two routing rules that read them.
fn page_layout(rules: &Rules, reading: &PageReading, repeated: &HashSet<ObjectId>) -> LayoutPage {
    let routing = &rules.page_raster_routing;
    let limits = &rules.layout;
    let words_known = !reading.exhausted && !reading.words_overflow;
    let images: Vec<LayoutImage> = reading.images.iter().map(|image| {
        let bbox = image.placement.map(|(bbox, _)| bbox);
        let words_inside = match (bbox, words_known) {
            (Some(b), true) => Some(reading.words_at.iter().filter(|w| w.x >= b[0] && w.x <= b[2] && w.y >= b[1] && w.y <= b[3]).count() as u32),
            _ => None,
        };
        LayoutImage {
            bbox,
            coverage: image.placement.map(|(_, coverage)| coverage),
            width_px: image.width_px,
            height_px: image.height_px,
            ppi: image.ppi,
            bytes_per_pixel: image.bytes_per_pixel,
            bilevel: image.bilevel,
            repeated: image.id.is_some_and(|id| repeated.contains(&id)),
            words_inside,
        }
    }).collect();
    let glyphs_over_images: f64 = reading.words_at.iter()
        .filter(|w| images.iter().any(|image| !image.repeated && image.bbox.is_some_and(|b| w.x >= b[0] && w.x <= b[2] && w.y >= b[1] && w.y <= b[3])))
        .map(|w| w.glyphs)
        .sum();
    // Scan beside native text: only on a page with at least the sparse-page word count.
    let scan_beside_text = if words_known && reading.words < routing.sparse_page_words {
        Some(false)
    } else {
        let candidate = |image: &&LayoutImage| {
            !image.repeated
                && image.coverage.is_some_and(|coverage| coverage >= routing.mixed_scan_min_coverage)
                && image.width_px.min(image.height_px) >= routing.mixed_scan_min_short_side_px
                && image.ppi[0].min(image.ppi[1]) >= routing.mixed_scan_min_ppi
                && (image.bilevel || image.bytes_per_pixel <= routing.scan_like_max_bytes_per_pixel)
        };
        let candidates: Vec<&LayoutImage> = images.iter().filter(candidate).collect();
        if candidates.iter().any(|image| image.words_inside.is_some_and(|inside| f64::from(inside) <= routing.mixed_scan_max_words_inside)) {
            if words_known { Some(true) } else { None }
        } else if candidates.iter().any(|image| image.words_inside.is_none()) || (!words_known && !candidates.is_empty()) {
            None
        } else {
            Some(false)
        }
    };
    let (grids, grid_coverage) = if reading.exhausted || reading.rules.overflow {
        (None, None)
    } else {
        let found = layout::ruled_grids(&reading.rules.rules, limits);
        let coverage = layout::union_coverage(&found.iter().map(|grid| grid.bbox).collect::<Vec<_>>(), reading.display_visible, limits.coverage_raster);
        let grids = found.iter()
            .map(|grid| (grid.rows, grid.columns, layout::union_coverage(&[grid.bbox], reading.display_visible, limits.coverage_raster)))
            .collect();
        (Some(grids), Some(coverage))
    };
    let tables = &rules.page_table_routing;
    let ruled_table_heavy = grids.as_ref().is_some_and(|grids: &Vec<(u32, u32, f64)>| grids.iter().any(|grid| grid.0 >= tables.table_heavy_min_rows))
        || grid_coverage.is_some_and(|coverage| coverage >= tables.table_heavy_min_coverage);
    LayoutPage {
        words: (!reading.exhausted).then_some(reading.words),
        width_pt: reading.display_visible[2] - reading.display_visible[0],
        height_pt: reading.display_visible[3] - reading.display_visible[1],
        images,
        grids,
        grid_coverage,
        scan_beside_text,
        ruled_table_heavy,
        glyphs_over_images,
    }
}

/// Every page's layout facts (up to the sample size), for the cross-check against the walker (`tests/layout_walker.rs`).
#[doc(hidden)]
pub fn layout_pages(bytes: &[u8]) -> Vec<LayoutPage> {
    let rules = Rules::bundled();
    let Ok(document) = Document::load_mem(bytes) else { return Vec::new() };
    let pages: Vec<ObjectId> = document.get_pages().into_values().collect();
    let mut forms = FormCache::default();
    let readings: Vec<PageReading> = pages.iter().take(rules.max_sampled_pages)
        .filter_map(|page| classify_page(&rules.page_raster_routing, &document, *page, &mut forms))
        .collect();
    let repeated = repeated_images(&rules.page_raster_routing, &readings);
    readings.iter().map(|reading| page_layout(rules, reading, &repeated)).collect()
}

/// `decidePageRaster` for the sampled page: a sparse page (fewer than `sparsePageWords` words) whose content is held by
/// significant, non-repeated images is a full-page raster (a scan or a photo of the page).
fn is_raster_page(routing: &PageRasterRouting, words: f64, images: &ImageTotals) -> bool {
    words < routing.sparse_page_words
        && ((words == 0.0
            && (images.largest >= routing.raster_page_min_largest_image_coverage || images.coverage >= routing.raster_page_min_total_image_coverage))
            || (words <= routing.stamp_text_max_words && images.largest >= routing.stamped_scan_min_image_coverage)
            || images.largest >= routing.sparse_text_full_page_image_coverage)
}

struct Context<'a, 'f> {
    strict_validation: bool,
    document: &'a Document,
    routing: &'a PageRasterRouting,
    forms: &'f mut FormCache,
    area: f64,
    /// The page's visible box (CropBox within MediaBox) and its MediaBox, in default user space.
    visible: [f64; 4],
    media: [f64; 4],
    limits: ExtractionLimitsCopy,
    display: layout::DisplaySpace,
    layout: &'a crate::rules::LayoutRules,
    encoding: &'a crate::rules::PageEncodingRules,
}

/// The extraction limits a page is read with (from the profiler rules).
#[derive(Clone, Copy)]
struct ExtractionLimitsCopy {
    tiny_points: f64,
    tiny_per_page: f64,
}

/// Lower bounds of the effective font size buckets, in points: under 1, 1-4, 4-6, 6-20, 20 and up.
const FONT_SIZE_BUCKETS: [f64; 5] = [0.0, 1.0, 4.0, 6.0, 20.0];

/// What a page's text adds up to, measured from its text-showing operators as extraction would read them.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct TextVolume {
    /// Glyphs shown (a two-byte string's pairs count once).
    chars: f64,
    /// Text lines started: a new text object, a line move or a next-line operator followed by shown text.
    lines: f64,
    /// Glyphs per effective font size bucket (FONT_SIZE_BUCKETS).
    by_size: [f64; 5],
    /// Glyphs in an invisible rendering mode (3 or 7).
    invisible: f64,
    /// Glyphs whose text position lies outside the visible box (inside the MediaBox: still extracted).
    off_crop: f64,
    /// Glyphs placed outside the MediaBox (extraction drops them), and tiny glyphs beyond the per-page limit.
    off_page: f64,
    tiny_dropped: f64,
    /// Tiny glyphs kept so far on the page.
    tiny_kept: f64,
    /// The page's text could not be read to the end; `chars` is estimated from its content size.
    estimated: bool,
}

/// The text state the volume needs: text matrices, leading, rendering mode, and whether a new line awaits its first glyph.
#[derive(Clone, Copy)]
struct TextState {
    matrix: Matrix,
    line: Matrix,
    leading: f64,
    render_mode: i64,
    new_line: bool,
    /// The last string shown ended inside a word: a kerned continuation (TJ) does not start a new one.
    word_open: bool,
    /// Horizontal displacement of TJ adjustments since the line's start, in text space: places runs for the encoding
    /// facts only (the word estimates above keep their own rule).
    kern: f64,
}

impl Default for TextState {
    fn default() -> Self {
        Self { matrix: IDENTITY, line: IDENTITY, leading: 0.0, render_mode: 0, new_line: true, word_open: false, kern: 0.0 }
    }
}

/// Glyphs in a shown string: pairs for a two-byte (CID) string, bytes otherwise (the word counter's rule).
fn glyph_count(bytes: &[u8]) -> f64 {
    let zero_high_bytes = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
    if bytes.len() >= 4 && zero_high_bytes * 2 >= bytes.len() / 2 { bytes.len() as f64 / 2.0 } else { bytes.len() as f64 }
}

impl<'a> Context<'a, '_> {
    /// Count a shown string into the page's text volume: its glyphs, the line it starts, their effective size, whether
    /// they are invisible or placed outside the visible box. The text position then advances by an estimate of the run's
    /// width (half an em a glyph), so a long run off the page edge is found.
    fn text_shown(&self, stats: &mut PageStats, text: &mut TextState, bytes: &[u8], font_size: f64, ctm: &Matrix) {
        let all = glyph_count(bytes);
        if all <= 0.0 {
            return;
        }
        let device = multiply(&text.matrix, ctm);
        if device.iter().any(|value|!value.is_finite()){stats.fail(2);return;}
        text.matrix = multiply(&[1.0, 0.0, 0.0, 1.0, all * 0.5 * font_size, 0.0], &text.matrix);
        let volume = &mut stats.text;
        let (x, y) = (device[4], device[5]);
        let inside = |b: [f64; 4]| x.is_finite() && y.is_finite() && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
        // Extraction drops glyphs placed outside the MediaBox: they are not text billing will measure.
        if !inside(self.media) {
            volume.off_page += all;
            return;
        }
        let scale = (device[0] * device[3] - device[1] * device[2]).abs().sqrt();
        let size = (font_size.abs() * scale).max(0.0);
        // Extraction keeps at most `tiny_per_page` tiny glyphs a page.
        let glyphs = if size < self.limits.tiny_points {
            let kept = all.min((self.limits.tiny_per_page - volume.tiny_kept).max(0.0));
            volume.tiny_kept += kept;
            volume.tiny_dropped += all - kept;
            kept
        } else {
            all
        };
        if glyphs <= 0.0 {
            return;
        }
        volume.chars += glyphs;
        // Words at their box centres: half an em a glyph along the baseline, a third of an em above it.
        let continues = text.word_open && bytes.first().is_some_and(|byte| !byte.is_ascii_whitespace());
        text.word_open = bytes.last().is_some_and(|byte| !byte.is_ascii_whitespace());
        for (index, (first, count)) in string_words(bytes, self.routing.unspaced_chars_per_word).into_iter().enumerate() {
            if index == 0 && continues {
                continue;
            }
            if stats.words_at.len() >= self.layout.max_words_per_page as usize {
                stats.words_overflow = true;
                break;
            }
            let u = (first as f64 + count as f64 / 2.0) * 0.5 * font_size;
            let v = 0.3 * font_size;
            let (ux, uy) = (u * device[0] + v * device[2] + device[4], u * device[1] + v * device[3] + device[5]);
            let (dx, dy) = self.display.point(ux, uy);
            let left=first as f64*0.5*font_size;let right=(first+count) as f64*0.5*font_size;
            let corners=[(left,-0.2*font_size),(right,-0.2*font_size),(right,0.8*font_size),(left,0.8*font_size)]
                .map(|(u,v)|self.display.point(u*device[0]+v*device[2]+device[4],u*device[1]+v*device[3]+device[5]));
            let width=corners.iter().map(|p|p.0).fold(f64::NEG_INFINITY,f64::max)-corners.iter().map(|p|p.0).fold(f64::INFINITY,f64::min);
            let height=corners.iter().map(|p|p.1).fold(f64::NEG_INFINITY,f64::max)-corners.iter().map(|p|p.1).fold(f64::INFINITY,f64::min);
            if !width.is_finite() || !height.is_finite() || width<=0.0 || height<=0.0{stats.words_overflow=true;continue;}
            stats.words_at.push(WordAt { x: dx, y: dy, glyphs: count as f64, width,height });
        }
        // The run for the encoding facts: its baseline start (with TJ adjustments) and estimated end, displayed.
        let start = multiply(&multiply(&[1.0, 0.0, 0.0, 1.0, text.kern, 0.0], &multiply(&[1.0, 0.0, 0.0, 1.0, -all * 0.5 * font_size, 0.0], &text.matrix)), ctm);
        let end = multiply(&[1.0, 0.0, 0.0, 1.0, all * 0.5 * font_size, 0.0], &start);
        let (a, b) = (self.display.point(start[4], start[5]), self.display.point(end[4], end[5]));
        stats.encoding.shown(encoding::Run { x0: a.0.min(b.0), x1: a.0.max(b.0), y: a.1, size, math: false, symbol: false, unmapped: false, glyphs: 0.0 }, glyphs);
        let volume = &mut stats.text;
        if text.new_line {
            volume.lines += 1.0;
            text.new_line = false;
        }
        let bucket = FONT_SIZE_BUCKETS.iter().rposition(|bound| size >= *bound).unwrap_or(0);
        volume.by_size[bucket] += glyphs;
        if matches!(text.render_mode, 3 | 7) {
            volume.invisible += glyphs;
        }
        if !inside(self.visible) {
            volume.off_crop += glyphs;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn record_image(&self, stats: &mut PageStats, id: Option<ObjectId>, ctm: &Matrix, width: f64, height: f64, stream_bytes: usize, bilevel: bool, lossy: bool) {
        let placement = self.display.placement(ctm);
        let placed = (ctm[0] * ctm[3] - ctm[1] * ctm[2]).abs();
        let coverage = (placed / self.area).min(1.0);
        let significant = coverage.is_finite()
            && coverage >= self.routing.min_significant_image_coverage
            && width.min(height) >= self.routing.min_significant_image_pixels;
        if let Some((bbox, _)) = placement {
            stats.encoding.image(self.encoding, id, bbox, self.display.visible, (width, height), significant, lossy);
        }
        if !significant {
            return;
        }
        // Pixels per inch as placed on each axis, rounded as `pdfimages -list` prints them.
        let x_ppi = (width / ((ctm[0].hypot(ctm[1])) / 72.0).max(1e-9)).round();
        let y_ppi = (height / ((ctm[2].hypot(ctm[3])) / 72.0).max(1e-9)).round();
        let bytes_per_pixel = if width * height > 0.0 { stream_bytes as f64 / (width * height) } else { 0.0 };
        let image = ImageUse { id, coverage, placement, width_px: width, height_px: height, ppi: [x_ppi, y_ppi], bytes_per_pixel, bilevel };
        if stats.images.len() < MAX_TRACKED_IMAGES_PER_PAGE {
            stats.images.push(image);
        } else if let Some(smallest) = stats.images.iter_mut().min_by(|a, b| a.coverage.total_cmp(&b.coverage)) {
            stats.exhausted = true;
            stats.failure_bits |= 512;
            // A page of hundreds of images keeps the largest ones: they decide the class.
            if coverage > smallest.coverage {
                *smallest = image;
            }
        }
    }

    /// A bilevel or fax image: a CCITT or JBIG2 filter, 1 bit per component, or an image mask.
    fn bilevel(&self, dict: &Dictionary, filter_keys: &[&[u8]], bpc_keys: &[&[u8]], mask_keys: &[&[u8]]) -> bool {
        let value = |keys: &[&[u8]]| keys.iter().find_map(|key| dict.get(key).ok().and_then(|object| deref(self.document, object)).map(|(_, value)| value));
        let fax = |name: &[u8]| matches!(name, b"CCITTFaxDecode" | b"CCF" | b"JBIG2Decode");
        let filtered = match value(filter_keys) {
            Some(Object::Name(name)) => fax(name),
            Some(Object::Array(filters)) => filters.iter().any(|filter| matches!(filter, Object::Name(name) if fax(name))),
            _ => false,
        };
        let one_bit = value(bpc_keys).and_then(number).is_some_and(|bits| bits == 1.0);
        let mask = matches!(value(mask_keys), Some(Object::Boolean(true)));
        filtered || one_bit || mask
    }

    /// A lossy image encoding (JPEG, JPEG 2000): photographs, rarely rendered tables.
    fn lossy(&self, dict: &Dictionary, filter_keys: &[&[u8]]) -> bool {
        let lossy = |name: &[u8]| matches!(name, b"DCTDecode" | b"DCT" | b"JPXDecode");
        match filter_keys.iter().find_map(|key| dict.get(key).ok().and_then(|object| deref(self.document, object)).map(|(_, value)| value)) {
            Some(Object::Name(name)) => lossy(name),
            Some(Object::Array(filters)) => filters.iter().any(|filter| matches!(filter, Object::Name(name) if lossy(name))),
            _ => false,
        }
    }

    /// The class of font resource `name` (`encoding::font_class`, with `FONT_UNMAPPED` from `unmapped_font`), cached per
    /// font dictionary so a page switching fonts reads each once. Its stream reads come out of the encoding facts' own
    /// budget; once that or the cache is spent, a font is still classified by name, and one that would need a read is
    /// unknown.
    fn font_class(&mut self, resources: &[&Dictionary], name: &[u8]) -> u8 {
        let found = resources.iter().find_map(|resource| {
            let fonts = resource.get(b"Font").ok().and_then(|object| dictionary(self.document, object))?;
            fonts.get(name).ok().and_then(|object| dictionary(self.document, object))
        });
        let Some(font) = found else { return 0 };
        let key = font as *const Dictionary as usize;
        if let Some(class) = self.forms.fonts.get(&key) {
            return *class as u8;
        }
        let unmapped = unmapped_font(self.document, font);
        let cacheable = self.forms.fonts.len() < MAX_CACHED_FONTS;
        // Detail and range sessions (strict validation) do not report encoding facts: they classify by name only and
        // read no font program or glyph procedure.
        let reads = cacheable && !self.strict_validation;
        let mut budget = encoding::Budget::new(if reads { self.forms.encoding_budget() } else { 0 });
        let left = budget.left;
        let class = encoding::font_class(self.document, font, unmapped, &mut budget, &mut self.forms.streams);
        if cacheable {
            self.forms.encoding_spend(left - budget.left);
            self.forms.fonts.insert(key, usize::from(class));
        }
        class
    }

    fn image_size(&self, dict: &Dictionary, width_key: &[u8], height_key: &[u8]) -> (f64, f64) {
        let read = |key: &[u8]| {
            dict.get(key).ok().and_then(|object| deref(self.document, object)).and_then(|(_, value)| number(value)).unwrap_or(0.0)
        };
        (read(width_key), read(height_key))
    }

    fn interpret(&mut self, content: &[u8], resources: &[&'a Dictionary], base: Matrix, depth: u32, stats: &mut PageStats) {
        if !stats.charge_bytes(content.len()) {
            return;
        }
        let normalized = if self.strict_validation && content.windows(2).any(|w| w == b"BI") {
            inline::normalize_inline_images(content, &mut stats.inline_budget, &|name| inline_color_components(self.document, resources, name, 0))
        } else { None };
        if let Some(ref normalized) = normalized {
            if !stats.charge_bytes(normalized.content.len()) { return; }
        }
        let content = normalized.as_ref().map(|n|n.content.as_slice()).unwrap_or(content);
        let mut inline_index = 0usize;
        let mut ctm = base;
        // The graphics state q/Q saves: the transformation, the line width and the encoding facts' font class (a form or
        // a q/Q block selecting a math font does not make the text after it math).
        let mut stack: Vec<(Matrix, f64, u8)> = Vec::new();
        let mut line_width = 1.0_f64;
        let mut path = layout::PathBuilder::default();
        if self.strict_validation { path.detailed_min_length = Some(self.layout.rule_min_length_pt); }
        let mut font_size = 12.0;
        let mut font_unmapped = false;
        // The path under construction for the encoding facts: its curves and displayed box.
        let mut path_curves = 0u32;
        let mut path_box: Option<[f64; 4]> = None;
        let mut text = TextState::default();
        for operation in Content::decode_iter(content) {
            let Ok(operation) = operation else { stats.fail(4); break };
            stats.operations += 1;
            if stats.operations > MAX_OPERATIONS_PER_PAGE {
                stats.fail(8);
                return;
            }
            let operands = &operation.operands;
            match operation.operator.as_str() {
                "q" if stack.len() < 256 => stack.push((ctm, line_width, stats.encoding.font)),
                // A save past the stack, or a restore with nothing saved, leaves the font in force unknown.
                "q" => stats.encoding.unknown = true,
                "Q" => match stack.pop() {
                    Some(saved) => (ctm, line_width, stats.encoding.font) = saved,
                    None => { (ctm, line_width) = (base, line_width); stats.encoding.unknown = true; }
                },
                "w" => line_width = operands.first().and_then(number).filter(|width| width.is_finite()).unwrap_or(line_width),
                "cm" => {
                    if let Some(matrix) = matrix_from(operands) {
                        ctm = multiply(&matrix, &ctm);
                    }
                }
                "BT" => {
                    stats.words.gap();
                    text = TextState { render_mode: text.render_mode, leading: text.leading, ..TextState::default() };
                }
                "ET" => stats.words.gap(),
                "T*" => {
                    stats.words.gap();
                    text.word_open = false;
                    text.line = multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, -text.leading], &text.line);
                    text.matrix = text.line;
                    text.kern = 0.0;
                    text.new_line = true;
                }
                "Tm" => {
                    stats.words.gap();
                    text.word_open = false;
                    if let Some(matrix) = matrix_from(operands) {
                        if (matrix[5] - text.line[5]).abs() > 0.01 || (matrix[3] - text.line[3]).abs() > 0.01 {
                            text.new_line = true;
                        }
                        text.line = matrix;
                        text.matrix = matrix;
                        text.kern = 0.0;
                    }
                }
                "TL" => text.leading = operands.first().and_then(number).unwrap_or(text.leading),
                "Tr" => text.render_mode = operands.first().and_then(number).map(|mode| mode as i64).unwrap_or(text.render_mode),
                "Tf" => {
                    font_size = operands.get(1).and_then(number).unwrap_or(font_size);
                    if let Some(Object::Name(name)) = operands.first() {
                        let class = self.font_class(resources, name);
                        font_unmapped = class & encoding::FONT_UNMAPPED != 0;
                        stats.encoding.font = class;
                    }
                }
                "Td" | "TD" => {
                    let tx = operands.first().and_then(number).unwrap_or(0.0);
                    text.word_open = false;
                    let ty = operands.get(1).and_then(number).unwrap_or(0.0);
                    stats.words.moved(tx, ty, font_size);
                    if operation.operator == "TD" {
                        text.leading = -ty;
                    }
                    text.line = multiply(&[1.0, 0.0, 0.0, 1.0, tx, ty], &text.line);
                    text.matrix = text.line;
                    text.kern = 0.0;
                    if ty.abs() > 0.01 {
                        text.new_line = true;
                    }
                }
                "Tj" => {
                    if let Some(Object::String(bytes, _)) = operands.last() {
                        stats.words.show(bytes);
                        stats.unmapped_text |= font_unmapped && !bytes.is_empty();
                        self.text_shown(stats, &mut text, bytes, font_size, &ctm);
                    }
                }
                "'" | "\"" => {
                    stats.words.gap();
                    text.word_open = false;
                    text.line = multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, -text.leading], &text.line);
                    text.matrix = text.line;
                    text.kern = 0.0;
                    text.new_line = true;
                    if let Some(Object::String(bytes, _)) = operands.last() {
                        stats.words.show(bytes);
                        stats.unmapped_text |= font_unmapped && !bytes.is_empty();
                        self.text_shown(stats, &mut text, bytes, font_size, &ctm);
                    }
                }
                "TJ" => {
                    if let Some(Object::Array(parts)) = operands.first() {
                        for part in parts {
                            match part {
                                Object::String(bytes, _) => {
                                    stats.words.show(bytes);
                                    stats.unmapped_text |= font_unmapped && !bytes.is_empty();
                                    self.text_shown(stats, &mut text, bytes, font_size, &ctm);
                                }
                                // A large negative adjustment is a word gap in kerned text.
                                other if number(other).is_some_and(|gap| gap <= -200.0) => {
                                    stats.words.gap();
                                    text.word_open = false;
                                    text.kern -= number(other).unwrap_or(0.0) / 1000.0 * font_size;
                                }
                                other => text.kern -= number(other).unwrap_or(0.0) / 1000.0 * font_size,
                            }
                        }
                    }
                }
                "re" | "m" | "l" | "c" | "v" | "y" => {
                    stats.path_operations += 1;
                    let values: Vec<f64> = operands.iter().filter_map(number).collect();
                    let shown = |x: f64, y: f64| {
                        let (ux, uy) = (x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]);
                        self.display.point(ux, uy)
                    };
                    let points:Vec<_>=if operation.operator=="re" && values.len()==4 {
                        let (x,y,w,h)=(values[0],values[1],values[2],values[3]);vec![shown(x,y),shown(x+w,y),shown(x+w,y+h),shown(x,y+h)]
                    }else{values.chunks_exact(2).map(|xy|shown(xy[0],xy[1])).collect()};
                    if matches!(operation.operator.as_str(), "c" | "v" | "y") { path_curves = path_curves.saturating_add(1); }
                    for (x,y) in points {
                        if x.is_finite() && y.is_finite() {
                            path_box = Some(match path_box { Some(b) => [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)], None => [x, y, x, y] });
                            stats.vector_bounds=Some(match stats.vector_bounds {Some(b)=>[b[0].min(x),b[1].min(y),b[2].max(x),b[3].max(y)],None=>[x,y,x,y]});
                        }else{stats.fail(2);}
                    }
                    match (operation.operator.as_str(), values.as_slice()) {
                        ("m", [x, y]) => path.move_to(shown(*x, *y)),
                        ("l", [x, y]) => path.line_to(shown(*x, *y)),
                        ("c", [.., x, y]) | ("v", [.., x, y]) | ("y", [.., x, y]) => path.curve_to(shown(*x, *y)),
                        ("re", [x, y, w, h]) => path.rectangle([shown(*x, *y), shown(x + w, *y), shown(x + w, y + h), shown(*x, y + h)]),
                        _ => {}
                    }
                }
                "h" => path.close(),
                "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n" => {
                    let op = operation.operator.as_str();
                    if matches!(op, "s" | "b" | "b*") {
                        path.close();
                    }
                    let stroke = matches!(op, "S" | "s" | "B" | "B*" | "b" | "b*");
                    let fill = matches!(op, "f" | "F" | "f*" | "B" | "B*" | "b" | "b*");
                    // The line's width as drawn: scaled by the transformation in force.
                    let width = line_width.abs() * (ctm[0] * ctm[3] - ctm[1] * ctm[2]).abs().sqrt();
                    path.paint(stroke, fill, width, self.display.visible, &mut stats.rules, self.layout);
                    stats.encoding.painted(fill, path_curves, path_box.take(), self.encoding);
                    path_curves = 0;
                }
                "BDC" => {
                    // Marked content with replacement text: inline properties or a named /Properties resource.
                    let properties = match operands.get(1) {
                        Some(Object::Dictionary(dict)) => Some(dict),
                        Some(Object::Name(name)) => resources.iter().find_map(|resource| {
                            dictionary(self.document, resource.get(b"Properties").ok()?)?.get(name).ok().and_then(|object| dictionary(self.document, object))
                        }),
                        _ => None,
                    };
                    if let Some(Object::String(text, _)) = properties.and_then(|dict| dict.get(b"ActualText").ok()).and_then(|object| deref(self.document, object)).map(|(_, value)| value) {
                        stats.encoding.actual_text(text);
                    }
                }
                "BI" => {
                    if let Some(Object::Stream(image)) = operands.first() {
                        let (mut width, mut height) = self.image_size(&image.dict, b"W", b"H");
                        if width == 0.0 {
                            (width, height) = self.image_size(&image.dict, b"Width", b"Height");
                        }
                        let bilevel = self.bilevel(&image.dict, &[b"F", b"Filter"], &[b"BPC", b"BitsPerComponent"], &[b"IM", b"ImageMask"]);
                        let lossy = self.lossy(&image.dict, &[b"F", b"Filter"]);
                        let stored = normalized.as_ref().and_then(|n|n.stored_lengths.get(inline_index)).copied().unwrap_or(image.content.len());
                        self.record_image(stats, None, &ctm, width, height, stored, bilevel, lossy);
                    }
                    inline_index += 1;
                }
                "Do" => {
                    let Some(Object::Name(name)) = operands.first() else { continue };
                    let Some((id, Object::Stream(xobject))) = lookup_xobject(self.document, resources, name) else { stats.fail(16); continue };
                    let subtype = xobject.dict.get(b"Subtype").ok().and_then(|object| deref(self.document, object)).map(|(_, value)| value);
                    match subtype {
                        Some(Object::Name(kind)) if kind == b"Image" => {
                            let (width, height) = self.image_size(&xobject.dict, b"Width", b"Height");
                            let bilevel = self.bilevel(&xobject.dict, &[b"Filter"], &[b"BitsPerComponent"], &[b"ImageMask"]);
                            let lossy = self.lossy(&xobject.dict, &[b"Filter"]);
                            self.record_image(stats, id, &ctm, width, height, xobject.content.len(), bilevel, lossy);
                        }
                        Some(Object::Name(kind)) if kind == b"Form" && depth < MAX_FORM_DEPTH => {
                            stats.form_calls += 1;
                            if stats.form_calls > MAX_FORM_CALLS_PER_PAGE {
                                stats.fail(32);
                                return;
                            }
                            // A direct (unreferenced) form stream cannot be cached; it is decompressed per call,
                            // still bounded by the per-page byte budget.
                            let form_content = match id {
                                Some(id) => self.forms.get(id, xobject),
                                None => self.forms.decompress(xobject),
                            };
                            let Some(form_content) = form_content else { stats.fail(64); continue };
                            let matrix = xobject
                                .dict
                                .get(b"Matrix")
                                .ok()
                                .and_then(|object| match deref(self.document, object) {
                                    Some((_, Object::Array(values))) => matrix_from(values),
                                    _ => None,
                                })
                                .unwrap_or(IDENTITY);
                            let own = xobject.dict.get(b"Resources").ok().and_then(|object| dictionary(self.document, object));
                            let mut form_resources: Vec<&Dictionary> = own.into_iter().collect();
                            form_resources.extend_from_slice(resources);
                            // A form runs in its own saved graphics state (`Do` wraps it in q/Q).
                            let font_before = stats.encoding.font;
                            self.interpret(&form_content, &form_resources, multiply(&matrix, &ctm), depth + 1, stats);
                            stats.encoding.font = font_before;
                            if stats.exhausted {
                                return;
                            }
                        }
                        Some(Object::Name(kind)) if kind == b"Form" => { stats.fail(128); }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        // Verify complete consumption without collecting a page's operations.
        if self.strict_validation && !stats.exhausted {
            let failure = strict_content_failure(content);
            if failure != 0 && !(failure == 2 && normalized.is_some() && strict_inline_content_complete(content)) {
                stats.fail(256 | (failure << 16));
            }
        }
    }
}

fn strict_content_failure(content:&[u8])->u64 {
    use otf_pdf_syntax::{parser::Parser,lexer::Token,Limits,Strictness};
    let limits=Limits{max_depth:32,max_object_size:MAX_STREAM_BYTES as u64,..Limits::default()};
    let mut parser=Parser::new(content,0,&limits,Strictness::Strict);
    let mut operands=0usize;
    let mut compatibility=0usize;
    for _ in 0..1_000_000 {
        let at=parser.lexer().pos();
        let token=match parser.lexer().next_token(){Ok(token)=>token,Err(_)=>return 1};
        match token {
            Token::Eof=>return if operands==0 && compatibility==0 {0} else {1},
            // Inline binary data cannot be validated by the syntax lexer alone.
            Token::Keyword(b"BI"|b"ID"|b"EI"|b"obj"|b"endobj"|b"stream"|b"endstream")=>return 2,
            Token::Keyword(word) if !matches!(word,b"true"|b"false"|b"null")=>{
                if word==b"BX"{compatibility+=1;if compatibility>256{return 1;}}
                else if word==b"EX"{if compatibility==0{return 1;}compatibility-=1;}
                else if compatibility==0 && !matches!(word,b"q"|b"Q"|b"cm"|b"w"|b"J"|b"j"|b"M"|b"d"|b"ri"|b"i"|b"gs"|b"m"|b"l"|b"c"|b"v"|b"y"|b"h"|b"re"|b"S"|b"s"|b"f"|b"F"|b"f*"|b"B"|b"B*"|b"b"|b"b*"|b"n"|b"W"|b"W*"|b"BT"|b"ET"|b"Tc"|b"Tw"|b"Tz"|b"TL"|b"Tf"|b"Tr"|b"Ts"|b"Td"|b"TD"|b"Tm"|b"T*"|b"Tj"|b"TJ"|b"'"|b"\""|b"d0"|b"d1"|b"CS"|b"cs"|b"SC"|b"SCN"|b"sc"|b"scn"|b"G"|b"g"|b"RG"|b"rg"|b"K"|b"k"|b"sh"|b"Do"|b"MP"|b"DP"|b"BMC"|b"BDC"|b"EMC"){return 3;}
                operands=0;
            }
            _=>{parser.lexer().set_pos(at);if parser.parse_object().is_err(){return 1;}operands+=1;if operands>1024{return 1;}}
        }
    }
    1
}

#[cfg(test)]
fn strict_content_complete(content:&[u8])->bool {
    let failure = strict_content_failure(content);
    failure == 0
}

/// Use the existing public strict grammar for small inline-image streams, where
/// a token-only verifier cannot skip binary payloads. Unsupported inline data
/// yields a BI without a Stream in lopdf's recovery path: explicitly refuse it.
/// Normalize only the non-image operations and verify their entire syntax too.
fn strict_inline_content_complete(content: &[u8]) -> bool {
    if content.len() > 256 * 1024 { return false; }
    let Ok(mut decoded) = Content::decode_strict(content) else { return false; };
    let mut saw_image = false;
    for op in &decoded.operations {
        if op.operator == "BI" {
            if !matches!(op.operands.as_slice(), [Object::Stream(_)]) { return false; }
            saw_image = true;
        }
    }
    if !saw_image { return false; }
    decoded.operations.retain(|op| op.operator != "BI");
    let Ok(encoded) = decoded.encode() else { return false; };
    encoded.len() <= MAX_STREAM_BYTES && strict_content_failure(&encoded) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimated_word_boxes_follow_page_rotation_and_anisotropic_text_transforms() {
        let reading=|rotate:i64,prefix:&str|{
            let mut document=Document::with_version("1.7");
            let content=document.add_object(lopdf::Stream::new(Dictionary::new(),format!("{prefix} BT 1 0 0 1 100 100 Tm (abcdef) Tj ET").into_bytes()));
            let mut dict=Dictionary::new();dict.set("Type",Object::Name(b"Page".to_vec()));dict.set("MediaBox",Object::Array(vec![0.into(),0.into(),612.into(),792.into()]));dict.set("Rotate",rotate);dict.set("Contents",content);
            let page=document.add_object(dict);classify_page_checked(&routing(),&document,page,&mut FormCache::default(),true).unwrap()
        };
        let normal=reading(0,"");let rotated=reading(90,"");let scaled=reading(0,"2 0 0 0.5 0 0 cm");
        assert!((normal.words_at[0].width-36.0).abs()<1e-6);assert!((normal.words_at[0].height-12.0).abs()<1e-6);
        assert!((rotated.words_at[0].width-12.0).abs()<1e-6);assert!((rotated.words_at[0].height-36.0).abs()<1e-6);
        assert!((scaled.words_at[0].width-72.0).abs()<1e-6);assert!((scaled.words_at[0].height-6.0).abs()<1e-6);
    }

    #[test]
    fn strict_streaming_verification_accepts_large_streams_and_refuses_malformed_tails() {
        assert!(!strict_content_complete(b"q BI /W 2 /H 1 /BPC 8 /CS /G ID EI\nEI Q"));
        assert!(!strict_content_complete(b"BI /W 0 /H 1 /BPC 8 /CS /G ID \nEI"));
        assert!(!strict_content_complete(b"BI /W 1 /H 1 /BPC 0 /CS /G ID \nEI"));
        assert!(!strict_content_complete(b"BI /W 1 /H 1 /BPC 8 /CS /G IDxEI Q"));
        assert!(!strict_content_complete(b"BI /W 1 /Width 2 /H 1 /BPC 8 /CS /G ID x EI"));
        assert!(!strict_content_complete(b"BI /W 2 /H 1 /BPC 8 /CS /G ID E"));
        assert!(!strict_content_complete(b"BI /W 0 /H 1 /BPC 8 /CS /G ID x EI"));
        assert!(!strict_content_complete(b"BI /W 1 /H 1 /BPC 8 /CS /G /F /Fl ID x EI"));
        assert!(!strict_content_complete(b"BI /W 1 /H 1 /BPC 8 /CS /G ID x EI unknownOperator"));
        assert!(strict_content_complete(&b"q Q\n".repeat(70000)));
        assert!(!strict_content_complete(b"q Q (unterminated"));
        assert!(!strict_content_complete(b"q Q unknownOperator"));
        assert!(strict_content_complete(b"BX unknownOperator EX"));
    }

    fn routing() -> PageRasterRouting {
        Rules::bundled().page_raster_routing.clone()
    }

    #[test]
    fn lexical_presence_is_not_whitespace_word_count() {
        let mut punctuation = WordCounter::default();
        punctuation.show(b"---");
        assert_eq!(punctuation.characters, 0.0);
        let mut digit = WordCounter::default();
        digit.show(b"7");
        assert_eq!(digit.characters, 1.0);
        let mut encoded = WordCounter::default();
        encoded.show(&[0, 7, 0, 8]);
        assert!(encoded.encoding_unknown);
    }

    #[test]
    fn finds_names_with_escapes_and_ignores_prefixes() {
        assert!(has_name(b"<< /Encrypt 5 0 R >>", b"Encrypt"));
        assert!(has_name(b"<</Encr#79pt 5 0 R>>", b"Encrypt"));
        assert!(has_name(b"<< /Encrypt\x005 0 R >>", b"Encrypt"));
        assert!(!has_name(b"<< /Encrypted true /EncryptMetadata false >>", b"Encrypt"));
        assert!(!has_name(b"(no names here)", b"Encrypt"));
    }

    /// A classic-xref PDF of `pages` text pages and `filler` small objects, its trailer declaring `size` objects.
    fn many_objects(pages: usize, filler: usize, size: Option<usize>) -> Vec<u8> {
        let mut out = b"%PDF-1.7\n".to_vec();
        let mut offsets = vec![0usize];
        let mut put = |out: &mut Vec<u8>, number: usize, body: &str| {
            offsets.push(out.len());
            out.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
        };
        let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", 3 + 2 * i)).collect();
        put(&mut out, 1, "<< /Type /Catalog /Pages 2 0 R >>");
        put(&mut out, 2, &format!("<< /Type /Pages /Kids [{}] /Count {pages} >>", kids.join(" ")));
        for i in 0..pages {
            let content = "BT /F1 12 Tf 72 720 Td (Revenue beat the forecast.) Tj ET";
            put(&mut out, 3 + 2 * i, &format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {} 0 R >>", 4 + 2 * i));
            put(&mut out, 4 + 2 * i, &format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()));
        }
        for i in 0..filler {
            put(&mut out, 3 + 2 * pages + i, &format!("<< /A {i} >>"));
        }
        let count = offsets.len();
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {count}\n0000000000 65535 f \n").as_bytes());
        for offset in &offsets[1..] {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", size.unwrap_or(count)).as_bytes());
        out
    }

    #[test]
    fn reads_the_largest_declared_object_count() {
        assert_eq!(declared_objects(b"trailer << /Size 12 /Root 1 0 R >>"), 12);
        // Incremental updates repeat /Size; the largest counts. Arrays (function dictionaries) are not counts.
        assert_eq!(declared_objects(b"<< /Size 9 >> << /Size [2 2] >> << /Size\r\n 40 /Root 1 0 R >>"), 40);
        assert_eq!(declared_objects(b"<< /Type /XRef /Size 754193 /W [1 4 2] >>"), 754_193);
        assert_eq!(declared_objects(b"no counts here /Siz"), 0);
        // At most ten digits are read, so an absurd count cannot overflow; it only sends the file down the bounded path.
        assert!(declared_objects(b"<< /Size 99999999999999999999999 >>") > 1_000_000);
    }

    #[test]
    fn loads_documents_whose_objects_fit_and_reads_only_the_page_tree_of_bigger_ones() {
        let small = many_objects(3, 100, None);
        assert!(whole_load_fits(&small));
        let fits = probe(Rules::bundled(), &ProbeInput::whole("a.pdf", None, &small));
        assert_eq!(fits.pages, Some(3.0));
        assert!(fits.pdf.is_some());
        // Declares more objects than a whole load may take: page count from the page tree, no page facts.
        let declared = many_objects(3, 100, Some(500_000));
        assert!(!whole_load_fits(&declared));
        let bounded = probe(Rules::bundled(), &ProbeInput::whole("b.pdf", None, &declared));
        assert_eq!(bounded.pages, Some(3.0));
        assert!(bounded.pdf.is_none());
        assert!(bounded.notes.iter().any(|note| note.contains("too many objects")), "{:?}", bounded.notes);
        assert!(bounded.notes.iter().any(|note| note.contains("page tree")), "{:?}", bounded.notes);
        // The host's retry after a trap asks for the bounded path whatever the file declares.
        let retry = probe(Rules::bundled(), &ProbeInput { bounded: true, ..ProbeInput::whole("c.pdf", None, &small) });
        assert_eq!(retry.pages, Some(3.0));
        assert!(retry.pdf.is_none());
        assert!(retry.notes.iter().any(|note| note.contains("retried without loading")), "{:?}", retry.notes);
    }

    #[test]
    fn falls_back_to_raw_page_objects_when_the_page_tree_cannot_be_read() {
        // A startxref pointing nowhere: no xref the bounded reader can follow, but the page objects are still there.
        let whole = many_objects(2, 10, Some(900_000));
        let at = whole.windows(10).rposition(|window| window == b"startxref\n").unwrap() + 10;
        let mut broken = whole[..at].to_vec();
        broken.extend_from_slice(b"7\n%%EOF\n");
        let result = probe(Rules::bundled(), &ProbeInput::whole("t.pdf", None, &broken));
        assert_eq!(result.pages, Some(2.0));
        assert!(result.notes.iter().any(|note| note.contains("raw page objects")), "{:?}", result.notes);
    }

    #[test]
    fn samples_evenly_with_both_ends() {
        assert_eq!(sample_indices(5, 24), vec![0, 1, 2, 3, 4]);
        let sample = sample_indices(1000, 24);
        assert_eq!(sample.len(), 24);
        assert_eq!((sample[0], sample[23]), (0, 999));
    }

    #[test]
    fn applies_the_page_raster_rule_like_the_worker_router() {
        let routing = routing();
        let images = |count: usize, largest: f64, total: f64| ImageTotals { count, coverage: total, largest };
        assert!(is_raster_page(&routing, 0.0, &images(1, 0.9, 0.9)));
        assert!(is_raster_page(&routing, 8.0, &images(1, 0.6, 0.6)));
        assert!(is_raster_page(&routing, 25.0, &images(1, 0.9, 0.9)));
        // A caption-sized amount of text over a mid-size image is not a full-page raster.
        assert!(!is_raster_page(&routing, 25.0, &images(1, 0.6, 0.6)));
        assert!(!is_raster_page(&routing, 400.0, &images(1, 0.9, 0.9)));
        assert!(!is_raster_page(&routing, 0.0, &images(0, 0.0, 0.0)));
        // Minor images alone never make a raster page.
        assert!(!is_raster_page(&routing, 0.0, &images(1, 0.1, 0.1)));
        assert!(!is_raster_page(&routing, 0.0, &images(4, 0.1, 0.34)));
        assert!(is_raster_page(&routing, 0.0, &images(4, 0.1, 0.36)));
    }

    #[test]
    fn buckets_words_and_coverage_on_the_rules_edges() {
        let rules = Rules::bundled();
        let words = |value: f64| bucket(&rules.words_per_page_buckets, value, WORDS_BUCKETS);
        assert_eq!([words(0.0), words(1.0), words(10.0), words(11.0), words(29.0), words(30.0), words(499.0), words(500.0), words(1e9)], [0, 1, 1, 2, 2, 3, 4, 5, 5]);
        let coverage = |value: f64| coverage_bucket(&rules.image_coverage_buckets, value);
        assert_eq!([coverage(0.0), coverage(0.01), coverage(0.15), coverage(0.49), coverage(0.5), coverage(0.9), coverage(1.0), coverage(f64::NAN)], [0, 1, 2, 2, 3, 4, 4, 0]);
    }

    #[test]
    fn drops_images_drawn_on_many_pages_as_page_furniture() {
        let routing = routing();
        let id = |number: u32| (number, 0);
        let page = |ids: &[u32]| PageReading {
            vector_bounds:None,
            operations: 0,
            words: 0.0,
            lexical: Some(false),
            path_operations: 0,
            images: ids.iter().map(|number| ImageUse::plain(Some(id(*number)), 0.9)).collect(),
            exhausted: false,
            failure_bits: 0,
            unmapped_text: false,
            area: DEFAULT_PAGE_AREA,
            width: 612.0,
            height: 792.0,
            text: TextVolume::default(),
            words_at: Vec::new(),
            words_overflow: false,
            rules: layout::RuleSet::default(),
            display_visible: [0.0, 0.0, 612.0, 792.0],
            encoding: encoding::PageEncoding::default(),
        };
        // The same full-bleed background on four pages: furniture, so the pages are blank.
        let slides = vec![page(&[7]), page(&[7]), page(&[7]), page(&[7])];
        let repeated = repeated_images(&routing, &slides);
        assert!(repeated.contains(&id(7)));
        assert!(slides.iter().all(|reading| reading.blank(&repeated)));
        // A different image on every page is a scan on every page.
        let scans = vec![page(&[1]), page(&[2]), page(&[3]), page(&[4])];
        let repeated = repeated_images(&routing, &scans);
        assert!(repeated.is_empty());
        assert!(scans.iter().all(|reading| !reading.blank(&repeated)));
        // Two pages sharing an object are not furniture (a duplicated scan), nor three of a hundred.
        assert!(repeated_images(&routing, &[page(&[9]), page(&[9])]).is_empty());
        let mut hundred: Vec<PageReading> = (0..100).map(|number| page(&[100 + number])).collect();
        for reading in hundred.iter_mut().take(3) {
            reading.images = vec![ImageUse::plain(Some(id(9)), 0.9)];
        }
        assert!(repeated_images(&routing, &hundred).is_empty());
    }

    #[test]
    fn counts_words_from_text_runs() {
        let mut counter = WordCounter::default();
        counter.show(b"hello brave new world, a b");
        // Single letters are not words to the worker.
        assert_eq!(counter.words(), 4.0);

        // A title drawn one character at a time with next-character moves is one word, not one per glyph.
        let mut title = WordCounter::default();
        for glyph in b"Contract" {
            title.show(&[*glyph]);
            title.moved(7.0, 0.0, 12.0);
        }
        assert_eq!(title.words(), 1.0);

        // A move to the next line starts a new word.
        let mut lines = WordCounter::default();
        lines.show(b"first");
        lines.moved(0.0, -14.0, 12.0);
        lines.show(b"second");
        assert_eq!(lines.words(), 2.0);

        let mut cid = WordCounter::default();
        cid.show(&[0, 41, 0, 42, 0, 43, 0, 44, 0, 45, 0, 46, 0, 47, 0, 48, 0, 49, 0, 50, 0, 51, 0, 52]);
        assert_eq!(cid.words(), 2.0);
    }
}
