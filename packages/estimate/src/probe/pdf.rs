//! PDF probe: page count, and a page mix measured on sampled pages.
//!
//! Each sampled page is classified the way the worker routes it (`classify-route.ts`, `page-image-evidence.ts`):
//! a page with no or almost no native words whose content is a large placed image is `scanned` (read by a vision
//! model, billed Rich); pages with sizeable images or heavy vector drawing (tables, rules, charts) are `complex`;
//! the rest are `text`. Words come from the text-showing operators, image coverage from the placement matrix of
//! each drawn image over the page's MediaBox, so no rendering is needed.

use lopdf::content::Content;
use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId};

use super::{ProbeInput, ProbeKind, ProbeResult};
use crate::card::PageMix;

/// Pages whose content is inspected; larger documents are sampled evenly.
const MAX_SAMPLED_PAGES: usize = 24;
/// Decompressed content stream bytes read per page (and per form XObject).
const MAX_CONTENT_BYTES: usize = 8 * 1024 * 1024;
/// Content operations interpreted per page, forms included.
const MAX_OPERATIONS_PER_PAGE: usize = 200_000;
/// Nested form XObjects followed.
const MAX_FORM_DEPTH: u32 = 3;
/// Decompression budget for loading the document (object streams, xref streams).
const MAX_LOAD_DECOMPRESSED_BYTES: usize = 64 * 1024 * 1024;

// Mirrors of the worker's routing thresholds (worker/src/lib/page-image-evidence.ts, classify-route.ts).
const MIN_SIGNIFICANT_IMAGE_COVERAGE: f64 = 0.02;
const MIN_SIGNIFICANT_IMAGE_PIXELS: f64 = 32.0;
const SPARSE_PAGE_WORDS: f64 = 30.0;
const RASTER_PAGE_MIN_LARGEST_IMAGE_COVERAGE: f64 = 0.25;
const RASTER_PAGE_MIN_TOTAL_IMAGE_COVERAGE: f64 = 0.35;
const STAMP_TEXT_MAX_WORDS: f64 = 10.0;
const STAMPED_SCAN_MIN_IMAGE_COVERAGE: f64 = 0.5;
const SPARSE_TEXT_FULL_PAGE_IMAGE_COVERAGE: f64 = 0.85;
const DRAWN_CONTENT_MIN_BYTES_PER_PAGE: usize = 16 * 1024;
// Estimator-only: what makes a text page "complex" (layout-aware extraction) rather than plain prose.
const COMPLEX_MIN_IMAGE_COVERAGE: f64 = 0.15;
const COMPLEX_MIN_PATH_OPERATIONS: usize = 60;

const DEFAULT_PAGE_AREA: f64 = 612.0 * 792.0;

#[derive(Debug, Clone, Copy, PartialEq)]
enum PageClass {
    Text,
    Complex,
    Scanned,
}

pub(super) fn probe(input: &ProbeInput<'_>) -> ProbeResult {
    let result = ProbeResult::new(ProbeKind::Pdf, "pdf");
    if !input.is_whole() {
        return result.note("PDF probes need the whole file; priced from size");
    }
    let options = LoadOptions { max_decompressed_size: Some(MAX_LOAD_DECOMPRESSED_BYTES), ..LoadOptions::default() };
    match std::panic::catch_unwind(|| Document::load_mem_with_options(input.head, options)) {
        Ok(Ok(document)) => probe_document(&document, result),
        Ok(Err(error)) => fallback_page_count(input.head, result).note(format!("PDF did not parse ({error})")),
        Err(_) => fallback_page_count(input.head, result).note("PDF parser failed"),
    }
}

fn probe_document(document: &Document, mut result: ProbeResult) -> ProbeResult {
    let pages: Vec<ObjectId> = document.get_pages().into_values().collect();
    if pages.is_empty() {
        return result.note("PDF has no pages");
    }
    result.pages = Some(pages.len() as f64);
    if document.is_encrypted() {
        // An encrypted file whose content does not decrypt with an empty password reads as no text.
        result.notes.push("encrypted PDF; page mix not measured".into());
        return result;
    }
    let sample = sample_indices(pages.len(), MAX_SAMPLED_PAGES);
    let mut counts = [0usize; 3];
    for index in &sample {
        let class = std::panic::catch_unwind(|| classify_page(document, pages[*index])).unwrap_or(None);
        match class {
            Some(PageClass::Text) => counts[0] += 1,
            Some(PageClass::Complex) => counts[1] += 1,
            Some(PageClass::Scanned) => counts[2] += 1,
            None => {}
        }
    }
    let measured = counts.iter().sum::<usize>();
    if measured == 0 {
        return result.note("no page content could be read; page mix not measured");
    }
    let total = measured as f64;
    result.mix = Some(PageMix::new(counts[0] as f64 / total, counts[1] as f64 / total, counts[2] as f64 / total));
    // Classification is a heuristic of the worker's routing, so even a full read is not certain; sampling a
    // fraction of a long document lowers trust further.
    let coverage = measured as f64 / pages.len() as f64;
    result.mix_confidence = Some(round3(0.6 + 0.25 * coverage.sqrt()));
    result.sampled_pages = Some(measured as u32);
    result
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

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

/// When the document does not parse, count `/Type /Page` objects in the raw bytes (misses compressed object streams).
fn fallback_page_count(bytes: &[u8], mut result: ProbeResult) -> ProbeResult {
    let mut count = 0usize;
    let mut at = 0usize;
    while let Some(found) = memmem(&bytes[at..], b"/Type") {
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

fn memmem(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

#[derive(Default)]
struct PageStats {
    words: f64,
    content_bytes: usize,
    path_operations: usize,
    operations: usize,
    image_count: usize,
    image_coverage: f64,
    largest_image_coverage: f64,
}

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `a × b` for PDF matrices `[a b c d e f]` (row vector convention: a point transforms by `a` then `b`).
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
}

fn matrix_from(operands: &[Object]) -> Option<Matrix> {
    if operands.len() != 6 {
        return None;
    }
    let mut matrix = [0.0; 6];
    for (slot, operand) in matrix.iter_mut().zip(operands) {
        *slot = number(operand).filter(|value| value.is_finite())?;
    }
    Some(matrix)
}

fn deref<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    document.dereference(object).ok().map(|(_, object)| object)
}

fn dictionary<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match deref(document, object)? {
        Object::Dictionary(dictionary) => Some(dictionary),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

/// MediaBox area, inherited through the page tree.
fn page_area(document: &Document, page_id: ObjectId) -> f64 {
    let mut node = document.get_dictionary(page_id).ok();
    for _ in 0..32 {
        let Some(current) = node else { break };
        if let Some(Object::Array(values)) = current.get(b"MediaBox").ok().and_then(|object| deref(document, object)) {
            let numbers: Vec<f64> = values.iter().filter_map(|value| deref(document, value).and_then(number)).collect();
            if numbers.len() == 4 {
                let area = ((numbers[2] - numbers[0]) * (numbers[3] - numbers[1])).abs();
                if area.is_finite() && area > 1.0 {
                    return area;
                }
            }
        }
        node = current.get(b"Parent").ok().and_then(|parent| dictionary(document, parent));
    }
    DEFAULT_PAGE_AREA
}

/// Resource dictionaries in lookup order (nearest first).
fn page_resources(document: &Document, page_id: ObjectId) -> Vec<&Dictionary> {
    let Ok((direct, ids)) = document.get_page_resources(page_id) else { return Vec::new() };
    let mut resources: Vec<&Dictionary> = direct.into_iter().collect();
    resources.extend(ids.into_iter().filter_map(|id| document.get_dictionary(id).ok()));
    resources
}

fn lookup_xobject<'a>(document: &'a Document, resources: &[&'a Dictionary], name: &[u8]) -> Option<&'a Object> {
    resources.iter().find_map(|resource| {
        let xobjects = resource.get(b"XObject").ok().and_then(|object| dictionary(document, object))?;
        xobjects.get(name).ok().and_then(|object| deref(document, object))
    })
}

fn classify_page(document: &Document, page_id: ObjectId) -> Option<PageClass> {
    let content = document.get_page_content_with_limit(page_id, MAX_CONTENT_BYTES).ok()?;
    let resources = page_resources(document, page_id);
    let area = page_area(document, page_id);
    let mut stats = PageStats { content_bytes: content.len(), ..PageStats::default() };
    interpret(document, &content, &resources, IDENTITY, area, 0, &mut stats);
    Some(classify(&stats))
}

fn classify(stats: &PageStats) -> PageClass {
    let words = stats.words.round();
    if words == 0.0 && stats.image_count == 0 {
        // Text drawn as vector outlines reaches vision; an empty page does not and bills as a plain page.
        return if stats.content_bytes >= DRAWN_CONTENT_MIN_BYTES_PER_PAGE && stats.path_operations > 0 {
            PageClass::Scanned
        } else {
            PageClass::Text
        };
    }
    let raster = (words == 0.0
        && (stats.largest_image_coverage >= RASTER_PAGE_MIN_LARGEST_IMAGE_COVERAGE
            || stats.image_coverage >= RASTER_PAGE_MIN_TOTAL_IMAGE_COVERAGE))
        || (words <= STAMP_TEXT_MAX_WORDS && stats.largest_image_coverage >= STAMPED_SCAN_MIN_IMAGE_COVERAGE)
        || (words < SPARSE_PAGE_WORDS && stats.largest_image_coverage >= SPARSE_TEXT_FULL_PAGE_IMAGE_COVERAGE);
    if raster {
        return PageClass::Scanned;
    }
    if stats.image_coverage >= COMPLEX_MIN_IMAGE_COVERAGE || stats.path_operations >= COMPLEX_MIN_PATH_OPERATIONS {
        return PageClass::Complex;
    }
    PageClass::Text
}

/// Words in one shown string. Two-byte (CID) strings rarely contain a space code, so count glyphs per word instead.
fn string_words(bytes: &[u8]) -> f64 {
    if bytes.is_empty() {
        return 0.0;
    }
    let zero_high_bytes = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
    if bytes.len() >= 4 && zero_high_bytes * 2 >= bytes.len() / 2 {
        let glyphs = bytes.len() as f64 / 2.0;
        return (glyphs / 6.0).ceil();
    }
    let tokens = bytes.split(|byte| byte.is_ascii_whitespace()).filter(|token| !token.is_empty()).count();
    tokens.max(1) as f64
}

fn record_image(stats: &mut PageStats, ctm: &Matrix, area: f64, width: f64, height: f64) {
    let placed = (ctm[0] * ctm[3] - ctm[1] * ctm[2]).abs();
    let coverage = (placed / area).min(1.0);
    if !coverage.is_finite() || coverage < MIN_SIGNIFICANT_IMAGE_COVERAGE || width.min(height) < MIN_SIGNIFICANT_IMAGE_PIXELS {
        return;
    }
    stats.image_count += 1;
    stats.image_coverage = (stats.image_coverage + coverage).min(1.0);
    stats.largest_image_coverage = stats.largest_image_coverage.max(coverage);
}

fn image_size(document: &Document, dict: &Dictionary, width_key: &[u8], height_key: &[u8]) -> (f64, f64) {
    let read = |key: &[u8]| dict.get(key).ok().and_then(|object| deref(document, object)).and_then(number).unwrap_or(0.0);
    (read(width_key), read(height_key))
}

fn interpret(
    document: &Document,
    content: &[u8],
    resources: &[&Dictionary],
    base: Matrix,
    area: f64,
    depth: u32,
    stats: &mut PageStats,
) {
    let mut ctm = base;
    let mut stack: Vec<Matrix> = Vec::new();
    for operation in Content::decode_iter(content) {
        let Ok(operation) = operation else { break };
        stats.operations += 1;
        if stats.operations > MAX_OPERATIONS_PER_PAGE {
            return;
        }
        match operation.operator.as_str() {
            "q" => {
                if stack.len() < 256 {
                    stack.push(ctm);
                }
            }
            "Q" => ctm = stack.pop().unwrap_or(base),
            "cm" => {
                if let Some(matrix) = matrix_from(&operation.operands) {
                    ctm = multiply(&matrix, &ctm);
                }
            }
            "Tj" | "'" => {
                if let Some(Object::String(bytes, _)) = operation.operands.last() {
                    stats.words += string_words(bytes);
                }
            }
            "\"" => {
                if let Some(Object::String(bytes, _)) = operation.operands.get(2) {
                    stats.words += string_words(bytes);
                }
            }
            "TJ" => {
                if let Some(Object::Array(parts)) = operation.operands.first() {
                    let mut run: Vec<u8> = Vec::new();
                    for part in parts {
                        match part {
                            Object::String(bytes, _) => run.extend_from_slice(bytes),
                            // A large negative adjustment is a word gap in kerned text.
                            other if number(other).is_some_and(|gap| gap <= -200.0) => {
                                stats.words += string_words(&run);
                                run.clear();
                            }
                            _ => {}
                        }
                    }
                    stats.words += string_words(&run);
                }
            }
            "re" | "m" | "l" | "c" | "v" | "y" => stats.path_operations += 1,
            "BI" => {
                if let Some(Object::Stream(image)) = operation.operands.first() {
                    let (mut width, mut height) = image_size(document, &image.dict, b"W", b"H");
                    if width == 0.0 {
                        (width, height) = image_size(document, &image.dict, b"Width", b"Height");
                    }
                    record_image(stats, &ctm, area, width, height);
                }
            }
            "Do" => {
                let Some(Object::Name(name)) = operation.operands.first() else { continue };
                let Some(Object::Stream(xobject)) = lookup_xobject(document, resources, name) else { continue };
                let subtype = xobject.dict.get(b"Subtype").ok().and_then(|object| deref(document, object));
                match subtype {
                    Some(Object::Name(kind)) if kind == b"Image" => {
                        let (width, height) = image_size(document, &xobject.dict, b"Width", b"Height");
                        record_image(stats, &ctm, area, width, height);
                    }
                    Some(Object::Name(kind)) if kind == b"Form" && depth < MAX_FORM_DEPTH => {
                        let Ok(form_content) = xobject.decompressed_content_with_limit(MAX_CONTENT_BYTES) else { continue };
                        stats.content_bytes += form_content.len();
                        let matrix = xobject
                            .dict
                            .get(b"Matrix")
                            .ok()
                            .and_then(|object| match deref(document, object) {
                                Some(Object::Array(values)) => matrix_from(values),
                                _ => None,
                            })
                            .unwrap_or(IDENTITY);
                        let own = xobject.dict.get(b"Resources").ok().and_then(|object| dictionary(document, object));
                        let mut form_resources: Vec<&Dictionary> = own.into_iter().collect();
                        form_resources.extend_from_slice(resources);
                        interpret(document, &form_content, &form_resources, multiply(&matrix, &ctm), area, depth + 1, stats);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_evenly_with_both_ends() {
        assert_eq!(sample_indices(5, 24), vec![0, 1, 2, 3, 4]);
        let sample = sample_indices(1000, 24);
        assert_eq!(sample.len(), 24);
        assert_eq!(sample[0], 0);
        assert_eq!(sample[23], 999);
    }

    #[test]
    fn classifies_like_the_worker_router() {
        let page = |words: f64, largest: f64, total: f64, images: usize| PageStats {
            words,
            largest_image_coverage: largest,
            image_coverage: total,
            image_count: images,
            ..PageStats::default()
        };
        assert_eq!(classify(&page(0.0, 0.9, 0.9, 1)), PageClass::Scanned);
        assert_eq!(classify(&page(8.0, 0.6, 0.6, 1)), PageClass::Scanned);
        assert_eq!(classify(&page(25.0, 0.9, 0.9, 1)), PageClass::Scanned);
        assert_eq!(classify(&page(400.0, 0.9, 0.9, 1)), PageClass::Complex);
        assert_eq!(classify(&page(400.0, 0.0, 0.0, 0)), PageClass::Text);
        assert_eq!(classify(&page(0.0, 0.0, 0.0, 0)), PageClass::Text);
    }

    #[test]
    fn counts_words_in_simple_and_cid_strings() {
        assert_eq!(string_words(b"hello brave new world"), 4.0);
        assert_eq!(string_words(b"x"), 1.0);
        assert_eq!(string_words(&[0, 41, 0, 42, 0, 43, 0, 44, 0, 45, 0, 46, 0, 47]), 2.0);
    }
}
